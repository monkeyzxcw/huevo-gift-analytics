import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("gifts and usernames are separate market workspaces with independent eight-tab navigation", async () => {
  const html = await read("cloudflare-site/index.html");
  assert.match(html, /id="marketTypeNav"/);
  assert.match(html, /id="giftsWorkspace"/);
  assert.match(html, /id="usernameWorkspace"/);
  assert.match(html, /data-market-type="gifts"/);
  assert.match(html, /data-market-type="usernames"/);
  const giftTabs = html.match(/id="mainNav"[\s\S]*?<\/nav>/)?.[0] || "";
  const usernameTabs = html.match(/id="usernameTabs"[\s\S]*?<\/nav>/)?.[0] || "";
  assert.equal((giftTabs.match(/role="tab"/g) || []).length, 8, "gift navigation must preserve its eight existing tabs");
  assert.equal((usernameTabs.match(/data-username-view=/g) || []).length, 8, "username market has its own eight tabs");
  assert.match(html, /https:\/\/huevo\.su\/market/);
  assert.match(html, /usernames\.js\?v=amnyam-usernames-v1/);
});

test("username workspace imports JSON and CSV locally without scraping Huevo or exposing credentials", async () => {
  const html = await read("cloudflare-site/index.html");
  const script = await read("cloudflare-site/usernames.js");
  assert.match(html, /id="usernameImportFile"/);
  assert.match(html, /accept="\.json,\.csv,application\/json,text\/csv"/);
  assert.match(script, /parseCsv/);
  assert.match(script, /parseImport/);
  assert.match(script, /localStorage/);
  assert.match(script, /AMNYAM\.MARKET/);
  assert.match(script, /BASE_KEY/);
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest|WebSocket/i, "username module must not attempt unapproved Huevo scraping");
  assert.doesNotMatch(script, /document\.cookie|localStorage\.getItem\(["'](?:huevo|cookie|session)/i);
  assert.match(html, /https:\/\/huevo\.su\/market/);
});

test("username prices are treated as asking prices and signals require five comparable peers", async () => {
  const html = await read("cloudflare-site/index.html");
  const script = await read("cloudflare-site/usernames.js");
  assert.match(html, /Цена объявления ≠ подтверждённая цена продажи/);
  assert.match(html, /не подключена к локальному HuevoDualScan/);
  assert.match(script, /if \(peers\.length < 5\) return/);
  assert.match(script, /Медиана/);
  assert.match(html, /минимум 5 аналогов/);
  assert.doesNotMatch(script, /sales_history|completed_sales|sold_price/i, "username listing prices must not be treated as completed sales");
});

test("username watchlist is profile-scoped and target notifications are sound-only", async () => {
  const script = await read("cloudflare-site/usernames.js");
  const html = await read("cloudflare-site/index.html");
  assert.match(script, /amnyam\.usernames\.workspace\.v1/);
  assert.match(script, /profileKey/);
  assert.match(script, /state\.targets/);
  assert.match(script, /AudioContext|webkitAudioContext/);
  assert.doesNotMatch(script, /new\s+Notification\s*\(|PushManager|pushManager/i);
  assert.match(html, /Push и системные уведомления не используются/);
});

test("username import rejects invalid identifiers, unsafe prices and external listing URLs", async () => {
  const script = await read("cloudflare-site/usernames.js");
  assert.match(script, /\^\[a-z0-9_\]\{1,32\}\$/i);
  assert.match(script, /Number\.isSafeInteger\(amount\)/);
  assert.match(script, /amount <= 0/);
  assert.match(script, /url\.hostname === "huevo\.su"/);
  assert.match(script, /MAX_ITEMS = 5000/);
  assert.match(script, /MAX_FILE_BYTES = 8 \* 1024 \* 1024/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
});

test("username analytics uses CSP-safe CSS bars and JavaScript syntax is checked by CI", async () => {
  const html = await read("cloudflare-site/index.html");
  const css = await read("cloudflare-site/styles.css");
  const pkg = await read("package.json");
  assert.match(pkg, /node --check cloudflare-site\/usernames\.js/);
  assert.match(html, /styles\.css\?v=amnyam-dota2-hud-v4/);
  assert.match(css, /\.username-bar-w-100\s*\{width:100%\}/);
  assert.match(css, /\.username-bar-h-100\s*\{height:100%\}/);
  assert.doesNotMatch(css.slice(css.indexOf("/* Separate Huevo market workspaces"), css.length), /<style/i);
});

test("username market validates inverted price ranges and parses grouped thousands", async () => {
  const script = await read("cloudflare-site/usernames.js");
  assert.match(script, /if \\(minValue != null && maxValue != null && minValue > maxValue\\)/);
  assert.match(script, /Минимальная цена не может быть выше максимальной/);
  assert.match(script, /\\d\\{1,3\\}\\(\\?:,\\d\\{3\\}\\)\\+/);
  assert.match(script, /normal = normal\\.replace\\(\\/,/);
});
