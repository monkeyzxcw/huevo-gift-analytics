import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import worker from "../../src/worker.js";

function createD1Mock() {
  let snapshotRow = null;
  return {
    get snapshotRow() { return snapshotRow; },
    prepare(sql) {
      let params = [];
      return {
        bind(...values) { params = values; return this; },
        async run() {
          if (sql.includes("INSERT INTO full_snapshot")) {
            snapshotRow = { data_json: params[0], generated_at: params[1], updated_at: params[2] };
          }
          return {};
        },
        async first() {
          if (sql.includes("SELECT generated_at") && sql.includes("FROM full_snapshot")) {
            return snapshotRow ? { generated_at: snapshotRow.generated_at } : null;
          }
          if (sql.includes("SELECT data_json") && sql.includes("FROM full_snapshot")) return snapshotRow;
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
    },
  };
}

function testEnv() {
  return {
    LIVE_INGEST_TOKEN: "test-ingest-token",
    DB: createD1Mock(),
  };
}

test("gzip snapshot is stored compactly in D1 and transparently expanded by /data.json", async () => {
  const env = testEnv();
  const snapshot = {
    schema_version: 3,
    generated_at: "2026-10-31T10:00:00.000Z",
    collector: { status: "ok" },
    lots: Array.from({ length: 300 }, (_, i) => ({
      lot_id: String(i + 1),
      title: "Подарок с повторяющимися характеристиками",
      price: 12345 + i,
      rarity: "Редкий",
      attributes: { model: "Model X", backdrop: "Blue Sky", symbol: "Comet" },
    })),
  };
  const gzipBody = gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"));
  const post = await worker.fetch(new Request("https://amnyam.test/api/snapshot", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-ingest-token",
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
    },
    body: gzipBody,
  }), env, {});

  assert.equal(post.status, 200);
  const postResult = await post.json();
  assert.equal(postResult.ok, true);
  assert.equal(postResult.compressed, true);
  assert.ok(postResult.stored_bytes < gzipBody.length * 1.4);
  assert.ok(String(env.DB.snapshotRow.data_json).startsWith("gzip64:"));

  const get = await worker.fetch(new Request("https://amnyam.test/data.json"), env, {});
  assert.equal(get.status, 200);
  const loaded = await get.json();
  assert.equal(loaded.generated_at, snapshot.generated_at);
  assert.equal(loaded.lots.length, snapshot.lots.length);
  assert.deepEqual(loaded.lots[0], snapshot.lots[0]);
  assert.deepEqual(loaded.lots.at(-1), snapshot.lots.at(-1));
});

test("legacy uncompressed full_snapshot rows remain readable", async () => {
  const env = testEnv();
  const snapshot = {
    generated_at: "2026-10-30T10:00:00.000Z",
    lots: [{ lot_id: "legacy-1", title: "Старый снимок", price: 100 }],
  };
  await env.DB.prepare("INSERT INTO full_snapshot").bind(JSON.stringify(snapshot)).run();

  const get = await worker.fetch(new Request("https://amnyam.test/data.json"), env, {});
  assert.equal(get.status, 200);
  const loaded = await get.json();
  assert.equal(loaded.generated_at, snapshot.generated_at);
  assert.deepEqual(loaded.lots, snapshot.lots);
});

test("three-second Live status endpoint reads only the Live row and skips schema setup", async () => {
  const statements = [];
  const liveItems = [{ lot_id: "live-1", title: "Live gift", price: 123, rarity: "Rare" }];
  const DB = {
    prepare(sql) {
      statements.push(sql);
      return {
        async first() {
          if (sql.includes("SELECT items_json, fingerprint") && sql.includes("FROM live_page_state")) {
            return {
              items_json: JSON.stringify(liveItems),
              fingerprint: "live-fingerprint",
              last_poll_at: new Date().toISOString(),
              item_count: liveItems.length,
              source: "https://huevo.su/market/gifts?page=1"
            };
          }
          return null;
        }
      };
    }
  };
  const response = await worker.fetch(
    new Request("https://amnyam.test/api/live/status"),
    { DB },
    {}
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.fresh, true);
  assert.equal(result.item_count, 1);
  assert.equal(result.fingerprint, "live-fingerprint");
  assert.deepEqual(result.items, liveItems);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /FROM live_page_state/);
  assert.doesNotMatch(statements.join("\n"), /sqlite_master|CREATE TABLE/i);
});

test("snapshot ingest rejects missing and incorrect bearer credentials before reading the payload", async () => {
  for (const headers of [
    { "Content-Type": "application/json" },
    { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
  ]) {
    const env = testEnv();
    const response = await worker.fetch(new Request("https://amnyam.test/api/snapshot", {
      method: "POST", headers, body: "{malformed"
    }), env, {});
    assert.equal(response.status, 401);
    assert.equal(env.DB.snapshotRow, null);
  }
});

test("snapshot ingest reports missing server token as unavailable, not unauthorized", async () => {
  const env = testEnv();
  delete env.LIVE_INGEST_TOKEN;
  const response = await worker.fetch(new Request("https://amnyam.test/api/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-ingest-token" },
    body: JSON.stringify({ generated_at: new Date().toISOString(), lots: [{ lot_id: "x" }] }),
  }), env, {});
  assert.equal(response.status, 503);
  assert.equal(env.DB.snapshotRow, null);
});

test("snapshot ingest rejects malformed JSON and unsupported content encodings without writing D1", async () => {
  const malformed = await worker.fetch(new Request("https://amnyam.test/api/snapshot", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-ingest-token",
      "Content-Type": "application/json",
    },
    body: "{not-json",
  }), testEnv(), {});
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /valid JSON/);

  const env = testEnv();
  const unsupported = await worker.fetch(new Request("https://amnyam.test/api/snapshot", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-ingest-token",
      "Content-Type": "application/json",
      "Content-Encoding": "br",
    },
    body: "{}",
  }), env, {});
  assert.equal(unsupported.status, 415);
  assert.equal(env.DB.snapshotRow, null);
});

test("snapshot ingest rejects declared oversized payload before attempting to store it", async () => {
  const env = testEnv();
  const response = await worker.fetch(new Request("https://amnyam.test/api/snapshot", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-ingest-token",
      "Content-Type": "application/json",
      "Content-Length": "12000001",
    },
    body: "{}",
  }), env, {});
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /too large/);
  assert.equal(env.DB.snapshotRow, null);
});


test("a delayed full scan cannot overwrite a newer published snapshot", async () => {
  const env = testEnv();
  const current = {
    generated_at: "2026-11-01T12:00:00.000Z",
    lots: [{ lot_id: "newer", title: "Newer catalogue" }],
  };
  env.DB.snapshotRow = {
    data_json: JSON.stringify(current),
    generated_at: current.generated_at,
    updated_at: current.generated_at,
  };

  const stale = {
    generated_at: "2026-11-01T11:55:00.000Z",
    lots: [{ lot_id: "older", title: "Delayed stale catalogue" }],
  };
  const response = await worker.fetch(new Request("https://amnyam.test/api/snapshot", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-ingest-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(stale),
  }), env, {});

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "stale_snapshot");
  assert.equal(env.DB.snapshotRow.generated_at, current.generated_at);
  const loaded = await (await worker.fetch(new Request("https://amnyam.test/data.json"), env, {})).json();
  assert.equal(loaded.lots[0].lot_id, "newer");
});
