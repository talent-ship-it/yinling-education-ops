const SAFE_DATABASE_FAILURE_CODES = new Map<string, string>([
  ["jiaowubao_completed_lesson_member_page_invalid", "member_page_invalid"],
  ["jiaowubao_completed_lesson_member_run_not_collecting", "member_run_not_collecting"],
  ["jiaowubao_completed_lesson_worker_lease_invalid", "worker_lease_invalid"],
  ["jiaowubao_completed_lesson_member_page_conflict", "member_page_conflict"],
  ["jiaowubao_completed_lesson_member_cursor_conflict", "member_cursor_conflict"],
  ["jiaowubao_completed_lesson_member_page_count_conflict", "member_page_count_conflict"],
  ["jiaowubao_completed_lesson_snapshot_page_invalid", "snapshot_page_invalid"],
  ["jiaowubao_completed_lesson_member_page_identity_conflict", "member_page_identity_conflict"],
  ["jiaowubao_completed_lesson_member_rows_oversize", "member_rows_oversize"],
]);

/**
 * Reduces a database failure to a fixed category and ignores every other
 * property, including database details, constraints, and source values.
 */
export function safeJiaowubaoCompletedLessonDatabaseFailure(
  error: Readonly<{ code?: unknown; message?: unknown }>,
) {
  const fixedCode = typeof error.message === "string"
    ? SAFE_DATABASE_FAILURE_CODES.get(error.message)
    : undefined;
  const boundedCode = typeof error.code === "string"
    && /^(?:[0-9A-Z]{5}|PGRST[0-9]{3}|timeout|missing_configuration)$/u.test(error.code)
    ? error.code
    : "other";

  return Object.freeze({
    kind: "database" as const,
    code: fixedCode ?? boundedCode,
  });
}
