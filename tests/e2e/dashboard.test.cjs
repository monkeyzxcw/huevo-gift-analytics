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
const OPEN_BROWSERS = new Set();

test.afterEach(async () => {
  // Ensure a failed assertion cannot leave Chromium alive and hang the CI job.
  for (const browser of OPEN_BROWSERS) {
    try { if (browser.isConnected()) await browser.close(); } catch (_) {}
  }
  OPEN_BROWSERS.clear();
});

function makeLots(n) {
  return Array.from({ length: n }, (_, i) => ({
    lot_id: String(1000 + i), title: i === 0 ? XSS : i % 7 === 0 ? "Звезда" : "Подарок " + i, serial: "#" + i + " из 100",
    rarity: i % 2 ? "Редкий" : "Обычный", price: i === 5 ? null : 100 + i * 10, status: "На продаже",
    image_url: i === 1 ? "javascript:alert(1)" : i < 25 ? "https://huevo.su/static/gift.webp" : "", lot_url: i === 2 ? "https://evil.example/x" : "https://huevo.su/market/lot/" + (1000 + i),
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
  OPEN_BROWSERS.add(browser);
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
    if (u.pathname === "/api/me") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        ok: true, authenticated: false, profiles_ready: true, user: null, profile: {}, updated_at: null
      }) });
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
  await page.selectOption("#sortBy", "lot_count:-1");
  assert.match(await page.textContent("#rows tr:first-child td:first-child"), /Звезда/);
  assert.equal((await page.textContent("#rows tr:first-child td:nth-child(3) .count-pill")).trim(), "9");
  await page.selectOption("#sortBy", "price:1");
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

test("gift grouping shows min, median, max and drills into matching lots", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="market"]');
  await page.click('[data-catalog-mode="gifts"]');
  assert.ok(await page.locator("#groupsRows tr").count()>0);
  const starGroup=page.locator("#groupsRows tr").filter({hasText:"Звезда"}).first();
  assert.ok(await starGroup.count());
  assert.equal(await starGroup.locator("td").count(),7);
  await starGroup.locator("[data-group-open]").click();
  assert.equal(await page.locator("#groupsMode.hide").count(),1);
  assert.match(await page.locator("#search").inputValue(),/Звезда/);
  assert.match(await page.textContent("#rowCount"),/Найдено лотов:/);
  assert.deepEqual(problems,[]);
  await browser.close();
});

test("saved filters, target prices, mini charts and comparison work", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="market"]');
  await page.fill("#search","звезда");
  await page.fill("#presetName","Звёзды");
  await page.click("#savePreset");
  assert.match(await page.textContent("#presetStatus"),/сохранён/);
  await page.click("#reset");
  await page.selectOption("#savedFilterSelect","0");
  await page.click("#applyPreset");
  assert.match(await page.textContent("#rowCount"),/17 из 120/);

  await page.fill("#search","1003");
  assert.equal(await page.locator("#rows .sparkline").count(),1);
  await page.locator("#rows button[aria-label^='Подробнее о лоте']").click();
  await page.fill("#dBody .target-input","120");
  await page.click("#dBody button:has-text('Сохранить цену-цель')");
  assert.match(await page.textContent("#dBody"),/Цена-цель сохранена/);
  await page.keyboard.press("Escape");
  await page.fill("#search","1002");
  await page.locator("#rows input[data-compare-id]").check();
  await page.fill("#search","1003");
  await page.locator("#rows input[data-compare-id]").check();
  assert.equal(await page.locator("#compareSelected").isEnabled(),true);
  await page.click("#compareSelected");
  assert.ok(await page.locator("#compareDialog[open]").count());
  assert.match(await page.textContent("#compareBody"),/Целевая цена/);
  assert.deepEqual(problems,[]);
  await browser.close();
});

