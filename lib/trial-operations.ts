import {
  DEFAULT_TEACHING_CONTROL_WATCHER,
  deterministicTaskId,
  formatTaskDeadline,
  isFrozenLegacyTask,
  sortTasksByDueAt,
  statusForDueAt,
  TRIAL_PARENT_REPLIED_ESCALATION_CLOSED_RESULT,
  type OpsTask,
  type TaskTone,
} from "./ops-tasks";
import {
  TRIAL_PAYMENT_METHODS,
  type LpFieldValues,
  type TrialPaymentMethod,
} from "./lp-workflows";

export const TRIAL_PLANNERS = ["Tara", "Eileen", "Abby"] as const;
export type TrialPlanner = (typeof TRIAL_PLANNERS)[number];

export const TRIAL_DURATIONS = [60, 45] as const;
export type TrialDurationMinutes = (typeof TRIAL_DURATIONS)[number];

export type TrialIntake = Readonly<{
  planner: TrialPlanner;
  requestSentAt: string;
  contactParents: boolean;
  contactStudent: boolean;
  contactNote?: string;
  writingRequired: boolean;
  writingNote?: string;
  paperRequired: boolean;
  paperNote?: string;
  preparationNote?: string;
  studentName?: string;
  trialDurationMinutes: TrialDurationMinutes;
  trialDurationNote?: string;
}>;

export const TRIAL_INTAKE_FIELD_KEYS = Object.freeze([
  "planner",
  "requestSentAt",
  "contactParents",
  "contactStudent",
  "contactNote",
  "writingRequired",
  "writingNote",
  "paperRequired",
  "paperNote",
  "preparationNote",
  "studentName",
  "trialDurationMinutes",
  "trialDurationNote",
] as const);

export type JiaowubaoTrialPlannerHint = TrialPlanner | null;

export type TrialScheduleLink = Readonly<{
  source: "jiaowubao-open-api";
  /** Immutable publication used to derive this link; absent only on legacy rows. */
  sourceRevision?: string;
  eventId: string;
  startsAt: string;
  endsAt: string;
  courseName: string | null;
  /** Student name deterministically extracted from the verified course title. */
  studentName: string;
  teacherId: string | null;
  teacherName: string;
  plannerHint: JiaowubaoTrialPlannerHint;
  matchedAt: string;
}>;

export type TrialScheduleEventLike = Readonly<{
  eventId: string;
  startsAt: string;
  endsAt: string;
  courseName: string | null;
  teacherId: string | null;
  teacherName?: string | null;
  visibleStudentIds: readonly string[];
  trialPlannerHint?: JiaowubaoTrialPlannerHint;
}>;

export type TrialScheduleMatch = Readonly<{
  lpItemId: string;
  studentId: string;
  studentName: string;
  owner: string;
  planner: string;
  preparationFollowUp: boolean;
  trialPaymentMethod?: TrialPaymentMethod;
  trialPaid?: boolean;
  requestSentAt?: string;
  link: TrialScheduleLink;
}>;

const TRIAL_PAYMENT_REMINDER_METHODS = new Set<TrialPaymentMethod>([
  "后置付费试听",
  "付费试听（未付费）",
  "在读学生付费试听",
]);

function trialPaymentMethod(value: unknown): TrialPaymentMethod | undefined {
  return typeof value === "string" && (TRIAL_PAYMENT_METHODS as readonly string[]).includes(value)
    ? value as TrialPaymentMethod
    : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalInstant(value: unknown, field: string) {
  const source = value instanceof Date ? value.valueOf() : text(value);
  const parsed = new Date(source);
  if ((typeof source === "string" && !source) || Number.isNaN(parsed.valueOf())) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return parsed.toISOString();
}

function optionalText(value: unknown) {
  const result = text(value);
  return result || undefined;
}

function normalize(value: unknown) {
  return text(value)
    .normalize("NFKC")
    .toLocaleLowerCase("en-AU")
    .replace(/[\s\p{P}\p{S}_]+/gu, "");
}

const UNPROVEN_TEACHER_KEYS = new Set([
  "",
  "待核对",
  "待核对老师映射",
  "待定",
  "未知",
  "未知老师",
  "未安排",
  "未填写",
  "na",
  "none",
  "tba",
  "unknown",
]);

function provenTeacherKey(value: unknown) {
  const key = normalize(value);
  return UNPROVEN_TEACHER_KEYS.has(key) ? null : key;
}

function compactTrialStudentName(value: string) {
  return value.trim().replace(/([\p{Script=Latin}\p{N}])[\s\p{P}\p{S}_]+(?=\p{Script=Han})/gu, "$1");
}

const STRUCTURED_TRIAL_STUDENT_NAME = /^[\p{Script=Latin}\p{M}'’.-]+(?:\s+[\p{Script=Latin}\p{M}'’.-]+){0,3}(?:\p{Script=Han}{1,8})?$/u;

/**
 * 教务宝试听学员 A/B/C use a generic participant, so the real student name
 * lives at the end of the course title: “课程信息 - English中文试听”.  Keep this
 * parser deliberately narrow; an unfamiliar title must remain unmatched.
 */
