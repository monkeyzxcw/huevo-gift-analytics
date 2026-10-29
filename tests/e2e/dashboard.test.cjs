// Static Cloudflare dashboard: real files served with the production CSP (_headers) and mocked data.json.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const SITE = path.resolve(__dirname, "../../cloudflare-site");
const CSP = fs.readFileSync(path.join(SITE, "_headers"), "utf8").match(/Content-Security-Policy: (.+)/)[1].trim();
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript" };
const XSS = '<img src=x onerror="window.__xss=1">';
const NOW = new Date().toISOString();

function makeLots(n) {
  return Array.from({ length: n }, (_, i) => ({
    lot_id: String(1000 + i), title: i === 0 ? XSS : i % 7 === 0 ? "Звезда" : "Подарок " + i, serial: "#" + i + " из 100",
    rarity: i % 2 ? "Редкий" : "Обычный", price: i === 5 ? null : 100 + i * 10, status: "На продаже",
    image_url: i === 1 ? "javascript:alert(1)" : "", lot_url: i === 2 ? "https://evil.example/x" : "https://huevo.su/market/lot/" + (1000 + i),
    first_seen: "2026-10-01T10:00:00+00:00", last_seen: NOW, active: true,
    history: i === 3 ? [{ observed_at: "2026-10-01T10:00:00+00:00", price: 200 }, { observed_at: "2026-10-10T10:00:00+00:00", price: 150 }, { observed_at: NOW, price: 130 }] : [{ observed_at: "2026-10-01T10:00:00+00:00", price: 100 + i * 10 }],
  }));
}
function dataV2(extra = {}) {
  const lots = makeLots(120);
  return {
    schema_version: 2, generated_at: NOW, source: "https://huevo.su", collector: { status: "ok", message: "ok", checked_at: NOW, pages: 3, lots: 120 },
    stats: { n_total: 120 }, lots, gone_lots: [],
    snapshots: [1, 2, 3].map((k) => ({ observed_at: new Date(Date.now() - (4 - k) * 86400e3).toISOString(), active_lots: 100 + k * 5, median_price: 500 + k * 20, priced: 100 })),
    price_bins: [{ from: 100, to: 500, count: 40, label: "a" }, { from: 500, to: 900, count: 50, label: "b" }, { from: 900, to: 1300, count: 29, label: "c" }],
    categories: [{ name: "Редкий", count: 60, median: 700 }, { name: "Обычный", count: 60, median: 600 }],
    top_expensive: lots.slice(-3).reverse(), deals: [], drops: [],
    changes: { since: NOW, counts: { new: 2, gone: 1, price_up: 1, price_down: 1, unchanged: 100 },
      new: [{ lot_id: "1", title: "Новинка", price: 999, rarity: "Редкий", lot_url: "https://huevo.su/market/lot/1" }],
      gone: [{ lot_id: "2", title: "Пропавший", price: 5, rarity: "Обычный", lot_url: "" }],
      price_changes: [{ lot_id: "3", title: "Подешевел", from: 200, to: 150, pct: -25, lot_url: "" }] },
    sales: null, ...extra,
  };
}

async function open(handler, viewport = { width: 1280, height: 900 }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("dialog", (d) => { problems.push("dialog: " + d.message()); d.dismiss(); });
  await ctx.route("https://huevo.su/**", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("http://site.test/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/api/support/config") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false, amounts: [5000, 10000, 25000, 50000, 100000], sdk_url: "https://huevo.su/static/js/huevo-apps-v1.js", origins: ["huevo.su", "huevo.departament.site"] }) });
    }
    if (u.pathname === "/api/support/stats") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false, supporters: 0, total: 0 }) });
    }
    if (u.pathname === "/data.json") return handler(route);
    const file = path.join(SITE, u.pathname === "/" ? "index.html" : u.pathname.slice(1));
    if (!file.startsWith(SITE) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, headers: { "content-type": TYPES[path.extname(file)] || "text/plain", "content-security-policy": CSP }, body: fs.readFileSync(file) });
  });
  await page.goto("http://site.test/");
  return { browser, page, problems };
}
const serve = (body, status = 200) => (route) => route.fulfill({ status, contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body) });