test("below-market cards show price evidence, quick target controls, and three daily picks", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="overview"]');
  assert.equal(await page.locator("#dayPicks .day-pick-card").count(),3,"three distinct daily picks");
  await page.click('#mainNav [data-view="deals"]');
  assert.ok(await page.locator("#dealsList .deal-card-rich").count()>0,"value signals rendered as rich cards");
  const card=page.locator("#dealsList .deal-card-rich").first();
  assert.match(await card.textContent(),/ЦЕНА ЛОТА/);
  assert.match(await card.textContent(),/МЕДИАНА ОБЪЯВЛЕНИЙ/);
  assert.match(await card.textContent(),/РАЗНИЦА/);
  await card.locator(".deal-target-input").fill("50");
  await card.locator(".target-save").click();
  assert.ok(await page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem("amnyam.targets")||"{}")).length>0),"target price persists in browser");
  assert.match(await page.textContent("#favoritesCount"),/лотов/);
  await page.selectOption("#dealSort","price");
  assert.deepEqual(problems,[]);
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
  assert.match(await page.textContent("#dBody"), /Недостаточно данных/);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#detail[open]").count(), 0);
  await page.fill("#search", "1002");                     // lot_url on a foreign host must be replaced
  await page.click("#rows button");
  assert.match(await page.getAttribute("#dBody a.btn", "href"), /^https:\/\/huevo\.su\/market\/lot\/1002$/);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("gift instance metadata and history feed render in the detail and catalog changes panels", async () => {
  const data = dataV2();
  data.lots[3].gift_details = {
    gift_id: "18336", gift_url: "https://huevo.su/gift/18336",
    checked_at: NOW, attributes: {}
  };
  data.lots[3].gift_instance = {
    gift_id: "18336", gift_url: "https://huevo.su/gift/18336",
    title: "Адидас-Тян Зеленая", serial: 4, supply: 111,
    rarity: "Лимитированный", drop_price: 5555, drop_price_text: "5555 монэток",
    edition_sold_out: true, author: "hhiૐvi buritania XVII",
    collection: "ADIDAS-Тян", current_owner: "monkeyzxcw",
    history_found: true, checked_at: NOW,
    history: [
      { event_id: "event-1", type: "purchase", label: "Куплен", from_user: "monkeyzxcw", to_user: "monkeyzxcw", time_raw: "22 окт в 03:35" },
      { event_id: "event-2", type: "market_sale", label: "Продан в Маркете", from_user: "monkeyzxcw", to_user: "teeth", time_raw: "28 окт в 21:37" },
      { event_id: "event-3", type: "transfer", label: "Передан", from_user: "teeth", to_user: "monkeyzxcw", time_raw: "вчера в 00:18" }
    ]
  };
  data.gone_lots = [{
    lot_id: "2000", title: "Золотая роза", price: 400, rarity: "Редкий",
    lot_url: "https://huevo.su/market/lot/2000", active: false,
    disappearance_status: "delisted",
    gift_instance: { serial: 111, supply: 111 }
  }];
  data.changes.gone = data.gone_lots;
  data.catalog_events = [{
    event_id: "history:18336:event-2", type: "market_sale",
    label: "Продан в Маркете", title: "Адидас-Тян Зеленая",
    lot_id: "1003", gift_id: "18336", serial: "№ 4/111",
    from_user: "monkeyzxcw", to_user: "teeth",
    time_raw: "28 окт в 21:37", observed_at: NOW,
    gift_url: "https://huevo.su/gift/18336",
    lot_url: "https://huevo.su/market/lot/1003"
  }];

  const { browser, page, problems } = await open(serve(data));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="market"]');
  await page.fill("#search", "1003");
  await page.click("#rows button");
  const detail = await page.textContent("#dBody");
  assert.match(detail, /№ 4/);
  assert.match(detail, /111/);
  assert.ok(detail.replace(/\s/g, "").includes("5555"), "grouped drop price must still be checked");
  assert.match(detail, /Продан в Маркете/);
  assert.match(detail, /teeth/);
  assert.match(detail, /не содержит сумму каждой сделки/);
  await page.keyboard.press("Escape");

  await page.click('#mainNav [data-view="analytics"]');
  await page.click("#tabGone");
  assert.match(await page.textContent("#changeList"), /Вероятно снят продавцом/);
  await page.click("#tabEvents");
  const events = await page.textContent("#changeList");
  assert.match(events, /Продан в Маркете/);
  assert.match(events, /monkeyzxcw → teeth/);
  assert.match(events, /28 окт в 21:37/);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("old v1 data.json still renders; missing sections show honest placeholders", async () => {
  const v1 = dataV2(); ["schema_version", "categories", "top_expensive", "changes", "sales"].forEach((k) => delete v1[k]); v1.schema_version = 1;
  const { browser, page, problems } = await open(serve(v1));
  await page.waitForSelector("#content:not(.hide)");
  assert.equal(await page.locator("#chartCats .hbar").count(), 2, "categories computed from lots");
  assert.equal(await page.locator("#topList li").count(), 10);
  assert.match(await page.textContent("#changeList"), /Список новых лотов отсутствует|Пока нет данных для сравнения/);
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
    assert.equal(await page.locator('[data-view-section="' + view + '"]:not(.view-hidden)').count() > 0, true, view + " view visible");
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
  assert.match(await page.textContent("#rowCount"), /5 из 120/);
  await page.fill("#search", "#1007");
  assert.match(await page.textContent("#rowCount"), /1 из 120/);
  assert.match(await page.textContent("#rows"), /Звезда/);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("appearance settings switch themes, mascot and motion and persist locally", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  assert.equal(await page.locator(".mascot-dock").count(), 1, "decorative mascot is present");
  await page.click('#mainNav [data-view="appearance"]');
  assert.equal(await page.locator('#appearancePanel:not(.view-hidden)').count(), 1);
  await page.selectOption("#appearanceBackground", "liquid");
  await page.selectOption("#appearanceMascot", "none");
  await page.selectOption("#appearanceMotion", "off");
  await page.locator("#appearanceGlass").uncheck();
  assert.equal(await page.locator("body").getAttribute("data-bg"), "liquid");
  assert.equal(await page.locator("body").getAttribute("data-mascot"), "none");
  assert.equal(await page.locator("body").getAttribute("data-motion"), "off");
  assert.ok(await page.locator("body.glass-off").count());
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("amnyam.appearance.v1")));
  assert.deepEqual(saved, { background: "liquid", mascot: "none", motion: "off", glass: false });
  await page.click("#resetAppearance");
  assert.equal(await page.locator("body").getAttribute("data-bg"), "cosmic");
  assert.equal(await page.locator("body").getAttribute("data-mascot"), "omnom");
  assert.deepEqual(problems, []);
  await browser.close();
});