function structuredTrialStudentNameFromCourseTitle(courseName: unknown) {
  const source = text(courseName).normalize("NFKC");
  if (!source) return undefined;
  const delimited = source.match(/^.*[-–—]\s+(.{1,80}?)\s*试听(?:课)?\s*$/u);
  const direct = delimited ? null : source.match(/^(.{1,80}?)\s*试听(?:课)?\s*$/u);
  const candidate = compactTrialStudentName(delimited?.[1] ?? direct?.[1] ?? "");
  return STRUCTURED_TRIAL_STUDENT_NAME.test(candidate) ? candidate : undefined;
}

/**
 * Narrow parser shared by read-only JWB source projections. It deliberately
 * returns nothing for a title that is not an established trial-title shape;
 * shared A/B/C accounts must never become durable student identities.
 */
export function jiaowubaoTrialStudentNameFromCourseTitle(courseName: unknown) {
  return structuredTrialStudentNameFromCourseTitle(courseName);
}

function studentNameUnitKind(unit: string) {
  if (/[\p{Script=Latin}\p{M}\p{N}]/u.test(unit)) return "latin";
  if (/\p{Script=Han}/u.test(unit)) return "han";
  return "other";
}

type StudentNameSearchUnits = Readonly<{
  units: readonly string[];
  /** True when whitespace or punctuation immediately precedes this unit. */
  separatedBefore: readonly boolean[];
}>;

function studentNameSearchUnits(value: unknown): StudentNameSearchUnits {
  const units: string[] = [];
  const separatedBefore: boolean[] = [];
  let boundary = false;
  for (const unit of Array.from(text(value).normalize("NFKC").toLocaleLowerCase("en-AU"))) {
    if (/[\s\p{P}\p{S}_]/u.test(unit)) {
      boundary = units.length > 0;
      continue;
    }
    units.push(unit);
    separatedBefore.push(boundary);
    boundary = false;
  }
  return Object.freeze({ units: Object.freeze(units), separatedBefore: Object.freeze(separatedBefore) });
}

function wholeStudentNameMatchAt(
  source: readonly string[],
  expected: readonly string[],
  start: number,
  separatedBefore: readonly boolean[] = [],
) {
  if (!expected.length || !expected.every((unit, index) => source[start + index] === unit)) return false;
  const before = source[start - 1];
  const after = source[start + expected.length];
  return (!before || separatedBefore[start] === true || studentNameUnitKind(before) !== studentNameUnitKind(expected[0]!))
    && (!after || separatedBefore[start + expected.length] === true || studentNameUnitKind(after) !== studentNameUnitKind(expected[expected.length - 1]!));
}

function courseTitleMatchesStudentName(courseName: unknown, expectedName: unknown) {
  const expected = Array.from(normalize(expectedName));
  if (!expected.length) return false;
  const structuredName = structuredTrialStudentNameFromCourseTitle(courseName);
  // A structured suffix can be only the subject after a delimiter (for
  // example, `Phyllis嘟嘟 - AES 试听`). Check it first but never let it hide
  // the complete title when matching a known internal student name.
  return [structuredName, courseName]
    .filter((source): source is string => typeof source === "string")
    .some((source) => {
      const searchable = studentNameSearchUnits(source);
      return searchable.units.some((_, start) => wholeStudentNameMatchAt(
        searchable.units,
        expected,
        start,
        searchable.separatedBefore,
      ));
    });
}

/**
 * Tests one already-known internal student against a shared A/B/C course
 * title.  This is intentionally a match predicate, rather than a title
 * parser: a title may include the student name plus a subject or parent-facing
 * suffix, and must still resolve only when exactly one internal name matches.
 */
export function jiaowubaoTrialCourseTitleMatchesStudentName(courseName: unknown, expectedName: unknown) {
  return courseTitleMatchesStudentName(courseName, expectedName);
}

function studentNameFromCourseTitle(courseName: unknown, expectedName: unknown, directStudentMatch: boolean) {
  const source = text(courseName).normalize("NFKC");
  const expected = Array.from(normalize(expectedName));
  if (!source) return undefined;

  const structuredName = structuredTrialStudentNameFromCourseTitle(source);
  if (structuredName && (directStudentMatch || courseTitleMatchesStudentName(structuredName, expectedName))) {
    return structuredName;
  }

  const searchable: string[] = [];
  const separatedBefore: boolean[] = [];
  const spans: Array<Readonly<{ start: number; end: number }>> = [];
  let boundary = false;
  for (let offset = 0; offset < source.length;) {
    const start = offset;
    const codePoint = String.fromCodePoint(source.codePointAt(offset)!);
    offset += codePoint.length;
    for (const unit of codePoint.toLocaleLowerCase("en-AU")) {
      if (/[\s\p{P}\p{S}_]/u.test(unit)) {
        boundary = searchable.length > 0;
        continue;
      }
      searchable.push(unit);
      separatedBefore.push(boundary);
      spans.push({ start, end: offset });
      boundary = false;
    }
  }

  const matchAt = expected.length
    ? searchable.findIndex((_, start) => wholeStudentNameMatchAt(searchable, expected, start, separatedBefore))
    : -1;
  if (matchAt < 0) {
    const compactSource = compactTrialStudentName(source);
    const combinedEnglishChineseName = /^[\p{Script=Latin}\p{M}'’.-]+(?:\s+[\p{Script=Latin}\p{M}'’.-]+){0,3}\p{Script=Han}{2,8}$/u;
    return directStudentMatch && combinedEnglishChineseName.test(compactSource) ? compactSource : undefined;
  }
  const first = spans[matchAt];
  const last = spans[matchAt + expected.length - 1];
  if (!first || !last) return undefined;
  return compactTrialStudentName(source.slice(first.start, last.end));
}

