import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("keeps desktop task deadlines aligned when action counts differ", () => {
  assert.match(css, /@media \(min-width:721px\) \{/);
  assert.match(css, /\.to-do-row \{ grid-template-columns:7px minmax\(0,1fr\) 58px 112px; \}/);
  assert.match(css, /\.to-do-row \.task-row-actions \{ flex-wrap:wrap; justify-self:end; width:112px; \}/);
  assert.match(css, /\.to-do-row \.task-row-actions \.reply-button \{ flex:1 0 100%; \}/);
});
