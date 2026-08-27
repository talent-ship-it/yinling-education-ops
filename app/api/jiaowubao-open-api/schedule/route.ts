import { createHmac, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { mapJiaowubaoSnapshotParticipants } from "@/lib/jiaowubao-open-api-schedule-reader";
import { buildOpsAccessContext, canReadOpsEntity } from "@/lib/ops-access";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { normalizeStudentImportName, studentImportAutomaticJwbNameKey } from "@/lib/student-import";
import { trialPlannerHintFromParticipants } from "@/lib/trial-operations";
import {
  getJiaowubaoOpenApiScheduleSnapshotWindow,
  getOpsState,
  OpsStoreError,
  type JiaowubaoOpenApiScheduleSnapshotWindow,
  type OpsStateRow,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const CANONICAL_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CANONICAL_CURSOR_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const SOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const SOURCE_EVENT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SNAPSHOT_REVISION = /^sha256:[a-f0-9]{64}$/;
const SCHEDULE_PAGE_LIMIT = 250;
const CURSOR_TTL_SECONDS = 10 * 60;

type Scope = "all" | "teacher" | "student" | "availability" | "trial";
type SourceScope = Exclude<Scope, "trial">;
type RecordValue = Record<string, unknown>;

type ReaderContext = Readonly<{
  windowStart: string;
  windowEnd: string;
  scope: Scope;
  teacherLabels: readonly string[] | null;
  studentMemberIds: readonly string[] | null;
  studentNameKeys: readonly string[] | null;
}>;

type SignedScheduleCursor = Readonly<{
  version: 1;
  revision: string;
  startsAt: string;
  eventId: string;
  contextHash: string;
  expiresAt: number;
}>;

type CursorRead = Readonly<{
  cursor: Readonly<{ startsAt: string; eventId: string }>;
  revision: string;
}>;

class ScheduleCursorError extends Error {}
class SnapshotResponseError extends Error {}
class SnapshotMappingError extends Error {}

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function normalise(value: unknown) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

function text(value: unknown, maximum = 240) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : null;
}

function readInstant(value: string | null, field: string) {
  if (!value || !CANONICAL_UTC_INSTANT.test(value)) return { error: `${field} 必须使用 UTC ISO 时间。` } as const;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    return { error: `${field} 无效。` } as const;
  }
  return { value: parsed.toISOString() } as const;
}

function readId(value: string | null, field: string) {
  if (value === null || value === "") return { value: undefined } as const;
  if (value !== value.trim() || value.length > 240) return { error: `${field} 无效。` } as const;
  return { value } as const;
}

function cursorSecret() {
  const secret = process.env.OPS_API_SECRET;
  if (!secret) throw new SnapshotResponseError("reader configuration unavailable");
  return secret;
}

function contextHash(context: ReaderContext) {
  return createHmac("sha256", cursorSecret()).update(JSON.stringify({
    windowStart: context.windowStart,
    windowEnd: context.windowEnd,
    scope: context.scope,
    teacherLabels: context.teacherLabels ? [...context.teacherLabels].sort() : [],
    studentMemberIds: context.studentMemberIds ? [...context.studentMemberIds].sort() : [],
    studentNameKeys: context.studentNameKeys ? [...context.studentNameKeys].sort() : [],
  })).digest("hex");
}

function signCursor(payload: SignedScheduleCursor) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", cursorSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function readCursorInstant(value: unknown) {
  if (typeof value !== "string" || !CANONICAL_CURSOR_UTC_INSTANT.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19) ? null : value;
}

function canonicalSourceDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