function planner(value: unknown): TrialPlanner | null {
  const key = normalize(value);
  return TRIAL_PLANNERS.find((candidate) => normalize(candidate) === key) ?? null;
}

// Keep the generic-account prefix exact, while allowing only the known
// descriptive suffixes used by 教务宝 labels (for example, 校长号1️⃣ 2026).
const GENERIC_TRIAL_ACCOUNT_LABEL = /^(?:(?:试听|视听)(?:学员|学生|账号)?|trial(?:student|account)?)([abc])(?:(?<=a)tara龙)?(?:(?:校长号|账号|account)[\p{N}\p{M}]*|year(?:19|20)\d{2}|(?:19|20)\d{2})*$/u;

export function isJiaowubaoSharedTrialAccountLabel(value: unknown) {
  return Boolean(normalize(value).match(GENERIC_TRIAL_ACCOUNT_LABEL));
}

/** Converts the extended browser form into the separately persisted manual intake. */
export function trialIntakeFromFields(fields: LpFieldValues): TrialIntake {
  const resolvedPlanner = planner(fields.planner);
  if (!resolvedPlanner) throw new TypeError("planner must be Tara, Eileen, or Abby");
  if (fields.contactParents !== true && fields.contactStudent !== true) {
    throw new TypeError("at least one trial contact is required");
  }
  const duration = Number(fields.trialDurationMinutes);
  if (!TRIAL_DURATIONS.includes(duration as TrialDurationMinutes)) {
    throw new TypeError("trialDurationMinutes must be 45 or 60");
  }
  if (fields.writingRequired !== true && fields.writingRequired !== false) {
    throw new TypeError("writingRequired must be a boolean");
  }
  if (fields.paperRequired !== true && fields.paperRequired !== false) {
    throw new TypeError("paperRequired must be a boolean");
  }
  return Object.freeze({
    planner: resolvedPlanner,
    requestSentAt: canonicalInstant(fields.requestSentAt, "requestSentAt"),
    contactParents: fields.contactParents === true,
    contactStudent: fields.contactStudent === true,
    ...(optionalText(fields.contactNote) ? { contactNote: optionalText(fields.contactNote) } : {}),
    writingRequired: fields.writingRequired === true,
    ...(optionalText(fields.writingNote) ? { writingNote: optionalText(fields.writingNote) } : {}),
    paperRequired: fields.paperRequired === true,
    ...(optionalText(fields.paperNote) ? { paperNote: optionalText(fields.paperNote) } : {}),
    ...(optionalText(fields.preparationNote) ? { preparationNote: optionalText(fields.preparationNote) } : {}),
    ...(optionalText(fields.studentName) ? { studentName: optionalText(fields.studentName) } : {}),
    trialDurationMinutes: duration as TrialDurationMinutes,
    ...(optionalText(fields.trialDurationNote) ? { trialDurationNote: optionalText(fields.trialDurationNote) } : {}),
  });
}

/** Maps the three generic 教务宝 trial accounts to their course planners. */
export function trialPlannerHintFromParticipants(
  participants: readonly Readonly<{ label: string | null }>[],
): JiaowubaoTrialPlannerHint {
  const hints = new Set<TrialPlanner>();
  for (const participant of participants) {
    const key = normalize(participant.label);
    if (!key) continue;
    const accountLetter = key.match(GENERIC_TRIAL_ACCOUNT_LABEL)?.[1];
    if (accountLetter === "a") hints.add("Tara");
    if (accountLetter === "b") hints.add("Eileen");
    if (accountLetter === "c") hints.add("Abby");
  }
  return hints.size === 1 ? [...hints][0]! : null;
}

function requestedAt(item: Readonly<{ requestedAt?: string; trialIntake?: TrialIntake }>) {
  const source = item.trialIntake?.requestSentAt ?? item.requestedAt;
  const parsed = source ? new Date(source) : null;
  return parsed && Number.isFinite(parsed.valueOf()) ? parsed.valueOf() : Number.NEGATIVE_INFINITY;
}

/**
 * Matches only unambiguous LP/student evidence. A direct student ID wins; the
 * course-title fallback also respects the A/B/C planner hint when available.
 */
