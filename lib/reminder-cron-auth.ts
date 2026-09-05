import { timingSafeEqual } from "node:crypto";

type ReminderCronEnvironment = {
  OPS_REMINDER_CRON_SECRET?: string;
  CRON_SECRET?: string;
};

export function hasReminderCronSecret(
  request: Request,
  environment: ReminderCronEnvironment = {
    OPS_REMINDER_CRON_SECRET: process.env.OPS_REMINDER_CRON_SECRET,
    CRON_SECRET: process.env.CRON_SECRET,
  },
) {
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!supplied) return false;
  const suppliedBytes = Buffer.from(supplied);
  // pg_cron has its own credential; preserve existing Vercel Cron callers.
  return [environment.OPS_REMINDER_CRON_SECRET, environment.CRON_SECRET].some((expected) => {
    if (!expected) return false;
    const expectedBytes = Buffer.from(expected);
    return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
  });
}
