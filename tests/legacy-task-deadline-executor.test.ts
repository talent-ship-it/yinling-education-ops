import assert from "node:assert/strict";
import test from "node:test";

import { executeLegacyTaskDeadlineCommand } from "../lib/legacy-task-deadline-executor";
import {
  LegacyTaskDeadlineServiceError,
  parseLegacyTaskDeadlineCommand,
} from "../lib/legacy-task-deadline-service";
import type {
  LegacyTaskDeadlineCommandResult,
  LegacyTaskDeadlineCommitResult,
  OpsStateRow,
} from "../lib/ops-store";

const COMMAND_KEY = "legacy-task-deadline:123e4567-e89b-42d3-a456-426614174010";

const rows: OpsStateRow[] = [
  {
    entity: "students",
    version: 7,
    updated_at: "2026-08-20T00:00:00.000Z",
    updated_by: "Ops Admin",
    payload: [{ id: "STU-LEGACY", name: "测试学生", status: "在读" }],
  },
  {
    entity: "tasks",
    version: 7,
    updated_at: "2026-08-20T00:00:00.000Z",
    updated_by: "Ops Admin",
    payload: [{ id: "TSK-LEGACY", studentId: "STU-LEGACY", title: "测试历史任务", status: "waiting" }],
  },
];

function clearCommand() {
  return parseLegacyTaskDeadlineCommand({
    commandKey: COMMAND_KEY,
    action: "clear",
    taskId: "TSK-LEGACY",
    expectedVersions: { students: 7, tasks: 7 },
  });
}

function setCommand() {
  return parseLegacyTaskDeadlineCommand({
    commandKey: COMMAND_KEY,
    action: "set",
    taskId: "TSK-LEGACY",
    melbourneDateTime: "2026-08-19T18:00",
    expectedVersions: { students: 7, tasks: 7 },
  });
}

const replayReceipt: LegacyTaskDeadlineCommandResult = {
  command_key: COMMAND_KEY,
  action: "clear",
  applied: true,
  task_id: "TSK-LEGACY",
  due_at: null,
  audit_entry_id: "AUD-REPLAY",
};

const commitReceipt: LegacyTaskDeadlineCommitResult = {
  command_key: COMMAND_KEY,
  action: "set",
  applied: true,
  task_id: "TSK-LEGACY",
  due_at: "2026-08-19T08:00:00.000Z",
  task_row: rows[1]!,
  audit_entry_id: "AUD-COMMIT",
};

function baseInput(command: ReturnType<typeof clearCommand> | ReturnType<typeof setCommand>) {
  return {
    command,
    rows,
    actor: "Ops Admin",
    role: "limited-admin" as const,
    fullAdmin: false,
  };
}

test("replays an authorized historical clear receipt without calling mutate", async () => {
  let mutationCalls = 0;
  const execution = await executeLegacyTaskDeadlineCommand({
    ...baseInput(clearCommand()),
    getReplay: async () => [replayReceipt],
    mutate: async () => {
      mutationCalls += 1;
      return [];
    },
  });
  assert.equal(execution.kind, "replay");
  assert.equal(execution.result.action, "clear");
  assert.equal(mutationCalls, 0);
});

test("rejects a new clear after replay lookup and never calls mutate", async () => {
  let replayCalls = 0;
  let mutationCalls = 0;
  await assert.rejects(executeLegacyTaskDeadlineCommand({
    ...baseInput(clearCommand()),
    getReplay: async () => {
      replayCalls += 1;
      return [];
    },
    mutate: async () => {
      mutationCalls += 1;
      return [];
    },
  }), (error) => error instanceof LegacyTaskDeadlineServiceError && error.code === "clear_disabled");
  assert.equal(replayCalls, 1);
  assert.equal(mutationCalls, 0);
});

test("allows a set command to reach the sole mutation dependency", async () => {
  let mutationCalls = 0;
  const execution = await executeLegacyTaskDeadlineCommand({
    ...baseInput(setCommand()),
    getReplay: async () => [],
    mutate: async () => {
      mutationCalls += 1;
      return [commitReceipt];
    },
  });
  assert.equal(execution.kind, "commit");
  assert.equal(execution.result?.action, "set");
  assert.equal(mutationCalls, 1);
});

test("fresh authorization still precedes receipt lookup", async () => {
  let replayCalls = 0;
  const missingRows = rows.map((row) => row.entity === "tasks" ? { ...row, payload: [] } : row);
  await assert.rejects(executeLegacyTaskDeadlineCommand({
    ...baseInput(clearCommand()),
    rows: missingRows,
    getReplay: async () => {
      replayCalls += 1;
      return [replayReceipt];
    },
    mutate: async () => [],
  }), (error) => error instanceof LegacyTaskDeadlineServiceError && error.code === "task_not_found");
  assert.equal(replayCalls, 0);
});
