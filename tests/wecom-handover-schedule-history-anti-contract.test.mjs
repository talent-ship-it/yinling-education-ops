import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sqlRuntimeFixtures } from "./sql/runtime-fixtures.mjs";

const before = readFileSync(new URL("../supabase/migrations/20261021094454_version_wecom_handover_schedule_evidence.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20261021112432_avoid_wecom_schedule_current_key_nested_loop.sql", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./sql/wecom-handover-schedule-history-anti-runtime.sql", import.meta.url), "utf8");

test("history anti lookup changes only the current-source suppression expression", () => {
  const reader = before.slice(before.indexOf("create or replace function public.read_wecom_handover_schedule_input("),
    before.indexOf("\ncreate or replace function internal.wecom_schedule_account_letter"));
  const original = "    select i.* from candidate_items i left join current_source_keys current_item on current_item.source_key=i.source_key\n"
    + "    where i.id = current_run or (i.latest_run_id = i.id and current_item.source_key is null)";
  const replacement = "    select i.* from candidate_items i\n"
    + "    where i.id = current_run or (i.latest_run_id = i.id and not exists(\n"
    + "      select 1 from current_source_keys current_item where current_item.source_key=i.source_key))";
  assert.ok(reader.includes(original));
  assert.equal(migration, reader.replace(original, replacement));
});

test("release SQL fixture checks full input parity and authoritative suppression edge cases", () => {
  assert.deepEqual(sqlRuntimeFixtures.find(({ id }) => id === "wecom-handover-schedule-history-anti")?.steps,
    [{ kind: "sql", file: "tests/sql/wecom-handover-schedule-history-anti-runtime.sql" }]);
  for (const condition of ["anti_complete_projection_input_changed", "anti_reader_modified_native_evidence",
    "anti_rpc_local_budgets_changed", "anti_rpc_privileges_changed", "anti_reader_secret_guard_missing",
    "anti_current_outside_nontrial_key_did_not_suppress_history", "anti_empty_current_run_changed_coverage_or_revived_history",
    "anti_nontrial_missing_latest_was_accepted", "anti_invalid_source_was_filtered"]) assert.ok(runtime.includes(condition), condition);
  assert.match(runtime, /array\['force_custom_plan','force_generic_plan'\]/u);
});
