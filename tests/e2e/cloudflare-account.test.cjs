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

async function openApp(search = "") {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem("amnyam.favorites", JSON.stringify(["1000"]));
    localStorage.setItem("amnyam.targets", JSON.stringify({ "1000": 75 }));
    localStorage.setItem("amnyam.alertSound.v1", "on");
  });
  const page = await context.newPage();
  const state = { user: null, profile: null, writes: [], launchPayload: null };
  const problems = [];
  page.on("console", (message) => { if (message.type() === "error") problems.push(message.text()); });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.route("https://huevo.su/**", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "window.huevo={init:async()=>{},confirmPayment:async()=>{}}" }));
  await page.route("http://amnyam.test/**", async (route) => {
    const url = new URL(route.request().url());
    const request = route.request();
    const respond = (body, status = 200) => route.fulfill({ status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });
    if (url.pathname === "/api/push/status") {
      return respond({ ok: true, authenticated: Boolean(state.user), enabled: true, subscriptions: 0 });
    }
    if (url.pathname === "/api/contact/status") {
      return respond({ configured: true, available: false, can_manage: false, updated_at: null });
    }
    if (url.pathname === "/api/me") {
      return respond(state.user ? { ok: true, authenticated: true, profiles_ready: true, user: state.user, profile: state.profile, updated_at: "2026-10-30T00:00:00.000Z" } : { ok: true, authenticated: false, profiles_ready: true, user: null, profile: {}, updated_at: null });
    }
    if (url.pathname === "/api/auth/launch" && request.method() === "POST") {
      state.launchPayload = request.postDataJSON();
      state.profile = state.launchPayload.profile;
      state.user = {
        id: "internal-user-1",
        hu_user_id: "456789",
        username: "gift_hunter",
        display_name: "Huevo Hunter",
        avatar_url: "https://huevo.su/avatar.png",
        mode: "live"
      };
      return respond({ ok: true, authenticated: true, user: state.user, profile: state.profile, updated_at: "2026-10-30T00:00:00.000Z" });
    }
    if (url.pathname === "/api/me/profile" && request.method() === "PUT") {
      state.profile = request.postDataJSON().profile;
      state.writes.push(state.profile);
      return respond({ ok: true, profile: state.profile, updated_at: "2026-10-30T00:01:00.000Z" });
    }
    if (url.pathname === "/api/support/config") return respond({ enabled: false, amounts: [] });
    if (url.pathname === "/api/support/stats") return respond({ supporters: 0, total: 0 });
    if (url.pathname === "/api/live/status") return respond({ enabled: false, fresh: false, items: [] });
    if (url.pathname.startsWith("/api/")) return respond({ ok: true, enabled: false, authenticated: Boolean(state.user), subscriptions: 0, amounts: [], supporters: 0, total: 0 });
    if (url.pathname === "/data.json") return respond(SNAPSHOT);
    const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
    const full = path.resolve(SITE, file);
    if (!full.startsWith(SITE) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, headers: { "content-type": TYPES[path.extname(full)] || "text/plain", "content-security-policy": CSP }, body: fs.readFileSync(full) });
  });
  try {
    await page.goto("http://amnyam.test/" + search);
    await page.waitForSelector("#content:not(.hide)");
    return { browser, page, state, problems };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

test("all market tabs stay available without huEVO login and profile dialog explains how to connect", async () => {
  const { browser, page, problems } = await openApp();
  try {
    for (const view of ["overview", "market", "deals", "cheap", "analytics", "favorites", "support", "appearance"]) {
      const tab = page.locator('#mainNav [data-view="' + view + '"]');
      await tab.click();
      assert.equal(await tab.getAttribute("aria-selected"), "true", view);
    }
    await page.click("#accountButton");
    await page.waitForSelector("#accountDialog[open]");
    assert.equal(await page.isVisible("#accountGuest"), true);
    assert.match(await page.textContent("#accountGuest"), /Открой AMNYAM MODE из huEVO/);
    assert.equal(await page.locator("#loginPassword").count(), 0, "AMNYAM must not ask for a separate password");
    assert.equal(await page.locator("#registerPassword").count(), 0, "AMNYAM must not offer a separate registration");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});

test("signed huEVO launch identifies the player and syncs their personal profile", async () => {
  const query = "?hu_app_id=123&hu_user_id=456789&hu_username=gift_hunter&hu_display_name=Huevo%20Hunter&hu_avatar=https%3A%2F%2Fhuevo.su%2Favatar.png&hu_mode=live&hu_ts=1793347200&hu_hash=" + "a".repeat(64);
  const { browser, page, state, problems } = await openApp(query);
  try {
    await page.waitForFunction(() => document.getElementById("accountButton").textContent.includes("Huevo Hunter"));
    assert.equal(state.launchPayload.launch_query, query, "forward the original signed query unchanged");
    assert.deepEqual(state.launchPayload.profile.favorites, ["1000"]);
    assert.equal(state.launchPayload.profile.targets["1000"], 75);
    assert.equal(state.launchPayload.profile.preferences.alertSound, true);
    assert.equal(await page.locator("#loginPassword").count(), 0);
    await page.click('#mainNav [data-view="appearance"]');
    await page.selectOption("#appearanceBackground", "nebula");
    await page.waitForTimeout(900);
    assert.ok(state.writes.length >= 1, "profile settings must be saved to the Worker");
    assert.equal(state.writes[state.writes.length - 1].preferences.appearance.background, "nebula");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});
