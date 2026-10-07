import { validateJiaowubaoClosedCompletedLessonMonth } from "@/lib/jiaowubao-completed-lessons";

export type JiaowubaoCompletedLessonCronOperation = Readonly<{
  force: boolean;
  month: string | null;
}>;

/**
 * Ordinary scheduler requests have no query. Recovery requests must name one
 * exact closed month so the bearer can never force whichever run happens to
 * be next in the database queue.
 */
export function parseJiaowubaoCompletedLessonCronOperation(
  requestUrl: string,
  now = new Date(),
): JiaowubaoCompletedLessonCronOperation | null {
  let params: URLSearchParams;
  try {
    params = new URL(requestUrl).searchParams;
  } catch {
    return null;
  }
  if (params.size === 0) return Object.freeze({ force: false, month: null });
  const month = params.get("month");
  if (params.size !== 2
    || params.getAll("force").length !== 1
    || params.get("force") !== "1"
    || params.getAll("month").length !== 1
    || typeof month !== "string") return null;
  try {
    return Object.freeze({ force: true, month: validateJiaowubaoClosedCompletedLessonMonth(month, now).month });
  } catch {
    return null;
  }
}

export function readJiaowubaoCompletedLessonPendingMonth(value: unknown) {
  const month = (value as { month?: unknown } | null)?.month;
  if (month === null || typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) {
    return Object.freeze({ month });
  }
  throw new Error("jiaowubao_completed_lesson_pending_month_invalid");
}