export function matchTrialScheduleEvents(input: Readonly<{
  lpItems: readonly Readonly<{
    id: string;
    studentId: string;
    workflowType?: string;
    stage?: string;
    requestedAt?: string;
    trialPaid?: unknown;
    fields?: Readonly<{ preparationFollowUp?: unknown; trialPaymentMethod?: unknown; newTeacher?: unknown }>;
    trialIntake?: TrialIntake;
  }>[];
  students: readonly Readonly<{ id: string; name: string; owner: string; planner?: string }>[];
  teachers: readonly Readonly<{ id: string; name: string }>[];
  events: readonly TrialScheduleEventLike[];
  matchedAt: Date | string;
  sourceRevision?: string;
}>): TrialScheduleMatch[] {
  const students = new Map(input.students.map((student) => [student.id, student]));
  const teachers = new Map(input.teachers.map((teacher) => [teacher.id, teacher.name]));
  const matchedAt = canonicalInstant(input.matchedAt, "matchedAt");
  const matches: TrialScheduleMatch[] = [];

  const candidatesByLp = input.lpItems
    .filter((candidate) => (
      candidate.workflowType === "试听 LP" || candidate.workflowType === "换老师试听"
    ) && candidate.stage !== "完成")
    .flatMap((item) => {
      const student = students.get(item.studentId);
      if (!student) return [];
      const teacherChangeTrial = item.workflowType === "换老师试听";
      const expectedTeacherKey = teacherChangeTrial ? provenTeacherKey(item.fields?.newTeacher) : null;
      if (teacherChangeTrial && !expectedTeacherKey) return [];
      const existingStudentName = item.trialIntake?.studentName || student.name;
      const nameKey = normalize(existingStudentName);
      if (!nameKey) return [];
      const plannerName = planner(item.trialIntake?.planner) || planner(student.planner) || "";
      const paymentMethod = teacherChangeTrial ? undefined : trialPaymentMethod(item.fields?.trialPaymentMethod);
      const requestTime = requestedAt(item);
      const candidates = input.events.filter((event) => {
        const start = new Date(event.startsAt).valueOf();
        if (!Number.isFinite(start) || start < requestTime - 24 * 60 * 60 * 1_000) return false;
        const directStudentMatch = event.visibleStudentIds.includes(student.id);
        const titleMatch = courseTitleMatchesStudentName(event.courseName, existingStudentName);
        const hint = event.trialPlannerHint ?? null;
        const plannerMatches = !hint || normalize(hint) === normalize(plannerName);
        const teacherMatches = !teacherChangeTrial
          || provenTeacherKey(event.teacherName) === expectedTeacherKey;
        return teacherMatches && (directStudentMatch || titleMatch && Boolean(hint) && plannerMatches);
      }).sort((left, right) => new Date(left.startsAt).valueOf() - new Date(right.startsAt).valueOf());
      return [{ item, student, existingStudentName, plannerName, paymentMethod, requestTime, candidates }];
    });
  const candidateLpCountByEvent = new Map<string, number>();
  for (const entry of candidatesByLp) {
    for (const eventId of new Set(entry.candidates.map((event) => event.eventId))) {
      candidateLpCountByEvent.set(eventId, (candidateLpCountByEvent.get(eventId) ?? 0) + 1);
    }
  }

  for (const entry of candidatesByLp) {
    if (entry.candidates.length !== 1) continue;
    const event = entry.candidates[0]!;
    if (candidateLpCountByEvent.get(event.eventId) !== 1) continue;
    const { item, student, existingStudentName, plannerName, paymentMethod, requestTime } = entry;
    const studentName = studentNameFromCourseTitle(
      event.courseName,
      existingStudentName,
      event.visibleStudentIds.includes(student.id),
    ) ?? existingStudentName;
    matches.push(Object.freeze({
      lpItemId: item.id,
      studentId: student.id,
      studentName,
      owner: student.owner,
      planner: plannerName,
      preparationFollowUp: item.fields?.preparationFollowUp !== "否",
      ...(paymentMethod ? { trialPaymentMethod: paymentMethod } : {}),
      ...(typeof item.trialPaid === "boolean" ? { trialPaid: item.trialPaid } : {}),
      ...(Number.isFinite(requestTime) ? { requestSentAt: new Date(requestTime).toISOString() } : {}),
      link: Object.freeze({
        source: "jiaowubao-open-api",
        ...(typeof input.sourceRevision === "string"
          && /^sha256:[a-f0-9]{64}$/.test(input.sourceRevision)
          ? { sourceRevision: input.sourceRevision }
          : {}),
        eventId: event.eventId,
        startsAt: canonicalInstant(event.startsAt, "startsAt"),
        endsAt: canonicalInstant(event.endsAt, "endsAt"),
        courseName: event.courseName,
        studentName,
        teacherId: event.teacherId,
        teacherName: optionalText(event.teacherName)
          ?? (event.teacherId ? teachers.get(event.teacherId) : undefined)
          ?? "待核对老师映射",
        plannerHint: event.trialPlannerHint ?? null,
        matchedAt,
      }),
    }));
  }
  return matches;
}

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const MELBOURNE_TIME_ZONE = "Australia/Melbourne";

function zonedParts(value: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
}

function localDateTimeToInstant(
  date: Readonly<{ year: number; month: number; day: number }>,
  hour: number,
  timeZone: string,
) {
  const target = Date.UTC(date.year, date.month - 1, date.day, hour, 0, 0);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(candidate), timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const adjustment = target - actualUtc;
    candidate += adjustment;
    if (!adjustment) break;
  }
  return new Date(candidate);
}

