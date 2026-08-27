import assert from "node:assert/strict";
import test from "node:test";

import {
  isCreateIfMissingRenewal,
  parseRenewalFollowUpCommand,
  prepareRenewalFollowUp,
  RenewalFollowUpServiceError,
} from "../lib/renewal-follow-up-service";
import type { OpsStateRow } from "../lib/ops-store";

const COMMAND_KEY = "renewal-follow-up:123e4567-e89b-42d3-a456-426614174000";
const AUTO_RENEWAL_ID = "REN-AUTO:renewal:STU-1:PKG-1";

function row(entity: string, payload: unknown, version = 7): OpsStateRow {
  return {
    entity,
    payload,
    version,
    updated_at: "2026-08-24T00:00:00.000Z",
    updated_by: "Ops Admin",
  };
}

function student(overrides: Record<string, unknown> = {}) {
  return {
    id: "STU-1",
    name: "Student One",
    owner: "Abby",
    status: "在读",
    lessonPackages: [{
      id: "PKG-1",
      name: "English 20h",
      subjectIds: ["English"],
      purchaseRecords: [{ id: "BUY-1", purchasedAt: "2026-01-01T00:00:00.000Z", hours: 20 }],
      consumedHours: 18,
    }],
    ...overrides,
  };
}

function rows(studentValue = student(), renewals: unknown[] = []) {
  return [
    row("students", [studentValue]),
    row("renewals", renewals),
    row("files", []),
    row("tasks", []),
    row("teachers", []),
    row("bookings", []),
  ];
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    commandKey: COMMAND_KEY,
    renewalId: AUTO_RENEWAL_ID,
    studentId: "STU-1",
    packageId: "PKG-1",
    businessStatus: "not_renewed_active",
    result: "已跟进",
    attemptedAt: "2026-08-24T01:02:03.000Z",
    note: "已联系家长",
    renewalDateNote: "",
    expectedVersions: { files: 7, renewals: 7, students: 7, tasks: 7 },
    ...overrides,
  };
}

function errorCode(error: unknown) {
  return error instanceof RenewalFollowUpServiceError ? error.code : "unexpected";
}

test("create-if-missing command is narrow and prepared from the exact package identity", () => {
  const parsed = parseRenewalFollowUpCommand(command());
  assert.equal(isCreateIfMissingRenewal(parsed), true);
  const prepared = prepareRenewalFollowUp({
    command: parsed,
    rows: rows(),
    actor: "Ops Admin",
    role: "admin",
    fullAdmin: true,
  });
  assert.equal(prepared.renewalId, AUTO_RENEWAL_ID);
  assert.equal(prepared.packageId, "PKG-1");
  assert.throws(
    () => parseRenewalFollowUpCommand({ ...command(), owner: "forged" }),
    (error) => errorCode(error) === "client_fields_forbidden",
  );
  assert.throws(
    () => parseRenewalFollowUpCommand({ ...command(), packageName: "forged", remaining: 999 }),
    (error) => errorCode(error) === "client_fields_forbidden",
  );
});

test("missing automatic renewal is allowed, while persisted renewal compatibility remains strict", () => {
  const parsed = parseRenewalFollowUpCommand(command());
  assert.doesNotThrow(() => prepareRenewalFollowUp({
    command: parsed,
    rows: rows(),
    actor: "Ops Admin",
    role: "admin",
    fullAdmin: true,
  }));
  assert.throws(() => prepareRenewalFollowUp({
    command: parseRenewalFollowUpCommand({ ...command(), renewalId: "REN-PERSISTED" }),
    rows: rows(),
    actor: "Ops Admin",
    role: "admin",
    fullAdmin: true,
  }), (error) => errorCode(error) === "renewal_not_found");
});

test("create-if-missing rejects inactive, archived, unassociated and wrong-package identities", () => {
  const base = { actor: "Ops Admin", role: "admin" as const, fullAdmin: true };
  assert.throws(() => prepareRenewalFollowUp({
    command: parseRenewalFollowUpCommand(command()),
    rows: rows(student({ status: "不活跃 + 有课时" })),
    ...base,
  }), (error) => errorCode(error) === "student_scope_forbidden");
  assert.throws(() => prepareRenewalFollowUp({
    command: parseRenewalFollowUpCommand(command()),
    rows: rows(student({ importArchived: true })),
    ...base,
  }), (error) => errorCode(error) === "student_scope_forbidden");
  assert.throws(() => prepareRenewalFollowUp({
    command: parseRenewalFollowUpCommand(command()),
    rows: rows(student({ lessonPackages: [] })),
    ...base,
  }), (error) => errorCode(error) === "renewal_identity_conflict");
  assert.throws(() => prepareRenewalFollowUp({
    command: parseRenewalFollowUpCommand(command({ packageId: "PKG-OTHER" })),
    rows: rows(),
    ...base,
  }), (error) => errorCode(error) === "renewal_identity_conflict");
  assert.throws(() => prepareRenewalFollowUp({
    command: parseRenewalFollowUpCommand(command({ renewalId: "REN-AUTO:renewal:STU-OTHER:PKG-1" })),
    rows: rows(),
    ...base,
  }), (error) => errorCode(error) === "renewal_identity_conflict");
});

test("subject-only persisted rows are not accepted as automatic package rows", () => {
  const parsed = parseRenewalFollowUpCommand(command());
  assert.throws(() => prepareRenewalFollowUp({
    command: parsed,
    rows: rows(student(), [{
      id: AUTO_RENEWAL_ID,
      studentId: "STU-1",
      packageId: "PKG-1",
      subjectId: "English",
    }]),
    actor: "Ops Admin",
    role: "admin",
    fullAdmin: true,
  }), (error) => errorCode(error) === "renewal_identity_conflict");
});