test("full v2 data: cards, charts, changes, top, table render with no errors", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  assert.match(await page.textContent("#cards"), /Активные лоты/);
  assert.equal(await page.locator("#cards .card").count(), 6);
  assert.ok(await page.locator("#chartBins svg rect").count() >= 3, "price distribution bars");
  assert.ok(await page.locator("#chartCount svg polyline").count() === 1, "lot-count dynamics line");
  assert.ok(await page.locator("#chartMedian svg polyline").count() === 1);
  assert.equal(await page.locator("#chartCats .hbar").count(), 2);
  await page.click('#mainNav [data-view="analytics"]');
  assert.match(await page.textContent("#changeList"), /Новинка/);
  await page.click("#tabGone"); assert.match(await page.textContent("#changeList"), /Пропавший/);
  await page.click("#tabPrice"); assert.match(await page.textContent("#changeList"), /200 → 150/);
  assert.equal(await page.locator("#topList li").count(), 3);
  await page.click('#mainNav [data-view="market"]');
  assert.equal(await page.locator("#rows tr").count(), 50, "first page only");
  assert.equal(await page.evaluate(() => window.__xss), undefined, "title markup must not execute");
  assert.equal(await page.locator("#salesPanel.hide").count(), 1, "no sales section without confirmed data");
  assert.deepEqual(problems, []);
  await browser.close();
});

test("search, filters, sort, pagination and reset work", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="market"]');
  await page.fill("#search", "звезда");
  assert.match(await page.textContent("#rowCount"), /Найдено лотов: 17 из 120/);
  await page.fill("#search", "");
  await page.selectOption("#rarity", "Редкий");
  assert.match(await page.textContent("#rowCount"), /60 из 120/);
  await page.fill("#pmin", "500"); await page.fill("#pmax", "600");
  const prices = await page.$$eval("#rows td.price", (t) => t.map((x) => parseInt(x.textContent.replace(/\D/g, ""))));
  assert.ok(prices.length > 0 && prices.every((p) => p >= 500 && p <= 600), "price range filter");
  await page.click("#reset");
  assert.match(await page.textContent("#rowCount"), /120 из 120/);
  await page.click(".sort[data-key=price]");           // already ascending -> descending
  assert.equal(await page.getAttribute("th:nth-child(2)", "aria-sort"), "descending");
  assert.match(await page.textContent("#rows tr:first-child td.price"), /1\s?290/);
  await page.click("#next");
  assert.match(await page.textContent("#pageInfo"), /Страница 2 из 3/);
  await page.fill("#search", "нет-такого-лота");
  assert.match(await page.textContent("#rows"), /лотов нет/);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("lot without a price sorts last and shows a dash, not zero", async () => {
  const { browser, page } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="market"]');
  await page.fill("#search", "1005");
  assert.equal((await page.textContent("#rows td.price")).trim(), "—");
  await browser.close();
});

test("detail dialog: price history, comparison, safe link, Escape closes", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="market"]');
  await page.fill("#search", "1003");
  await page.click("#rows button");
  assert.ok(await page.locator("#detail[open]").count());
  assert.equal(await page.locator("#dBody table.hist tr").count(), 3, "three history points");
  assert.ok(await page.locator("#dBody svg polyline").count());
  assert.match(await page.textContent("#dBody"), /не цена сделки/);
  assert.match(await page.textContent("#dBody"), /Недостаточно сопоставимых/);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#detail[open]").count(), 0);
  await page.fill("#search", "1002");                     // lot_url on a foreign host must be replaced
  await page.click("#rows button");
  assert.match(await page.getAttribute("#dBody a.btn", "href"), /^https:\/\/huevo\.su\/market\/lot\/1002$/);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("old v1 data.json still renders; missing sections show honest placeholders", async () => {
  const v1 = dataV2(); ["schema_version", "categories", "top_expensive", "changes", "sales"].forEach((k) => delete v1[k]); v1.schema_version = 1;
  const { browser, page, problems } = await open(serve(v1));
  await page.waitForSelector("#content:not(.hide)");
  assert.equal(await page.locator("#chartCats .hbar").count(), 2, "categories computed from lots");
  assert.equal(await page.locator("#topList li").count(), 10);
  assert.match(await page.textContent("#changeList"), /появится после следующего/);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("empty and partial JSON show an empty state, never fake zeros", async () => {
  for (const body of [{}, { lots: [], collector: { status: "no_cards", message: "каталог пуст" } }, []]) {
    const { browser, page, problems } = await open(serve(body));
    await page.waitForSelector("#empty:not(.hide)");
    assert.equal(await page.locator("#content:not(.hide)").count(), 0);
    assert.deepEqual(problems, []);
    await browser.close();
  }
});

test("load failure shows an error with a working retry", async () => {
  let fail = true;
  const { browser, page } = await open((route) => fail ? route.fulfill({ status: 500, body: "x" }) : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dataV2()) }));
  await page.waitForSelector("#error:not(.hide)");
  assert.match(await page.textContent("#errorText"), /HTTP 500/);
  fail = false; await page.click("#retry");
  await page.waitForSelector("#content:not(.hide)");
  await browser.close();
});

