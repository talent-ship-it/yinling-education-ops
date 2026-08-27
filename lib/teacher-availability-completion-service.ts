import type {
  OpsStateRow,
  TeacherAvailabilityCompletionPendingTeacherIds,
} from "@/lib/ops-store";
import {
  assertValidTeacherAvailability,
  expandTeacherAvailability,
  localTimeToInstant,
  type TeacherAvailabilityWindow,
} from "@/lib/teacher-availability";

type RecordValue = Record<string, unknown>;

const MELBOURNE_TIMEZONE = "Australia/Melbourne";
/** Match the narrow client DTO cap before returning any roster names. */
const MAX_COMPLETION_TEACHERS = 1_000;
/** The DB reader fetches one extra ID and reports overflow instead of truncating. */
export const MAX_COMPLETION_PENDING_TEACHERS = 1_000;
/**
 * A teacher self-submission permits at most 64 monthly slots; this permits 16
 * full monthly sets while preventing one ever-growing historic 370-day-window
 * ledger from turning a read-only completion check into an unbounded scan.
 */
const MAX_COMPLETION_WINDOWS_PER_TEACHER = 1_024;

export type TeacherAvailabilityCompletionIssue = "missing" | "invalid";

export type TeacherAvailabilityCompletionItem = Readonly<{
  /** Used only by a host-owned navigation callback; it is never displayed here. */
  teacherId: string;
  teacherName: string;
  issue: TeacherAvailabilityCompletionIssue;
  /** A submission for this exact month exists but has not been approved yet. */
  pendingSubmission: boolean;
}>;

export type TeacherAvailabilityCompletionInbox = Readonly<{
  month: string;
  teacherVersion: number;
  summary: Readonly<{
    teachers: number;
    currentStructured: number;
    missing: number;
    invalid: number;
    pendingReview: number;
  }>;
  items: readonly TeacherAvailabilityCompletionItem[];
}>;

export type TeacherAvailabilityCompletionServiceErrorCode =
  | "invalid_month"
  | "invalid_teachers_state"
  | "invalid_pending_teacher_reader"
  | "too_many_teachers"
  | "too_many_pending_teachers";

export class TeacherAvailabilityCompletionServiceError extends Error {
  constructor(
    readonly code: TeacherAvailabilityCompletionServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TeacherAvailabilityCompletionServiceError";
  }
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function monthRange(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) {
    throw new TeacherAvailabilityCompletionServiceError(
      "invalid_month",
      "AVA 完整度月份格式无效。",
    );
  }
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (year < 1900 || monthNumber < 1 || monthNumber > 12) {
    throw new TeacherAvailabilityCompletionServiceError(
      "invalid_month",
      "AVA 完整度月份无效。",
    );
  }
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const nextMonth = monthNumber === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
  return {
    from: `${month}-01`,
    to: `${month}-${String(lastDay).padStart(2, "0")}`,
    nextMonth,
  };
}

function dateInTimezone(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (!year || !month || !day) throw new Error("无法解析 AVA 时区日期。");
  return `${year}-${month}-${day}`;
}

