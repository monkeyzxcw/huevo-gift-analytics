import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = await readFile(resolve(root, ".github/workflows/cloudflare-static.yml"), "utf8");

test("Cloudflare deployment performs production smoke checks after wrangler deploy", () => {
  const deploy = workflow.indexOf("wrangler@4 deploy --config wrangler.jsonc");
  const smoke = workflow.indexOf("Smoke-test deployed Worker, D1, and published snapshot");
  assert.ok(deploy >= 0, "deploy command must exist");
  assert.ok(smoke > deploy, "production smoke checks must run after deployment");
  for (const endpoint of ["/", "/assets/amnyam-battlefield.webp", "/api/health", "/api/live/status", "/data.json"]) {
    assert.ok(workflow.includes(endpoint), "smoke check must probe " + endpoint);
  }
  assert.match(workflow, /huevo-gift-analytics\.monkeyzxc1437\.workers\.dev/);
  assert.match(workflow, /range\(1, 9\)/, "smoke checks must tolerate short deployment propagation delays");
  assert.match(workflow, /dashboard_html_ready/);
  assert.match(workflow, /hero_art_ready/);
  assert.match(workflow, /snapshot_has_lots/);
  assert.match(workflow, /ingest_secret_configured/);
  assert.match(workflow, /Chrome\\/131\\.0\\.0\\.0/);
  assert.match(workflow, /cf-ray/);
  assert.match(workflow, /cf-mitigated/);
});

test("deployment is not marked unhealthy solely because the local collector is offline", () => {
  assert.match(workflow, /live\.get\("fresh"\)/);
  assert.match(workflow, /local HuevoDualScan collector has not reported fresh Live data/);
  assert.doesNotMatch(workflow, /"live_fresh"\s*:\s*live\.get\("fresh"\)\s*is\s*True/,
    "live freshness is reported, not required for a successful Worker deploy");
});
