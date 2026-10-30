import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import worker from "../../src/worker.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const SESSION = "A".repeat(43);
const SESSION_HASH = createHash("sha256").update(SESSION).digest("hex");
const OWNER = {
  user_id: "account-owner",
  hu_user_id: "14188",
  hu_username: "monkeyzxcw",
  display_name: "monkeyzxc",
  avatar_url: "",
  app_id: "237",
  mode: "test",
  created_at: "2026-10-01T00:00:00.000Z",
  expires_at: "2099-01-01T00:00:00.000Z"
};

function makeD1({ account = OWNER, available = false } = {}) {
  const state = {
    account,
    presence: { is_available: available ? 1 : 0, updated_at: "2026-10-01T00:00:00.000Z" },
    vapid: null,
    subscriptions: [],
    runs: []
  };
  return {
    state,
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) { params = values; return statement; },
        async first() {
          if (sql.includes("FROM user_sessions s JOIN user_accounts a")) {
            return params[0] === SESSION_HASH ? state.account : null;
          }
          if (sql.includes("SELECT is_available, updated_at FROM owner_presence")) {
            return state.presence ? { ...state.presence } : null;
          }
          if (sql.includes("SELECT public_key, private_jwk FROM push_vapid_keys WHERE id = 1")) {
            return state.vapid ? { ...state.vapid } : null;
          }
          if (sql.includes("SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?")) {
            return { count: state.subscriptions.filter(item => item.user_id === params[0]).length };
          }
          if (sql.includes("SELECT COUNT(*) AS count FROM push_subscriptions")) {
            return { count: state.subscriptions.length };
          }
          return null;
        },
        async run() {
          state.runs.push({ sql, params: [...params] });
          if (sql.includes("INSERT OR IGNORE INTO push_vapid_keys")) {
            if (!state.vapid) {
              state.vapid = { public_key: params[0], private_jwk: params[1], created_at: params[2] };
            }
          } else if (sql.includes("INSERT INTO push_subscriptions")) {
            const [endpoint_hash, user_id, endpoint, p256dh, auth_secret, created_at, updated_at] = params;
            const existing = state.subscriptions.findIndex(item => item.endpoint_hash === endpoint_hash);
            const value = { endpoint_hash, user_id, endpoint, p256dh, auth_secret, created_at, updated_at };
            if (existing >= 0) state.subscriptions[existing] = value;
            else state.subscriptions.push(value);
          } else if (sql.includes("INSERT INTO owner_presence")) {
            state.presence = { is_available: params[0], updated_at: params[1] };
          }
          return { success: true, meta: { changes: 1 } };
        },
        async all() {
          if (sql.includes("SELECT endpoint_hash, endpoint, p256dh, auth_secret FROM push_subscriptions WHERE user_id = ?")) {
            return { results: state.subscriptions.filter(item => item.user_id === params[0]).map(({ endpoint_hash, endpoint, p256dh, auth_secret }) => ({ endpoint_hash, endpoint, p256dh, auth_secret })) };
          }
          return { results: [] };
        }
      };
      return statement;
    },
    async batch(statements) {
      const output = [];
      for (const statement of statements) output.push(await statement.run());
      return output;
    }
  };
}

function request(path, { method = "GET", body, cookie = true, origin = "https://amnyam.test" } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", "amnyam_session=" + SESSION);
  if (origin) headers.set("Origin", origin);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request("https://amnyam.test" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function invoke(env, path, options) {
  const response = await worker.fetch(request(path, options), env, {});
  let body = {};
  try { body = await response.json(); } catch (_) {}
  return { status: response.status, body };
}

test("only the signed huEVO owner can read owner controls and update availability", async () => {
  const db = makeD1({ available: false });
  const env = { DB: db };
  const publicStatus = await invoke(env, "/api/contact/status", { cookie: false, origin: null });
  assert.equal(publicStatus.status, 200);
  assert.equal(publicStatus.body.available, false);
  assert.equal(publicStatus.body.can_manage, false);

  const ownerStatus = await invoke(env, "/api/contact/status");
  assert.equal(ownerStatus.status, 200);
  assert.equal(ownerStatus.body.can_manage, true);

  const changed = await invoke(env, "/api/contact/status", {
    method: "PUT", body: { available: true }
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.available, true);
  assert.equal(db.state.presence.is_available, 1);

  const otherDb = makeD1({ account: { ...OWNER, hu_user_id: "123", hu_username: "another_user" } });
  const denied = await invoke({ DB: otherDb }, "/api/contact/status", {
    method: "PUT", body: { available: false }
  });
  assert.equal(denied.status, 403);
  assert.equal(otherDb.state.presence.is_available, 0);
});

test("Web Push config persists VAPID keys and sends an encrypted test push", async () => {
  const db = makeD1();
  const env = { DB: db };
  const config = await invoke(env, "/api/push/config", { cookie: false, origin: null });
  assert.equal(config.status, 200);
  assert.equal(config.body.enabled, true);
  assert.match(config.body.public_key, /^[A-Za-z0-9_-]{80,120}$/);
  assert.ok(db.state.vapid.private_jwk, "private VAPID JWK must stay server-side");

  const receiver = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const rawReceiver = new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const encode = bytes => Buffer.from(bytes).toString("base64url");
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/amnyam-test-endpoint",
    expirationTime: null,
    keys: { p256dh: encode(rawReceiver), auth: encode(auth) }
  };
  const saved = await invoke(env, "/api/push/subscribe", {
    method: "POST", body: subscription
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.saved, true);
  assert.equal(db.state.subscriptions.length, 1);
  assert.equal(db.state.subscriptions[0].user_id, "account-owner");

  const originalFetch = globalThis.fetch;
  let outbound;
  globalThis.fetch = async (url, options = {}) => {
    outbound = { url: String(url), options };
    return new Response(null, { status: 201 });
  };
  try {
    const sent = await invoke(env, "/api/push/test", { method: "POST", body: {} });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.ok, true);
    assert.equal(sent.body.sent, 1);
    assert.match(outbound.url, /^https:\/\/fcm\.googleapis\.com\//);
    assert.equal(outbound.options.headers["Content-Encoding"], "aes128gcm");
    assert.equal(outbound.options.headers["Content-Type"], "application/octet-stream");
    assert.match(outbound.options.headers.Authorization, /^vapid t=/);
    assert.ok(outbound.options.body instanceof Uint8Array);
    assert.ok(outbound.options.body.length > 100, "payload should be encrypted and framed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
