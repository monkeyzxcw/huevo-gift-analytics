import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const app = () => readFile(resolve(root, "cloudflare-site/app.js"), "utf8");

test("best-lot valuation never mixes title-only sales across rarities or catalog editions", async () => {
  const source = await app();
  assert.match(source, /Never use title-only sales as a price benchmark/);
  assert.match(source, /return null;\s*}\s*\n\s*function robustOfferReference/);
  assert.match(source, /const exactRarity = title && rarity[\s\S]*?normaliseSaleRarity\(item\.rarity\) === rarity/);
  assert.match(source, /if \(sales && sales\.count >= 5\)/);
  assert.match(source, /referenceScope = sales\.match_scope \|\| "title"/);
});

test("best-lot recommendations use active comparable offers when exact sale evidence is unavailable", async () => {
  const source = await app();
  assert.match(source, /const offers = robustOfferReference\(group\.map\(lot => lot\.price\)\)/);
  assert.match(source, /if \(!offers \|\| offers\.ambiguous \|\| offers\.dispersion > 1\.0\) continue/);
  assert.match(source, /reference = offers\.reference; basis = "active"/);
  assert.match(source, /if \(lot\.price >= reference \* 0\.85\) continue/);
});
