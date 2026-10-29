// Browser collector vs. fixtures. Real huevo.su / Render are never contacted: every request is routed locally.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "../..");
const COLLECTOR = fs.readFileSync(path.join(ROOT, "static/browser_collector.js"), "utf8");
const DASH = "https://huevo-gift-analytics.onrender.com";
const CORS = { "access-control-allow-origin": "https://huevo.su", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "POST,OPTIONS" };

const card = (id, price, title = "Лот " + id) => `<a class="mk-gcard" href="/market/lot/${id}"><div class="mk-gtitle">${title}</div><div class="mk-gsub">Редкий</div><div class="mk-price">${price}</div></a>`;
const html = (cards) => `<!doctype html><html><head><title>Маркет</title></head><body>${cards.join("") || "Пусто"}</body></html>`;

async function run({ pages, token = "good-token", opts = {}, host = "https://huevo.su", ingestStatus = 200, prompt }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const seen = { gifts: [], ingest: [], complete: [], dialogs: [], auth: [] };
  page.on("dialog", async (d) => { seen.dialogs.push(d.message()); if (d.type() === "prompt") await d.accept(prompt === undefined ? token : prompt); else await d.accept(); });
  await ctx.route("https://huevo.su/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/market/gifts" && u.searchParams.has("page")) {
      const n = Number(u.searchParams.get("page")); seen.gifts.push(n);
      const spec = pages[n] || { status: 200, html: html([]) };
      return route.fulfill({ status: spec.status || 200, headers: { "content-type": "text/html", ...(spec.headers || {}) }, body: spec.html || html([]) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: html([]) });
  });
  await ctx.route(DASH + "/**", async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    seen.auth.push(req.headers()["authorization"]);
    const body = req.postDataJSON();
    if (u.pathname === "/api/ingest") {
      seen.ingest.push(body);
      if (ingestStatus !== 200) return route.fulfill({ status: ingestStatus, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ detail: "Неверный токен" }) });
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ ok: true, saved: body.lots.length, rejected: 0, new: body.lots.length }) });
    }
    if (u.pathname === "/api/ingest/complete") {
      seen.complete.push(body);
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ ok: true, complete: body.reached_end, deactivated: 0 }) });
    }
    return route.fulfill({ status: 404, headers: CORS, body: "{}" });
  });
  await page.goto(host + "/market/gifts");
  await page.evaluate((o) => { window.HUEVO_COLLECTOR = o; }, { allowFast: true, delayMs: 0, ...opts });
  await page.evaluate(COLLECTOR);
  const result = await page.waitForFunction(() => window.HUEVO_COLLECTOR_RESULT, null, { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => null);
  await browser.close();
  return { seen, result };
}

test("full pass: parses prices like the Python parser, dedupes, and reports reached_end", async () => {
  const { seen, result } = await run({ pages: {
    1: { html: html([card(1, "1&nbsp;250 ◉"), card(2, "340"), card(1, "999"), card(3, "от 100 до 200"), card(4, "12,5"), card(5, "")]) },
    2: { html: html([card(6, "10"), card(7, "20")]) },
    3: { html: html([card(6, "10"), card(7, "20")]) },
  } });
  assert.deepEqual(seen.gifts, [1, 2, 3]);
  const lots = seen.ingest.flatMap((b) => b.lots);
  assert.deepEqual(lots.map((l) => l.lot_id), ["1", "2", "3", "4", "5", "6", "7"], "duplicate card 1 must be dropped");
  assert.deepEqual(lots.slice(0, 5).map((l) => l.price), [1250, 340, 100, 12.5, null]);
  assert.equal(result.reachedEnd, true);
  assert.deepEqual(seen.complete, [{ reached_end: true, pages: 3, unique: 7 }]);
  assert.ok(seen.auth.every((a) => a === "Bearer good-token"));
});

test("HTTP 418 with Retry-After stops immediately, never retries, and reports an incomplete pass", async () => {
  const { seen, result } = await run({ pages: {
    1: { html: html([card(1, "10")]) },
    2: { status: 418, headers: { "retry-after": "120" }, html: "<html><body>HTTP ERROR 418</body></html>" },
    3: { html: html([card(9, "10")]) },
  } });
  assert.deepEqual(seen.gifts, [1, 2], "page 3 must never be requested");
  assert.equal(result.reachedEnd, false);
  assert.match(result.stop, /418/);
  assert.match(result.stop, /Retry-After 120/);
  assert.deepEqual(seen.complete.map((c) => c.reached_end), [false]);
  assert.ok(seen.dialogs.some((m) => /остановлен/i.test(m)));
});

test("403 and 429 are treated as blocks; 503 as a source error", async () => {
  for (const [status, re] of [[403, /403/], [429, /429/], [503, /Ошибка сервера/]]) {
    const { seen, result } = await run({ pages: { 1: { status, html: "<html><body>x</body></html>" } } });
    assert.deepEqual(seen.gifts, [1]);
    assert.match(result.stop, re);
    assert.equal(result.reachedEnd, false);
  }
});

test("empty first page is not a success and sends nothing", async () => {
  const { seen, result } = await run({ pages: { 1: { html: html([]) } } });
  assert.equal(seen.ingest.length, 0);
  assert.equal(result.reachedEnd, false);
  assert.match(result.stop, /нет карточек/);
});

test("max pages limit does not claim the end of the catalog", async () => {
  const pages = {}; for (let n = 1; n <= 5; n++) pages[n] = { html: html([card(n * 10, "5"), card(n * 10 + 1, "6")]) };
  const { result, seen } = await run({ pages, opts: { maxPages: 2 } });
  assert.equal(result.reachedEnd, false);
  assert.deepEqual(seen.gifts, [1, 2]);
  assert.equal(seen.complete[0].reached_end, false);
});

test("wrong token: server refusal aborts the pass and is not reported as complete", async () => {
  const { seen, result } = await run({ pages: { 1: { html: html([card(1, "1")]) }, 2: { html: html([card(2, "1")]) } }, ingestStatus: 403 });
  assert.deepEqual(seen.gifts, [1]);
  assert.equal(result.reachedEnd, false);
  assert.match(result.stop, /Панель отклонила/);
});

test("untrusted dashboard address: token is never sent anywhere", async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(), page = await ctx.newPage();
  const requests = [], dialogs = [];
  page.on("dialog", async (d) => { dialogs.push(d.type()); await d.accept("secret-token"); });
  await ctx.route("**/*", (route) => { requests.push(route.request().url()); route.fulfill({ status: 200, contentType: "text/html", body: html([]) }); });
  await page.goto("https://huevo.su/market/gifts");
  await page.evaluate(() => { window.HUEVO_COLLECTOR = { dashboard: "https://evil.example" }; });
  await page.evaluate(COLLECTOR);
  await page.waitForTimeout(300);
  await browser.close();
  assert.ok(!requests.some((u) => u.includes("evil.example")), "no request to the untrusted host");
  assert.ok(!dialogs.includes("prompt"), "token must not even be requested");
});

test("running on a non-Huevo site refuses to start", async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(), page = await ctx.newPage();
  const dialogs = []; page.on("dialog", async (d) => { dialogs.push(d.type()); await d.accept(); });
  await ctx.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html([]) }));
  await page.goto("https://example.com/");
  await page.evaluate(COLLECTOR);
  await page.waitForTimeout(200);
  await browser.close();
  assert.deepEqual(dialogs, ["alert"]);
});