test("AMNYAM atmosphere: daily picks wrap, seasonal themes persist, and mascot celebrates confirmed purchases", async () => {
  const { browser, page, problems } = await open(serve(dataV2()), { width: 390, height: 844 });
  await page.waitForSelector("#content:not(.hide)");
  await page.waitForTimeout(760);
  const cards = page.locator("#dayPicks .day-pick-card");
  assert.equal(await cards.count(), 3);
  const layout = await cards.first().evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const title = el.querySelector(".t").getBoundingClientRect();
    const actions = el.querySelector(".deal-actions").getBoundingClientRect();
    return { width: rect.width, titleRight: title.right, cardRight: rect.right, actionsRight: actions.right };
  });
  assert.ok(layout.width > 0 && layout.titleRight <= layout.cardRight + 1, "long title stays inside its card");
  assert.ok(layout.actionsRight <= layout.cardRight + 1, "action controls stay inside their card");
  const heroTitle = await page.locator("#heroTitle").boundingBox();
  await page.mouse.move(heroTitle.x + heroTitle.width / 2, heroTitle.y + heroTitle.height / 2);
  assert.ok((await page.locator("body").getAttribute("class") || "").includes("cursor-glow-active"), "cursor glow appears over decoration");
  const buyButton = await page.locator("#dayPicks .purchase-confirm").first().boundingBox();
  await page.mouse.move(buyButton.x + buyButton.width / 2, buyButton.y + buyButton.height / 2);
  assert.ok(!(await page.locator("body").getAttribute("class") || "").includes("cursor-glow-active"), "cursor glow stays off interactive purchase controls");
  await page.selectOption("#seasonTheme", "halloween");
  assert.equal(await page.locator("body").getAttribute("data-season"), "halloween");
  await page.reload();
  await page.waitForSelector("#content:not(.hide)");
  assert.equal(await page.locator("body").getAttribute("data-season"), "halloween", "season theme persists");
  await page.locator("#dayPicks .purchase-confirm").first().click();
  assert.equal(await page.locator("#amnyamMascot").getAttribute("data-mood"), "happy");
  assert.match(await page.textContent("#mascotSpeech"), /Лот куплен/);
  assert.deepEqual(problems, []);
  await browser.close();
});


test("catalog changes panel handles partial payloads and falls back to gone lots and price history", async () => {
  const data = dataV2();
  delete data.changes;
  data.gone_lots = [{ lot_id: "gone-42", title: "Снятый лот", price: 420, rarity: "Редкий" }];
  data.lots[0].history = [
    { observed_at: "2026-10-29T10:00:00Z", price: 100 },
    { observed_at: "2026-10-29T11:00:00Z", price: 125 }
  ];
  const { browser, page, problems } = await open(serve(data));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="analytics"]');
  assert.match(await page.textContent("#changeList"), /Список новых лотов отсутствует|Пока нет данных|Новых лотов/);
  await page.click("#tabGone");
  assert.match(await page.textContent("#changeList"), /Снятый лот/);
  await page.click("#tabPrice");
  assert.match(await page.textContent("#changeList"), /100.*125|100 → 125/);
  assert.deepEqual(problems, []);
  await browser.close();
});


