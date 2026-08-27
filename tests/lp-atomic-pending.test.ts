import test from "node:test";
import assert from "node:assert/strict";
import {
  persistLpAtomicPendingCommands,
  readLpAtomicPendingCommands,
  removeLpAtomicPendingCommand,
  upsertLpAtomicPendingCommand,
  type LpAtomicPendingStorage,
} from "@/lib/lp-atomic-pending";

function storage(): LpAtomicPendingStorage {
  let value: string | null = null;
  return { getItem: () => value, setItem: (_key, next) => { value = next; }, removeItem: () => { value = null; } };
}

test("LP pending commands survive reload and remove only the exact intent", () => {
  const backing = storage();
  const entry = {
    intent: JSON.stringify({ operation: "revise", studentId: "STU-1", lpItemId: "LP-1", fields: { documentUrl: "https://docs.qq.com/doc/a" } }),
    commandIntent: JSON.stringify({ operation: "revise", studentId: "STU-1", lpItemId: "LP-1", fields: { documentUrl: "https://docs.qq.com/doc/a" }, expectedVersions: { students: 1, lpItems: 1, tasks: 1, files: 1 } }),
    commandKey: "11111111-1111-4111-8111-111111111111",
    expectedVersions: { students: 1, lpItems: 1, tasks: 1, files: 1 },
  } as const;
  persistLpAtomicPendingCommands(backing, "Abby", [entry]);
  assert.equal(readLpAtomicPendingCommands(backing, "Abby").get(entry.intent)?.commandKey, entry.commandKey);
  const next = upsertLpAtomicPendingCommand(readLpAtomicPendingCommands(backing, "Abby").values(), { ...entry, commandKey: "22222222-2222-4222-8222-222222222222" });
  assert.equal(removeLpAtomicPendingCommand(next.values(), entry.intent).size, 0);
});

test("provisional intake keeps the server-generated student command key across reload", () => {
  const backing = storage();
  const provisionalIntake = { course: "Year 8 English", guardianWechat: "Daisy", owner: "Abby", planner: "Tara" };
  const fields = { responsibleOperations: "Abby" };
  const expectedVersions = { students: 2, lpItems: 3, tasks: 4, files: 5 };
  const entry = {
    intent: JSON.stringify({ operation: "create", provisionalIntake, workflowType: "试听 LP", fields }),
    commandIntent: JSON.stringify({ operation: "create", provisionalIntake, workflowType: "试听 LP", fields, expectedVersions }),
    commandKey: "33333333-3333-4333-8333-333333333333",
    expectedVersions,
  } as const;
  persistLpAtomicPendingCommands(backing, "Nixon", [entry]);
  assert.equal(readLpAtomicPendingCommands(backing, "Nixon").get(entry.intent)?.commandKey, entry.commandKey);
});
