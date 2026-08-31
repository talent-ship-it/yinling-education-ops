import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/20260828000200_trial_manual_tasks_atomic.sql", import.meta.url),
  "utf8",
);
const evidencePreservationMigration = readFileSync(
  new URL("../supabase/migrations/20260828000300_preserve_trial_legacy_evidence.sql", import.meta.url),
  "utf8",
);
const handbookTitlesMigration = readFileSync(
  new URL("../supabase/migrations/20260828000400_align_trial_handbook_task_titles.sql", import.meta.url),
  "utf8",
);
const followUpDefaultsMigration = readFileSync(
  new URL("../supabase/migrations/20260829000200_trial_handbook_follow_up_defaults.sql", import.meta.url),
  "utf8",
);
const schedulingPolicyMigration = readFileSync(
  new URL("../supabase/migrations/20260831000100_trial_scheduling_policy.sql", import.meta.url),
  "utf8",
);
const schedulingFeedbackMigration = readFileSync(
  new URL("../supabase/migrations/20260831001100_restore_trial_scheduling_feedback_chain.sql", import.meta.url),
  "utf8",
);
const runtimeFixture = readFileSync(
  new URL("./sql/trial-manual-lp-atomic-runtime.sql", import.meta.url),
  "utf8",
);
const client = readFileSync(new URL("../app/operations-client.tsx", import.meta.url), "utf8");

