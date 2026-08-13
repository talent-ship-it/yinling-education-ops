import assert from "node:assert/strict";
import test from "node:test";

import {
  lookupTeacherRosterIdentity,
  resolveTeacherIdentity,
  validateTeacherSession,
} from "../lib/demo-teacher-login";

test("a roster teacher outside the seeded demo list can authenticate by exact normalized name", () => {
  const result = resolveTeacherIdentity("  DEREKＪIANG  ", [
    { id: "T-1", name: "Derek J iang" },
    { id: "T-2", name: "DEREKJIANG" },
  ]);
  // The first near-match includes a distinct space and must not match.
  assert.deepEqual(result, { identity: { user: "DEREKJIANG", role: "teacher" } });
});

test("casefolded duplicate roster names are rejected without revealing matches", () => {
  const result = resolveTeacherIdentity("derek jiang", [
    { id: "T-1", name: "Derek Jiang" },
    { id: "T-2", name: "DEREK JIANG" },
  ]);
  assert.equal("error" in result, true);
  if ("error" in result) {
    assert.equal(result.status, 409);
    assert.match(result.error, /姓名重复/);
    assert.doesNotMatch(result.error, /Derek/i);
  }
});

test("unknown names return the same generic credential error", () => {
  assert.deepEqual(resolveTeacherIdentity("Unknown Person", [{ id: "T-1", name: "Derek Jiang" }]), {
    error: "密码不正确。",
    status: 401,
  });
});

test("plain colliding staff name selects the teacher and the qualified alias selects canonical staff", () => {
  assert.deepEqual(lookupTeacherRosterIdentity("Abby", [
    { id: "T-1", name: "ＡＢＢＹ" },
  ]), { matches: ["ABBY"] });
  assert.deepEqual(resolveTeacherIdentity("Abby", [{ id: "T-1", name: "ＡＢＢＹ" }]), {
    identity: { user: "ABBY", role: "teacher" },
  });
  assert.deepEqual(resolveTeacherIdentity("Abby 教务", [{ id: "T-1", name: "ＡＢＢＹ" }]), {
    identity: { user: "Abby", role: "staff" },
  });
  assert.deepEqual(resolveTeacherIdentity("Ella", [{ id: "T-1", name: "Other Teacher" }]), {
    identity: { user: "Ella", role: "staff" },
  });
});

test("privileged-name and qualified-alias roster collisions fail closed", () => {
  for (const name of ["Nixon", "Ops Admin", "Abby 教务"]) {
    const result = resolveTeacherIdentity(name, [{ id: "T-3", name }]);
    assert.equal("error" in result, true);
    if ("error" in result) assert.equal(result.status, 409);
  }
});

test("teacher sessions fail closed when the roster entry is removed or becomes ambiguous", () => {
  const identity = { user: "Derek Jiang", role: "teacher" } as const;
  assert.deepEqual(validateTeacherSession(identity, [{ id: "T-1", name: "Derek Jiang" }]), {
    identity,
  });
  for (const roster of [
    [{ id: "T-2", name: "Other Teacher" }],
    [{ id: "T-1", name: "Derek Jiang" }, { id: "T-2", name: "DEREK JIANG" }],
  ]) {
    const result = validateTeacherSession(identity, roster);
    assert.equal("error" in result, true);
    if ("error" in result) assert.equal(result.status, 401);
  }
});

test("malformed roster payloads fail closed as unavailable", () => {
  const lookup = lookupTeacherRosterIdentity("Derek Jiang", { id: "T-1", name: "Derek Jiang" });
  assert.equal("error" in lookup, true);
  if ("error" in lookup) assert.equal(lookup.status, 503);

  const session = validateTeacherSession(
    { user: "Derek Jiang", role: "teacher" },
    [{ id: "T-1", name: 123 }],
  );
  assert.equal("error" in session, true);
  if ("error" in session) assert.equal(session.status, 503);

  const missingId = validateTeacherSession(
    { user: "Derek Jiang", role: "teacher" },
    [{ name: "Derek Jiang" }],
  );
  assert.equal("error" in missingId, true);
  if ("error" in missingId) assert.equal(missingId.status, 503);
});