test("blocked collector and stale data are announced while the last good snapshot stays visible", async () => {
  const old = new Date(Date.now() - 40 * 3600e3).toISOString();
  const { browser, page } = await open(serve(dataV2({ generated_at: old, collector: { status: "blocked", message: "HTTP 418", checked_at: NOW, blocked_until: new Date(Date.now() + 6 * 3600e3).toISOString() } })));
  await page.waitForSelector("#content:not(.hide)");
  const note = await page.textContent("#notice");
  assert.match(note, /больше 24 ч/); assert.match(note, /HTTP 418/); assert.match(note, /Пауза до/);
  assert.match(await page.textContent("#stateText"), /на паузе/);
  assert.equal(await page.locator("#rows tr").count(), 50);
  await browser.close();
});

test("sales section appears only with confirmed data", async () => {
  const sales = { summary: { count: 12, unknown: 1, min: 100, max: 900, median: 300, enough_data: true, note: "Прошлые сделки, а не объявления" } };
  const { browser, page } = await open(serve(dataV2({ sales })));
  await page.waitForSelector("#content:not(.hide)");
  assert.equal(await page.locator("#salesPanel:not(.hide)").count(), 1);
  assert.match(await page.textContent("#salesBody"), /Медианная цена продажи/);
  await browser.close();
});

test("page has no inline handlers/styles and fits a phone screen", async () => {
  const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  assert.equal(/\son[a-z]+=|\sstyle=/i.test(html), false, "no inline handlers or style attributes");
  const { browser, page, problems } = await open(serve(dataV2()), { width: 375, height: 800 });
  await page.waitForSelector("#content:not(.hide)");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no page-level horizontal scroll");
  assert.deepEqual(problems, []);
  await browser.close();
});


test("AMNYAM navigation renders all views and author support shows five levels", async () => {
  const { browser, page, problems } = await open(serve(dataV2()), { width: 1280, height: 900 });
  await page.waitForSelector("#content:not(.hide)");
  for (const view of ["overview", "market", "deals", "cheap", "analytics", "favorites", "support"]) {
    await page.click('#mainNav [data-view="' + view + '"]');
    assert.equal(await page.getAttribute('#mainNav [data-view="' + view + '"]', "aria-selected"), "true", view + " tab selected");
    assert.equal(await page.locator('[data-view-section="' + view + '"]:not(.hide)').count() > 0, true, view + " view visible");
  }
  assert.equal(await page.locator("#supportAmounts [data-amount]").count(), 5);
  assert.deepEqual(await page.locator("#supportAmounts [data-amount]").evaluateAll(nodes => nodes.map(n => n.dataset.amount)), ["5000", "10000", "25000", "50000", "100000"]);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("value hunt compares similar gifts; smart search supports price, rarity and lot ID operators", async () => {
  const data = dataV2();
  data.lots.forEach((lot, index) => {
    if (index % 7 === 0) {
      lot.title = "Звезда";
      lot.rarity = "Редкий";
    }
  });
  const { browser, page, problems } = await open(serve(data), { width: 1280, height: 900 });
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="deals"]');
  assert.match(await page.textContent("#belowBest"), /Звезда/);
  assert.match(await page.textContent("#belowBestMeta"), /медианы/);
  assert.ok(await page.locator("#dealsList .deal-row").count() > 0);
  await page.click('#mainNav [data-view="market"]');
  await page.fill("#search", "price<200");
  assert.match(await page.textContent("#rowCount"), /9 из 120/);
  await page.fill("#search", "rarity:Редкий price<200");
  assert.match(await page.textContent("#rowCount"), /4 из 120/);
  await page.fill("#search", "#1007");
  assert.match(await page.textContent("#rowCount"), /1 из 120/);
  assert.match(await page.textContent("#rows"), /Звезда/);
  assert.deepEqual(problems, []);
  await browser.close();
});
