import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { currentAccount, saveAccountProfile } from "../../src/auth.js";

const SESSION_A = "A".repeat(43);
const SESSION_B = "B".repeat(43);
const hash = (token) => createHash("sha256").update(token).digest("hex");
const users = {
  "internal-a": {
    user_id: "internal-a", hu_user_id: "1001", hu_username: "alice",
    display_name: "Alice", avatar_url: "", app_id: "123", mode: "live",
    created_at: "2026-10-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z"
  },
  "internal-b": {
    user_id: "internal-b", hu_user_id: "1002", hu_username: "bob",
    display_name: "Bob", avatar_url: "", app_id: "123", mode: "live",
    created_at: "2026-10-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z"
  }
};

function makeD1() {
  const sessions = new Map([[hash(SESSION_A), users["internal-a"]], [hash(SESSION_B), users["internal-b"]]]);
  const profiles = new Map([
    ["internal-a", { profile_json: JSON.stringify({ favorites: ["11"], targets: { "11": 100 } }), updated_at: "2026-10-01T00:00:00.000Z" }],
    ["internal-b", { profile_json: JSON.stringify({ favorites: ["22"], targets: { "22": 200 } }), updated_at: "2026-10-01T00:00:00.000Z" }]
  ]);
  return {
    profiles,
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) { params = values; return statement; },
        async all() {
          if (sql.includes("sqlite_master")) {
            return { results: ["user_accounts", "user_sessions", "user_profiles", "auth_rate_limits"].map(name => ({ name })) };
          }
          return { results: [] };
        },
        async first() {
          if (sql.includes("FROM user_sessions s JOIN user_accounts a")) {
            const row = sessions.get(params[0]);
            return row && row.expires_at > params[1] ? row : null;
          }
          if (sql.includes("SELECT profile_json, updated_at FROM user_profiles")) {
            return profiles.get(params[0]) || null;
          }
          return null;
        },
        async run() {
          if (sql.includes("INSERT INTO user_profiles")) {
            profiles.set(params[0], { profile_json: params[1], updated_at: params[2] });
          }
          return { success: true, meta: { changes: 1 } };
        }
      };
      return statement;
    }
  };
}

function responseJson(request, env, value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function makeRequest(token, { method = "GET", origin = "https://amnyam.test", body } = {}) {
  const headers = new Headers({ Cookie: "amnyam_session=" + token });
  if (origin) headers.set("Origin", origin);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request("https://amnyam.test/api/me/profile", {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test("two huEVO accounts read and write only their own D1 profile rows", async () => {
  const DB = makeD1();
  const env = { DB };
  const a = await currentAccount(makeRequest(SESSION_A), env, responseJson);
  const b = await currentAccount(makeRequest(SESSION_B), env, responseJson);
  const accountA = await a.json();
  const accountB = await b.json();

  assert.equal(accountA.user.hu_user_id, "1001");
  assert.deepEqual(accountA.profile.favorites, ["11"]);
  assert.equal(accountB.user.hu_user_id, "1002");
  assert.deepEqual(accountB.profile.favorites, ["22"]);

  const saved = await saveAccountProfile(makeRequest(SESSION_A, {
    method: "PUT",
    body: { profile: { favorites: ["99"], targets: { "99": 999 } } }
  }), env, responseJson);
  assert.equal(saved.status, 200);

  const refreshedA = await (await currentAccount(makeRequest(SESSION_A), env, responseJson)).json();
  const refreshedB = await (await currentAccount(makeRequest(SESSION_B), env, responseJson)).json();
  assert.deepEqual(refreshedA.profile.favorites, ["99"]);
  assert.deepEqual(refreshedA.profile.targets, { "99": 999 });
  assert.deepEqual(refreshedB.profile.favorites, ["22"]);
  assert.deepEqual(refreshedB.profile.targets, { "22": 200 });
});

test("profile mutation rejects cross-origin requests and expired/unknown sessions", async () => {
  const env = { DB: makeD1() };
  const crossOrigin = await saveAccountProfile(makeRequest(SESSION_A, {
    method: "PUT", origin: "https://evil.example", body: { profile: { favorites: ["77"] } }
  }), env, responseJson);
  assert.equal(crossOrigin.status, 403);

  const expired = await saveAccountProfile(makeRequest("C".repeat(43), {
    method: "PUT", body: { profile: { favorites: ["77"] } }
  }), env, responseJson);
  assert.equal(expired.status, 401);
  assert.deepEqual(JSON.parse(env.DB.profiles.get("internal-a").profile_json).favorites, ["11"]);
});

test("account lookup without a valid session never exposes another user's profile", async () => {
  const response = await currentAccount(makeRequest("C".repeat(43)), { DB: makeD1() }, responseJson);
  const result = await response.json();
  assert.equal(result.authenticated, false);
  assert.equal(result.user, null);
  assert.deepEqual(result.profile.favorites, []);
});
