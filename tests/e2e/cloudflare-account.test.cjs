// Cloudflare multi-user account UI tests with mocked Worker endpoints.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "../..");
const SITE = path.join(ROOT, "cloudflare-site");
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".json": "application/json" };
const SNAPSHOT = {
  schema_version: 2,
  generated_at: "2026-10-30T00:00:00.000Z",
  collector: { status: "ok", message: "OK", lots: 2, pages: 1 },
  stats: { n_total: 2, priced: 2, min: 100, max: 400, avg: 250, median: 250, p25: 175, p75: 325 },
  lots: [
    { lot_id: "1000", title: "Gift Alpha", serial: "#1", rarity: "Rare", price: 100, status: "В продаже", active: true, lot_url: "https://huevo.su/market/lot/1000", first_seen: "2026-10-29T00:00:00Z", last_seen: "2026-10-30T00:00:00Z", history: [] },
    { lot_id: "1001", title: "Gift Beta", serial: "#2", rarity: "Common", price: 400, status: "В продаже", active: true, lot_url: "https://huevo.su/market/lot/1001", first_seen: "2026-10-29T00:00:00Z", last_seen: "2026-10-30T00:00:00Z", history: [] }
  ],
  snapshots: [], changes: { counts: { new: 0, gone: 0, price_up: 0, price_down: 0 }, new: [], gone: [], price_up: [], price_down: [] },
  deals: [], drops: [], sales: { summary: {}, by_title: [] }, price_bins: [], categories: [], top_expensive: []
};
const CSP = "default-src 'none'; script-src 'self' https://huevo.su; style-src 'self'; img-src 'self' https://huevo.su https://*.huevo.su https://huevo.departament.site data:; connect-src 'self' https://huevo.su https://*.huevo.su; base-uri 'none'; form-action 'none'";

async function openApp() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem("amnyam.favorites", JSON.stringify(["1000"]));
    localStorage.setItem("amnyam.targets", JSON.stringify({ "1000": 75 }));
    localStorage.setItem("amnyam.alertSound.v1", "on");
  });
  const page = await context.newPage();
  const state = { user: null, profile: null, writes: [], registerPayload: null };
  const problems = [];
  page.on("console", (message) => { if (message.type() === "error") problems.push(message.text()); });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.route("https://huevo.su/**", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "window.huevo={init:async()=>{},confirmPayment:async()=>{}}" }));
  await page.route("http://amnyam.test/**", async (route) => {
    const url = new URL(route.request().url());
    const request = route.request();
    const respond = (body, status = 200) => route.fulfill({ status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });
    if (url.pathname === "/api/me") {
      return respond(state.user ? { ok: true, authenticated: true, profiles_ready: true, user: state.user, profile: state.profile, updated_at: "2026-10-30T00:00:00.000Z" } : { ok: true, authenticated: false, profiles_ready: true, user: null, profile: {}, updated_at: null });
    }
    if (url.pathname === "/api/auth/register" && request.method() === "POST") {
      state.registerPayload = request.postDataJSON();
      state.profile = state.registerPayload.profile;
      state.user = { id: "user-1", username: state.registerPayload.username.toLowerCase(), display_name: state.registerPayload.display_name || state.registerPayload.username };
      return respond({ ok: true, authenticated: true, user: state.user, profile: state.profile, updated_at: "2026-10-30T00:00:00.000Z" }, 201);
    }
    if (url.pathname === "/api/auth/login" && request.method() === "POST") {
      state.user = { id: "user-1", username: "tester", display_name: "Tester" };
      state.profile = { favorites: [], targets: {}, alertedTargets: [], savedFilters: [], preferences: { alertSound: false, appearance: { background: "cosmic", mascot: "omnom", motion: "normal", glass: true }, seasonTheme: "default" } };
      return respond({ ok: true, authenticated: true, user: state.user, profile: state.profile, updated_at: "2026-10-30T00:00:00.000Z" });
    }
    if (url.pathname === "/api/auth/logout" && request.method() === "POST") {
      state.user = null;
      return respond({ ok: true });
    }
    if (url.pathname === "/api/me/profile" && request.method() === "PUT") {
      state.profile = request.postDataJSON().profile;
      state.writes.push(state.profile);
      return respond({ ok: true, profile: state.profile, updated_at: "2026-10-30T00:01:00.000Z" });
    }
    if (url.pathname === "/api/support/config") return respond({ enabled: false, amounts: [] });
    if (url.pathname === "/api/support/stats") return respond({ supporters: 0, total: 0 });
    if (url.pathname === "/api/live/status") return respond({ enabled: false, fresh: false, items: [] });
    if (url.pathname === "/data.json") return respond(SNAPSHOT);
    const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
    const full = path.resolve(SITE, file);
    if (!full.startsWith(SITE) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, headers: { "content-type": TYPES[path.extname(full)] || "text/plain", "content-security-policy": CSP }, body: fs.readFileSync(full) });
  });
  await page.goto("http://amnyam.test/");
  await page.waitForSelector("#content:not(.hide)");
  return { browser, page, state, problems };
}

test("all market tabs stay available without login and account dialog opens", async () => {
  const { browser, page, problems } = await openApp();
  for (const view of ["overview", "market", "deals", "cheap", "analytics", "favorites", "support", "appearance"]) {
    const tab = page.locator('#mainNav [data-view="' + view + '"]');
    await tab.click();
    assert.equal(await tab.getAttribute("aria-selected"), "true", view);
  }
  await page.click("#accountButton");
  await page.waitForSelector("#accountDialog[open]");
  assert.equal(await page.isVisible("#loginForm"), true);
  assert.deepEqual(problems, []);
  await browser.close();
});

test("registration imports guest favourites and saves account preferences to the Worker", async () => {
  const { browser, page, state, problems } = await openApp();
  await page.click("#accountButton");
  await page.click("#showRegister");
  await page.fill("#registerDisplayName", "Gift Hunter");
  await page.fill("#registerUsername", "gift_hunter");
  await page.fill("#registerPassword", "a-unique-password-123");
  await page.click('#registerForm button[type="submit"]');
  await page.waitForFunction(() => document.getElementById("accountButton").textContent.includes("Gift Hunter"));
  assert.deepEqual(state.registerPayload.profile.favorites, ["1000"]);
  assert.equal(state.registerPayload.profile.targets["1000"], 75);
  assert.equal(state.registerPayload.profile.preferences.alertSound, true);
  await page.click('#mainNav [data-view="appearance"]');
  await page.selectOption("#appearanceBackground", "nebula");
  await page.waitForFunction(() => document.getElementById("accountSyncStatus").textContent.includes("сохранены"), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
  assert.ok(state.writes.length >= 1, "profile preferences should be persisted to the Worker");
  assert.equal(state.writes[state.writes.length - 1].preferences.appearance.background, "nebula");
  assert.deepEqual(problems, []);
  await browser.close();
});
