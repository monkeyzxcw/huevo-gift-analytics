import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { verifyHuevoLaunch } from "../../src/huevo_launch.js";

const SECRET = "test-huevo-client-secret";

function signedQuery(overrides = {}) {
  const fields = {
    hu_app_id: "12345",
    hu_user_id: "987654321",
    hu_username: "gift_hunter",
    hu_display_name: "Gift Hunter",
    hu_avatar: "https://huevo.su/avatar/987654321.png",
    hu_mode: "live",
    hu_ts: String(Math.floor(Date.now() / 1000)),
    hu_start: "room=42",
    hu_future_field: "future value",
    ...overrides
  };
  const data = Object.keys(fields).sort().map((key) => key + "=" + fields[key]).join("\n");
  const key = createHash("sha256").update(SECRET).digest();
  const hash = createHmac("sha256", key).update(data).digest("hex");
  const params = new URLSearchParams({ ...fields, hu_hash: hash, not_signed: "ignored" });
  return "?" + params.toString();
}

test("validates the exact Huevo HMAC algorithm and includes every hu_* field", async () => {
  const query = signedQuery();
  const result = await verifyHuevoLaunch(query, SECRET);
  assert.equal(result.hu_user_id, "987654321");
  assert.equal(result.hu_display_name, "Gift Hunter");
  assert.equal(result.hu_start, "room=42");
  assert.equal(result.hu_future_field, "future value");
  assert.equal(result.not_signed, undefined);
});

test("rejects forged user IDs and signatures", async () => {
  const query = signedQuery();
  const forged = query.replace("hu_user_id=987654321", "hu_user_id=111111111");
  assert.equal(await verifyHuevoLaunch(forged, SECRET), null);
  assert.equal(await verifyHuevoLaunch(query, "wrong-secret"), null);
});

test("rejects stale, future-dated, malformed timestamps and duplicate signed fields", async () => {
  assert.equal(await verifyHuevoLaunch(signedQuery({ hu_ts: "1" }), SECRET), null);
  assert.equal(await verifyHuevoLaunch(signedQuery({ hu_ts: String(Math.floor(Date.now() / 1000) + 120) }), SECRET), null);
  assert.equal(await verifyHuevoLaunch(signedQuery({ hu_ts: "123abc" }), SECRET), null);
  assert.equal(await verifyHuevoLaunch(signedQuery() + "&hu_user_id=123", SECRET), null);
});

test("rejects missing or malformed hashes", async () => {
  assert.equal(await verifyHuevoLaunch("?hu_user_id=123&hu_ts=1793347200", SECRET), null);
  const query = signedQuery().replace(/hu_hash=[^&]+/, "hu_hash=xyz");
  assert.equal(await verifyHuevoLaunch(query, SECRET), null);
});