test("trial handbook intake and task projection stay inside the LP transaction", () => {
  assert.match(migration, /rename to mutate_lp_atomic_before_trial_manual_tasks/i);
  assert.match(migration, /create or replace function public\.mutate_lp_atomic\(/i);
  assert.match(migration, /p_command_intent -> 'fields' is distinct from p_fields/i);
  assert.match(migration, /delegated_fields := \([\s\S]*p_fields - array\[/i);
  assert.match(migration, /specifiedContentStatus' = '需教务跟进'[\s\S]*specifiedContentStatus', '需要跟进'/i);
  assert.match(migration, /select \* into delegated[\s\S]*mutate_lp_atomic_before_trial_manual_tasks/i);
  assert.match(migration, /select \* into l from public\.ops_state where entity = 'lpItems' for update/i);
  assert.match(migration, /select \* into t from public\.ops_state where entity = 'tasks' for update/i);
  assert.match(migration, /'fields', full_fields,[\s\S]*'requestedAt',[\s\S]*'trialIntake', trial_intake/i);
  assert.match(migration, /update public\.ops_state[\s\S]*where entity = 'lpItems'/i);
  assert.match(migration, /update public\.ops_state[\s\S]*where entity = 'tasks'/i);
  assert.match(migration, /insert into internal\.trial_lp_atomic_intents/i);
});

test("the atomic projection removes open legacy rules and creates the complete handbook chain", () => {
  for (const rule of [
    "trial.parent-follow-up",
    "trial.scheduling",
    "trial.parent-no-reply-follow-up",
    "trial.teaching-control-escalation",
    "trial.parent-progress-sync.1",
  ]) assert.match(migration, new RegExp(rule.replaceAll(".", "\\.")));

  for (const rule of [
    "trial.manual-request.specified-content",
    "trial.manual-request.writing",
    "trial.manual-request.paper-send",
    "trial.manual-request.paper-receive",
    "trial.manual-request.parent-progress-24h",
    "trial.manual-request.scheduling-alert-36h",
    "trial.manual-request.parent-progress-48h",
  ]) assert.match(migration, new RegExp(rule.replaceAll(".", "\\.")));

  assert.match(migration, /request_at \+ interval '24 hours'/i);
  assert.match(migration, /request_at \+ interval '36 hours'/i);
  assert.match(migration, /request_at \+ interval '48 hours'/i);
  assert.match(migration, /specifiedContentStatus' in \('需要跟进', '需教务跟进'\)/i);
  assert.match(migration, /internal\.trial_manual_task_id\(delegated\.lp_item_id, rule\)/i);
});

test("open manual trial tasks use every title confirmed word-for-word in the handbook", () => {
  for (const title of [
    "【要指定内容】",
    "【要写作】",
    "【发试卷】",
    "【收试卷】",
    "【向家长交待排课进度】",
    "【试听排课进度反常】",
    "【二次向家长交待排课进度】",
  ]) assert.match(handbookTitlesMigration, new RegExp(title));
  assert.match(handbookTitlesMigration, /guardianWechat/);
  assert.match(handbookTitlesMigration, /coalesce\(task\.value ->> 'status', ''\) <> 'done'/);
  assert.match(handbookTitlesMigration, /mutate_lp_atomic_before_trial_handbook_titles/);
});

test("new trials default their result and defer 收试卷 until 发试卷 is actually completed", () => {
  assert.match(followUpDefaultsMigration, /resultStatus', '试听未进行'/);
  assert.match(followUpDefaultsMigration, /trial\.manual-request\.paper-receive/);
  assert.match(followUpDefaultsMigration, /trial\.manual-request\.paper-send/);
  assert.match(followUpDefaultsMigration, /closedAt[\s\S]*interval '24 hours'/);
  assert.match(followUpDefaultsMigration, /coalesce\(task\.value ->> 'status', ''\) <> 'done'/);
  assert.match(followUpDefaultsMigration, /not \(task\.value \? 'legacyEvidence'\)/);
});

test("the latest scheduling policy creates one JWB-controlled pending task and retires superseded chains", () => {
  assert.match(schedulingPolicyMigration, /trial_scheduling_policy_tasks/);
  assert.match(schedulingPolicyMigration, /【试听待排课】/);
  assert.match(schedulingPolicyMigration, /internal\.trial_manual_task_id\(p_lp_item_id, 'trial\.scheduling'\)/);
  assert.match(schedulingPolicyMigration, /trial\.manual-request\.parent-progress-24h/);
  for (const retiredRule of [
    "trial.manual-request.scheduling-alert-36h",
    "trial.manual-request.parent-progress-48h",
    "trial.jiaowubao.teacher-reply-4h",
    "trial.jiaowubao.teacher-reply-8h",
  ]) assert.match(schedulingPolicyMigration, new RegExp(retiredRule.replaceAll(".", "\\.")));
  assert.match(schedulingPolicyMigration, /coalesce\(task\.value ->> 'status', ''\) <> 'done'/);
  assert.match(schedulingPolicyMigration, /not \(task\.value \? 'legacyEvidence'\)/);
  assert.match(schedulingPolicyMigration, /mutate_lp_atomic_before_trial_scheduling_policy/);
  assert.match(schedulingPolicyMigration, /jiaowubao_trial_sync_manual_completion_valid/);
});

test("the boss-confirmed scheduling feedback restores 24h, 48h, and 72h tasks", () => {
  assert.match(schedulingFeedbackMigration, /trial_scheduling_policy_tasks/);
  assert.match(schedulingFeedbackMigration, /trial\.manual-request\.parent-progress-24h/);
  assert.match(schedulingFeedbackMigration, /trial\.manual-request\.parent-progress-48h/);
  assert.match(schedulingFeedbackMigration, /trial\.manual-request\.scheduling-anomaly-72h/);
  assert.match(schedulingFeedbackMigration, /interval '24 hours'/i);
  assert.match(schedulingFeedbackMigration, /interval '48 hours'/i);
  assert.match(schedulingFeedbackMigration, /【向家长交待排课进度】/);
  assert.match(schedulingFeedbackMigration, /【二次向家长交待排课进度】/);
  assert.match(schedulingFeedbackMigration, /【试听排课进度反常】/);
  assert.match(schedulingFeedbackMigration, /jiaowubao_trial_sync_manual_completion_valid/);
  assert.doesNotMatch(schedulingFeedbackMigration, /teacher-reply-[48]h/);
});

test("trial task replacement preserves unrelated legacy evidence with sparse metadata", () => {
  assert.match(evidencePreservationMigration, /create or replace function public\.mutate_lp_atomic\(/i);
  assert.match(evidencePreservationMigration, /not exists \([\s\S]*internal\.legacy_task_deadline_freezes evidence[\s\S]*evidence\.task_id = task\.value ->> 'id'/i);
  assert.match(evidencePreservationMigration, /coalesce\(task\.value ->> 'anchorBookingId', ''\) = delegated\.lp_item_id/i);
  assert.match(evidencePreservationMigration, /coalesce\(task\.value ->> 'status', ''\) <> 'done'/i);
  assert.match(evidencePreservationMigration, /coalesce\(task\.value ->> 'ruleKey', ''\) in \(/i);
  assert.match(evidencePreservationMigration, /coalesce\(task\.value ->> 'ruleKey', ''\) like 'trial\.manual-request\.%'/i);
  assert.match(runtimeFixture, /fixture_enforce_legacy_task_evidence/i);
  assert.match(runtimeFixture, /legacy_task_evidence_delete_forbidden/i);
  assert.match(runtimeFixture, /TSK-LEGACY-SPARSE/i);
  assert.match(runtimeFixture, /TSK-LEGACY-MATCH[\s\S]*trial\.parent-follow-up[\s\S]*LP-ATOMIC-a8f78ee5b2f178415038e032/i);
});

test("the browser sends one complete command and performs no post-commit trial repair", () => {
  assert.match(client, /const fields = parsedLp\.fields as LpFieldValues/);
  assert.match(client, /试听 LP 和所需任务已保存/);
  assert.doesNotMatch(client, /24\/36\/48 小时任务已保存/);
  assert.doesNotMatch(client, /trialAtomicFields/);
  assert.doesNotMatch(client, /generateTrialManualRequestTasks/);

  const submitLp = client.slice(
    client.indexOf("const submitLp = async"),
    client.indexOf("const submitLpRevision = async"),
  );
  const applied = submitLp.slice(
    submitLp.indexOf("studentsShared.applyRemote(body.studentsRow"),
    submitLp.indexOf("lpAtomicCommandKeysRef.current = removeLpAtomicPendingCommand"),
  );
  assert.doesNotMatch(applied, /mutateAndCommit/);
});
