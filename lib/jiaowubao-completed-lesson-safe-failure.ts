import { safeJiaowubaoCompletedLessonDatabaseFailure } from "@/lib/jiaowubao-completed-lesson-database-failure";
import { JiaowubaoOpenApiError } from "@/lib/jiaowubao-open-api-node";
import { OpsStoreError } from "@/lib/ops-store";

/**
 * Reduces a completed-lesson sync failure to fixed, non-sensitive diagnostics.
 * Database messages/details can contain implementation metadata and must never
 * cross this boundary.
 */
export function safeJiaowubaoCompletedLessonSyncFailure(error: unknown) {
  if (error instanceof JiaowubaoOpenApiError) {
    const source = error.tool === "query_lesson_list"
      ? "lessons"
      : error.tool === "query_schedule_list" ? "schedules" : undefined;
    return Object.freeze({
      kind: "open_api" as const,
      code: error.code,
      ...(source ? { source } : {}),
    });
  }
  if (error instanceof OpsStoreError) {
    return safeJiaowubaoCompletedLessonDatabaseFailure(error);
  }
  if (error instanceof Error
    && error.message.length <= 240
    && /^教务宝(?:已消课|已结课排课|排课|完成月度)/u.test(error.message)
    && !/[\u0000-\u001f\u007f<>]/u.test(error.message)) {
    return Object.freeze({ kind: "source_validation" as const, message: error.message });
  }
  return Object.freeze({ kind: "internal" as const });
}
