import test from "node:test";
import assert from "node:assert/strict";
import { sanitiseProfile } from "../../src/auth.js";

test("profile validator drops invalid lot IDs, targets and unsupported preferences", () => {
  const profile = sanitiseProfile({
    favorites: ["123", "bad-id", "456", "123", 7],
    targets: { "123": 1000, "bad": 20, "456": -10, "789": "500" },
    alertedTargets: ["123", "invalid"],
    savedFilters: [
      { name: "Rare under 1k", filters: { search: "rare", mode: "gifts", sort: { key: "price", dir: -1 } } },
      { name: "Bad", filters: {} }
    ],
    preferences: {
      alertSound: true,
      appearance: { background: "not-a-theme", mascot: "none", motion: "off", glass: false },
      seasonTheme: "unknown"
    }
  });
  assert.deepEqual(profile.favorites, ["123", "456", "7"]);
  assert.deepEqual(profile.targets, { "123": 1000, "789": 500 });
  assert.deepEqual(profile.alertedTargets, ["123"]);
  assert.equal(profile.savedFilters.length, 2);
  assert.equal(profile.savedFilters[0].filters.mode, "gifts");
  assert.deepEqual(profile.savedFilters[0].filters.sort, { key: "price", dir: -1 });
  assert.equal(profile.preferences.alertSound, true);
  assert.equal(profile.preferences.appearance.background, "cosmic");
  assert.equal(profile.preferences.appearance.mascot, "none");
  assert.equal(profile.preferences.appearance.motion, "off");
  assert.equal(profile.preferences.appearance.glass, false);
  assert.equal(profile.preferences.seasonTheme, "default");
});

test("profile validator returns isolated empty defaults for absent data", () => {
  const first = sanitiseProfile(null);
  const second = sanitiseProfile(null);
  first.favorites.push("100");
  assert.deepEqual(second.favorites, []);
  assert.equal(second.preferences.alertSound, false);
  assert.equal(second.preferences.appearance.background, "cosmic");
});
