import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("production D1 binding and migrations directory stay explicit", async () => {
  const config = JSON.parse(await read("wrangler.jsonc"));
  const database = config.d1_databases?.find((entry) => entry.binding === "DB");
  assert.ok(database, "Worker must have the DB binding");
  assert.equal(database.database_name, "huevo-live-data");
  assert.ok(database.database_id, "remote D1 database ID must not be blank");
  assert.equal(database.migrations_dir, "migrations");

  const migrations = (await readdir(resolve(root, database.migrations_dir)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(migrations.length > 0, "schema migrations must be checked into the repository");
  assert.ok(migrations.every((name) => /^\d{4}_[a-z0-9_-]+\.sql$/i.test(name)),
    "migration filenames must have an ordered four-digit prefix");
  assert.equal(new Set(migrations).size, migrations.length, "migration names must be unique");
});

test("Cloudflare deploy applies remote D1 migrations before publishing Worker code", async () => {
  const workflow = await read(".github/workflows/cloudflare-static.yml");
  const migrate = workflow.indexOf("d1 migrations apply huevo-live-data --remote");
  const deploy = workflow.indexOf("wrangler@4 deploy --config wrangler.jsonc");
  assert.notEqual(migrate, -1, "deploy workflow must apply remote D1 migrations");
  assert.notEqual(deploy, -1, "deploy workflow must publish the Worker");
  assert.ok(migrate < deploy, "schema migrations must finish before Worker deployment");
  assert.match(workflow, /CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID/);
});
