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
