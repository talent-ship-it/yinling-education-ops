import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sqlRuntimeFixtures } from "./sql/runtime-fixtures.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261021130241_lp_business_handover_types.sql", import.meta.url), "utf8");

test("business handover confirmation has one compatible signature and preserves its secret and scope gates", () => {
  assert.match(migration, /drop function public\.confirm_wecom_lp_draft_atomic\(text,uuid,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,boolean\);/u);
  assert.match(migration, /p_workflow_type text default '试听 LP'/u);
  const start = migration.indexOf("create function public.confirm_wecom_lp_draft_atomic(");
  const body = migration.slice(start, migration.indexOf("$$;", start));
  assert.match(body, /internal\.verify_ops_secret\(p_secret\)/u);
  assert.match(body, /wecom_lp_owner_scope_forbidden/u);
  assert.match(body, /wecom_lp_student_scope_forbidden/u);
  assert.match(body, /wecom_lp_source_changed/u);
  assert.match(body, /p_workflow_type <> '试听 LP' and p_new_student is not null/u);
  assert.match(migration, /revoke all on function internal\.resolve_wecom_lp_business_identity\(\) from public, anon, authenticated, service_role/u);
  assert.match(migration, /alter table internal\.wecom_lp_business_sources enable row level security/u);
  assert.match(migration, /num_nonnulls\(case_id,business_case_id\) = 1/u);
  assert.match(migration, /foreign key \(source_message_id,business_case_id\)/u);
  assert.doesNotMatch(migration, /grant execute[^;]+to[^;]*service_role/su);
});

test("the release gate registers local behavioral acceptance for template routing, retries, tasks and identity ambiguity", () => {
  const fixture = sqlRuntimeFixtures.find(({ id }) => id === "wecom-lp-business-handover");
  assert.ok(fixture);
  assert.ok(fixture.steps.some(({ file }) => file.endsWith("20261021130241_lp_business_handover_types.sql")));
  const runtime = readFileSync(new URL("./sql/wecom-lp-business-handover-runtime.sql", import.meta.url), "utf8");
  for (const expectation of [
    "legacy_confirmation_default_type_replay_failed",
    "unique_student_business_source_without_wechat_not_eligible",
    "business_sources_missing_from_range_reader",
    "old_student_lp_full_intake_or_n_plus_two_missing",
    "repeat_trial_generated_initial_trial_intake",
    "lp_modification_immediate_or_weekly_review_missing",
    "ambiguous_business_identity_auto_bound",
    "ambiguous_business_manual_confirmation_failed",
    "business_without_guardian_hidden_or_fabricated_wechat",
    "independent_business_source_missing_from_scoped_readers",
    "independent_business_case_not_bound_to_source_fk",
  ]) assert.ok(runtime.includes(expectation), expectation);
});
