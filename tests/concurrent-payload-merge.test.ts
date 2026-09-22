import assert from "node:assert/strict";
import test from "node:test";
import { mergeConcurrentPayload, structurallyEqual } from "@/lib/concurrent-payload-merge";

const base = { id: "booking-1", title: "Base", metadata: { room: "A", seats: 2 } };
const unchangedWithDifferentKeyOrder = { metadata: { seats: 2, room: "A" }, title: "Base", id: "booking-1" };

test("local delete wins when the remote record is unchanged", () => {
  assert.deepEqual(mergeConcurrentPayload([base], [], [unchangedWithDifferentKeyOrder]), {
    value: [],
    conflicts: 0,
  });
});

test("local delete versus a remote edit reports a conflict and preserves the server edit", () => {
  const remote = { ...base, title: "Remote edit" };
  assert.deepEqual(mergeConcurrentPayload([base], [], [remote]), {
    value: [remote],
    conflicts: 1,
  });
});

test("remote delete wins when the local record is unchanged", () => {
  assert.deepEqual(mergeConcurrentPayload([base], [unchangedWithDifferentKeyOrder], []), {
    value: [],
    conflicts: 0,
  });
});

test("remote delete versus a local edit reports a conflict without resurrecting the record", () => {
  assert.deepEqual(mergeConcurrentPayload([base], [{ ...base, title: "Local edit" }], []), {
    value: [],
    conflicts: 1,
  });
});

test("structural equality ignores object key insertion order", () => {
  assert.equal(structurallyEqual(base, unchangedWithDifferentKeyOrder), true);
  const sharedBase = [{ id: "booking-1", metadata: { first: 0, second: 0 } }];
  const left = [{ id: "booking-1", metadata: { first: 1, second: 2 } }];
  const right = [{ metadata: { second: 2, first: 1 }, id: "booking-1" }];
  assert.deepEqual(mergeConcurrentPayload(sharedBase, left, right), { value: left, conflicts: 0 });
});
