import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "../../src/worker.js";
const SESSION = "A".repeat(43);
const SESSION_HASH = createHash("sha256").update(SESSION).digest("hex");
const OWNER = {
  user_id: "account-owner", hu_user_id: "14188", hu_username: "monkeyzxcw",
  display_name: "monkeyzxc", avatar_url: "", app_id: "237", mode: "test",
  created_at: "2026-10-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z"
};
function makeD1({ account = OWNER, available = false } = {}) {
  const state = { account, presence: { is_available: available ? 1 : 0, updated_at: "2026-10-01T00:00:00.000Z" } };
  return {
    state,
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) { params = values; return statement; },
        async first() {
          if (sql.includes("FROM user_sessions s JOIN user_accounts a")) return params[0] === SESSION_HASH ? state.account : null;
          if (sql.includes("SELECT is_available, updated_at FROM owner_presence")) return state.presence ? { ...state.presence } : null;
          return null;
        },
        async run() {
          if (sql.includes("INSERT INTO owner_presence")) state.presence = { is_available: params[0], updated_at: params[1] };
          return { success: true, meta: { changes: 1 } };
        }
      };
      return statement;
    }
  };
}
function request(path, { method = "GET", body, cookie = true, origin = "https://amnyam.test" } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", "amnyam_session=" + SESSION);
  if (origin) headers.set("Origin", origin);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request("https://amnyam.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
  const changed = await invoke(env, "/api/contact/status", { method: "PUT", body: { available: true } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.available, true);
  assert.equal(db.state.presence.is_available, 1);
  const otherDb = makeD1({ account: { ...OWNER, hu_user_id: "123", hu_username: "another_user" } });
  const denied = await invoke({ DB: otherDb }, "/api/contact/status", { method: "PUT", body: { available: false } });
  assert.equal(denied.status, 403);
  assert.equal(otherDb.state.presence.is_available, 0);
});
