import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("Field Kit exposes exactly twenty local workflow actions", async () => {
  const html = await read("cloudflare-site/index.html");
  const kit = await read("cloudflare-site/field-kit.js");
  const labels = kit.match(/^ {6}\["[^"]+",/gm) || [];
  assert.equal(labels.length, 20, "all twenty promised actions must be wired");
  assert.match(html, /field-kit\.js\?v=amnyam-field-kit-v1/);
  assert.match(kit, /copyIds/);
  assert.match(kit, /exportVisibleCsv/);
  assert.match(kit, /exportVisibleJson/);
  assert.match(kit, /saveSearch/);
  assert.match(kit, /restoreSearch/);
});

test("Field Kit never adds market requests or browser/system notifications", async () => {
  const kit = await read("cloudflare-site/field-kit.js");
  assert.doesNotMatch(kit, /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket/i);
  assert.doesNotMatch(kit, /new\s+Notification\s*\(|PushManager|pushManager/i);
  assert.match(kit, /amnyam:market/);
  assert.match(kit, /without additional requests|не делает дополнительных запросов/i);
});

test("Field Kit exports protect CSV against spreadsheet formula injection", async () => {
  const kit = await read("cloudflare-site/field-kit.js");
  const csvCell = kit.slice(kit.indexOf("function csvCell"), kit.indexOf("function download"));
  assert.ok(csvCell.includes("test(text)"), "CSV values must neutralise spreadsheet formulas");
  assert.ok(csvCell.includes("text.replace(/"), "CSV values must escape quotes");
});

test("invalid price ranges are reported explicitly and do not leave stale rows visible", async () => {
  const app = await read("cloudflare-site/app.js");
  assert.match(app, /if \(lower > upper\)/);
  assert.match(app, /Некорректный диапазон цен/);
  assert.match(app, /setCustomValidity\("Минимальная цена не может быть выше максимальной\."\)/);
  assert.match(app, /state\.view = \[\];[\s\S]*?renderRows\(\);/);
});

test("audited dashboard cache versions and motion preferences are present", async () => {
  const html = await read("cloudflare-site/index.html");
  const css = await read("cloudflare-site/styles.css");
  assert.match(html, /styles\.css\?v=amnyam-dota2-hud-v3/);
  assert.match(html, /app\.js\?v=amnyam-workspace-v25/);
  assert.match(css, /body\.amnyam-compact/);
  assert.match(css, /amnyam-focus \.catalog-panel/);
  assert.doesNotMatch(css, /amnyam-focus \[data-view-section\]/, "focus mode must not hide navigation destinations");
  assert.match(css, /body\.amnyam-calm/);
});
