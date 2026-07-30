import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultDisplayPreferences,
  displayPreferencesStorageKey,
  parseDisplayPreferences,
  timezoneLabelFor,
} from "../lib/display-preferences";
import { translateInterfaceText } from "../lib/interface-localization";

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

test("translates shared controls and schedule details without changing names", () => {
  assert.equal(translateInterfaceText("排课与时区检查", "en-AU"), "Schedule and timezone checks");
  assert.equal(translateInterfaceText("关闭课程详情", "en-AU"), "Close lesson details");
  assert.equal(translateInterfaceText(" 查看排课\n", "en-AU"), " View schedule\n");
  assert.equal(
    translateInterfaceText("\n  当前只记录发送意图，未连接企业微信\n API。\n", "en-AU"),
    "\n  The system currently records sending intent only; the WeCom API is not connected.\n",
  );
  assert.equal(translateInterfaceText("第 2 / 7 页", "en-AU"), "Page 2 of 7");
  assert.equal(translateInterfaceText("与 Olivia Chen 的匹配度", "en-AU"), "Match with Olivia Chen");
  assert.equal(translateInterfaceText("当前账号无权访问这节课。", "en-AU"), "This account cannot access this lesson.");
  assert.equal(translateInterfaceText("Olivia 陈欣兰", "en-AU"), "Olivia 陈欣兰");
  assert.equal(translateInterfaceText("排课与时区检查", "zh-CN"), "排课与时区检查");
});
