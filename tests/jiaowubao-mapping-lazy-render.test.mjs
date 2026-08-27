import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [priorityPanel, historyPanel, styles] = await Promise.all([
  readFile(new URL("../app/jiaowubao-schedule-mapping-priority-review.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/jiaowubao-schedule-mapping-review.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);

test("large Jiaowubao mapping queues mount controls only for expanded candidates", () => {
  for (const source of [priorityPanel, historyPanel]) {
    assert.match(source, /const \[expanded, setExpanded\] = useState\(false\)/);
    assert.match(source, /onToggle=\{\(event\) => setExpanded\(event\.currentTarget\.open\)\}/);
    assert.match(source, /\{expanded \? <div className="jwb-mapping-candidate-body">/);
  }
  assert.match(styles, /\.jwb-mapping-candidate \{[\s\S]*?content-visibility:auto;/);
  assert.match(styles, /contain-intrinsic-block-size:auto 58px;/);
});
