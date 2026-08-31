import type { LegacyTaskDeadlineServiceError } from "@/lib/legacy-task-deadline-service";

export type LegacyTaskDeadlineHttpError = Readonly<{
  status: number;
  body: Readonly<{ error: string; code: LegacyTaskDeadlineServiceError["code"] }>;
}>;

/** Pure mapping used by the route so status/code behavior is runtime-testable. */
export function legacyTaskDeadlineHttpError(
  error: LegacyTaskDeadlineServiceError,
): LegacyTaskDeadlineHttpError {
  let status = 422;
  if (error.code === "teacher_forbidden"
    || error.code === "admin_forbidden"
    || error.code === "archived_student_read_only") status = 403;
  else if (error.code === "task_not_found") status = 404;
  else if (["stale_expected_version", "task_not_legacy", "task_closed"].includes(error.code)) status = 409;
  else if (error.code === "invalid_shared_state") status = 503;
  return { status, body: { error: error.message, code: error.code } };
}