function sourceInstant(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function readCursorToken(url: URL) {
  if (url.searchParams.has("cursorStartsAt") || url.searchParams.has("cursorEventId") || url.searchParams.has("revision")) {
    return { error: "分页游标格式已更新，请重新读取课表。" } as const;
  }
  const value = url.searchParams.get("cursor");
  if (value === null) return { value: null } as const;
  if (!/^[A-Za-z0-9_-]{32,2048}\.[A-Za-z0-9_-]{32,128}$/.test(value)) {
    return { error: "分页游标无效，请重新读取课表。" } as const;
  }
  return { value } as const;
}

function verifyCursor(token: string | null, context: ReaderContext): CursorRead | null {
  if (token === null) return null;
  const [encoded, suppliedSignature, ...extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra.length) throw new ScheduleCursorError("分页游标无效，请重新读取课表。");
  const expectedSignature = createHmac("sha256", cursorSecret()).update(encoded).digest("base64url");
  const supplied = Buffer.from(suppliedSignature, "base64url");
  const expected = Buffer.from(expectedSignature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ScheduleCursorError("分页游标无效，请重新读取课表。");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new ScheduleCursorError("分页游标无效，请重新读取课表。");
  }
  const value = record(parsed) as Partial<SignedScheduleCursor> | null;
  const startsAt = readCursorInstant(value?.startsAt);
  const eventId = value?.eventId;
  const revision = value?.revision;
  const expiresAt = value?.expiresAt;
  if (value?.version !== 1
    || typeof revision !== "string" || !SNAPSHOT_REVISION.test(revision)
    || !startsAt
    || typeof eventId !== "string" || !SOURCE_EVENT_KEY.test(eventId)
    || typeof value.contextHash !== "string" || !/^[a-f0-9]{64}$/.test(value.contextHash)
    || value.contextHash !== contextHash(context)
    || !Number.isSafeInteger(expiresAt)
    || expiresAt === undefined
    || expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new ScheduleCursorError("分页游标已失效，请重新读取课表。");
  }
  return { cursor: { startsAt, eventId }, revision };
}

function safeSourceKey(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return SOURCE_KEY.test(trimmed) ? trimmed : null;
}

function entityRecords(rows: OpsStateRow[], entity: string) {
  const payload = rows.find((row) => row.entity === entity)?.payload;
  return Array.isArray(payload) ? payload.map(record).filter((value): value is RecordValue => Boolean(value)) : [];
}

function idsForEntity(rows: OpsStateRow[], entity: string) {
  return new Set(entityRecords(rows, entity).flatMap((item) => {
    const id = text(item.id, 240);
    return id ? [id] : [];
  }));
}

type TeacherLookup = Readonly<{
  idsByLabel: Map<string, readonly string[]>;
  labelById: Map<string, string>;
}>;

function teacherLookup(rows: OpsStateRow[]): TeacherLookup {
  const ids = new Map<string, string[]>();
  const labels = new Map<string, string>();
  for (const item of entityRecords(rows, "teachers")) {
    const id = text(item.id, 240);
    const label = text(item.name, 240);
    const key = normalise(label);
    if (!id || !label || !key) continue;
    const current = ids.get(key) ?? [];
    if (!current.includes(id)) current.push(id);
    ids.set(key, current);
    labels.set(id, label);
  }
  return { idsByLabel: ids, labelById: labels };
}

function labelsForTeacherIds(lookup: TeacherLookup, teacherIds: readonly string[]) {
  const labels: string[] = [];
  for (const id of teacherIds) {
    const label = lookup.labelById.get(id);
    const matchingIds = label ? lookup.idsByLabel.get(normalise(label)) ?? [] : [];
    // A source teacher title cannot safely select one of two current records.
    if (!label || matchingIds.length !== 1 || matchingIds[0] !== id) throw new SnapshotMappingError("ambiguous teacher mapping");
    labels.push(label);
  }
  const normalized = labels.map(normalise);
  if (new Set(normalized).size !== normalized.length) throw new SnapshotMappingError("ambiguous teacher mapping");
  return labels;
}

type StudentLookup = Readonly<{
  internalByMember: Map<string, string>;
  internalByNameKey: Map<string, string>;
  memberCandidates: Map<string, readonly string[]>;
  nameCandidates: Map<string, readonly string[]>;
  memberIds: readonly string[];
  nameKeys: readonly string[];
  trialCourseCandidates: ReadonlyMap<string, readonly string[]>;
  trialCourseVisible: ReadonlyMap<string, string>;
}>;

function trialCourseKey(value: unknown) {
  return typeof value === "string"
    ? value.normalize("NFKC").toLocaleLowerCase("en-AU").replace(/[^\p{L}\p{N}]+/gu, "")
    : "";
}

function studentLookup(rows: OpsStateRow[], allowedStudentIds: ReadonlySet<string>): StudentLookup {
  const candidates = new Map<string, string[]>();
  const nameCandidates = new Map<string, string[]>();
  const trialCourseCandidates = new Map<string, string[]>();
  for (const item of entityRecords(rows, "students")) {
    const id = text(item.id, 240);
    const memberId = safeSourceKey(item.jwbSourceRow);
    if (!id
      || item.importArchived === true
      || String(item.importArchived ?? "").trim().toLowerCase() === "true") continue;
    if (memberId) {
      const current = candidates.get(memberId) ?? [];
      if (!current.includes(id)) current.push(id);
      candidates.set(memberId, current);
    }
    const name = text(item.name, 240);
    if (name) {
      const courseKey = trialCourseKey(name);
      if (courseKey.length >= 4) {
        const current = trialCourseCandidates.get(courseKey) ?? [];
        if (!current.includes(id)) current.push(id);
        trialCourseCandidates.set(courseKey, current);
      }
      const keys = new Set([normalizeStudentImportName(name), studentImportAutomaticJwbNameKey(name)]);
      for (const key of keys) {
        if (!key) continue;
        const current = nameCandidates.get(key) ?? [];
        if (!current.includes(id)) current.push(id);
        nameCandidates.set(key, current);
      }
    }
  }
  const internalByMember = new Map<string, string>();
  for (const [memberId, ids] of candidates) {
    if (ids.length === 1 && allowedStudentIds.has(ids[0]!)) internalByMember.set(memberId, ids[0]!);
  }
  const internalByNameKey = new Map<string, string>();
  for (const [nameKey, ids] of nameCandidates) {
    if (ids.length === 1 && allowedStudentIds.has(ids[0]!)) internalByNameKey.set(nameKey, ids[0]!);
  }
  const trialCourseVisible = new Map<string, string>();
  for (const [courseKey, ids] of trialCourseCandidates) {
    if (ids.length === 1 && allowedStudentIds.has(ids[0]!)) trialCourseVisible.set(courseKey, ids[0]!);
  }
  return {
    internalByMember,
    internalByNameKey,
    memberCandidates: new Map([...candidates.entries()].map(([key, ids]) => [key, [...ids]])),
    nameCandidates: new Map([...nameCandidates.entries()].map(([key, ids]) => [key, [...ids]])),
    memberIds: [...internalByMember.keys()].sort(),
    nameKeys: [...internalByNameKey.keys()].sort(),
    trialCourseCandidates: new Map([...trialCourseCandidates.entries()].map(([key, ids]) => [key, [...ids]])),
    trialCourseVisible,
  };
}

function trialCourseStudentIds(courseName: string | null, lookup: StudentLookup) {
  const courseKey = trialCourseKey(courseName);
  if (!courseKey) return [];
  const candidateIds = new Set<string>();
  const visibleIds = new Set<string>();
  for (const [nameKey, ids] of lookup.trialCourseCandidates) {
    if (!courseKey.includes(nameKey)) continue;
    ids.forEach((id) => candidateIds.add(id));
    const visible = lookup.trialCourseVisible.get(nameKey);
    if (visible) visibleIds.add(visible);
  }
  if (candidateIds.size !== 1 || visibleIds.size !== 1) return [];
  const candidate = [...candidateIds][0];
  const visible = [...visibleIds][0];
  return candidate === visible ? [visible] : [];
}

function emptyPage() {
  return {
    state: "complete" as const,
    events: [],
    invalidTimeEventCount: 0,
    hasMore: false,
    nextCursor: null,
    freshness: "absent" as const,
    empty: true,
  };
}

function validRawPage(value: unknown): JiaowubaoOpenApiScheduleSnapshotWindow {
  const source = record(value);
  if (!source || (source.state !== "absent" && source.state !== "complete" && source.state !== "stale" && source.state !== "reset")) {
    throw new SnapshotResponseError("invalid reader response");
  }
  if (!Array.isArray(source.events)) throw new SnapshotResponseError("invalid reader events");
  const events = source.events.map((value) => {
    const event = record(value);
    const eventId = text(event?.eventId, 200);
    const sourceDateRaw = text(event?.sourceDate, 32);
    const startsAtRaw = text(event?.startsAt, 64);
    const endsAtRaw = text(event?.endsAt, 64);
    const sourceDate = sourceDateRaw ? canonicalSourceDate(sourceDateRaw) : null;
    const startsAt = startsAtRaw ? sourceInstant(startsAtRaw) : null;
    const endsAt = endsAtRaw ? sourceInstant(endsAtRaw) : null;
    if (!event || !eventId || !SOURCE_EVENT_KEY.test(eventId) || !sourceDate || !startsAt || !endsAt
      || new Date(endsAt).getTime() <= new Date(startsAt).getTime()) throw new SnapshotResponseError("invalid reader event");
    const courseName = event.courseName === null ? null : text(event.courseName, 240);
    const sourceTeacherId = event.sourceTeacherId === null ? null : text(event.sourceTeacherId, 240);
    const sourceTeacherLabel = event.sourceTeacherLabel === null ? null : text(event.sourceTeacherLabel, 240);
    const sourceParticipants = event.sourceParticipants;
    if (event.courseName !== null && courseName === null
      || event.sourceTeacherId !== null && sourceTeacherId === null
      || event.sourceTeacherLabel !== null && sourceTeacherLabel === null
      || !Array.isArray(sourceParticipants)
      || !sourceParticipants.every((participant) => {
        const value = record(participant);
        return value !== null
          && (value.memberId === null || typeof value.memberId === "string" && SOURCE_KEY.test(value.memberId.trim()))
          && (value.label === null || typeof value.label === "string" && value.label.trim().length > 0 && value.label.trim().length <= 240)
          && (value.memberId !== null || value.label !== null);
      })
      || typeof event.sourceStudentsTruncated !== "boolean") {
      throw new SnapshotResponseError("invalid reader event");
    }
    return {
      eventId,
      sourceDate,
      startsAt,
      endsAt,
      courseName,
      sourceTeacherId,
      sourceTeacherLabel,
      sourceParticipants: sourceParticipants.map((participant) => {
        const value = record(participant)!;
        return {
          memberId: value.memberId === null ? null : (value.memberId as string).trim(),
          label: value.label === null ? null : (value.label as string).trim(),
        };
      }),
      sourceStudentsTruncated: event.sourceStudentsTruncated,
    };
  });
  const invalidTimeEventCount = source.invalidTimeEventCount;
  if (typeof invalidTimeEventCount !== "number" || !Number.isSafeInteger(invalidTimeEventCount) || invalidTimeEventCount < 0) throw new SnapshotResponseError("invalid reader diagnostics");
  if (typeof source.hasMore !== "boolean") throw new SnapshotResponseError("invalid reader pagination");
  const rawCursor = source.nextCursor;
  let nextCursor: JiaowubaoOpenApiScheduleSnapshotWindow["nextCursor"] = null;
  if (rawCursor !== null) {
    const cursor = record(rawCursor);
    const startsAt = readCursorInstant(cursor?.startsAt);
    const eventId = cursor?.eventId;
    if (!cursor || !startsAt || typeof eventId !== "string" || !SOURCE_EVENT_KEY.test(eventId)) throw new SnapshotResponseError("invalid reader cursor");
    nextCursor = { startsAt, eventId };
  }
  if (source.hasMore !== Boolean(nextCursor)) throw new SnapshotResponseError("invalid reader pagination");
  const revision = source.revision === null ? null : text(source.revision, 71);
  if (source.state !== "absent" && source.state !== "reset" && (!revision || !SNAPSHOT_REVISION.test(revision))) throw new SnapshotResponseError("invalid reader revision");
  if (source.state === "absent" && (revision !== null || events.length || source.hasMore || nextCursor)) throw new SnapshotResponseError("invalid absent reader response");
  if (source.freshness !== "absent" && source.freshness !== "fresh" && source.freshness !== "stale") throw new SnapshotResponseError("invalid reader freshness");
  if (typeof source.empty !== "boolean") throw new SnapshotResponseError("invalid reader empty state");
  if ((source.state === "absent" && source.freshness !== "absent")
    || (source.state === "complete" && source.freshness !== "fresh")
    || (source.state === "stale" && source.freshness !== "stale")
    || (source.state === "reset" && source.freshness !== "stale")
    || (source.state === "reset" && (events.length || source.hasMore || nextCursor))) {
    throw new SnapshotResponseError("invalid reader state freshness");
  }
  if (source.empty !== (events.length === 0 && !source.hasMore)) throw new SnapshotResponseError("invalid reader empty state");
  return { ...source, events, invalidTimeEventCount, nextCursor, revision } as unknown as JiaowubaoOpenApiScheduleSnapshotWindow;
}

function publicPage(
  page: JiaowubaoOpenApiScheduleSnapshotWindow,
  context: ReaderContext,
  teacherLookupValue: TeacherLookup,
  studentLookupValue: StudentLookup,
  signedCursor: CursorRead | null,
) {
  if (page.state === "reset" || page.state === "absent") {
    return {
      state: page.state,
      events: [],
      invalidTimeEventCount: page.invalidTimeEventCount,
      hasMore: false,
      nextCursor: null,
      freshness: page.freshness,
      empty: true,
    };
  }
  const events = page.events.flatMap((event) => {
    const matchingTeacherIds = event.sourceTeacherLabel
      ? teacherLookupValue.idsByLabel.get(normalise(event.sourceTeacherLabel)) ?? []
      : [];
    const teacherId = matchingTeacherIds.length === 1 ? matchingTeacherIds[0]! : null;
    const participantStudentIds = context.scope === "availability" ? [] : mapJiaowubaoSnapshotParticipants(
      event.sourceParticipants,
      studentLookupValue,
    );
    const visibleStudentIds = context.scope === "trial"
      ? [...new Set([...participantStudentIds, ...trialCourseStudentIds(event.courseName, studentLookupValue)])]
      : participantStudentIds;
    if ((context.scope === "student" || context.scope === "trial") && !visibleStudentIds.length) return [];
    return [{
      eventId: event.eventId,
      sourceDate: event.sourceDate,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      courseName: context.scope === "availability" ? null : event.courseName,
      teacherId,
      trialPlannerHint: context.scope === "availability"
        ? null
        : trialPlannerHintFromParticipants(event.sourceParticipants),
      availabilityEffect: teacherId ? "blocks_teacher_ava" as const : "display_only" as const,
      visibleStudentIds: [...new Set(visibleStudentIds)].slice(0, 100),
      visibleStudentsTruncated: event.sourceStudentsTruncated || visibleStudentIds.length > 100,
    }];
  });
  const nextCursor = page.hasMore && page.nextCursor && page.revision
    ? {
      token: signCursor({
        version: 1,
        revision: page.revision,
        startsAt: page.nextCursor.startsAt,
        eventId: page.nextCursor.eventId,
        contextHash: contextHash(context),
        expiresAt: Math.floor(Date.now() / 1000) + CURSOR_TTL_SECONDS,
      }),
    }
    : null;
  if (page.hasMore && !nextCursor) throw new SnapshotResponseError("reader returned an unsigned continuation");
  // A cursor is accepted only for the same immutable revision; retaining this
  // local assertion makes accidental mixed-window responses fail closed.
  if (signedCursor && page.revision !== signedCursor.revision) {
    return { state: "reset" as const, events: [], invalidTimeEventCount: 0, hasMore: false, nextCursor: null, freshness: "stale" as const, empty: true };
  }
  return {
    state: page.state,
    events,
    invalidTimeEventCount: page.invalidTimeEventCount,
    hasMore: page.hasMore,
    nextCursor,
    freshness: page.freshness,
    empty: page.empty,
  };
}

function missingReader(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

function unavailable() {
  return noStore({ error: "教务宝快照暂时不可用。", code: "jiaowubao_open_api_schedule_snapshot_unavailable" }, 503);
}

/**
 * Read-only schedule source for the immutable 30-minute Open API snapshot.
 * The browser receives only this route's projected DTO; raw source member and
 * teacher keys are consumed here and pricing/source payloads never cross it.
 */
export async function GET(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) {
    if (resolved.status === 401) return noStore({ error: resolved.error, code: "session_required" }, 401);
    return unavailable();
  }

  const url = new URL(request.url);
  const trialOnly = url.searchParams.get("trialOnly") === "1";
  if (url.searchParams.has("trialOnly") && url.searchParams.get("trialOnly") !== "1") {
    return noStore({ error: "trialOnly 参数无效。" }, 400);
  }
  const windowStart = readInstant(url.searchParams.get("windowStart"), "windowStart");
  const windowEnd = readInstant(url.searchParams.get("windowEnd"), "windowEnd");
  const requestedTeacher = readId(url.searchParams.get("teacherId"), "teacherId");
  const cursorToken = readCursorToken(url);
  if ("error" in windowStart) return noStore({ error: windowStart.error }, 400);
  if ("error" in windowEnd) return noStore({ error: windowEnd.error }, 400);
  if ("error" in requestedTeacher) return noStore({ error: requestedTeacher.error }, 400);
  if ("error" in cursorToken) return noStore({ error: cursorToken.error }, 400);
  if (trialOnly && requestedTeacher.value) return noStore({ error: "试听 LP 投影不能同时筛选单一老师。" }, 400);
  if (new Date(windowEnd.value).getTime() <= new Date(windowStart.value).getTime()) return noStore({ error: "windowEnd 必须晚于 windowStart。" }, 400);

  const { session } = resolved;
  const fullAdmin = session.user === DEMO_ADMIN_USER
    && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  try {
    const rows = await getOpsState(["bookings", "students", "teachers"]);
    const access = buildOpsAccessContext(rows, session.user, fullAdmin, session);
    if (!["bookings", "students", "teachers"].every((entity) => canReadOpsEntity(access, entity))) {
      return noStore({ error: "当前账号不能查看教务宝排课。" }, 403);
    }
    const unrestricted = access.fullAdmin || (access.limitedAdmin && !access.restrictedStudentScope);
    const requestedTeacherId = requestedTeacher.value;
    const knownTeacherIds = idsForEntity(rows, "teachers");
    const lookup = teacherLookup(rows);
    let context: ReaderContext;
    let studentLookupValue: StudentLookup;

    if (unrestricted) {
      if (requestedTeacherId && !knownTeacherIds.has(requestedTeacherId)) return noStore({ error: "未找到该老师。" }, 404);
      const scope = trialOnly ? "trial" : requestedTeacherId ? "teacher" : "all" as Scope;
      const teacherLabels = requestedTeacherId ? labelsForTeacherIds(lookup, [requestedTeacherId]) : null;
      studentLookupValue = studentLookup(rows, new Set(entityRecords(rows, "students").flatMap((item) => {
        const id = text(item.id, 240);
        return id ? [id] : [];
      })));
      context = {
        windowStart: windowStart.value,
        windowEnd: windowEnd.value,
        scope,
        teacherLabels,
        studentMemberIds: null,
        studentNameKeys: null,
      };
    } else if (access.teacher) {
      if (trialOnly) return noStore({ error: "老师账号不能读取试听 LP 投影。" }, 403);
      if (requestedTeacherId && !access.teacherIds.has(requestedTeacherId)) return noStore({ error: "未找到该老师。" }, 404);
      const teacherIds = requestedTeacherId ? [requestedTeacherId] : [...access.teacherIds].sort();
      if (!teacherIds.length) return noStore(emptyPage());
      const teacherLabels = labelsForTeacherIds(lookup, teacherIds);
      studentLookupValue = studentLookup(rows, access.studentIds);
      context = {
        windowStart: windowStart.value,
        windowEnd: windowEnd.value,
        scope: "teacher",
        teacherLabels,
        // Participant visibility is filtered after the source read against the
        // current Ops student scope. Do not send member IDs to the SQL teacher
        // selector: teacher labels alone define the event set.
        studentMemberIds: null,
        studentNameKeys: null,
      };
    } else if (requestedTeacherId) {
      if (!access.staff || !knownTeacherIds.has(requestedTeacherId)) return noStore({ error: "未找到该老师。" }, 404);
      const teacherLabels = labelsForTeacherIds(lookup, [requestedTeacherId]);
      studentLookupValue = studentLookup(rows, access.studentIds);
      context = {
        windowStart: windowStart.value,
        windowEnd: windowEnd.value,
        scope: "availability",
        teacherLabels,
        studentMemberIds: null,
        studentNameKeys: null,
      };
    } else if (trialOnly) {
      studentLookupValue = studentLookup(rows, access.studentIds);
      if (!studentLookupValue.trialCourseVisible.size && !studentLookupValue.memberIds.length) return noStore(emptyPage());
      context = {
        windowStart: windowStart.value,
        windowEnd: windowEnd.value,
        scope: "trial",
        teacherLabels: null,
        studentMemberIds: null,
        studentNameKeys: null,
      };
    } else {
      studentLookupValue = studentLookup(rows, access.studentIds);
      if (!studentLookupValue.memberIds.length && !studentLookupValue.nameKeys.length) return noStore(emptyPage());
      context = {
        windowStart: windowStart.value,
        windowEnd: windowEnd.value,
        scope: "student",
        teacherLabels: null,
        studentMemberIds: studentLookupValue.memberIds.length ? studentLookupValue.memberIds : null,
        studentNameKeys: studentLookupValue.nameKeys.length ? studentLookupValue.nameKeys : null,
      };
    }

    const signedCursor = verifyCursor(cursorToken.value, context);
    const page = await getJiaowubaoOpenApiScheduleSnapshotWindow({
      windowStart: context.windowStart,
      windowEnd: context.windowEnd,
      scope: (context.scope === "trial" ? "all" : context.scope) as SourceScope,
      teacherLabels: context.teacherLabels,
      studentMemberIds: context.studentMemberIds,
      studentNameKeys: context.studentNameKeys,
      limit: SCHEDULE_PAGE_LIMIT,
      cursor: signedCursor?.cursor ?? null,
      revision: signedCursor?.revision ?? null,
    });
    return noStore(publicPage(validRawPage(page), context, lookup, studentLookupValue, signedCursor));
  } catch (error) {
    if (error instanceof ScheduleCursorError) return noStore({ error: error.message, code: "invalid_jiaowubao_open_api_schedule_cursor" }, 400);
    if (error instanceof SnapshotMappingError) return unavailable();
    if (error instanceof SnapshotResponseError) return unavailable();
    if (missingReader(error)) return noStore({ error: "教务宝快照读取合同尚未部署。", code: "jiaowubao_open_api_schedule_reader_unavailable" }, 501);
    return unavailable();
  }
}
