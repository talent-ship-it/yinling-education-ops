export const sqlRuntimeFixtures = Object.freeze([
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
