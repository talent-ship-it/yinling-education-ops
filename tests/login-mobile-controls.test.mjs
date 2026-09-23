import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mobile login fields keep a 44px touch target after workspace overrides", async () => {
  const css = await readFile(new URL("../app/workspace-design.css", import.meta.url), "utf8");
  const mobileStart = css.indexOf("@media (max-width:680px)");
  const mobileEnd = css.indexOf("/* Detail and form surfaces", mobileStart);
  assert.notEqual(mobileStart, -1);
  assert.notEqual(mobileEnd, -1);
  const mobileCss = css.slice(mobileStart, mobileEnd);
  assert.match(mobileCss, /\.login-panel \.login-form input\s*\{\s*min-height:44px;\s*\}/);
});
