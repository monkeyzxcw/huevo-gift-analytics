import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function loadCatalogOfferReference() {
  const source = await readFile(resolve(root, "cloudflare-site/app.js"), "utf8");
  const start = source.indexOf("function catalogOfferReference(prices) {");
  assert.notEqual(start, -1, "catalogue pricing helper must exist");
  const open = source.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.notEqual(end, -1, "catalogue pricing helper must be balanced");
  const fnSource = source.slice(start, end);
  const median = values => {
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const quantile = (sorted, q) => {
    const position = (sorted.length - 1) * q;
    const low = Math.floor(position), high = Math.ceil(position);
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  };
  return new Function("isNum", "median", "quantile", "return (" + fnSource + ");")(
    value => typeof value === "number" && Number.isFinite(value), median, quantile
  );
}

test("single million-coin ask is excluded from a normal gift price cluster", async () => {
  const reference = await loadCatalogOfferReference();
  const result = reference([30000, 35000, 40000, 45000, 1000000]);
  assert.equal(result.ambiguous, false);
  assert.equal(result.excluded, 1);
  assert.equal(result.sample_size, 4);
  assert.equal(result.reference, 37500);
  assert.ok(result.reference < 100000, "the outlier must not pull the price into the millions");
});

test("two populated price clusters do not produce a misleading single valuation", async () => {
  const reference = await loadCatalogOfferReference();
  const result = reference([25000, 30000, 500000, 700000]);
  assert.equal(result.reference, null);
  assert.equal(result.ambiguous, true);
});

test("catalogue does not invent a price from fewer than three comparable offers", async () => {
  const reference = await loadCatalogOfferReference();
  const result = reference([30000, 35000]);
  assert.equal(result.reference, null);
  assert.equal(result.insufficient, true);
});

test("catalogue does not price from only two offers left after removing an extreme listing", async () => {
  const reference = await loadCatalogOfferReference();
  const result = reference([30000, 35000, 1000000]);
  assert.equal(result.reference, null);
  assert.equal(result.sample_size, 2);
  assert.equal(result.insufficient, true);
});

test("confirmed completed-sale median is preferred and rarity profiles remain isolated", async () => {
  const source = await readFile(resolve(root, "cloudflare-site/app.js"), "utf8");
  assert.match(source, /const supportedSale = profile => validSale\(profile\) && Number\(profile.count\) >= 3/);
  assert.match(source, /catalogSales\.find\(supportedSale\) \|\| titleSales\.find\(supportedSale\)/);
  assert.match(source, /Number\(profile.count\) >= 3/);
  assert.match(source, /normaliseSaleRarity\(profile\.rarity \|\| "Без редкости"\) === bucketRarity/);
  assert.match(source, /\.filter\(lot => !rarityKey \|\| normaliseSaleRarity\(lot\.rarity\) === rarityKey\)/);
});


test("active asking prices are reported separately and never become the fair-price value", async () => {
  const source = await readFile(resolve(root, "cloudflare-site/app.js"), "utf8");
  assert.match(source, /value: null,[\s\S]{0,180}basis: "Нет достаточной истории сделок"/);
  assert.match(source, /offer_reference: offers && !offers\.ambiguous && !offers\.insufficient \? offers\.reference : null/);
  assert.match(source, /Медиана активных объявлений:[\s\S]{0,160}цены продавцов, не подтверждённые сделки/);
  assert.match(source, /Оценка по завершённым продажам/);
});
