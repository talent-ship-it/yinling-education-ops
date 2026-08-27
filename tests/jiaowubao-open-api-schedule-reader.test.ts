import assert from "node:assert/strict";
import test from "node:test";

import {
  mapJiaowubaoSnapshotParticipant,
  type JiaowubaoSnapshotStudentLookup,
} from "../lib/jiaowubao-open-api-schedule-reader";
import { normalizeStudentImportName, studentImportAutomaticJwbNameKey } from "../lib/student-import";

const aliceName = "张三 Zhang San";
const bobName = "李四 Li Si";
const aliceStrict = normalizeStudentImportName(aliceName);
const aliceAuto = studentImportAutomaticJwbNameKey(aliceName);
const bobStrict = normalizeStudentImportName(bobName);
const bobAuto = studentImportAutomaticJwbNameKey(bobName);

function lookup(overrides: Partial<{
  internalByMember: ReadonlyMap<string, string>;
  internalByNameKey: ReadonlyMap<string, string>;
  memberCandidates: ReadonlyMap<string, readonly string[]>;
  nameCandidates: ReadonlyMap<string, readonly string[]>;
}> = {}): JiaowubaoSnapshotStudentLookup {
  return {
    internalByMember: new Map([
      ["mem-alice", "student-alice"],
      ...(overrides.internalByMember ? [...overrides.internalByMember.entries()] : []),
    ]),
    internalByNameKey: new Map([
      [aliceStrict, "student-alice"],
      [aliceAuto, "student-alice"],
      ...(overrides.internalByNameKey ? [...overrides.internalByNameKey.entries()] : []),
    ]),
    memberCandidates: new Map([
      ["mem-alice", ["student-alice"]],
      ...(overrides.memberCandidates ? [...overrides.memberCandidates.entries()] : []),
    ]),
    nameCandidates: new Map([
      [aliceStrict, ["student-alice"]],
      [aliceAuto, ["student-alice"]],
      [bobStrict, ["student-bob"]],
      [bobAuto, ["student-bob"]],
      ...(overrides.nameCandidates ? [...overrides.nameCandidates.entries()] : []),
    ]),
  };
}

test("maps a member-only snapshot participant to the allowed internal ID", () => {
  assert.equal(
    mapJiaowubaoSnapshotParticipant({ memberId: "mem-alice", label: null }, lookup()),
    "student-alice",
  );
});

test("maps a name-only snapshot participant through strict and bilingual keys", () => {
  assert.equal(
    mapJiaowubaoSnapshotParticipant({ memberId: null, label: aliceName }, lookup()),
    "student-alice",
  );
});

test("accepts dual evidence only when both proofs identify the same student", () => {
  assert.equal(
    mapJiaowubaoSnapshotParticipant({ memberId: "mem-alice", label: aliceName }, lookup()),
    "student-alice",
  );
});

test("fails closed when member and name evidence identify different students", () => {
  assert.equal(
    mapJiaowubaoSnapshotParticipant({ memberId: "mem-alice", label: bobName }, lookup({
      internalByNameKey: new Map([[bobStrict, "student-bob"], [bobAuto, "student-bob"]]),
      nameCandidates: new Map([[bobStrict, ["student-bob"]], [bobAuto, ["student-bob"]]]),
    })),
    null,
  );
});

test("fails closed for a globally unique student outside the allowed scope", () => {
  assert.equal(
    mapJiaowubaoSnapshotParticipant({ memberId: "mem-bob", label: null }, lookup({
      memberCandidates: new Map([["mem-bob", ["student-bob"]]]),
    })),
    null,
  );
  assert.equal(
    mapJiaowubaoSnapshotParticipant({ memberId: null, label: bobName }, lookup()),
    null,
  );
});