test("sale benchmarks beat inflated asking prices and split offer clusters are suppressed", async () => {
  const lots = Array.from({ length: 13 }, (_, i) => ({
    lot_id: String(7000 + i), title: "Топор", serial: "#" + (i + 1), rarity: "Редкий",
    price: i < 3 ? 80000 : 1000000, status: "На продаже",
    image_url: i < 3 ? "https://huevo.su/static/axe.webp" : "",
    lot_url: "https://huevo.su/market/lot/" + (7000 + i), first_seen: NOW, last_seen: NOW,
    active: true, history: [{ observed_at: NOW, price: i < 3 ? 80000 : 1000000 }]
  }));
  const { browser, page, problems } = await open(serve(dataV2({ lots, sales: null })));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="deals"]');
  assert.equal(await page.locator("#dealsList .deal-card-rich").count(), 0,
    "three low offers versus ten 1m offers form two price clusters, not a trustworthy market median");
  assert.match(await page.textContent("#dealsNote"), /устойчивой группы/);
  await browser.close();

  const profile = {
    title: "топор", count: 20, median: 100000, p25: 95000, p75: 110000,
    min: 80000, max: 130000, dated_sales: 4,
    history: [
      { date: "2026-10-27", median: 98000, count: 2 },
      { date: "2026-10-28", median: 102000, count: 2 }
    ]
  };
  const sales = { generated_at: NOW, summary: { count: 20, unknown: 0, median: 100000, min: 80000, max: 130000, enough_data: true }, by_title: [profile] };
  const second = await open(serve(dataV2({ lots, sales })));
  await second.page.waitForSelector("#content:not(.hide)");
  await second.page.click('#mainNav [data-view="deals"]');
  assert.equal(await second.page.locator("#dealsList .deal-card-rich").count(), 3,
    "only the three genuinely cheap asks are compared to confirmed sales");
  assert.match(await second.page.locator("#dealsList .deal-card-rich").first().textContent(), /МЕДИАНА ПРОДАЖ/);
  assert.match(await second.page.locator("#dealsList .deal-card-rich").first().textContent(), /СОВЕРШЁННЫЕ ПРОДАЖИ/);
  await second.page.click('#mainNav [data-view="analytics"]');
  assert.ok(await second.page.locator("#salesPanel:not(.hide)").count());
  assert.ok(await second.page.locator("#giftSalesSelect option").count() === 1);
  assert.ok(await second.page.locator("#giftSalesProfile svg polyline").count() === 1,
    "dated confirmed transactions produce a gift-level median price graph");
  assert.deepEqual(second.problems, []);
  await second.browser.close();
});

test("daily-pick gift art stays beside the title at desktop and mobile widths", async () => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const { browser, page, problems } = await open(serve(dataV2()), viewport);
    await page.waitForSelector("#content:not(.hide)");
    await page.click('#mainNav [data-view="overview"]');
    assert.equal(await page.locator("#dayPicks .day-pick-card").count(), 3);
    const cards = page.locator("#dayPicks .day-pick-card");
    for (let i = 0; i < await cards.count(); i++) {
      const card = cards.nth(i);
      const image = await card.locator(".thumb").boundingBox();
      const title = await card.locator(".t").boundingBox();
      assert.ok(image && title, "each card has image and title boxes");
      assert.ok(image.x + image.width <= title.x + 1, "gift art must not overlap or cover the title");
      assert.ok(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "card has no internal horizontal overflow");
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    assert.deepEqual(problems, []);
    await browser.close();
  }
});

test("target price sound is opt-in and persists locally", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="favorites"]');
  assert.equal(await page.getAttribute("#toggleAlertSound", "aria-pressed"), "false");
  await page.click("#toggleAlertSound");
  assert.equal(await page.getAttribute("#toggleAlertSound", "aria-pressed"), "true");
  assert.equal(await page.evaluate(() => localStorage.getItem("amnyam.alertSound.v1")), "on");
  await page.click("#testAlertSound");
  assert.deepEqual(problems, []);
  await browser.close();
});


test("malformed snapshot is rejected and retry recovers without showing a false empty market", async () => {
  let calls = 0;
  const { browser, page, problems } = await open((route) => {
    calls += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(calls === 1 ? { schema_version: 3, lots: "not-an-array" } : dataV2())
    });
  });
  await page.waitForSelector("#error:not(.hide)");
  assert.match(await page.textContent("#errorText"), /список lots/);
  assert.equal(await page.locator("#empty:not(.hide)").count(), 0, "malformed data is not a genuine empty-market response");
  await page.click("#retry");
  await page.waitForSelector("#content:not(.hide)");
  assert.equal(await page.locator("#rows tr").count(), 50);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("target prices reject fractional and unsafe values but blank input clears a target", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="market"]');
  await page.fill("#search", "1003");
  await page.click("#rows button[aria-label^='Подробнее о лоте']");
  await page.fill("#dBody .target-input", "12.5");
  await page.click("#dBody button:has-text('Сохранить цену-цель')");
  assert.match(await page.textContent("#watchAlertText"), /целую целевую цену/);
  assert.equal(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("amnyam.targets") || "{}")).length), 0);
  await page.click("#closeWatchAlert");
  await page.fill("#dBody .target-input", "1000000000000001");
  await page.click("#dBody button:has-text('Сохранить цену-цель')");
  assert.match(await page.textContent("#watchAlertText"), /целую целевую цену/);
  await page.click("#closeWatchAlert");
  await page.fill("#dBody .target-input", "1000");
  await page.click("#dBody button:has-text('Сохранить цену-цель')");
  assert.equal(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("amnyam.targets") || "{}")).every(Number.isSafeInteger)), true);
  await page.click("#closeWatchAlert");
  await page.fill("#dBody .target-input", "");
  await page.click("#dBody button:has-text('Сохранить цену-цель')");
  assert.equal(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("amnyam.targets") || "{}")).length), 0);
  assert.deepEqual(problems, []);
  await browser.close();
});Static Cloudflare dashboard: real files served with the production CSP (_headers) and mocked data.json.
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
const OPEN_BROWSERS = new Set();