function shiftIsoDate(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function melbourneMonthInterval(month: string) {
  const range = monthRange(month);
  const startsAt = localTimeToInstant(range.from, "00:00", MELBOURNE_TIMEZONE, "earlier");
  const endsAt = localTimeToInstant(range.nextMonth, "00:00", MELBOURNE_TIMEZONE, "earlier");
  return { startsAt, endsAt };
}

function parseTeachersState(row: OpsStateRow | undefined) {
  if (!row
    || row.entity !== "teachers"
    || !Number.isSafeInteger(row.version)
    || row.version < 1
    || !Array.isArray(row.payload)) {
    throw new TeacherAvailabilityCompletionServiceError(
      "invalid_teachers_state",
      "老师目录暂时无法用于 AVA 完整度核对。",
    );
  }

  const ids = new Set<string>();
  if (row.payload.length > MAX_COMPLETION_TEACHERS) {
    throw new TeacherAvailabilityCompletionServiceError(
      "too_many_teachers",
      "老师目录超过 AVA 完整度安全上限，请由管理员分批核对。",
    );
  }
  const teachers = row.payload.map((value): Readonly<{
    id: string;
    name: string;
    availabilityWindows: unknown;
  }> => {
    if (!isRecord(value)
      || typeof value.id !== "string"
      || !value.id.trim()
      || typeof value.name !== "string"
      || !value.name.trim()) {
      throw new TeacherAvailabilityCompletionServiceError(
        "invalid_teachers_state",
        "老师目录包含无法识别的老师资料。",
      );
    }
    const id = value.id.trim();
    if (ids.has(id)) {
      throw new TeacherAvailabilityCompletionServiceError(
        "invalid_teachers_state",
        "老师目录包含重复老师编号。",
      );
    }
    ids.add(id);
    return {
      id,
      name: value.name.trim(),
      availabilityWindows: value.availabilityWindows,
    };
  });
  return { teacherVersion: row.version, teachers };
}

/**
 * Accept only the one narrow DB result used by this surface. A malformed or
 * overflowing reader result must never turn into a partial completion queue.
 */
function parsePendingTeacherIds(
  rows: readonly TeacherAvailabilityCompletionPendingTeacherIds[],
) {
  const reader = rows[0];
  if (!Array.isArray(rows) || rows.length !== 1 || !reader || !isRecord(reader)) {
    throw new TeacherAvailabilityCompletionServiceError(
      "invalid_pending_teacher_reader",
      "待审核 AVA 完整度读取结果无效。",
    );
  }
  if (reader.overflowed === true) {
    throw new TeacherAvailabilityCompletionServiceError(
      "too_many_pending_teachers",
      "待审核 AVA 老师超过安全上限，请由管理员分批核对。",
    );
  }
  if (reader.overflowed !== false || !Array.isArray(reader.pending_teacher_ids)) {
    throw new TeacherAvailabilityCompletionServiceError(
      "invalid_pending_teacher_reader",
      "待审核 AVA 完整度读取结果无效。",
    );
  }
  if (reader.pending_teacher_ids.length > MAX_COMPLETION_PENDING_TEACHERS) {
    throw new TeacherAvailabilityCompletionServiceError(
      "too_many_pending_teachers",
      "待审核 AVA 老师超过安全上限，请由管理员分批核对。",
    );
  }

  const teacherIds = new Set<string>();
  for (const value of reader.pending_teacher_ids) {
    if (typeof value !== "string" || !value.trim() || value.length > 240 || teacherIds.has(value.trim())) {
      throw new TeacherAvailabilityCompletionServiceError(
        "invalid_pending_teacher_reader",
        "待审核 AVA 老师编号无效。",
      );
    }
    teacherIds.add(value.trim());
  }
  return teacherIds;
}

function availabilityIssueForMonth(input: {
  teacherId: string;
  availabilityWindows: unknown;
  month: string;
}): TeacherAvailabilityCompletionIssue | null {
  if (input.availabilityWindows === undefined
    || (Array.isArray(input.availabilityWindows) && input.availabilityWindows.length === 0)) {
    return "missing";
  }
  if (!Array.isArray(input.availabilityWindows)) return "invalid";
  if (input.availabilityWindows.length > MAX_COMPLETION_WINDOWS_PER_TEACHER) return "invalid";

  try {
    const windows = input.availabilityWindows as TeacherAvailabilityWindow[];
    assertValidTeacherAvailability(windows);
    if (windows.some((window) => window.teacherId !== input.teacherId)) return "invalid";
    const interval = melbourneMonthInterval(input.month);
    const isCurrentInMelbourne = windows.some((window) => {
      // The source-date buffer is intentional: a local window that begins the
      // day before the Melbourne boundary may still end inside this month.
      const sourceFrom = dateInTimezone(interval.startsAt, window.timezone);
      const sourceTo = dateInTimezone(interval.endsAt, window.timezone);
      const from = [window.validFrom, shiftIsoDate(sourceFrom, -1)].sort().at(-1)!;
      const to = [window.validTo, sourceTo].sort()[0]!;
      if (from > to) return false;
      return expandTeacherAvailability([window], {
        from,
        to,
        displayTimezone: MELBOURNE_TIMEZONE,
      }).some((occurrence) => {
        const startsAt = new Date(occurrence.startsAt).getTime();
        const endsAt = new Date(occurrence.endsAt).getTime();
        return startsAt < interval.endsAt.getTime() && endsAt > interval.startsAt.getTime();
      });
    });
    return isCurrentInMelbourne ? null : "missing";
  } catch {
    return "invalid";
  }
}

/**
 * Builds an admin-only, read-only completion queue from the authoritative
 * teacher directory. It never interprets legacy text or schedules as AVA. A
 * server-filtered pending self-submission is shown only as a review state,
 * never as an approved availability window. Historical submission content is
 * not read by this service.
 */
export function buildTeacherAvailabilityCompletionInbox(input: {
  month: string;
  teachersRow: OpsStateRow | undefined;
  pendingTeacherRows: readonly TeacherAvailabilityCompletionPendingTeacherIds[];
}): TeacherAvailabilityCompletionInbox {
  monthRange(input.month);
  const teachersState = parseTeachersState(input.teachersRow);
  const knownTeacherIds = new Set(teachersState.teachers.map((teacher) => teacher.id));
  const pendingTeacherIds = parsePendingTeacherIds(input.pendingTeacherRows);
  pendingTeacherIds.forEach((teacherId) => {
    if (!knownTeacherIds.has(teacherId)) {
      throw new TeacherAvailabilityCompletionServiceError(
        "invalid_pending_teacher_reader",
        "待审核 AVA 没有对应的当前老师资料。",
      );
    }
  });

  let currentStructured = 0;
  let missing = 0;
  let invalid = 0;
  const items = teachersState.teachers.flatMap((teacher): TeacherAvailabilityCompletionItem[] => {
    const issue = availabilityIssueForMonth({
      teacherId: teacher.id,
      availabilityWindows: teacher.availabilityWindows,
      month: input.month,
    });
    if (!issue) {
      currentStructured += 1;
      return [];
    }
    if (issue === "missing") missing += 1;
    else invalid += 1;
    return [{
      teacherId: teacher.id,
      teacherName: teacher.name,
      issue,
      pendingSubmission: pendingTeacherIds.has(teacher.id),
    }];
  }).sort((left, right) =>
    Number(right.pendingSubmission) - Number(left.pendingSubmission)
    || Number(right.issue === "invalid") - Number(left.issue === "invalid")
    || left.teacherName.localeCompare(right.teacherName, "zh-CN"),
  );

  return {
    month: input.month,
    teacherVersion: teachersState.teacherVersion,
    summary: {
      teachers: teachersState.teachers.length,
      currentStructured,
      missing,
      invalid,
      pendingReview: items.filter((item) => item.pendingSubmission).length,
    },
    items,
  };
}
