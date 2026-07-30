import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultDisplayPreferences,
  displayPreferencesStorageKey,
  parseDisplayPreferences,
  timezoneLabelFor,
} from "../lib/display-preferences";

test("uses an English-friendly default for teacher accounts without changing the administrator default", () => {
  assert.equal(defaultDisplayPreferences(true).language, "en-AU");
  assert.equal(defaultDisplayPreferences(false).language, "zh-CN");
  assert.equal(defaultDisplayPreferences(true).timezone, "Australia/Melbourne");
});

test("keeps only supported display preference values", () => {
  const fallback = defaultDisplayPreferences(false);
  const parsed = parseDisplayPreferences(JSON.stringify({
    language: "en-AU",
    textSize: "extra-large",
    timeFormat: "12h",
    dateFormat: "ymd",
    timezone: "Australia/Adelaide",
    density: "compact",
    motion: "reduced",
  }), fallback);

  assert.deepEqual(parsed, {
    language: "en-AU",
    textSize: "extra-large",
    timeFormat: "12h",
    dateFormat: "ymd",
    timezone: "Australia/Adelaide",
    density: "compact",
    motion: "reduced",
  });

  assert.deepEqual(parseDisplayPreferences({ timezone: "Not/A-Real-Timezone", language: "unsupported" }, fallback), fallback);
});

test("partitions browser display preferences by login account", () => {
  assert.notEqual(displayPreferencesStorageKey("Helen Ceperkovic"), displayPreferencesStorageKey("Anna Zhang"));
  assert.equal(displayPreferencesStorageKey("  Helen Ceperkovic  "), displayPreferencesStorageKey("helen ceperkovic"));
  assert.equal(timezoneLabelFor("Australia/Melbourne", "en-AU"), "Melbourne");
  assert.equal(timezoneLabelFor("Australia/Melbourne", "zh-CN"), "墨尔本");
});