test.afterEach(async () => {
  // Ensure a failed assertion cannot leave Chromium alive and hang the CI job.
  for (const browser of OPEN_BROWSERS) {
    try { if (browser.isConnected()) await browser.close(); } catch (_) {}
  }
  OPEN_BROWSERS.clear();
});

function makeLots(n) {
  return Array.from({ length: n }, (_, i) => ({
    lot_id: String(1000 + i), title: i === 0 ? XSS : i % 7 === 0 ? "Звезда" : "Подарок " + i, serial: "#" + i + " из 100",
    rarity: i % 2 ? "Редкий" : "Обычный", price: i === 5 ? null : 100 + i * 10, status: "На продаже",
    image_url: i === 1 ? "javascript:alert(1)" : i < 25 ? "https://huevo.su/static/gift.webp" : "", lot_url: i === 2 ? "https://evil.example/x" : "https://huevo.su/market/lot/" + (1000 + i),
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
  OPEN_BROWSERS.add(browser);
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
    if (u.pathname === "/api/me") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        ok: true, authenticated: false, profiles_ready: true, user: null, profile: {}, updated_at: null
      }) });
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
  await page.selectOption("#sortBy", "lot_count:-1");
  assert.match(await page.textContent("#rows tr:first-child td:first-child"), /Звезда/);
  assert.equal((await page.textContent("#rows tr:first-child td:nth-child(3) .count-pill")).trim(), "9");
  await page.selectOption("#sortBy", "price:1");
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

test("gift grouping shows min, median, max and drills into matching lots", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="market"]');
  await page.click('[data-catalog-mode="gifts"]');
  assert.ok(await page.locator("#groupsRows tr").count()>0);
  const starGroup=page.locator("#groupsRows tr").filter({hasText:"Звезда"}).first();
  assert.ok(await starGroup.count());
  assert.equal(await starGroup.locator("td").count(),7);
  await starGroup.locator("[data-group-open]").click();
  assert.equal(await page.locator("#groupsMode.hide").count(),1);
  assert.match(await page.locator("#search").inputValue(),/Звезда/);
  assert.match(await page.textContent("#rowCount"),/Найдено лотов:/);
  assert.deepEqual(problems,[]);
  await browser.close();
});

test("saved filters, target prices, mini charts and comparison work", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="market"]');
  await page.fill("#search","звезда");
  await page.fill("#presetName","Звёзды");
  await page.click("#savePreset");
  assert.match(await page.textContent("#presetStatus"),/сохранён/);
  await page.click("#reset");
  await page.selectOption("#savedFilterSelect","0");
  await page.click("#applyPreset");
  assert.match(await page.textContent("#rowCount"),/17 из 120/);

  await page.fill("#search","1003");
  assert.equal(await page.locator("#rows .sparkline").count(),1);
  await page.locator("#rows button[aria-label^='Подробнее о лоте']").click();
  await page.fill("#dBody .target-input","120");
  await page.click("#dBody button:has-text('Сохранить цену-цель')");
  assert.match(await page.textContent("#dBody"),/Цена-цель сохранена/);
  await page.keyboard.press("Escape");
  await page.fill("#search","1002");
  await page.locator("#rows input[data-compare-id]").check();
  await page.fill("#search","1003");
  await page.locator("#rows input[data-compare-id]").check();
  assert.equal(await page.locator("#compareSelected").isEnabled(),true);
  await page.click("#compareSelected");
  assert.ok(await page.locator("#compareDialog[open]").count());
  assert.match(await page.textContent("#compareBody"),/Целевая цена/);
  assert.deepEqual(problems,[]);
  await browser.close();
});

