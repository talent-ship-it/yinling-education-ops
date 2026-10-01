export const sqlRuntimeFixtures = Object.freeze([
  { id: "completed-hour-review", source: "tests/sql/completed-hour-review-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/completed-hour-review-setup.sql" },
    { kind: "sql-fragment", file: "supabase/migrations/20260813013935_operational_atomic_contracts.sql",
      start: "create or replace function internal.student_import_display_name(p_name text)",
      end: "create or replace function internal.student_import_is_manual_trial(p_student jsonb)" },
    { kind: "sql-fragment", file: "supabase/migrations/20260817000300_enforce_exact_student_jwb_name_match.sql",
      start: "create or replace function internal.student_import_name_key(p_name text)",
      end: "create or replace function internal.student_import_master_review_name_key(p_name text)" },
    { kind: "sql-fragment", file: "supabase/migrations/20260817000500_review_jwb_latin_parenthetical_annotations.sql",
      start: "create or replace function internal.student_import_ascii_latin_letters(",
      end: "create or replace function internal.student_import_jwb_annotation_relaxed_name_key(" },
    { kind: "sql", file: "supabase/migrations/20261001000200_completed_hour_review_evidence.sql" },
    { kind: "sql", file: "tests/sql/completed-hour-review-runtime.sql" },
  ] },
  { id: "booking-projection-atomic", source: "tests/sql/booking-projection-atomic-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/booking-projection-atomic-runtime.sql" },
  ] },
  { id: "business-lifecycle", source: "tests/sql/business-lifecycle-runtime.ts", steps: [
    { kind: "typescript", file: "tests/sql/business-lifecycle-runtime.ts", databaseArgument: true },
  ] },
  { id: "classroom-end-recovery", source: "tests/sql/classroom-end-recovery-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/classroom-end-recovery-runtime.sql" },
  ] },
  { id: "jiaowubao-live-teacher-subject-observations", source: "tests/sql/jiaowubao-live-teacher-subject-observations-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/jiaowubao-live-teacher-subject-observations-runtime.sql" },
  ] },
  { id: "jiaowubao-schedule-identity-reader", source: "tests/sql/jiaowubao-schedule-identity-reader-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/jiaowubao-schedule-identity-reader-setup.sql" },
    { kind: "sql", file: "supabase/migrations/20260923000100_read_jiaowubao_schedule_snapshot_identities.sql" },
    { kind: "sql", file: "tests/sql/jiaowubao-schedule-identity-reader-runtime.sql" },
  ] },
  { id: "jiaowubao-schedule-projection-jobs", source: "tests/sql/jiaowubao-schedule-projection-jobs-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/jiaowubao-schedule-projection-jobs-setup.sql" },
    { kind: "sql", file: "supabase/migrations/20260923000200_jiaowubao_schedule_projection_jobs.sql" },
    { kind: "sql", file: "tests/sql/jiaowubao-schedule-projection-jobs-runtime.sql" },
  ] },
  { id: "jiaowubao-schedule-horizon-resume", source: "tests/sql/jiaowubao-schedule-horizon-resume-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/jiaowubao-schedule-horizon-resume-setup.sql" },
    { kind: "sql", file: "supabase/migrations/20261001000100_resume_jiaowubao_schedule_horizon.sql" },
    { kind: "sql", file: "tests/sql/jiaowubao-schedule-horizon-resume-runtime.sql" },
  ] },
  { id: "jiaowubao-trial-lifecycle", source: "tests/sql/jiaowubao-trial-lifecycle-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/jiaowubao-trial-lifecycle-runtime.sql" },
  ] },
  { id: "lesson-joint-attendance", source: "tests/sql/lesson-joint-attendance-runtime.ts", steps: [
    { kind: "sql", file: "tests/sql/booking-projection-atomic-runtime.sql" },
    { kind: "sql", file: "tests/sql/settlement-runtime-bootstrap.sql" },
    { kind: "sql", file: "supabase/migrations/20260728042500_add_student_fu_attachments.sql" },
    { kind: "sql", file: "supabase/migrations/20260813013935_operational_atomic_contracts.sql" },
    { kind: "sql", file: "supabase/migrations/20260907000300_manual_settlement_minutes.sql" },
    { kind: "sql", file: "supabase/migrations/20260922082015_lesson_joint_attendance_validation.sql" },
    { kind: "typescript-sql", file: "tests/sql/lesson-joint-attendance-runtime.ts" },
  ] },
  { id: "lp-atomic", source: "tests/sql/lp-atomic-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/lp-atomic-runtime.sql" },
  ] },
  { id: "lp-parent-progress-scheduler", source: "tests/sql/lp-parent-progress-scheduler-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/lp-parent-progress-scheduler-runtime.sql" },
  ] },
  { id: "renewal-follow-up-create-if-missing", source: "tests/sql/renewal-follow-up-create-if-missing-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/renewal-follow-up-create-if-missing-runtime.sql" },
  ] },
  { id: "requirements-input", source: "tests/sql/requirements-input-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/booking-projection-atomic-runtime.sql" },
    { kind: "sql", file: "supabase/migrations/20260907000100_booking_custom_duration.sql" },
    { kind: "sql", file: "supabase/migrations/20260907000200_teacher_leave_requests.sql" },
    { kind: "sql", file: "tests/sql/requirements-input-runtime.sql" },
  ] },
  { id: "requirements-settlement", source: "tests/sql/requirements-settlement-runtime.ts", steps: [
    { kind: "sql", file: "tests/sql/booking-projection-atomic-runtime.sql" },
    { kind: "sql", file: "tests/sql/settlement-runtime-bootstrap.sql" },
    { kind: "sql", file: "supabase/migrations/20260728042500_add_student_fu_attachments.sql" },
    { kind: "sql", file: "supabase/migrations/20260813013935_operational_atomic_contracts.sql" },
    { kind: "sql", file: "supabase/migrations/20260907000300_manual_settlement_minutes.sql" },
    { kind: "typescript-sql", file: "tests/sql/requirements-settlement-runtime.ts" },
  ] },
  { id: "retired-staff-assignment", source: "tests/sql/retired-staff-assignment-runtime.sql", steps: [
    { kind: "typescript", file: "tests/sql/business-lifecycle-runtime.ts", databaseArgument: true },
    { kind: "sql", file: "tests/sql/retired-staff-runtime-bootstrap.sql" },
    { kind: "sql", file: "tests/sql/retired-staff-assignment-runtime.sql" },
  ] },
  { id: "staff-identity-contract", source: "tests/sql/staff-identity-contract-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/staff-identity-contract-runtime.sql" },
  ] },
  { id: "student-operation-atomic", source: "tests/sql/student-operation-atomic-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/student-operation-atomic-runtime.sql" },
  ] },
  { id: "tencent-trial-ledger-recovery", source: "tests/sql/tencent-trial-ledger-recovery-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/tencent-trial-ledger-recovery-runtime.sql" },
  ] },
  { id: "trial-manual-lp-atomic", source: "tests/sql/trial-manual-lp-atomic-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/trial-manual-lp-atomic-runtime.sql" },
  ] },
  { id: "trial-payment-reminders", source: "tests/sql/trial-payment-reminders-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/trial-payment-reminders-setup.sql" },
    {
      kind: "sql-fragment",
      file: "supabase/migrations/20260827000900_account_lifecycle_security_hardening.sql",
      start: "create or replace function public.complete_trial_payment_task_tx(",
    },
    { kind: "sql", file: "tests/sql/trial-payment-reminders-runtime.sql" },
  ] },
  { id: "wecom-batch-lock-order", source: "tests/sql/wecom-batch-lock-order-runtime.py", steps: [
    { kind: "python", file: "tests/sql/wecom-batch-lock-order-runtime.py" },
  ] },
  { id: "wecom-case-pagination", source: "tests/sql/wecom-case-pagination-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/wecom-case-pagination-runtime.sql" },
  ] },
  { id: "wecom-receiver-health", source: "tests/sql/wecom-receiver-health-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/wecom-receiver-health-runtime.sql" },
  ] },
  { id: "wecom-trial-handover-identity", source: "tests/sql/wecom-trial-handover-identity-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/wecom-trial-handover-identity-runtime.sql" },
  ] },
  { id: "wecom-trial-handover-tolerant-identity", source: "tests/sql/wecom-trial-handover-tolerant-identity-runtime.sql", steps: [
    { kind: "sql", file: "tests/sql/wecom-trial-handover-tolerant-identity-runtime.sql" },
  ] },
]);
