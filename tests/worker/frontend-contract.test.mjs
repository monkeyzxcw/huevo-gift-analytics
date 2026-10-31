import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("AMNYAM keeps the agreed fast Live and slow full-catalogue polling cadence", async () => {
  const app = await read("cloudflare-site/app.js");
  assert.match(app, /window\.setInterval\(pollLive,\s*3000\)/, "Live polling must remain at ~3 seconds");
  assert.match(app, /window\.setInterval\(pollFullSnapshot,\s*5\s*\*\s*60\s*\*\s*1000\)/, "full snapshot polling must remain at 5 minutes");
  assert.match(app, /document\.visibilityState\s*!==\s*"visible"/, "fast polling must respect tab visibility");
  assert.match(app, /fastLivePollRunning/, "fast polling must avoid overlapping requests");
});

test("Push and system notifications stay disabled; sound is the only alert channel", async () => {
  const app = await read("cloudflare-site/app.js");
  const html = await read("cloudflare-site/index.html");
  assert.match(html, /Push и системные уведомления не используются|Системных и Push-уведомлений нет/i);
  assert.doesNotMatch(app, /new\s+Notification\s*\(|PushManager|pushManager\.subscribe\s*\(/i);
  assert.match(app, /toggleAlertSound|alertSound/i, "sound alert controls should remain available");
  assert.match(app, /unregisterLegacyServiceWorker/, "legacy service workers must be cleaned up");
});

test("dashboard keeps strict content security policy and safe DOM text handling", async () => {
  const html = await read("cloudflare-site/index.html");
  const app = await read("cloudflare-site/app.js");
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(app, /textContent/);
  assert.doesNotMatch(app, /\.innerHTML\s*=/, "untrusted market content must not be inserted with innerHTML");
});

test("frontend polling remains same-page fetch based instead of hard page reloads", async () => {
  const app = await read("cloudflare-site/app.js");
  assert.match(app, /async function pollLive\s*\(/);
  assert.match(app, /async function pollFullSnapshot\s*\(/);
  assert.doesNotMatch(app, /(?:window\.)?location\.reload\s*\(/, "polling must not reload the entire dashboard");
});


test("Market Intelligence Lab is shared user-facing analytics, not collector control", async () => {
  const html = await read("cloudflare-site/index.html");
  const app = await read("cloudflare-site/app.js");
  const intel = await read("cloudflare-site/intel-lab.js");
  assert.match(html, /id="intelLab" data-view-section="analytics"/);
  assert.match(html, /intel-lab\.js\?v=amnyam-intel-v2/);
  assert.match(intel, /amnyam:market/);
  assert.match(intel, /intelExportCsv/);
  assert.match(intel, /intelExportJson/);
  assert.match(intel, /intelSaveFilter/);
  assert.match(html, /Проверил актуальность цен/);
  assert.doesNotMatch(html, /data-desk-check="collector"|Сборщик запущен/);
  assert.doesNotMatch(app, /PRIVATE FULL SCAN DETAIL/);
  assert.match(app, /function renderSourceHealth\(\)[\s\S]*Shared users see data freshness and coverage only/);
});