test("below-market cards show price evidence, quick target controls, and three daily picks", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="overview"]');
  assert.equal(await page.locator("#dayPicks .day-pick-card").count(),3,"three distinct daily picks");
  await page.click('#mainNav [data-view="deals"]');
  assert.ok(await page.locator("#dealsList .deal-card-rich").count()>0,"value signals rendered as rich cards");
  const card=page.locator("#dealsList .deal-card-rich").first();
  assert.match(await card.textContent(),/ЦЕНА ЛОТА/);
  assert.match(await card.textContent(),/МЕДИАНА ОБЪЯВЛЕНИЙ/);
  assert.match(await card.textContent(),/РАЗНИЦА/);
  await card.locator(".deal-target-input").fill("50");
  await card.locator(".target-save").click();
  assert.ok(await page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem("amnyam.targets")||"{}")).length>0),"target price persists in browser");
  assert.match(await page.textContent("#favoritesCount"),/лотов/);
  await page.selectOption("#dealSort","price");
  assert.deepEqual(problems,[]);
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
  assert.match(await page.textContent("#dBody"), /Недостаточно данных/);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#detail[open]").count(), 0);
  await page.fill("#search", "1002");                     // lot_url on a foreign host must be replaced
  await page.click("#rows button");
  assert.match(await page.getAttribute("#dBody a.btn", "href"), /^https:\/\/huevo\.su\/market\/lot\/1002$/);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("gift instance metadata and history feed render in the detail and catalog changes panels", async () => {
  const data = dataV2();
  data.lots[3].gift_details = {
    gift_id: "18336", gift_url: "https://huevo.su/gift/18336",
    checked_at: NOW, attributes: {}
  };
  data.lots[3].gift_instance = {
    gift_id: "18336", gift_url: "https://huevo.su/gift/18336",
    title: "Адидас-Тян Зеленая", serial: 4, supply: 111,
    rarity: "Лимитированный", drop_price: 5555, drop_price_text: "5555 монэток",
    edition_sold_out: true, author: "hhiૐvi buritania XVII",
    collection: "ADIDAS-Тян", current_owner: "monkeyzxcw",
    history_found: true, checked_at: NOW,
    history: [
      { event_id: "event-1", type: "purchase", label: "Куплен", from_user: "monkeyzxcw", to_user: "monkeyzxcw", time_raw: "22 окт в 03:35" },
      { event_id: "event-2", type: "market_sale", label: "Продан в Маркете", from_user: "monkeyzxcw", to_user: "teeth", time_raw: "28 окт в 21:37" },
      { event_id: "event-3", type: "transfer", label: "Передан", from_user: "teeth", to_user: "monkeyzxcw", time_raw: "вчера в 00:18" }
    ]
  };
  data.gone_lots = [{
    lot_id: "2000", title: "Золотая роза", price: 400, rarity: "Редкий",
    lot_url: "https://huevo.su/market/lot/2000", active: false,
    disappearance_status: "delisted",
    gift_instance: { serial: 111, supply: 111 }
  }];
  data.changes.gone = data.gone_lots;
  data.catalog_events = [{
    event_id: "history:18336:event-2", type: "market_sale",
    label: "Продан в Маркете", title: "Адидас-Тян Зеленая",
    lot_id: "1003", gift_id: "18336", serial: "№ 4/111",
    from_user: "monkeyzxcw", to_user: "teeth",
    time_raw: "28 окт в 21:37", observed_at: NOW,
    gift_url: "https://huevo.su/gift/18336",
    lot_url: "https://huevo.su/market/lot/1003"
  }];

  const { browser, page, problems } = await open(serve(data));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="market"]');
  await page.fill("#search", "1003");
  await page.click("#rows button");
  const detail = await page.textContent("#dBody");
  assert.match(detail, /№ 4/);
  assert.match(detail, /111/);
  assert.ok(detail.replace(/\s/g, "").includes("5555"), "grouped drop price must still be checked");
  assert.match(detail, /Продан в Маркете/);
  assert.match(detail, /teeth/);
  assert.match(detail, /не содержит сумму каждой сделки/);
  await page.keyboard.press("Escape");

  await page.click('#mainNav [data-view="analytics"]');
  await page.click("#tabGone");
  assert.match(await page.textContent("#changeList"), /Вероятно снят продавцом/);
  await page.click("#tabEvents");
  const events = await page.textContent("#changeList");
  assert.match(events, /Продан в Маркете/);
  assert.match(events, /monkeyzxcw → teeth/);
  assert.match(events, /28 окт в 21:37/);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("old v1 data.json still renders; missing sections show honest placeholders", async () => {
  const v1 = dataV2(); ["schema_version", "categories", "top_expensive", "changes", "sales"].forEach((k) => delete v1[k]); v1.schema_version = 1;
  const { browser, page, problems } = await open(serve(v1));
  await page.waitForSelector("#content:not(.hide)");
  assert.equal(await page.locator("#chartCats .hbar").count(), 2, "categories computed from lots");
  assert.equal(await page.locator("#topList li").count(), 10);
  assert.match(await page.textContent("#changeList"), /Список новых лотов отсутствует|Пока нет данных для сравнения/);
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
    assert.equal(await page.locator('[data-view-section="' + view + '"]:not(.view-hidden)').count() > 0, true, view + " view visible");
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
  assert.match(await page.textContent("#rowCount"), /5 из 120/);
  await page.fill("#search", "#1007");
  assert.match(await page.textContent("#rowCount"), /1 из 120/);
  assert.match(await page.textContent("#rows"), /Звезда/);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("appearance settings switch themes, mascot and motion and persist locally", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  assert.equal(await page.locator(".mascot-dock").count(), 1, "decorative mascot is present");
  await page.click('#mainNav [data-view="appearance"]');
  assert.equal(await page.locator('#appearancePanel:not(.view-hidden)').count(), 1);
  await page.selectOption("#appearanceBackground", "liquid");
  await page.selectOption("#appearanceMascot", "none");
  await page.selectOption("#appearanceMotion", "off");
  await page.locator("#appearanceGlass").uncheck();
  assert.equal(await page.locator("body").getAttribute("data-bg"), "liquid");
  assert.equal(await page.locator("body").getAttribute("data-mascot"), "none");
  assert.equal(await page.locator("body").getAttribute("data-motion"), "off");
  assert.ok(await page.locator("body.glass-off").count());
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("amnyam.appearance.v1")));
  assert.deepEqual(saved, { background: "liquid", mascot: "none", motion: "off", glass: false });
  await page.click("#resetAppearance");
  assert.equal(await page.locator("body").getAttribute("data-bg"), "cosmic");
  assert.equal(await page.locator("body").getAttribute("data-mascot"), "omnom");
  assert.deepEqual(problems, []);
  await browser.close();
});


