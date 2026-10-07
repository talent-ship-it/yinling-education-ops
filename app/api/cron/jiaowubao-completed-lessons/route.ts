import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { parseJiaowubaoCompletedLessonCronOperation, readJiaowubaoCompletedLessonPendingMonth } from "@/lib/jiaowubao-completed-lesson-cron-request";
import { syncJiaowubaoCompletedLessonMonth } from "@/lib/jiaowubao-completed-lesson-resumable-sync";
import { safeJiaowubaoCompletedLessonSyncFailure } from "@/lib/jiaowubao-completed-lesson-safe-failure";
import { getJiaowubaoCompletedLessonPendingMonth } from "@/lib/ops-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const TIME_ZONE = "Australia/Melbourne";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function hasCronSecret(request: Request) {
  // This is deliberately independent from the schedule-sync credential: a
  // database job must only be able to invoke the completed-lesson source.
  const expected = process.env.JIAOWUBAO_COMPLETED_LESSON_SYNC_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function currentMelbourneMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const month = `${values.year}-${values.month}`;
  if (!/^\d{4}-\d{2}$/u.test(month)) throw new Error("melbourne_clock_invalid");
  return month;
}

function previousMelbourneMonth(now = new Date()) {
  const current = currentMelbourneMonth(now);
  const date = new Date(`${current}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
}

export async function GET(request: Request) {
  if (!hasCronSecret(request)) return noStore({ error: "Not found" }, 404);
  const operation = parseJiaowubaoCompletedLessonCronOperation(request.url);
  if (!operation) return noStore({ error: "Not found" }, 404);
  let month = operation.month ?? previousMelbourneMonth();
  try {
    if (!operation.force) {
      const pending = readJiaowubaoCompletedLessonPendingMonth(await getJiaowubaoCompletedLessonPendingMonth({ actor: "Ops Admin" }));
      if (pending.month === null) return noStore({ outcome: "no_change", month });
      month = pending.month;
    }
    const sync = await syncJiaowubaoCompletedLessonMonth({
      month,
      force: operation.force,
      forceIfBlockedOnly: operation.force,
    });
    const status = sync.outcome === "blocked" ? 409
      : sync.outcome === "already_running" || sync.outcome === "in_progress" ? 202 : 200;
    return noStore(sync, status);
  } catch (error) {
    // Keep source details, credentials, upstream response text, and database
    // errors out of this bearer-protected scheduler response and logs.
    console.error("jiaowubao_completed_lesson_cron_failed", {
      month,
      failure: safeJiaowubaoCompletedLessonSyncFailure(error),
    });
    return noStore({ error: "教务宝已消课同步未完成；系统会在下一次计划任务重试。" }, 503);
  }
}
