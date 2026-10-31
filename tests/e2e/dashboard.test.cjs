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

async function open(handler, viewport = { width: 1280, height: 900 }, options = {}) {
  const browser = await chromium.launch();
  OPEN_BROWSERS.add(browser);
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const problems = [];
  if (options.initScript) await page.addInitScript(options.initScript);
  page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
  page.on("response", (response) => {
    if (response.status() === 404) problems.push("http 404: " + response.url());
  });
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("dialog", (d) => { problems.push("dialog: " + d.message()); d.dismiss(); });
  await ctx.route("https://huevo.su/**", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("http://site.test/**", async (route) => {
    const u = new URL(route.request().url());
    if (options.supportRoutes && options.supportRoutes[u.pathname]) return options.supportRoutes[u.pathname](route);
    if (u.pathname === "/api/contact/status") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        configured: true, available: false, can_manage: false, updated_at: null
      }) });
    }
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
    if (u.pathname.startsWith("/api/")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, enabled: false, authenticated: false, subscriptions: 0, amounts: [], supporters: 0, total: 0 }) });
    }
    if (u.pathname === "/data.json") return handler(route);
    const file = path.join(SITE, u.pathname === "/" ? "index.html" : u.pathname.slice(1));
    if (!file.startsWith(SITE) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, headers: { "content-type": TYPES[path.extname(file)] || "text/plain", "content-security-policy": CSP }, body: fs.readFileSync(file) });
  });
  const destination = options.path ? String(options.path).replace(/^[/]+/, "") : "";
  await page.goto("http://site.test/" + destination + (options.query || ""));
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

