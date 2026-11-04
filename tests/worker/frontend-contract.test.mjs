import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("AMNYAM keeps the agreed fast Live and slow full-catalogue polling cadence", async () => {
  const app = await read("cloudflare-site/app.js");
  assert.match(app, /window\.setInterval\(pollLive,\s*3000\)/, "Live polling must remain at ~3 seconds");
  assert.match(app, /window\.setInterval\(pollFullSnapshot,\s*5\s*\*\s*60\s*\*\s*1000\)/, "full snapshot polling must remain at 5 minutes");
  assert.match(app, /document\.visibilityState\s*!==\s*"visible"/, "fast polling must respect tab visibility");
  assert.match(app, /fastLivePollRunning/, "fast polling must avoid overlapping requests");
});

test("Push and system notifications stay disabled; sound is the only alert channel", async () => {
  const app = await read("cloudflare-site/app.js");
  const html = await read("cloudflare-site/index.html");
  assert.match(html, /Push и системные уведомления не используются|Системных и Push-уведомлений нет/i);
  assert.doesNotMatch(app, /new\s+Notification\s*\(|PushManager|pushManager\.subscribe\s*\(/i);
  assert.match(app, /toggleAlertSound|alertSound/i, "sound alert controls should remain available");
  assert.match(app, /unregisterLegacyServiceWorker/, "legacy service workers must be cleaned up");
});

test("dashboard keeps strict content security policy and safe DOM text handling", async () => {
  const html = await read("cloudflare-site/index.html");
  const app = await read("cloudflare-site/app.js");
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(app, /textContent/);
  assert.doesNotMatch(app, /\.innerHTML\s*=/, "untrusted market content must not be inserted with innerHTML");
});

test("frontend polling remains same-page fetch based instead of hard page reloads", async () => {
  const app = await read("cloudflare-site/app.js");
  assert.match(app, /async function pollLive\s*\(/);
  assert.match(app, /async function pollFullSnapshot\s*\(/);
  assert.doesNotMatch(app, /(?:window\.)?location\.reload\s*\(/, "polling must not reload the entire dashboard");
});


test("Market Intelligence Lab is shared user-facing analytics, not collector control", async () => {
  const html = await read("cloudflare-site/index.html");
  const app = await read("cloudflare-site/app.js");
  const intel = await read("cloudflare-site/intel-lab.js");
  assert.match(html, /id="intelLab" data-view-section="analytics"/);
  assert.match(html, /intel-lab\.js\?v=amnyam-intel-v3/);
  assert.match(intel, /amnyam:market/);
  assert.match(intel, /intelExportCsv/);
  assert.match(intel, /intelExportJson/);
  assert.match(intel, /intelSaveFilter/);
  assert.match(html, /Проверил актуальность цен/);
  assert.doesNotMatch(html, /data-desk-check="collector"|Сборщик запущен/);
  assert.doesNotMatch(app, /PRIVATE FULL SCAN DETAIL/);
  assert.match(app, /function renderSourceHealth\(\)[\s\S]*Shared users see data freshness and coverage only/);
});


test("own market lots are matched to the signed huEVO profile and can be filtered", async () => {
  const app = await read("cloudflare-site/app.js");
  const html = await read("cloudflare-site/index.html");
  assert.match(app, /function lotSellerIdentity\(lot\)/);
  assert.match(app, /if \(accountId && seller\.userId\) return accountId === seller\.userId/);
  assert.match(app, /accountUsername && seller\.username && accountUsername === seller\.username/);
  assert.match(app, /ownLotsOnly[^\n]*checked|const onlyOwnLots =/);
  assert.doesNotMatch(app, /own-lot-badge|МОЙ ЛОТ/i, "market listings must not display own-lot labels");
  assert.match(html, /id="ownLotsOnly"/);
  assert.match(html, /id="ownLotsHint"/);
});

test("live market ingest preserves only validated seller identity fields", async () => {
  const worker = await read("src/worker.js");
  assert.match(worker, /const seller = \/\^\[A-Za-z0-9_\]\{1,32\}\$\/\.test\(rawSeller\) \? rawSeller : ""/);
  assert.match(worker, /const sellerUserId = \/\^\\d\{1,20\}\$\/\.test\(rawSellerId\) \? rawSellerId : ""/);
  assert.match(worker, /seller_user_id: sellerUserId/);
});

test("AMNYAM Aurora visual system remains decorative, responsive and reduced-motion aware", async () => {
  const css = await read("cloudflare-site/styles.css");
  const app = await read("cloudflare-site/app.js");
  assert.match(css, /AMNYAM AURORA INTERFACE — 2026 visual system refresh/);
  assert.match(css, /@keyframes amnyam-status-sheen/);
  assert.match(css, /@keyframes amnyam-live-pulse/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /#mainNav\s*\{[\s\S]*?position:\s*sticky/);
  assert.match(css, /\.market-results-viewport\s*\{/);
  assert.match(css, /body\[data-motion="off"\]/);
  assert.match(app, /window\.setInterval\(pollLive,\s*3000\)/);
  assert.match(app, /window\.setInterval\(pollFullSnapshot,\s*5\s*\*\s*60\s*\*\s*1000\)/);
  assert.doesNotMatch(app, /(?:window\.)?location\.reload\s*\(/);
});

test("AMNYAM 2.0 deploy busts cached app, styles, Intel and username assets", async () => {
  const html = await read("cloudflare-site/index.html");
  assert.match(html, /styles\.css\?v=giftrack-catalog-fair-price-v1/);
  assert.match(html, /app\.js\?v=giftrack-catalog-fair-price-v1/);
  assert.match(html, /intel-lab\.js\?v=amnyam-intel-v3/);
  assert.match(html, /usernames\.js\?v=amnyam-usernames-v4/);
});
test("AMNYAM Studio dashboard, natural search and per-user layout preferences are wired end to end", async () => {
  const html = await read("cloudflare-site/index.html");
  const app = await read("cloudflare-site/app.js");
  const studio = await read("cloudflare-site/amnyam-studio.js");
  const auth = await read("src/auth.js");
  assert.match(html, /id="amnyamStudio" data-view-section="overview"/);
  assert.match(html, /amnyam-studio\.js\?v=amnyam-studio-v1/);
  assert.match(html, /id="studioNaturalSearch"/);
  assert.match(studio, /confidence\(b\.confidence\) - confidence\(a\.confidence\)/, "deal radar ranks evidence confidence before discount");
  assert.match(studio, /a\.basis === "sales" \? -1 : 1/, "confirmed sale evidence outranks asking-price-only evidence");
  assert.match(studio, /function parseNaturalQuery/);
  assert.match(studio, /function submitNaturalQuery/);
  assert.match(studio, /data-studio-filter/);
  assert.match(studio, /function move\(/);
  assert.match(studio, /studioCompactMarket/);
  assert.match(app, /amnyam:studio-change/);
  assert.match(app, /amnyam:studio-query/);
  assert.match(app, /AMNYAM_STUDIO_SETTINGS\.get/);
  assert.match(auth, /studioWidgets = new Set\(\["pulse", "radar", "movement", "watchlist", "saved"\]\)/);
  assert.match(auth, /compactMarket: studioRaw\.compactMarket === true/);
});

test("username market comparison and similar-handle search are local, bounded and safe", async () => {
  const html = await read("cloudflare-site/index.html");
  const module = await read("cloudflare-site/usernames.js");
  assert.match(html, /id="usernameCompareSelected"/);
  assert.match(html, /id="usernameCompareDialog"/);
  assert.match(html, /id="usernameSimilarQuery"/);
  assert.match(module, /usernameCompareKeys\.size < 4/);
  assert.match(module, /function openUsernameComparison/);
  assert.match(module, /function levenshtein/);
  assert.match(module, /function runSimilarUsernames/);
  assert.match(module, /не проверка доступности/i);
  assert.doesNotMatch(module, /\.innerHTML\s*=/, "username comparisons must use safe DOM text nodes");
});

test("portfolio purchase dates and notes are persisted, sanitized and exported", async () => {
  const html = await read("cloudflare-site/index.html");
  const app = await read("cloudflare-site/app.js");
  const auth = await read("src/auth.js");
  assert.match(html, /id="portfolioPurchaseDate"/);
  assert.match(html, /id="portfolioNotes"/);
  assert.match(app, /purchase_date: purchaseDate, notes/);
  assert.match(app, /\["Заметка", item => item\.notes/);
  assert.match(auth, /purchase_date: validPurchaseDate \? purchaseDate : ""/);
  assert.match(auth, /notes: cleanString\(item\.notes, 300\)/);
});

test("Intelligence Lab saves screeners inline without blocking browser prompts", async () => {
  const html = await read("cloudflare-site/index.html");
  const intel = await read("cloudflare-site/intel-lab.js");
  assert.match(html, /id="intelPeriod"/);
  assert.match(intel, /"24h":86400000/);
  assert.match(intel, /"7d":604800000/);
  assert.match(intel, /"30d":2592000000/);
  assert.match(intel, /change_period:periodLabel\(selectedPeriod\(\)\)/);
  assert.match(html, /id="intelFilterName"/);
  assert.match(intel, /\$\("intelFilterName"\)/);
  assert.doesNotMatch(intel, /prompt\(/, "screeners use inline controls rather than a system prompt");
});


test("all-gifts catalogue is a first-class workspace and shows evidence-backed estimates", async () => {
  const html = await read("cloudflare-site/index.html");
  const app = await read("cloudflare-site/app.js");
  assert.match(html, /data-view="giftcatalog"/);
  assert.match(html, /id="giftCatalogPanel" data-view-section="giftcatalog"/);
  assert.match(html, /id="giftCatalogSummary"/);
  assert.match(app, /function catalogPriceProfiles\\(item\\)/);
  assert.match(app, /function catalogOfferReference\\(prices\\)/);
  assert.match(app, /Завершённые продажи/);
  assert.match(app, /Активные объявления · медиана/);
  assert.match(app, /gift_catalog_index/);
  assert.doesNotMatch(app, /filtered\\.slice\\(0,\\s*150\\)/, "the full canonical index must remain browseable");
  assert.match(app, /navGiftCatalogCount/);
});