function localDayDeadline(value: Date, dayOffset: number, hour: number, timeZone: string) {
  const local = zonedParts(value, timeZone);
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day + dayOffset));
  return localDateTimeToInstant({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }, hour, timeZone);
}

function localDayNumber(value: Date, timeZone: string) {
  const local = zonedParts(value, timeZone);
  return Date.UTC(local.year, local.month - 1, local.day) / (24 * 60 * 60 * 1_000);
}

function task(input: Readonly<{
  anchor: string;
  ruleKey: string;
  title: string;
  owner: string;
  assignees: readonly string[];
  studentId: string;
  dueAt: Date;
  now: Date;
  category?: "试听" | "排课" | "LP";
  tone?: TaskTone;
  trigger: string;
  requestAnchorBookingId?: string;
}>): OpsTask {
  const dueAt = input.dueAt;
  const canonical = dueAt.toISOString();
  return {
    id: deterministicTaskId(input.anchor, input.ruleKey),
    title: input.title,
    owner: input.owner,
    assignees: [...new Set(input.assignees.filter(Boolean))],
    watchers: [DEFAULT_TEACHING_CONTROL_WATCHER],
    studentId: input.studentId,
    due: formatTaskDeadline(canonical, SHANGHAI_TIME_ZONE) ?? canonical,
    dueAt: canonical,
    status: statusForDueAt(canonical, input.now),
    tone: input.tone ?? "blue",
    category: input.category ?? "试听",
    trigger: input.trigger,
    ruleKey: input.ruleKey,
    anchorBookingId: input.anchor,
    ...(input.requestAnchorBookingId ? { requestAnchorBookingId: input.requestAnchorBookingId } : {}),
  };
}

export const TRIAL_MANUAL_REQUEST_RULE_PREFIX = "trial.manual-request.";
export const TRIAL_PENDING_SCHEDULING_RULE_KEY = "trial.scheduling";

export const TRIAL_SCHEDULING_REMINDER_RULE_KEYS = Object.freeze([
  TRIAL_PENDING_SCHEDULING_RULE_KEY,
  `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}parent-progress-24h`,
  `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}parent-progress-48h`,
  `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}scheduling-anomaly-72h`,
] as const);

export function generateTrialManualRequestTasks(input: Readonly<{
  lpItemId: string;
  studentId: string;
  studentName: string;
  guardianWechat: string;
  owner: string;
  specifiedContentStatus: string;
  intake: TrialIntake;
  now: Date | string;
}>): OpsTask[] {
  const requestedAt = new Date(input.intake.requestSentAt);
  const now = new Date(input.now);
  const sameDay = localDayDeadline(requestedAt, 0, 18, SHANGHAI_TIME_ZONE);
  const shared = {
    anchor: input.lpItemId,
    owner: input.owner,
    assignees: [input.owner, DEFAULT_TEACHING_CONTROL_WATCHER],
    studentId: input.studentId,
    now,
    trigger: "试听 LP 信息交接后按手册自动生成",
  } as const;
  const tasks: OpsTask[] = [];
  const guardianWechat = text(input.guardianWechat) || "家长微信名未填写";
  const taskDetails = `<${input.studentName}> <${guardianWechat}>`;
  const schedulingDeadline = new Date(requestedAt.valueOf() + 24 * 60 * 60 * 1_000);
  const secondProgressDeadline = new Date(requestedAt.valueOf() + 48 * 60 * 60 * 1_000);
  const anomalyDeadline = new Date(requestedAt.valueOf() + 72 * 60 * 60 * 1_000);
  if (["需教务跟进", "需要跟进"].includes(input.specifiedContentStatus)) tasks.push(task({
    ...shared,
    ruleKey: `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}specified-content`,
    title: `《教务+教统》【要指定内容】${taskDetails}`,
    dueAt: sameDay,
    category: "LP",
  }));
  if (input.intake.writingRequired) tasks.push(task({
    ...shared,
    ruleKey: `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}writing`,
    title: `《教务+教统》【要写作】${taskDetails}`,
    dueAt: sameDay,
    category: "LP",
  }));
  if (input.intake.paperRequired) {
    tasks.push(task({
      ...shared,
      ruleKey: `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}paper-send`,
      title: `《教务+教统》【发试卷】${taskDetails}`,
      dueAt: sameDay,
      category: "LP",
    }));
  }
  tasks.push(task({
    ...shared,
    ruleKey: TRIAL_PENDING_SCHEDULING_RULE_KEY,
    title: `《教务+教统》【试听待排课】${taskDetails}`,
    dueAt: schedulingDeadline,
    category: "排课",
    tone: "red",
    trigger: "试听 LP 信息交接后立即生成，排课后由教务宝自动完成",
  }));
  tasks.push(task({
    ...shared,
    ruleKey: `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}parent-progress-24h`,
    title: `《教务+教统》【向家长交待排课进度】${taskDetails}`,
    dueAt: schedulingDeadline,
  }));
  tasks.push(task({
    ...shared,
    ruleKey: `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}parent-progress-48h`,
    title: `《教务+教统》【二次向家长交待排课进度】${taskDetails}`,
    dueAt: secondProgressDeadline,
  }));
  tasks.push(task({
    ...shared,
    ruleKey: `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}scheduling-anomaly-72h`,
    title: `《教务+教统》【试听排课进度反常】${taskDetails}`,
    dueAt: anomalyDeadline,
    category: "排课",
    tone: "red",
  }));
  return tasks;
}

