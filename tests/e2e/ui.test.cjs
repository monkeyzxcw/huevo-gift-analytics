// UI smoke tests against a mocked API, served with the app's real Content-Security-Policy.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "../..");
const CSP = execFileSync("python3", ["-c", "import security;print(security.CSP)"], { cwd: ROOT }).toString().trim();
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript" };
const XSS = '<img src=x onerror="window.__xss=1">';
const LOTS = Array.from({ length: 30 }, (_, i) => ({ lot_id: String(1000 + i), title: i === 0 ? XSS : "Подарок " + i, serial: "#" + i, rarity: i % 2 ? "Редкий" : "Обычный", price: 100 + i * 10, status: "В продаже", image_url: i === 1 ? "javascript:alert(1)" : "", lot_url: "https://huevo.su/market/lot/" + (1000 + i), first_seen: "2026-10-01T10:00:00+00:00", last_seen: "2026-10-29T10:00:00+00:00", active: 1 }));
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function api(state) {
  return async (route) => {
    const u = new URL(route.request().url()); const p = u.pathname; state.calls.push(p + u.search);
    if (state.fail && p.startsWith(state.fail)) return json(route, { detail: "Сервер недоступен" }, 500);
    if (p === "/api/catalog") {
      const q = (u.searchParams.get("q") || "").toLowerCase(), off = +u.searchParams.get("offset") || 0, lim = +u.searchParams.get("limit") || 24;
      const all = state.empty ? [] : LOTS.filter((l) => l.title.toLowerCase().includes(q) || l.lot_id.includes(q));
      return json(route, { items: all.slice(off, off + lim), total: all.length, limit: lim, offset: off });
    }
    if (p === "/api/facets") return json(route, { statuses: ["В продаже"], rarities: ["Редкий", "Обычный"] });
    if (p === "/api/highlights") return json(route, state.empty ? { latest: null, best: null, runner_up: [], data_state: "empty", latest_note: "", best_note: "" } : { latest: LOTS[0], best: { ...LOTS[2], reference: 300, basis: "gone", sample_size: 4, discount_pct: 60, suspicious: false }, runner_up: [], latest_note: "Замечен последним", best_note: "Эталон: медиана" });
    if (p === "/api/analytics/summary") return json(route, { summary: state.empty ? { priced: 0, min: null, max: null, avg: null, median: null, p25: null, p75: null } : { priced: 30, min: 100, max: 390, avg: 245, median: 245, p25: 170, p75: 320 }, enough_data: !state.empty, sample_size: state.empty ? 0 : 30, active_total: state.empty ? 0 : 30, bins: state.empty ? [] : [{ label: "≤ 150", count: 6 }, { label: "150–200", count: 10 }], rarities: [{ rarity: "Редкий", count: 15 }], changes: [7, 30, 90].map((d) => ({ days: d, snapshots: 0, change_pct: null })), method: "Метод", note: "Не цены сделок" });
    if (p === "/api/analytics/snapshots") return json(route, { days: 30, points: [] });
    if (p === "/api/drops") return json(route, []);
    if (p === "/api/deals") return json(route, { method: "m", note: "n", deals: [] });
    if (p === "/api/lots/by-ids") return json(route, { items: LOTS.filter((l) => (u.searchParams.get("ids") || "").split(",").includes(l.lot_id)) });
    if (p === "/api/status") return json(route, { running: false, message: "ok", page: 0, found: 0, last_ingest_at: "2026-10-29T10:00:00+00:00", blocked_until: state.blocked || null, last_http_status: state.blocked ? "418" : null });
    if (p === "/api/diagnostics") return json(route, { ok: true, lots_in_database: 30, active_lots: 30, price_history_rows: 30, snapshots: 1, ingest_token_configured: true, huevo_cookies_configured: false, persistence: { ephemeral_warning: false, message: "" } });
    if (p === "/api/support/config") return json(route, { enabled: true, amounts: [5, 10, 50, 100], sdk_url: "https://huevo.su/static/js/huevo-apps-v1.js", origins: ["huevo.su"] });
    if (p === "/api/support/stats") return json(route, { supporters: 0, total: 0 });
    return json(route, { detail: "not found" }, 404);
  };
}

async function open(state, viewport) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("dialog", (d) => { problems.push("dialog: " + d.message()); d.dismiss(); });
  await ctx.route("https://huevo.su/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: "window.huevo={init:async()=>{},confirmPayment:async()=>{}}" }));
  await ctx.route("http://panel.test/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/api/")) return api(state)(route);
    const file = u.pathname === "/" ? "static/index.html" : u.pathname.slice(1);
    const full = path.join(ROOT, file);
    if (!full.startsWith(ROOT) || !fs.existsSync(full)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, headers: { "content-type": TYPES[path.extname(full)] || "text/plain", "content-security-policy": CSP }, body: fs.readFileSync(full) });
  });
  await page.goto("http://panel.test/");
  return { browser, page, problems };
}
const fresh = (extra = {}) => ({ calls: [], ...extra });