test("AMNYAM atmosphere: daily picks wrap, seasonal themes persist, and mascot celebrates confirmed purchases", async () => {
  const { browser, page, problems } = await open(serve(dataV2()), { width: 390, height: 844 });
  await page.waitForSelector("#content:not(.hide)");
  await page.waitForTimeout(760);
  const cards = page.locator("#dayPicks .day-pick-card");
  assert.equal(await cards.count(), 3);
  const layout = await cards.first().evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const title = el.querySelector(".t").getBoundingClientRect();
    const actions = el.querySelector(".deal-actions").getBoundingClientRect();
    return { width: rect.width, titleRight: title.right, cardRight: rect.right, actionsRight: actions.right };
  });
  assert.ok(layout.width > 0 && layout.titleRight <= layout.cardRight + 1, "long title stays inside its card");
  assert.ok(layout.actionsRight <= layout.cardRight + 1, "action controls stay inside their card");
  const heroTitle = await page.locator("#heroTitle").boundingBox();
  await page.mouse.move(heroTitle.x + heroTitle.width / 2, heroTitle.y + heroTitle.height / 2);
  assert.ok((await page.locator("body").getAttribute("class") || "").includes("cursor-glow-active"), "cursor glow appears over decoration");
  const buyButton = await page.locator("#dayPicks .purchase-confirm").first().boundingBox();
  await page.mouse.move(buyButton.x + buyButton.width / 2, buyButton.y + buyButton.height / 2);
  assert.ok(!(await page.locator("body").getAttribute("class") || "").includes("cursor-glow-active"), "cursor glow stays off interactive purchase controls");
  await page.selectOption("#seasonTheme", "halloween");
  assert.equal(await page.locator("body").getAttribute("data-season"), "halloween");
  await page.reload();
  await page.waitForSelector("#content:not(.hide)");
  assert.equal(await page.locator("body").getAttribute("data-season"), "halloween", "season theme persists");
  await page.locator("#dayPicks .purchase-confirm").first().click();
  assert.equal(await page.locator("#amnyamMascot").getAttribute("data-mood"), "happy");
  assert.match(await page.textContent("#mascotSpeech"), /Лот куплен/);
  assert.deepEqual(problems, []);
  await browser.close();
});


test("catalog changes panel handles partial payloads and falls back to gone lots and price history", async () => {
  const data = dataV2();
  delete data.changes;
  data.gone_lots = [{ lot_id: "gone-42", title: "Снятый лот", price: 420, rarity: "Редкий" }];
  data.lots[0].history = [
    { observed_at: "2026-10-29T10:00:00Z", price: 100 },
    { observed_at: "2026-10-29T11:00:00Z", price: 125 }
  ];
  const { browser, page, problems } = await open(serve(data));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="analytics"]');
  assert.match(await page.textContent("#changeList"), /Список новых лотов отсутствует|Пока нет данных|Новых лотов/);
  await page.click("#tabGone");
  assert.match(await page.textContent("#changeList"), /Снятый лот/);
  await page.click("#tabPrice");
  assert.match(await page.textContent("#changeList"), /100.*125|100 → 125/);
  assert.deepEqual(problems, []);
  await browser.close();
});


