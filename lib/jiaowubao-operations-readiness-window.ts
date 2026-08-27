/** The server accepts a maximum 63-day, canonical UTC review window. */
export const JIAOWUBAO_OPERATIONS_READINESS_WINDOW_DAYS = 63;

export type JiaowubaoOperationsReadinessWindow = Readonly<{
  startsAt: string;
  endsAt: string;
}>;

/**
 * Freeze the dashboard review at the current UTC day boundary. Using UTC here
 * keeps the browser's query canonical and avoids daylight-saving arithmetic.
 */
export function buildJiaowubaoOperationsReadinessWindow(
  now: Date = new Date(),
): JiaowubaoOperationsReadinessWindow {
  const startsAt = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0,
  ));
  const endsAt = new Date(startsAt.getTime() + JIAOWUBAO_OPERATIONS_READINESS_WINDOW_DAYS * 24 * 60 * 60 * 1_000);
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}
