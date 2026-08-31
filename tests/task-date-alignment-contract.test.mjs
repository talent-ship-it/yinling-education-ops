import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("keeps desktop task deadlines aligned to the right of every action group", () => {
  assert.match(css, /@media \(min-width:721px\) \{/);
  assert.match(css, /\.to-do-row \.due-label \{ flex:0 0 58px; margin-left:auto; \}/);
  assert.match(css, /\.to-do-row \{ grid-template-columns:7px minmax\(0,1fr\) 176px; \}/);
  assert.match(css, /\.to-do-row \.task-row-actions \{ flex-wrap:wrap; justify-self:end; width:176px; \}/);
  assert.match(css, /\.to-do-row \.task-row-actions \.reply-button \{ flex:1 0 100%; \}/);
});