export function completeTrialSchedulingReminderTasks(
  current: readonly OpsTask[],
  input: Readonly<{ lpItemId: string; eventId: string; completedAt: Date | string }>,
): OpsTask[] {
  const closedAt = new Date(input.completedAt).toISOString();
  const managedRules: readonly string[] = TRIAL_SCHEDULING_REMINDER_RULE_KEYS;
  return current.map((task) => task.anchorBookingId === input.lpItemId
    && typeof task.ruleKey === "string"
    && managedRules.includes(task.ruleKey)
    && task.status !== "done"
    && !isFrozenLegacyTask(task)
    ? {
        ...task,
        status: "done" as const,
        tone: "green" as const,
        completionOutcome: "done" as const,
        result: `教务宝真实排课已匹配：${input.eventId}`,
        closedAt,
      }
    : task);
}

export const TRIAL_JWB_RULE_PREFIX = "trial.jiaowubao.";

export const TRIAL_JWB_SCHEDULE_RULE_KEYS = Object.freeze([
  `${TRIAL_JWB_RULE_PREFIX}lp-finalize-tomorrow-n3`,
  `${TRIAL_JWB_RULE_PREFIX}lp-materials-n2`,
  `${TRIAL_JWB_RULE_PREFIX}prep-n1`,
  `${TRIAL_JWB_RULE_PREFIX}payment-n2`,
  `${TRIAL_JWB_RULE_PREFIX}today`,
] as const);

export const TRIAL_TEACHER_REPLY_RULE_KEYS = Object.freeze([
  `${TRIAL_JWB_RULE_PREFIX}teacher-reply-4h`,
  `${TRIAL_JWB_RULE_PREFIX}teacher-reply-8h`,
] as const);

export function isTrialTeacherReplyTaskRule(ruleKey: string | undefined) {
  return Boolean(ruleKey && (TRIAL_TEACHER_REPLY_RULE_KEYS as readonly string[]).includes(ruleKey));
}

function followUpTitle(title: string, from: string, to: string) {
  return title.includes(from) ? title.replace(from, to) : `${to}${title}`;
}

function dependentTrialTasks(taskToComplete: OpsTask, completedAt: Date) {
  if (!taskToComplete.anchorBookingId) return [];
  const common = {
    owner: taskToComplete.owner,
    assignees: taskToComplete.assignees ?? [taskToComplete.owner, DEFAULT_TEACHING_CONTROL_WATCHER],
    watchers: taskToComplete.watchers ?? [DEFAULT_TEACHING_CONTROL_WATCHER],
    studentId: taskToComplete.studentId,
    category: "LP" as const,
    trigger: `完成“${taskToComplete.title}”后按试听手册自动生成`,
    anchorBookingId: taskToComplete.anchorBookingId,
    ...(taskToComplete.requestAnchorBookingId
      ? { requestAnchorBookingId: taskToComplete.requestAnchorBookingId }
      : {}),
  };
  const create = (ruleKey: string, title: string, hours: number, tone: TaskTone = "blue"): OpsTask => {
    const dueAt = new Date(completedAt.valueOf() + hours * 60 * 60 * 1_000).toISOString();
    return {
      id: deterministicTaskId(taskToComplete.anchorBookingId!, ruleKey),
      title,
      ...common,
      due: formatTaskDeadline(dueAt, SHANGHAI_TIME_ZONE) ?? dueAt,
      dueAt,
      status: statusForDueAt(dueAt, completedAt),
      tone,
      ruleKey,
    };
  };

  if (taskToComplete.ruleKey === `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}paper-send`) {
    return [create(
      `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}paper-receive`,
      followUpTitle(taskToComplete.title, "【发试卷】", "【收试卷】"),
      24,
    )];
  }
  return [];
}

/**
 * Completes one task and materializes only the handbook follow-ups whose clock
 * starts at that exact completion instant. Existing completed evidence wins;
 * an open deterministic follow-up is safely rebased instead of duplicated.
 */
export function completeTrialTaskWithHandbookFollowUps(
  current: readonly OpsTask[],
  input: Readonly<{ taskId: string; completedAt: Date | string }>,
) {
  const completedAt = new Date(input.completedAt);
  if (!Number.isFinite(completedAt.valueOf())) throw new TypeError("completedAt must be a valid timestamp");
  const source = current.find((candidate) => candidate.id === input.taskId);
  if (!source || source.status === "done" || isFrozenLegacyTask(source)) return [...current];
  const closedAt = completedAt.toISOString();
  const completed = current.map((candidate) => candidate.id === source.id
    ? {
        ...candidate,
        status: "done" as const,
        tone: "green" as const,
        closedAt,
        result: "已由当前操作员确认完成",
        completionOutcome: "done" as const,
      }
    : candidate);
  const generated = dependentTrialTasks(source, completedAt);
  if (!generated.length) return completed;
  const generatedIds = new Set(generated.map((candidate) => candidate.id));
  const preserved = completed.filter((candidate) => !generatedIds.has(candidate.id));
  for (const candidate of generated) {
    const existing = completed.find((item) => item.id === candidate.id);
    preserved.push(existing?.status === "done"
      ? existing
      : existing?.completionNote ? { ...candidate, completionNote: existing.completionNote } : candidate);
  }
  return sortTasksByDueAt(preserved);
}

