import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import worker from "../../src/worker.js";

const SECRET = "test-huevo-client-secret";
const CLIENT_ID = "test-client-id";

function signedQuery(overrides = {}) {
  const fields = {
    hu_app_id: "12345",
    hu_user_id: "987654321",
    hu_username: "gift_hunter",
    hu_display_name: "Gift Hunter",
    hu_avatar: "https://huevo.su/avatar.png",
    hu_mode: "live",
    hu_ts: String(Math.floor(Date.now() / 1000)),
    ...overrides
  };
  const canonical = Object.keys(fields).sort().map((key) => key + "=" + fields[key]).join("\n");
  const key = createHash("sha256").update(SECRET).digest();
  const signature = createHmac("sha256", key).update(canonical).digest("hex");
  return "?" + new URLSearchParams({ ...fields, hu_hash: signature }).toString();
}

function mockD1() {
  const state = { payment: null, inserts: 0, updates: [] };
  return {
    state,
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) { params = values; return statement; },
        async first() {
          if (sql.includes("SELECT 1 FROM support_payments LIMIT 1")) return { ready: 1 };
          if (sql.includes("WHERE user_id = ? AND test = ? AND status = 'pending'")) {
            const [userId, test] = params;
            const row = state.payment;
            return row && row.user_id === userId && row.test === test && row.status === "pending" ? { ...row } : null;
          }
          if (sql.includes("SELECT intent_id FROM support_payments WHERE user_id = ?")) {
            const [userId, test] = params;
            const row = state.payment;
            return row && row.user_id === userId && row.test === test ? { intent_id: row.intent_id } : null;
          }
          return null;
        },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO support_payments")) {
            state.inserts += 1;
            if (!state.payment) {
              const [intentId, userId, amount, test, createdAt, updatedAt] = params;
              state.payment = { intent_id: intentId, user_id: userId, amount, test, status: "pending", created_at: createdAt, updated_at: updatedAt };
            }
            return { success: true };
          }
          if (sql.includes("UPDATE support_payments SET status")) {
            const [status, error, updatedAt, intentId] = params;
            if (state.payment && state.payment.intent_id === intentId && state.payment.status === "pending") {
              state.payment.status = status;
              state.payment.error = error;
              state.payment.updated_at = updatedAt;
            }
            state.updates.push({ status, intentId });
            return { success: true };
          }
          return { success: true };
        }
      };
      return statement;
    }
  };
}

async function invokeIntent(env, launchQuery, amount = 5000) {
  const request = new Request("https://amnyam.test/api/support/intent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount, launch_query: launchQuery })
  });
  const response = await worker.fetch(request, env, {});
  return { status: response.status, body: await response.json() };
}

test("server reuses the existing pending huEVO intent instead of creating a duplicate payment", async () => {
  const db = mockD1();
  const originalFetch = globalThis.fetch;
  const providerCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    providerCalls.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (path.endsWith("/payments") && options.method === "POST") {
      return new Response(JSON.stringify({ ok: true, intent_id: "pi_existing_pending_1" }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }
    if (path.endsWith("/pi_existing_pending_1") && options.method === "GET") {
      return new Response(JSON.stringify({ status: "pending" }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: { code: "unexpected_request" } }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const env = { DB: db, HU_CLIENT_ID: CLIENT_ID, HU_SECRET: SECRET };
    const launchQuery = signedQuery();
    const first = await invokeIntent(env, launchQuery);
    assert.equal(first.status, 200);
    assert.equal(first.body.intent_id, "pi_existing_pending_1");
    assert.equal(first.body.reused, undefined);
    assert.equal(db.state.inserts, 1);

    const second = await invokeIntent(env, launchQuery, 10000);
    assert.equal(second.status, 200);
    assert.equal(second.body.ok, true);
    assert.equal(second.body.reused, true);
    assert.equal(second.body.status, "pending");
    assert.equal(second.body.intent_id, "pi_existing_pending_1");
    assert.equal(second.body.amount, 5000, "the existing payment amount is authoritative");
    assert.equal(providerCalls.filter(call => call.method === "POST").length, 1, "second request must not create another provider intent");
    assert.equal(providerCalls.filter(call => call.method === "GET").length, 1, "existing pending status must be reconciled");
    assert.equal(db.state.inserts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("server keeps the pending intent when huEVO status API is unavailable", async () => {
  const db = mockD1();
  db.state.payment = {
    intent_id: "pi_waiting_for_provider",
    user_id: "987654321",
    amount: 5000,
    test: 0,
    status: "pending",
    created_at: new Date().toISOString()
  };
  const originalFetch = globalThis.fetch;
  let createCalls = 0;
  globalThis.fetch = async () => {
    createCalls += 1;
    throw new Error("provider network offline");
  };
  try {
    const response = await invokeIntent({ DB: db, HU_CLIENT_ID: CLIENT_ID, HU_SECRET: SECRET }, signedQuery());
    assert.equal(response.status, 200);
    assert.equal(response.body.reused, true);
    assert.equal(response.body.intent_id, "pi_waiting_for_provider");
    assert.equal(createCalls, 1, "only the provider GET status lookup is attempted");
    assert.equal(db.state.inserts, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker aborts a hung huEVO API request and does not write an unresolved payment row", async () => {
  const db = mockD1();
  const originalFetch = globalThis.fetch;
  let signalSeen = false;
  globalThis.fetch = async (_url, options = {}) => {
    signalSeen = Boolean(options.signal);
    return new Promise((_resolve, reject) => {
      if (!options.signal) return reject(new Error("missing AbortSignal"));
      if (options.signal.aborted) return reject(new Error("already aborted"));
      options.signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
    });
  };
  try {
    const response = await invokeIntent({
      DB: db,
      HU_CLIENT_ID: CLIENT_ID,
      HU_SECRET: SECRET,
      HU_APPS_TIMEOUT_MS: 250
    }, signedQuery());
    assert.equal(signalSeen, true, "provider requests must carry an AbortSignal");
    assert.equal(response.status, 502);
    assert.match(response.body.detail, /huevo_api_timeout/);
    assert.equal(db.state.inserts, 0, "a timed-out create must not be recorded as a confirmed provider intent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