test("sale benchmarks beat inflated asking prices and split offer clusters are suppressed", async () => {
  const lots = Array.from({ length: 13 }, (_, i) => ({
    lot_id: String(7000 + i), title: "Топор", serial: "#" + (i + 1), rarity: "Редкий",
    price: i < 3 ? 80000 : 1000000, status: "На продаже",
    image_url: i < 3 ? "https://huevo.su/static/axe.webp" : "",
    lot_url: "https://huevo.su/market/lot/" + (7000 + i), first_seen: NOW, last_seen: NOW,
    active: true, history: [{ observed_at: NOW, price: i < 3 ? 80000 : 1000000 }]
  }));
  const { browser, page, problems } = await open(serve(dataV2({ lots, sales: null })));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="deals"]');
  assert.equal(await page.locator("#dealsList .deal-card-rich").count(), 0,
    "three low offers versus ten 1m offers form two price clusters, not a trustworthy market median");
  assert.match(await page.textContent("#dealsNote"), /устойчивой группы/);
  await browser.close();

  const profile = {
    title: "топор", count: 20, median: 100000, p25: 95000, p75: 110000,
    min: 80000, max: 130000, dated_sales: 4,
    history: [
      { date: "2026-10-27", median: 98000, count: 2 },
      { date: "2026-10-28", median: 102000, count: 2 }
    ]
  };
  const sales = { generated_at: NOW, summary: { count: 20, unknown: 0, median: 100000, min: 80000, max: 130000, enough_data: true }, by_title: [profile] };
  const second = await open(serve(dataV2({ lots, sales })));
  await second.page.waitForSelector("#content:not(.hide)");
  await second.page.click('#mainNav [data-view="deals"]');
  assert.equal(await second.page.locator("#dealsList .deal-card-rich").count(), 3,
    "only the three genuinely cheap asks are compared to confirmed sales");
  assert.match(await second.page.locator("#dealsList .deal-card-rich").first().textContent(), /МЕДИАНА ПРОДАЖ/);
  assert.match(await second.page.locator("#dealsList .deal-card-rich").first().textContent(), /СОВЕРШЁННЫЕ ПРОДАЖИ/);
  await second.page.click('#mainNav [data-view="analytics"]');
  assert.ok(await second.page.locator("#salesPanel:not(.hide)").count());
  assert.ok(await second.page.locator("#giftSalesSelect option").count() === 1);
  assert.ok(await second.page.locator("#giftSalesProfile svg polyline").count() === 1,
    "dated confirmed transactions produce a gift-level median price graph");
  assert.deepEqual(second.problems, []);
  await second.browser.close();
});

test("daily-pick gift art stays beside the title at desktop and mobile widths", async () => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const { browser, page, problems } = await open(serve(dataV2()), viewport);
    await page.waitForSelector("#content:not(.hide)");
    await page.click('#mainNav [data-view="overview"]');
    assert.equal(await page.locator("#dayPicks .day-pick-card").count(), 3);
    const cards = page.locator("#dayPicks .day-pick-card");
    for (let i = 0; i < await cards.count(); i++) {
      const card = cards.nth(i);
      const image = await card.locator(".thumb").boundingBox();
      const title = await card.locator(".t").boundingBox();
      assert.ok(image && title, "each card has image and title boxes");
      assert.ok(image.x + image.width <= title.x + 1, "gift art must not overlap or cover the title");
      assert.ok(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "card has no internal horizontal overflow");
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    assert.deepEqual(problems, []);
    await browser.close();
  }
});

test("target price sound is opt-in and persists locally", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="favorites"]');
  assert.equal(await page.getAttribute("#toggleAlertSound", "aria-pressed"), "false");
  await page.click("#toggleAlertSound");
  assert.equal(await page.getAttribute("#toggleAlertSound", "aria-pressed"), "true");
  assert.equal(await page.evaluate(() => localStorage.getItem("amnyam.alertSound.v1")), "on");
  await page.click("#testAlertSound");
  assert.deepEqual(problems, []);
  await browser.close();
});


test("malformed snapshot is rejected and retry recovers without showing a false empty market", async () => {
  let calls = 0;
  const { browser, page, problems } = await open((route) => {
    calls += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(calls === 1 ? { schema_version: 3, lots: "not-an-array" } : dataV2())
    });
  });
  await page.waitForSelector("#error:not(.hide)");
  assert.match(await page.textContent("#errorText"), /список lots/);
  assert.equal(await page.locator("#empty:not(.hide)").count(), 0, "malformed data is not a genuine empty-market response");
  await page.click("#retry");
  await page.waitForSelector("#content:not(.hide)");
  assert.equal(await page.locator("#rows tr").count(), 50);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("target prices reject fractional and unsafe values but blank input clears a target", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="deals"]');
  await page.fill("#belowBestTarget", "12.5");
  await page.click("#saveBelowBestTarget");
  assert.match(await page.textContent("#watchAlertText"), /целую целевую цену/);
  assert.equal(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("amnyam.targets") || "{}")).length), 0);
  await page.fill("#belowBestTarget", "1000000000000001");
  await page.click("#saveBelowBestTarget");
  assert.match(await page.textContent("#watchAlertText"), /целую целевую цену/);
  await page.fill("#belowBestTarget", "1000");
  await page.click("#saveBelowBestTarget");
  assert.equal(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("amnyam.targets") || "{}")).every(Number.isSafeInteger)), true);
  await page.fill("#belowBestTarget", "");
  await page.click("#saveBelowBestTarget");
  assert.equal(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("amnyam.targets") || "{}")).length), 0);
  assert.deepEqual(problems, []);
  await browser.close();
});