/** Reopens a source task and removes only still-open follow-ups it generated. */
export function reopenTrialTaskWithHandbookFollowUps(
  current: readonly OpsTask[],
  input: Readonly<{ taskId: string; reopenedAt: Date | string; timeZone: string }>,
) {
  const reopenedAt = new Date(input.reopenedAt);
  if (!Number.isFinite(reopenedAt.valueOf())) throw new TypeError("reopenedAt must be a valid timestamp");
  const source = current.find((candidate) => candidate.id === input.taskId);
  if (!source || source.status !== "done" || !source.dueAt || isFrozenLegacyTask(source)) return [...current];
  const parentReplyClosure = source.anchorBookingId && source.closedAt
    && (source.result === "家长已回复" || source.result === TRIAL_PARENT_REPLIED_ESCALATION_CLOSED_RESULT)
    ? current.filter((candidate) => candidate.status === "done"
      && candidate.anchorBookingId === source.anchorBookingId
      && candidate.studentId === source.studentId
      && candidate.closedAt === source.closedAt
      && (candidate.result === "家长已回复"
        || candidate.result === TRIAL_PARENT_REPLIED_ESCALATION_CLOSED_RESULT))
    : [];
  if (parentReplyClosure.some((candidate) => !candidate.dueAt || isFrozenLegacyTask(candidate))) {
    return [...current];
  }
  const parentReplyClosureIds = new Set(parentReplyClosure.map((candidate) => candidate.id));
  const dependentRules = source.ruleKey === `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}paper-send`
    ? new Set([`${TRIAL_MANUAL_REQUEST_RULE_PREFIX}paper-receive`])
    : source.ruleKey === `${TRIAL_JWB_RULE_PREFIX}lp-materials-n2`
      ? new Set<string>(TRIAL_TEACHER_REPLY_RULE_KEYS)
      : new Set<string>();
  return sortTasksByDueAt(current.flatMap((candidate) => {
    if (candidate.id === source.id || parentReplyClosureIds.has(candidate.id)) {
      const status = statusForDueAt(candidate.dueAt!, reopenedAt, input.timeZone);
      const tone: TaskTone = status === "overdue" ? "red" : status === "today" ? "amber" : "blue";
      return [{
        ...candidate,
        status,
        tone,
        result: undefined,
        closedAt: undefined,
        completionOutcome: undefined,
      }];
    }
    if (candidate.status !== "done"
      && candidate.anchorBookingId === source.anchorBookingId
      && dependentRules.has(candidate.ruleKey ?? "")) return [];
    return [candidate];
  }));
}

/** A manual teacher reply closes both the 4h and 8h reminder branches. */
export function closeTrialTeacherReplyTasks(
  current: readonly OpsTask[],
  input: Readonly<{ task: OpsTask; repliedAt: Date | string }>,
) {
  const repliedAt = new Date(input.repliedAt);
  if (!Number.isFinite(repliedAt.valueOf())) throw new TypeError("repliedAt must be a valid timestamp");
  const closedAt = repliedAt.toISOString();
  return current.map((candidate) => candidate.anchorBookingId === input.task.anchorBookingId
    && candidate.studentId === input.task.studentId
    && isTrialTeacherReplyTaskRule(candidate.ruleKey)
    && candidate.status !== "done"
    ? {
        ...candidate,
        status: "done" as const,
        tone: "green" as const,
        result: "老师已回复",
        completionOutcome: "done" as const,
        closedAt,
      }
    : candidate);
}

export function formatJiaowubaoTodayTaskTitle(input: Readonly<{
  task: Pick<OpsTask, "ruleKey" | "title">;
  endsAt?: string;
  timeZone: string;
  timeZoneLabel: string;
  locale?: string;
  timeFormat?: "24h" | "12h";
}>) {
  if (input.task.ruleKey !== `${TRIAL_JWB_RULE_PREFIX}today`
    || !input.task.title.startsWith("《教务+教统》【今日试听】<")
    || !input.task.title.endsWith(">")
    || !input.endsAt) return input.task.title;
  const endsAt = new Date(input.endsAt);
  if (!Number.isFinite(endsAt.valueOf())) return input.task.title;
  try {
    const endLabel = new Intl.DateTimeFormat(input.locale ?? "zh-CN", {
      timeZone: input.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: input.timeFormat === "12h",
    }).format(endsAt);
    const inner = input.task.title.slice(0, -1)
      .replace(/ · 墨尔本 \d{2}:\d{2} 结束$/u, "");
    return `${inner} · ${input.timeZoneLabel} ${endLabel} 结束>`;
  } catch {
    return input.task.title;
  }
}

