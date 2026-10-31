import test from "node:test";
import assert from "node:assert/strict";
import { sanitiseProfile } from "../../src/auth.js";

test("profile validator drops invalid lot IDs, targets and unsupported preferences", () => {
  const profile = sanitiseProfile({
    favorites: ["123", "bad-id", "456", "123", 7],
    targets: { "123": 1000, "bad": 20, "456": -10, "789": "500", "111": 1.5, "222": "2.75", "333": 1000000000000001 },
    alertedTargets: ["123", "invalid"],
    savedFilters: [
      { name: "Rare under 1k", filters: { search: "rare", mode: "gifts", sort: { key: "price", dir: -1 } } },
      { name: "Bad", filters: {} }
    ],
    preferences: {
      alertSound: true,
      soundVolume: 35,
      soundPattern: "soft",
      sniperNewSound: true,
      sniperDealSound: false,
      appearance: { background: "not-a-theme", mascot: "none", motion: "off", glass: false },
      seasonTheme: "unknown",
      overviewWidgets: { hero: false, dayPicks: true, charts: false }
    },
    portfolio: [
      { id: "p1", title: "Подарок А", rarity: "Редкий", quantity: 2, purchase_price: 1000, added_at: "2026-10-31T10:00:00Z" },
      { id: "p2", title: "", rarity: "", quantity: 0, purchase_price: -1 },
      { id: "p3", title: "Подарок Б", rarity: "", quantity: 1001, purchase_price: 500 }
    ],
    sniperRuleProfiles: [
      { id: "rule-a", name: "Редкие до 1k", filter: { type: "deal", search: "Редкий", min: "1", max: "1000", discount: "20" } },
      { id: "", name: "Invalid", filter: { type: "all" } }
    ]
  });
  assert.deepEqual(profile.favorites, ["123", "456", "7"]);
  assert.deepEqual(profile.targets, { "123": 1000, "789": 500 });
  assert.deepEqual(profile.alertedTargets, ["123"]);
  assert.equal(profile.savedFilters.length, 2);
  assert.equal(profile.savedFilters[0].filters.mode, "gifts");
  assert.deepEqual(profile.savedFilters[0].filters.sort, { key: "price", dir: -1 });
  assert.equal(profile.preferences.alertSound, true);
  assert.equal(profile.preferences.soundVolume, 35);
  assert.equal(profile.preferences.soundPattern, "soft");
  assert.equal(profile.preferences.sniperNewSound, true);
  assert.equal(profile.preferences.sniperDealSound, false);
  assert.equal(profile.preferences.appearance.background, "cosmic");
  assert.equal(profile.preferences.appearance.mascot, "none");
  assert.equal(profile.preferences.appearance.motion, "off");
  assert.equal(profile.preferences.appearance.glass, false);
  assert.equal(profile.preferences.seasonTheme, "default");
  assert.deepEqual(profile.preferences.overviewWidgets, { hero: false, dayPicks: true, charts: false });
  assert.equal(profile.portfolio.length, 1);
  assert.deepEqual(profile.portfolio[0], {
    id: "p1", title: "Подарок А", rarity: "Редкий", quantity: 2,
    purchase_price: 1000, added_at: "2026-10-31T10:00:00Z"
  });
  assert.equal(profile.sniperRuleProfiles.length, 1);
  assert.deepEqual(profile.sniperRuleProfiles[0].filter, {
    type: "deal", search: "Редкий", min: "1", max: "1000", discount: "20"
  });
});

test("profile validator returns isolated empty defaults for absent data", () => {
  const first = sanitiseProfile(null);
  const second = sanitiseProfile(null);
  first.favorites.push("100");
  assert.deepEqual(second.favorites, []);
  assert.equal(second.preferences.alertSound, false);
  assert.equal(second.preferences.soundVolume, 100);
  assert.equal(second.preferences.soundPattern, "signature");
  assert.equal(second.preferences.sniperNewSound, false);
  assert.equal(second.preferences.sniperDealSound, false);
  assert.equal(second.preferences.appearance.background, "cosmic");
  assert.deepEqual(second.portfolio, []);
  assert.deepEqual(second.sniperRuleProfiles, []);
  assert.deepEqual(second.preferences.overviewWidgets, { hero: true, dayPicks: true, charts: true });
});