for (const [name, vp] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 800 }]]) {
  test(`${name}: every tab renders, no CSP/console errors, no horizontal overflow`, async () => {
    const { browser, page, problems } = await open(fresh(), vp);
    await page.waitForSelector("#spotBest .spot-info");
    for (const tab of ["overview", "catalog", "deals", "analytics", "favorites", "collector", "support"]) {
      await page.click(`#t-${tab}`);
      assert.equal(await page.isVisible(`#tab-${tab}`), true, tab);
      assert.equal(await page.getAttribute(`#t-${tab}`, "aria-selected"), "true");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tab}: horizontal overflow`);
    }
    await page.waitForTimeout(300);
    assert.deepEqual(problems, []);
    await browser.close();
  });
}

test("catalog: server pagination, debounced search, reset; XSS payload is text", async () => {
  const state = fresh();
  const { browser, page, problems } = await open(state, { width: 1280, height: 900 });
  await page.click("#t-catalog");
  await page.waitForSelector(".lot");
  assert.equal(await page.locator(".lot").count(), 24);
  assert.match(await page.textContent("#rowsCount"), /1–24 из 30/);
  assert.equal(await page.evaluate(() => window.__xss), undefined, "markup in a title must not execute");
  assert.match(await page.textContent(".lot .name"), /<img/);
  await page.click("#nextPage");
  await page.waitForFunction(() => /25–30 из 30/.test(document.getElementById("rowsCount").textContent));
  assert.equal(await page.locator(".lot").count(), 6);
  assert.equal(await page.isDisabled("#nextPage"), true);
  await page.fill("#q", "Подарок 7");
  await page.waitForFunction(() => /из 1\b/.test(document.getElementById("rowsCount").textContent));
  assert.ok(state.calls.some((c) => c.includes("q=%D0%9F%D0%BE%D0%B4%D0%B0%D1%80%D0%BE%D0%BA+7")));
  await page.click("#resetFilters");
  await page.waitForFunction(() => /1–24 из 30/.test(document.getElementById("rowsCount").textContent));
  assert.deepEqual(problems, []);
  await browser.close();
});

test("favorites: star persists in the browser and is listed with data from the server", async () => {
  const { browser, page } = await open(fresh(), { width: 1280, height: 900 });
  await page.click("#t-catalog"); await page.waitForSelector(".lot");
  await page.locator(".lot").nth(2).locator("[data-star]").click();
  await page.click("#t-favorites");
  await page.waitForSelector("#favs .gcard");
  assert.match(await page.textContent("#favs"), /Подарок 2/);
  await page.click("[data-unstar]");
  assert.match(await page.textContent("#favs"), /Пока пусто/);
  await browser.close();
});

test("empty database shows honest empty states, not fake numbers", async () => {
  const { browser, page } = await open(fresh({ empty: true }), { width: 1280, height: 900 });
  await page.waitForSelector("#spotLatest .empty");
  assert.match(await page.textContent("#spotLatest"), /Пока нет данных/);
  assert.match(await page.textContent("#spotBest"), /Пока нет данных/);
  await page.click("#t-catalog"); await page.waitForSelector("#lots .empty");
  await page.click("#t-analytics");
  await page.waitForSelector("#changes .li");
  assert.match(await page.textContent("#changes"), /Недостаточно данных/);
  assert.match(await page.textContent("#bins"), /Недостаточно данных/);
  await browser.close();
});

test("API failure shows an error with a working retry button", async () => {
  const state = fresh({ fail: "/api/catalog" });
  const { browser, page } = await open(state, { width: 1280, height: 900 });
  await page.click("#t-catalog");
  await page.waitForSelector("#lots [data-retry]");
  assert.match(await page.textContent("#lots"), /Не удалось загрузить каталог/);
  state.fail = null;
  await page.click("#lots [data-retry]");
  await page.waitForSelector(".lot");
  await browser.close();
});

test("block cooldown is shown as a Huevo-side restriction with the pause time", async () => {
  const { browser, page } = await open(fresh({ blocked: "2026-10-30T00:00:00+00:00" }), { width: 1280, height: 900 });
  await page.waitForFunction(() => /Пауза/.test(document.getElementById("statusText").textContent));
  assert.match(await page.textContent("#banner"), /HTTP 418/);
  assert.match(await page.textContent("#banner"), /не обходится/);
  await browser.close();
});

test("token dialog: cancel keeps the button usable and reports the reason", async () => {
  const { browser, page } = await open(fresh(), { width: 1280, height: 900 });
  await page.click("#refreshBtn");
  await page.waitForSelector("#tokenDialog[open]");
  await page.click("#tokenDialog button[value=cancel]");
  await page.waitForFunction(() => /Токен не введён/.test(document.getElementById("banner").textContent));
  assert.equal(await page.isDisabled("#refreshBtn"), false);
  await browser.close();
});

test("support: outside huEVO the payment buttons explain why they cannot pay", async () => {
  const { browser, page } = await open(fresh(), { width: 1280, height: 900 });
  await page.click("#t-support"); await page.waitForSelector("[data-amount]");
  await page.click("[data-amount='10']");
  assert.match(await page.textContent("#supportMsg"), /внутри huEVO/);
  await browser.close();
});