test("collector source health distinguishes completed, paused and missing sources", async () => {
  const data = dataV2({
    live: { enabled: true, fresh: true, item_count: 30, last_poll_at: NOW },
    collector: {
      status: "ok", message: "Full scan completed", checked_at: NOW, pages: 22, lots: 474,
      sales_history: { status: "ok", pages: 4, updated: 12, total: 120, total_pages: 652, checked_at: NOW },
      gift_catalog_index: { status: "ok", cards: 123, checked_at: NOW },
      gift_catalog_details: { status: "ok", attempted: 4, updated: 4, known: 89, index_total: 123, checked_at: NOW },
      gift_instances: { status: "pending", attempted: 8, updated: 3, events_added: 1, batches: 2, checked_at: NOW }
    },
    sales_history_state: { status: "ok", total_records: 120, total_pages: 652, checked_at: NOW },
    gift_catalog_index: Array.from({ length: 123 }, (_, i) => ({ catalog_id: String(i + 1) })),
    gift_catalogs: Array.from({ length: 89 }, (_, i) => ({ catalog_id: String(i + 1) }))
  });
  const { browser, page, problems } = await open(serve(data));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="analytics"]');
  assert.equal(await page.locator("#sourceHealthGrid .source-health-card").count(), 6);
  const panel = await page.textContent("#sourceHealthGrid");
  assert.match(panel, /Полный рынок[\s\S]*474 лотов/);
  assert.match(panel, /Live · первая страница[\s\S]*30 лотов/);
  assert.match(panel, /История завершённых продаж[\s\S]*120 записей[\s\S]*652/);
  assert.match(panel, /Независимый индекс \/gifts[\s\S]*123 карточек/);
  assert.match(panel, /Подробности каталога[\s\S]*4 обновлено[\s\S]*89 полных карточек/);
  assert.match(panel, /Экземпляры и история владельцев[\s\S]*В очереди[\s\S]*1 новых событий/);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("collector source health does not invent successful status when metadata is missing", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="analytics"]');
  const panel = page.locator("#sourceHealthGrid");
  assert.equal(await panel.locator(".source-health-card").count(), 6);
  assert.equal(await panel.locator(".source-health-status:has-text('Нет метаданных')").count(), 5);
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

test("top reliable discount and absolute cheapest offer are shown as different picks", async () => {
  const data=dataV2();
  data.lots=[
    ...Array.from({length:11},(_,i)=>({
      lot_id:String(20000+i),title:"Лудобофос",rarity:"Лимитированный",
      price:i===0?144000:567000,status:"На продаже",active:true,
      image_url:"https://huevo.su/static/gift.webp",
      lot_url:"https://huevo.su/market/lot/"+(20000+i),history:[]
    })),
    ...Array.from({length:5},(_,i)=>({
      lot_id:String(21000+i),title:"Нимфа (FUKKERS)",rarity:"Лимитированный",
      price:i===0?111111:888222,status:"На продаже",active:true,
      image_url:"https://huevo.su/static/gift.webp",
      lot_url:"https://huevo.su/market/lot/"+(21000+i),history:[]
    }))
  ];
  data.stats={n_total:data.lots.length};
  data.collector.lots=data.lots.length;
  const {browser,page,problems}=await open(serve(data));
  await page.waitForSelector("#content:not(.hide)");
  assert.match(await page.textContent("#belowBestTitle"),/Лудобофос/);
  assert.match(await page.textContent("#belowBestMeta"),/74,6|74\.6/);
  await page.click('#mainNav [data-view="overview"]');
  const picks=page.locator("#dayPicks .day-pick-card");
  assert.equal(await picks.count(),3);
  assert.match(await picks.nth(0).textContent(),/ЛУЧШИЙ НАДЁЖНЫЙ ДИСКОНТ/);
  assert.match(await picks.nth(1).textContent(),/САМАЯ НИЗКАЯ ЦЕНА/);
  assert.match(await picks.nth(1).textContent(),/Нимфа/);
  assert.match(await picks.nth(1).textContent(),/ПРОВЕРИТЬ/);
  assert.match(await picks.nth(1).textContent(),/Экстремальный дисконт более 80%/);
  assert.deepEqual(problems,[]);
  await browser.close();
});

test("contact strip shows public availability but hides controls from other Huevo users", async () => {
  const {browser,page,problems}=await open(serve(dataV2()),{width:1280,height:900},{
    supportRoutes:{
      "/api/contact/status":route=>route.fulfill({
        status:200,contentType:"application/json",
        body:JSON.stringify({configured:true,available:true,can_manage:false,updated_at:NOW})
      })
    }
  });
  await page.waitForSelector("#content:not(.hide)");
  await page.waitForFunction(()=>document.querySelector("#ownerPresenceText").textContent==="Сейчас на месте");
  assert.equal(await page.locator("#ownerPresenceToggle").isVisible(),false);
  assert.equal(await page.getAttribute("#ownerPresenceView","data-available"),"true");
  assert.equal(await page.getAttribute("#contactPanel a.contact-message-btn","href"),"https://huevo.su/messages/monkeyzxcw");
  assert.deepEqual(problems,[]);
  await browser.close();
});

test("only the authenticated owner receives the availability switch and may change it", async () => {
  let available=false;
  const {browser,page,problems}=await open(serve(dataV2()),{width:1280,height:900},{
    query:"?hu_user_id=14188",
    supportRoutes:{
      "/api/contact/status":async route=>{
        if(route.request().method()==="PUT"){
          const body=route.request().postDataJSON();
          available=Boolean(body.available);
        }
        return route.fulfill({
          status:200,contentType:"application/json",
          body:JSON.stringify({configured:true,available,can_manage:true,updated_at:NOW})
        });
      }
    }
  });
  await page.waitForSelector("#content:not(.hide)");
  await page.waitForFunction(()=>!document.querySelector("#ownerPresenceToggle").hidden);
  const toggle=page.locator("#ownerPresenceToggle");
  assert.equal(await toggle.getAttribute("aria-checked"),"false");
  await toggle.click();
  await page.waitForFunction(()=>document.querySelector("#ownerPresenceToggle").getAttribute("aria-checked")==="true");
  assert.equal(available,true);
  assert.match(await page.textContent("#ownerPresenceText"),/Сейчас на месте/);
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

test("gift instance and catalogue edition use separate verified data sources", async () => {
  const data = dataV2();
  data.lots[3].gift_details = {
    gift_id: "18336", gift_url: "https://huevo.su/gift/18336",
    checked_at: NOW, attributes: {
      model: { name: "Лунная модель", rarity: "1.2%" },
      backdrop: "Синий космос", symbol: "Комета", pattern: { value: "Звёздный узор" }
    }
  };
  data.lots[3].gift_catalog = {
    catalog_id: "131", gift_catalog_id: "131",
    gift_catalog_url: "https://huevo.su/gifts/131",
    title: "Адидас-Тян Зеленая", supply: 222, issued: 220,
    drop_price: 7777, drop_price_text: "7777 монэток",
    edition_sold_out: false, rarity: "Лимитированный",
    author: "Дизайнер каталога", collection: "Каталог Адидас",
    attributes: { model: "Green Adidas" }, checked_at: NOW,
    source: "huevo_gift_catalog_page"
  };
  // Deliberately conflicting values prove that /gift/{instance_id} is not
  // allowed to override catalogue supply, drop price, designer or collection.
  data.lots[3].gift_instance = {
    gift_id: "18336", gift_url: "https://huevo.su/gift/18336",
    title: "Адидас-Тян Зеленая", serial: 4, supply: 111,
    rarity: "Лимитированный", drop_price: 5555, drop_price_text: "5555 монэток",
    edition_sold_out: true, author: "Автор экземпляра (не использовать)",
    collection: "Чужая коллекция (не использовать)", current_owner: "monkeyzxcw",
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
  assert.match(detail, /Полный тираж/);
  assert.match(detail, /222/);
  assert.doesNotMatch(detail, /Полный тираж\s*111/);
  assert.match(detail, /Лунная модель/);
  assert.match(detail, /Синий космос/);
  assert.match(detail, /Комета/);
  assert.match(detail, /Звёздный узор/);
  assert.ok(detail.replace(/\s/g, "").includes("7777"), "drop price must come from the /gifts/ catalogue record");
  assert.doesNotMatch(detail, /5555/, "instance-page price must not appear as catalogue drop price");
  assert.match(detail, /Дизайнер каталога/);
  assert.match(detail, /Каталог Адидас/);
  assert.doesNotMatch(detail, /Автор экземпляра/);
  assert.doesNotMatch(detail, /Чужая коллекция/);
  assert.match(detail, /Продан в Маркете/);
  assert.match(detail, /teeth/);
  assert.match(detail, /не содержат сумму каждой сделки/);
  assert.equal(await page.locator("#dBody a").filter({ hasText: "Открыть страницу подарка и тираж" }).getAttribute("href"), "https://huevo.su/gifts/131");
  assert.equal(await page.locator("#dBody a").filter({ hasText: "Открыть страницу конкретного экземпляра" }).getAttribute("href"), "https://huevo.su/gift/18336");
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

test("only an explicit empty lots array shows an empty-market state; malformed roots show an error", async () => {
  const empty = await open(serve({ lots: [], collector: { status: "no_cards", message: "каталог пуст" } }));
  await empty.page.waitForSelector("#empty:not(.hide)");
  assert.equal(await empty.page.locator("#content:not(.hide)").count(), 0);
  assert.deepEqual(empty.problems, []);
  await empty.browser.close();

  for (const body of [{}, []]) {
    const invalid = await open(serve(body));
    await invalid.page.waitForSelector("#error:not(.hide)");
    assert.equal(await invalid.page.locator("#empty:not(.hide)").count(), 0, "malformed root is not an empty catalogue");
    assert.equal(await invalid.page.locator("#content:not(.hide)").count(), 0);
    assert.deepEqual(invalid.problems, []);
    await invalid.browser.close();
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
  for (const view of ["overview", "market", "sniper", "deals", "cheap", "analytics", "favorites", "support"]) {
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


test("live polling refreshes every gift-instance field and event detail", async () => {
  const data = dataV2();
  const lot = data.lots[3];
  lot.gift_instance = {
    gift_id: "18336", gift_url: "https://huevo.su/gift/18336",
    title: lot.title, serial: 4, supply: 111, rarity: "Лимитированный",
    drop_price: 5555, drop_price_text: "5555 монэток",
    edition_sold_out: null, author: "", collection: "", current_owner: "",
    history_found: true, checked_at: NOW,
    history: [{
      event_id: "stable-event-id", type: "transfer", label: "Первичная запись",
      from_user: "old_owner", to_user: "unknown", time_raw: "вчера"
    }]
  };
  lot.gift_catalog = {
    catalog_id: "131", gift_catalog_id: "131",
    gift_catalog_url: "https://huevo.su/gifts/131",
    title: lot.title, supply: 111, rarity: "Лимитированный",
    drop_price: 5555, drop_price_text: "5555 монэток",
    edition_sold_out: null, author: "", collection: "",
    checked_at: NOW, source: "huevo_gift_catalog_page"
  };
  data.catalog_events = [{
    event_id: "stable-event-id", type: "transfer", label: "Первичная запись",
    title: lot.title, lot_id: String(lot.lot_id), gift_id: "18336",
    serial: "№ 4/111", from_user: "old_owner", to_user: "unknown",
    time_raw: "вчера", observed_at: NOW,
    gift_url: "https://huevo.su/gift/18336",
    lot_url: "https://huevo.su/market/lot/" + lot.lot_id
  }];

  let latest = data;
  const liveResponse = (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(latest)
  });
  const { browser, page, problems } = await open(liveResponse);
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="market"]');
  await page.fill("#search", String(lot.lot_id));
  await page.click("#rows button");
  assert.doesNotMatch(await page.textContent("#dBody"), /Новый автор/);
  // Keep the detail dialog open while the collector publishes new fields.

  // Keep the cache timestamp, history length and last event ID unchanged. These are
  // exactly the fields the old signature checked, while the actual visible metadata
  // and event details have changed.
  latest = JSON.parse(JSON.stringify(latest));
  latest.lots[3].gift_catalog.author = "Новый автор";
  latest.lots[3].gift_catalog.collection = "Обновлённая коллекция";
  latest.lots[3].gift_catalog.edition_sold_out = true;
  latest.lots[3].gift_instance.current_owner = "new_owner";
  latest.lots[3].gift_instance.history[0] = {
    ...latest.lots[3].gift_instance.history[0],
    label: "Продан в Маркете", from_user: "seller", to_user: "buyer", time_raw: "28 окт в 21:37"
  };
  latest.catalog_events[0] = {
    ...latest.catalog_events[0],
    label: "Продан в Маркете", from_user: "seller", to_user: "buyer", time_raw: "28 окт в 21:37"
  };

  await page.waitForTimeout(3600);
  const detail = await page.textContent("#dBody");
  assert.match(detail, /Новый автор/);
  assert.match(detail, /Обновлённая коллекция/);
  assert.match(detail, /new_owner/);
  assert.match(detail, /Тираж разошёлся/);
  assert.match(detail, /Продан в Маркете/);
  assert.match(detail, /seller → buyer/);
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

test("daily-pick cards keep gift art, title, metrics and actions in separate responsive tracks", async () => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 360, height: 780 }]) {
    const { browser, page, problems } = await open(serve(dataV2()), viewport);
    await page.waitForSelector("#content:not(.hide)");
    await page.click('#mainNav [data-view="overview"]');
    assert.equal(await page.locator("#dayPicks .day-pick-card").count(), 3);
    const cards = page.locator("#dayPicks .day-pick-card");
    for (let i = 0; i < await cards.count(); i++) {
      const card = cards.nth(i);
      const image = await card.locator(".thumb").boundingBox();
      const title = await card.locator(".t").boundingBox();
      const actions = await card.locator(".day-pick-actions").boundingBox();
      assert.ok(image && title && actions, "each card has image, title and action rows");
      assert.ok(image.width >= 50 && image.height >= 50, "gift image remains large enough to identify");
      assert.ok(image.x + image.width + 5 <= title.x + 1, "gift art must sit beside, not overlap, the title");
      assert.ok(actions.y >= title.y + title.height - 1, "actions must remain below the title and metrics");
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

test("collector aggregate detail count is not shown as per-lot analysis when the lot has no attached record", async () => {
  const data = dataV2();
  data.collector.gift_details = { status: "ok", pages: 8, updated: 8, message: "Карточки подарков проверены." };
  const { browser, page, problems } = await open(serve(data));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="market"]');
  await page.fill("#search", "1003");
  await page.click("#rows button");
  assert.match(await page.textContent("#dBody"), /8 карточек подарков, но характеристики этого экземпляра не прикреплены к лоту/);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("target price crossing plays sound only without browser notifications", async () => {
  const initial = dataV2();
  initial.lots[0].price = 180;
  let latest = initial;
  const { browser, page, problems } = await open((route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(latest)
  }), { width: 1280, height: 900 }, {
    initScript: () => {
      localStorage.setItem("amnyam.targets", JSON.stringify({ "1000": 120 }));
      localStorage.setItem("amnyam.alertSound.v1", "on");
      window.__soundNotes = 0;
      class FakeAudioContext {
        constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
        createOscillator() {
          return { type: "", frequency: { setValueAtTime() {} }, connect() {},
            start() { window.__soundNotes += 1; }, stop() {} };
        }
        createGain() {
          return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
        }
      }
      Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    }
  });
  await page.waitForSelector("#content:not(.hide)");
  assert.equal(await page.locator("#enablePushNotifications, #enableNotifications").count(), 0);
  assert.equal(await page.locator("#watchAlert").count(), 0);
  assert.equal(await page.evaluate(() => window.__soundNotes), 0, "no sound before the ask reaches the target");
  latest = JSON.parse(JSON.stringify(latest));
  latest.lots[0].price = 100;
  await page.waitForFunction(() => window.__soundNotes === 5, { timeout: 10000 });
  assert.equal(await page.locator("#watchAlert, #pushStatus, #enablePushNotifications").count(), 0);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("help tab documents market workflows and sound-only target alerts", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="help"]');
  assert.equal(await page.locator("#helpPanel:not(.view-hidden)").count(), 1);
  const guide = await page.textContent("#helpPanel");
  assert.match(guide, /Маркет/);
  assert.match(guide, /Снайпер/);
  assert.match(guide, /Экспорт CSV/);
  assert.match(guide, /цена-цель/);
  assert.match(guide, /Звуковой сигнал AMNYAM/);
  assert.match(guide, /Фоновых браузерных или системных уведомлений больше нет/);
  assert.doesNotMatch(guide, /Подключить push|Проверить push|серверный push/i);
  assert.match(guide, /Cloudflare Worker/);
  assert.match(guide, /HuevoDualScan/);
  assert.ok(guide.includes("gifts/{id}"));
  assert.match(guide, /неоднозначна/);
  const appSource = fs.readFileSync(path.join(SITE, "app.js"), "utf8");
  assert.equal(appSource.includes("Notification"), false);
  assert.equal(appSource.includes("PushManager"), false);
  assert.equal(appSource.includes("/api/push"), false);
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
  assert.equal(await page.locator("#empty:not(.hide)").count(), 0);
  await page.click("#retry");
  await page.waitForSelector("#content:not(.hide)");
  assert.equal(await page.locator("#rows tr").count(), 50);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("target prices reject fractions and values above the safe limit; blank input clears a target", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="market"]');
  await page.fill("#search", "1003");
  await page.locator("#rows button[aria-label^='Подробнее о лоте']").click();

  const input = page.locator("#dBody .target-input");
  const save = page.locator("#dBody .detail-watch button.btn:not(.secondary)");
  await input.fill("12.5");
  await save.click();
  assert.match(await page.textContent("#dBody .target-error"), /целую целевую цену/);
  assert.equal(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("amnyam.targets") || "{}")).length), 0);

  await input.fill("1000000000000001");
  await save.click();
  assert.match(await page.textContent("#dBody .target-error"), /целую целевую цену/);
  assert.equal(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("amnyam.targets") || "{}")).length), 0);

  await input.fill("1000");
  await save.click();
  assert.equal(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("amnyam.targets") || "{}")).every(Number.isSafeInteger)), true);

  await input.fill("");
  await save.click();
  assert.equal(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("amnyam.targets") || "{}")).length), 0);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("support payment status failures do not invite duplicate intents and can be checked again", async () => {
  let intentCalls = 0;
  let statusCalls = 0;
  const ok = (body) => (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
  const { browser, page, problems } = await open(serve(dataV2()), { width: 1280, height: 900 }, {
    query: "?hu_user_id=123",
    initScript: () => {
      window.huevo = {
        init: async () => true,
        confirmPayment: async () => true
      };
    },
    supportRoutes: {
      "/api/support/config": ok({
        enabled: true,
        amounts: [5000, 10000, 25000, 50000, 100000],
        sdk_url: "https://huevo.su/static/js/huevo-apps-v1.js",
        origins: ["huevo.su", "huevo.departament.site"]
      }),
      "/api/support/stats": ok({ supporters: 3, total: 15000 }),
      "/api/support/intent": (route) => {
        intentCalls += 1;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, intent_id: "pi_test_retry_1", amount: 5000, test: true })
        });
      },
      "/api/support/status/pi_test_retry_1": (route) => {
        statusCalls += 1;
        if (statusCalls === 1) {
          return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "temporary status outage" }) });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ intent_id: "pi_test_retry_1", amount: 5000, status: "succeeded", test: true })
        });
      }
    }
  });
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="support"]');
  await page.waitForFunction(() => document.querySelector("#supportHint").textContent.includes("Платёж будет создан"));
  await page.click('#supportAmounts [data-amount="5000"]');
  await page.waitForFunction(() => document.querySelector("#supportRetryStatus") && !document.querySelector("#supportRetryStatus").hidden);
  assert.match(await page.textContent("#supportMsgText"), /не создавай повторный/i);
  assert.match(await page.textContent("#supportMsgText"), /pi_test_retry_1/);
  assert.equal(intentCalls, 1);
  assert.equal(statusCalls, 1);

  await page.reload();
  await page.waitForSelector("#content:not(.hide)");
  await page.click('#mainNav [data-view="support"]');
  await page.waitForFunction(() => document.querySelector("#supportRetryStatus") && !document.querySelector("#supportRetryStatus").hidden);
  assert.match(await page.textContent("#supportMsgText"), /ранее созданный платёж/i);

  await page.click('#supportAmounts [data-amount="5000"]');
  assert.equal(intentCalls, 1, "a pending intent blocks creation of a duplicate");
  await page.click("#supportRetryStatus");
  await page.waitForFunction(() => document.querySelector("#supportMsgText").textContent.includes("Тестовый платёж подтверждён"));
  assert.equal(statusCalls, 2);
  assert.equal(intentCalls, 1);
  assert.equal(await page.locator("#supportRetryStatus").isVisible(), false);
  assert.equal(problems.length, 1, "only the deliberately mocked 503 response may be logged");
  assert.match(problems[0], /503 \(Service Unavailable\)/);
  await browser.close();
});

