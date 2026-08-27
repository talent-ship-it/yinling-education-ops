import assert from "node:assert/strict";
import test from "node:test";

import { resolveStudentDisplayName } from "../lib/student-intake";

test("trial records use guardian WeChat as the display name when the student name is unknown", () => {
  assert.deepEqual(resolveStudentDisplayName({
    segment: "试听",
    name: "  ",
    guardianWechat: "  Daisy  ",
  }), {
    ok: true,
    displayName: "Daisy",
    guardianWechat: "Daisy",
  });
});

test("trial records reject a blank name without a guardian WeChat identifier", () => {
  const result = resolveStudentDisplayName({ segment: "试听" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "missing_guardian_wechat");
    assert.match(result.message, /家长微信名/);
  }
});

test("enrolled records always require a student name", () => {
  const result = resolveStudentDisplayName({
    segment: "已报名",
    guardianWechat: "Daisy",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing_name");
});

test("a named trial preserves the real name and optional guardian identifier", () => {
  assert.deepEqual(resolveStudentDisplayName({
    segment: "试听",
    name: "  Sebastian  ",
    guardianWechat: "Daisy",
  }), {
    ok: true,
    displayName: "Sebastian",
    guardianWechat: "Daisy",
  });
});
