import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
  assertCompletedLessonRetirementCredentialEnvironment,
  createCompletedLessonRetirementState,
  parseCompletedLessonRetirementManagementArguments,
  parseCompletedLessonRetirementState,
  readCompletedLessonRetirementState,
  validateCompletedLessonRetirementCommitReceipt,
  validateCompletedLessonRetirementPreviewReceipt,
} = await import("../scripts/jiaowubao-completed-lesson-retirement-management.ts");

const confirmationKey = `sha256:${"a".repeat(64)}`;
const commandId = "123e4567-e89b-42d3-a456-426614174000";

test("management CLI arguments require an exact month, owner state path, and explicit actor", () => {
  const options = parseCompletedLessonRetirementManagementArguments([
    "--state", "/private/tmp/jwb-retirement/state.json",
    "--month", "2026-08",
    "--actor", "Nixon",
    "--commit",
  ]);
  assert.equal(options.month, "2026-08");
  assert.equal(options.actor, "Nixon");
  assert.equal(options.commit, true);
  assert.throws(
    () => parseCompletedLessonRetirementManagementArguments([
      "--state", "/private/tmp/state",
      "--month", "2026-8",
      "--actor", "Nixon",
    ]),
    /--state、--month 和 --actor/,
  );
  assert.throws(
    () => parseCompletedLessonRetirementManagementArguments([
      "--state", "/private/tmp/state",
      "--month", "2026-08",
      "--actor", "Someone Else",
    ]),
    /--state、--month 和 --actor/,
  );
  assert.throws(
    () => parseCompletedLessonRetirementManagementArguments([
      "--profile", "/private/tmp/profile",
      "--state", "/private/tmp/state",
      "--month", "2026-08",
      "--actor", "Nixon",
    ]),
    /参数无效/,
  );
});

test("management CLI fails closed unless the Insider Leads credential wrapper supplies its token", () => {
  const validEnvironment = {
    CODEX_COMPANY_PROFILE: "insiderlead",
    SUPABASE_ACCESS_TOKEN: `sbp_${"a".repeat(32)}`,
  };
  assert.doesNotThrow(() => assertCompletedLessonRetirementCredentialEnvironment(validEnvironment));
  for (const environment of [
    { SUPABASE_ACCESS_TOKEN: validEnvironment.SUPABASE_ACCESS_TOKEN },
    { ...validEnvironment, CODEX_COMPANY_PROFILE: "personal" },
    { CODEX_COMPANY_PROFILE: "insiderlead" },
    { ...validEnvironment, SUPABASE_ACCESS_TOKEN: "too-short" },
    { ...validEnvironment, SUPABASE_ACCESS_TOKEN: `${validEnvironment.SUPABASE_ACCESS_TOKEN} ` },
    { ...validEnvironment, SUPABASE_ACCESS_TOKEN: `${validEnvironment.SUPABASE_ACCESS_TOKEN}\n` },
  ]) {
    assert.throws(
      () => assertCompletedLessonRetirementCredentialEnvironment(environment),
      /codex-project-credential Supabase 包装器/,
    );
  }
});

test("retirement state is owner-only, atomically no-overwrite, and keeps one stable command UUID", async () => {
  const root = await mkdtemp(join(tmpdir(), "jwb-retirement-state-test-"));
  const directory = join(root, "private");
  const statePath = join(directory, "state.json");
  try {
    await chmod(root, 0o700);
    const expected = Object.freeze({
      schemaVersion: 1,
      month: "2026-08",
      confirmationKey,
      commandId,
    });
    await createCompletedLessonRetirementState(statePath, expected);
    assert.equal((await stat(directory)).mode & 0o077, 0);
    assert.equal((await stat(statePath)).mode & 0o077, 0);
    assert.deepEqual(await readCompletedLessonRetirementState(statePath, "2026-08"), expected);
    assert.deepEqual(
      parseCompletedLessonRetirementState(JSON.parse(await readFile(statePath, "utf8")), "2026-08"),
      expected,
    );
    await assert.rejects(
      () => createCompletedLessonRetirementState(statePath, { ...expected, commandId: "223e4567-e89b-42d3-a456-426614174000" }),
      /已存在|冲突/,
    );
    assert.deepEqual(await readCompletedLessonRetirementState(statePath, "2026-08"), expected);
    await assert.rejects(
      () => readCompletedLessonRetirementState(statePath, "2026-07"),
      /月份或命令不匹配/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("management receipts expose only the opaque preview key and exact aggregate output", () => {
  const preview = validateCompletedLessonRetirementPreviewReceipt({
    phase: "preview",
    month: "2026-08",
    confirmationKey,
    memberCount: 1065,
    completedMemberCount: 1009,
    rowCount: 4321,
    canCommit: true,
  }, "2026-08");
  assert.deepEqual(preview, {
    phase: "preview",
    month: "2026-08",
    confirmationKey,
    memberCount: 1065,
    completedMemberCount: 1009,
    rowCount: 4321,
    canCommit: true,
  });

  const commit = validateCompletedLessonRetirementCommitReceipt({
    phase: "commit",
    month: "2026-08",
    state: "aborted",
    reason: "schedule_changed",
    memberCount: 1065,
    completedMemberCount: 1009,
    rowCount: 4321,
    replayed: true,
  }, "2026-08");
  assert.deepEqual(commit, {
    phase: "commit",
    month: "2026-08",
    state: "aborted",
    reason: "schedule_changed",
    memberCount: 1065,
    completedMemberCount: 1009,
    rowCount: 4321,
    replayed: true,
  });
  for (const receipt of [preview, commit]) {
    const output = JSON.stringify(receipt);
    assert.doesNotMatch(output, /runId|auditId|commandId|memberIds|sourceKey/);
  }
  assert.throws(
    () => validateCompletedLessonRetirementCommitReceipt({
      phase: "commit",
      month: "2026-08",
      state: "aborted",
      reason: "schedule_changed",
      memberCount: 1065,
      completedMemberCount: 1009,
      rowCount: 4321,
      replayed: false,
      runId: commandId,
    }, "2026-08"),
    /字段无效/,
  );
});
