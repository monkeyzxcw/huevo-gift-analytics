// Cloudflare static dashboard regression test: latest lot link, escaping, and one-second polling.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "../..");
const SITE = path.join(ROOT, "cloudflare-site");
const DATA = {
  schema_version: 1,
  generated_at: "2026-10-30T00:00:00+00:00",
  source: "https://huevo.su",
  collector: { status: "ok", pages: 1, lots: 1, message: "ok" },
  stats: { n_total: 1, priced: 1, min: 123, max: 123, avg: 123, median: 123 },
  lots: [{
    lot_id: "12345",
    title: '<img src=x onerror="window.__xss=1">',
    serial: "#1",
    rarity: "Редкий",
    price: 123,
    status: "На продаже",
    image_url: "",
    lot_url: "https://attacker.invalid/steal",
    first_seen: "2026-10-30T00:00:00+00:00",
    last_seen: "2026-10-30T00:00:00+00:00",
    history: [{ observed_at: "2026-10-30T00:00:00+00:00", price: 123 }]
  }],
  snapshots: [],
  deals: []
};

test("static dashboard links the first market lot safely and polls data every second", async () => {
  let snapshotRequests = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/data.json") {
      snapshotRequests += 1;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(DATA));
      return;
    }
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const full = path.resolve(SITE, "." + pathname);
    if (!full.startsWith(SITE + path.sep) || !fs.existsSync(full)) {
      res.writeHead(404); res.end("not found"); return;
    }
    const type = full.endsWith(".html") ? "text/html; charset=utf-8" : "application/javascript; charset=utf-8";
    res.writeHead(200, { "content-type": type });
    res.end(fs.readFileSync(full));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.waitForFunction(() => document.querySelector("#latestLot")?.textContent.includes("12345"));
    const link = page.locator("#latestLot");
    assert.equal(await link.getAttribute("href"), "https://huevo.su/market/lot/12345");
    assert.match(await link.textContent(), /<img src=x onerror=/);
    assert.equal(await link.locator("img").count(), 0, "untrusted title must be rendered as text");
    assert.equal(await page.evaluate(() => window.__xss), undefined, "title payload must not execute");
    await page.waitForTimeout(1250);
    assert.ok(snapshotRequests >= 2, `expected one-second polling; got ${snapshotRequests} requests`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