export function generateJiaowubaoTrialTasks(input: TrialScheduleMatch & Readonly<{
  now: Date | string;
  paymentManagedByBooking?: boolean;
}>): OpsTask[] {
  const start = new Date(input.link.startsAt);
  const end = new Date(input.link.endsAt);
  const now = new Date(input.now);
  const requestSentAt = input.requestSentAt ? new Date(input.requestSentAt) : null;
  const leadDays = requestSentAt !== null && Number.isFinite(requestSentAt.valueOf())
    ? localDayNumber(start, MELBOURNE_TIME_ZONE) - localDayNumber(requestSentAt, MELBOURNE_TIME_ZONE)
    : null;
  const shortNoticeFinalize = leadDays !== null && leadDays >= 0 && leadDays <= 2;
  const compressBeforeTrialTasks = leadDays !== null && leadDays >= 0 && leadDays <= 1;
  const n3Deadline = localDayDeadline(start, -3, 18, MELBOURNE_TIME_ZONE);
  const n2Deadline = shortNoticeFinalize
    ? localDayDeadline(requestSentAt!, 0, 18, MELBOURNE_TIME_ZONE)
    : localDayDeadline(start, -2, 18, MELBOURNE_TIME_ZONE);
  const n1Deadline = compressBeforeTrialTasks
    ? localDayDeadline(requestSentAt!, 0, 18, MELBOURNE_TIME_ZONE)
    : localDayDeadline(start, -1, 18, MELBOURNE_TIME_ZONE);
  const anchor = `JWB:${input.link.eventId}`;
  const operations = [input.owner, DEFAULT_TEACHING_CONTROL_WATCHER];
  const shared = {
    anchor,
    owner: input.owner,
    assignees: operations,
    studentId: input.studentId,
    now,
    trigger: `教务宝真实课表匹配 · ${input.link.eventId}`,
    requestAnchorBookingId: input.lpItemId,
  } as const;
  const endLabel = new Intl.DateTimeFormat("zh-CN", {
    timeZone: MELBOURNE_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(end);
  return [
    ...(leadDays === null || leadDays >= 3 ? [
      task({
        ...shared,
        ruleKey: `${TRIAL_JWB_RULE_PREFIX}lp-finalize-tomorrow-n3`,
        title: `《教务+教统》【明日LP定稿】<${input.studentName}> <${input.link.teacherName}>`,
        dueAt: n3Deadline,
        category: "LP",
      }),
    ] : []),
    task({
      ...shared,
      ruleKey: `${TRIAL_JWB_RULE_PREFIX}lp-materials-n2`,
      title: `《教务+教统》【今日LP定稿】<${input.studentName}> <${input.link.teacherName}>`,
      dueAt: n2Deadline,
      category: "LP",
    }),
    ...(input.preparationFollowUp ? [
      task({
        ...shared,
        ruleKey: `${TRIAL_JWB_RULE_PREFIX}prep-n1`,
        title: `《教务+教统》【跟进老师备课内容】<${input.studentName}> <${input.link.teacherName}>`,
        dueAt: n1Deadline,
        category: "LP",
      }),
    ] : []),
    ...(!input.paymentManagedByBooking
      && input.trialPaymentMethod
      && TRIAL_PAYMENT_REMINDER_METHODS.has(input.trialPaymentMethod) ? [
        (() => {
          const paymentTask = task({
            ...shared,
            owner: input.planner || input.owner,
            assignees: [input.planner || input.owner],
            ruleKey: `${TRIAL_JWB_RULE_PREFIX}payment-n2`,
            title: `《教统》【提醒规划老师收取试听费】<${input.studentName}>`,
            dueAt: n2Deadline,
          });
          return input.trialPaid === true ? {
            ...paymentTask,
            status: "done" as const,
            tone: "green" as const,
            result: "试听台账已标记付费，收费提醒自动关闭",
            closedAt: now.toISOString(),
          } : paymentTask;
        })(),
      ] : []),
    task({
      ...shared,
      ruleKey: `${TRIAL_JWB_RULE_PREFIX}today`,
      title: `《教务+教统》【今日试听】<${input.studentName} · ${input.link.teacherName} · 墨尔本 ${endLabel} 结束>`,
      dueAt: start,
      tone: "red",
    }),
  ];
}

export function replaceRuleTasks(
  current: readonly OpsTask[],
  generated: readonly OpsTask[],
  input: Readonly<{
    anchor: string;
    rulePrefixes?: readonly string[];
    ruleKeys?: readonly string[];
  }>,
) {
  const managed = (task: OpsTask) => task.anchorBookingId === input.anchor
    && (input.ruleKeys?.includes(task.ruleKey ?? "") === true
      || input.rulePrefixes?.some((prefix) => task.ruleKey?.startsWith(prefix)) === true);
  const generatedById = new Map(generated.map((item) => [item.id, item]));
  const next = current.filter((item) => !managed(item) || item.status === "done" && !generatedById.has(item.id));
  for (const candidate of generated) {
    const existing = current.find((item) => item.id === candidate.id);
    const candidateWithNote = existing?.completionNote
      ? { ...candidate, completionNote: existing.completionNote }
      : candidate;
    next.push(existing?.status === "done" ? existing : candidateWithNote);
  }
  return next;
}

export function isTrialIntake(value: unknown): value is TrialIntake {
  if (!record(value)) return false;
  try {
    trialIntakeFromFields(value as LpFieldValues);
    return true;
  } catch {
    return false;
  }
}