test("main navigation supports ArrowLeft, ArrowRight, Home and End with roving focus", async () => {
  const { browser, page, problems } = await open(serve(dataV2()));
  try {
    await page.waitForSelector("#content:not(.hide)");
    const tab = (view) => page.locator('#mainNav [role="tab"][data-view="' + view + '"]');
    await tab("overview").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await tab("market").getAttribute("aria-selected"), "true");
    assert.equal(await tab("market").evaluate(node => document.activeElement === node), true);
    await page.keyboard.press("ArrowRight");
    assert.equal(await tab("sniper").getAttribute("aria-selected"), "true");
    await page.keyboard.press("ArrowRight");
    assert.equal(await tab("deals").getAttribute("aria-selected"), "true");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await tab("sniper").getAttribute("aria-selected"), "true");
    await page.keyboard.press("End");
    assert.equal(await tab("help").getAttribute("aria-selected"), "true");
    await page.keyboard.press("Home");
    assert.equal(await tab("overview").getAttribute("aria-selected"), "true");
    assert.equal(await tab("overview").evaluate(node => document.activeElement === node), true);
    await tab("help").click();
    assert.equal(await page.locator("#helpPanel:not(.view-hidden)").count(), 1);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});



test("Sniper shows a live new-lot event and calculates scenarios from confirmed sale data", async () => {
  let latest = dataV2({
    sales: {
      generated_at: NOW,
      summary: { count: 20, unknown: 0, median: 1000, min: 800, max: 1200, enough_data: true },
      by_title: [{ title: "Звезда", count: 20, median: 1000, p25: 900, p75: 1100,
        history: [{ date: "2026-10-29", median: 980 }, { date: "2026-10-30", median: 1000 }] }]
    }
  });
  const { browser, page, problems } = await open((route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(latest)
  }));
  try {
    await page.waitForSelector("#content:not(.hide)");
    await page.click('#mainNav [data-view="sniper"]');
    assert.equal(await page.locator("#sniperPanel:not(.view-hidden)").count(), 1);
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#sniperGiftSelect option")).some(option => option.textContent === "Звезда"));
    await page.selectOption("#sniperGiftSelect", { label: "Звезда" });
    await page.fill("#sniperBuyPrice", "800");
    await page.waitForSelector("#sniperCalcResult .sniper-scenario", { timeout: 5000 });
    assert.equal(await page.locator("#sniperCalcResult .sniper-scenario").count(), 3);
    assert.match(await page.textContent("#sniperCalcResult"), /Подтверждённые продажи/);
    assert.match(await page.textContent("#sniperCalcResult"), /Оптимистичный/);
    assert.match(await page.textContent("#sniperRarityResult"), /характеристик|нескольких сопоставимых/i);

    latest = JSON.parse(JSON.stringify(latest));
    latest.lots.push({
      lot_id: "900001", title: "Звезда", rarity: "Редкий", price: 650, status: "На продаже",
      first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), active: true,
      lot_url: "https://huevo.su/market/lot/900001", history: []
    });
    await page.waitForFunction(() => document.querySelector("#sniperFeed").textContent.includes("900001"), { timeout: 12000 });
    assert.match(await page.textContent("#sniperFeed"), /НОВЫЙ ЛОТ/);
    await page.selectOption("#sniperType", "new");
    assert.ok(await page.locator("#sniperFeed .sniper-event").count() >= 2, "existing snapshot change and the newly detected lot are both retained");
    await page.fill("#sniperSearch", "not-found");
    assert.match(await page.textContent("#sniperFeed"), /Нет событий под выбранные фильтры/);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});


test("CSV export contains the filtered market data and neutralises spreadsheet formulas", async () => {
  const data = dataV2();
  data.lots[0].title = '=HYPERLINK("https://evil.example";"open")';
  const { browser, page, problems } = await open(serve(data));
  try {
    await page.waitForSelector("#content:not(.hide)");
    await page.click('#mainNav [data-view="market"]');
    const downloadPromise = page.waitForEvent("download");
    await page.click("#exportCsv");
    const download = await downloadPromise;
    assert.ok(download.suggestedFilename().startsWith("amnyam-market-"));
    assert.ok(download.suggestedFilename().endsWith(".csv"));
    const file = await download.path();
    const csv = fs.readFileSync(file, "utf8");
    assert.match(csv, /ID лота/);
    assert.match(csv, /Подарок/);
    assert.match(csv, /'=HYPERLINK/);
    assert.match(await page.textContent("#exportCsvStatus"), /Экспортировано строк/);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});
