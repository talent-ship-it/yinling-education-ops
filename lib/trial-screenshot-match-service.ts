import { DateTime } from "luxon";
import type { DemoSessionIdentity } from "./demo-session-token";
import { normaliseDemoUserName } from "./demo-users";
import { buildOpsAccessContext, canOperateStudent, canWriteOpsTransaction } from "./ops-access";
import type { getJiaowubaoOpenApiScheduleSnapshotWindow, JiaowubaoOpenApiScheduleSnapshotWindow, OpsStateRow, readWecomLpDraft } from "./ops-store";
import type { readJiaowubaoTrialSourceWindow } from "./jiaowubao-trial-source-window";
import { buildWecomLpDraft } from "./wecom-lp-draft";
import { matchWecomDraftStudent } from "./wecom-lp-intake";
import { trialAccountLetter } from "./trial-account-label";
import { jiaowubaoTrialStudentNameFromCourseTitle } from "./trial-operations";

const SOURCE_ZONE = "Australia/Melbourne";
type RecordValue = Record<string, unknown>;
type Dependencies = Readonly<{
  readSession: () => Promise<{ session: DemoSessionIdentity; fullAdmin: boolean } | { error: string; status: number }>;
  readRows: () => Promise<OpsStateRow[]>;
  readDraft: typeof readWecomLpDraft;
  readSnapshot: typeof getJiaowubaoOpenApiScheduleSnapshotWindow;
  readSource: typeof readJiaowubaoTrialSourceWindow;
}>;
export type TrialScreenshotTarget = { lpItemId: string } | { caseId: string; sourceMessageId: string; sourceRevision: string };
export type TrialScreenshotCandidate = Readonly<{
  eventId: string; sourceRevision: string; sourceDate: string; startsAt: string; endsAt: string;
  teacherName: string | null; courseName: string | null; studentNameHint: string | null;
  sharedAccountLabel: string | null; sharedAccountLetter: string | null; durationMinutes: number;
}>;
export type TrialScreenshotMatchResult = Readonly<{
  candidates: readonly TrialScreenshotCandidate[]; ambiguous: boolean; hasMore: boolean; reason?: "needs_identity";
  coverage: null | Readonly<Pick<JiaowubaoOpenApiScheduleSnapshotWindow, "state" | "freshness" | "publishedAt" | "sourceWindow"> & {
    sourceRevision: string | null; requestedWindow: { startsAt: string; endsAt: string }; timeZone: string; complete: boolean;
  }>;
}>;
type Evidence = Readonly<{ sourceDate: string; startTime: string; endTime: string; teacherName: string; courseName: string; sharedAccountLetter?: string }>;
class MatchError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new MatchError(status, code, message); }
function record(value: unknown): value is RecordValue { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function normalise(value: unknown) { return text(value).normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase("en-AU"); }
function exactKeys(value: RecordValue, keys: readonly string[]) {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail(400, "invalid_request", "排课识别参数无效。");
}
function bounded(value: unknown, max: number) {
  const result = text(value);
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) fail(400, "invalid_request", "请核对截图中的日期、时间、老师和课程。");
  return result;
}
function parseTarget(value: unknown): TrialScreenshotTarget {
  if (!record(value)) fail(400, "invalid_request", "请选择试听交接或 LP。");
  if (Object.hasOwn(value, "lpItemId")) {
    exactKeys(value, ["lpItemId"]);
    const lpItemId = bounded(value.lpItemId, 160);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(lpItemId)) fail(400, "invalid_request", "试听 LP 参数无效。");
    return { lpItemId };
  }
  exactKeys(value, ["caseId", "sourceMessageId", "sourceRevision"]);
  const caseId = bounded(value.caseId, 36);
  const sourceMessageId = bounded(value.sourceMessageId, 240);
  const sourceRevision = bounded(value.sourceRevision, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(caseId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,239}$/u.test(sourceMessageId)
    || !/^[0-9a-f]{64}$/u.test(sourceRevision)) fail(400, "invalid_request", "交接来源参数无效。");
  return { caseId, sourceMessageId, sourceRevision };
}
function parseRequest(value: unknown) {
  if (!record(value)) fail(400, "invalid_request", "排课识别参数无效。");
  exactKeys(value, ["target", "evidence"]);
  const target = parseTarget(value.target);
  if (!record(value.evidence)) fail(400, "invalid_request", "请核对截图中的排课信息。");
  exactKeys(value.evidence, ["sourceDate", "startTime", "endTime", "teacherName", "courseName", ...(Object.hasOwn(value.evidence, "sharedAccountLetter") ? ["sharedAccountLetter"] : [])]);
  const evidence: Evidence = {
    sourceDate: bounded(value.evidence.sourceDate, 10), startTime: bounded(value.evidence.startTime, 5), endTime: bounded(value.evidence.endTime, 5),
    teacherName: bounded(value.evidence.teacherName, 240), courseName: bounded(value.evidence.courseName, 240),
    ...(Object.hasOwn(value.evidence, "sharedAccountLetter") ? { sharedAccountLetter: bounded(value.evidence.sharedAccountLetter, 1).toLowerCase() } : {}),
  };
  const day = DateTime.fromISO(evidence.sourceDate, { zone: SOURCE_ZONE }).startOf("day");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(evidence.sourceDate) || !day.isValid || day.year < 1900 || day.year > 9998 || day.toISODate() !== evidence.sourceDate
    || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(evidence.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(evidence.endTime)
    || evidence.endTime <= evidence.startTime || evidence.sharedAccountLetter && !/^[abc]$/u.test(evidence.sharedAccountLetter)) fail(400, "invalid_request", "请核对截图中的日期和起止时间。");
  return { target, evidence, window: { startsAt: day.toUTC().toISO()!, endsAt: day.plus({ days: 1 }).startOf("day").toUTC().toISO()! } };
}
function records(rows: readonly OpsStateRow[], entity: string) {
  const payload = rows.find((row) => row.entity === entity)?.payload;
  if (!Array.isArray(payload) || !payload.every(record)) fail(503, "state_unavailable", "试听资料暂不可用，请重试。");
  return payload as RecordValue[];
}
function studentIdentity(student: RecordValue | undefined, fields: RecordValue, extraName?: string | null) {
  const names = new Set<string>();
  if (extraName) names.add(normalise(extraName));
  if (fields.studentNameKnown === true && text(fields.studentName)) names.add(normalise(fields.studentName));
  if (student && text(student.name) && normalise(student.name) !== normalise(student.guardianWechat) && !trialAccountLetter(student.name)) names.add(normalise(student.name));
  return { names, memberId: student && (typeof student.jwbSourceRow === "string" || Number.isSafeInteger(student.jwbSourceRow)) ? String(student.jwbSourceRow) : null };
}
async function authorizeTarget(dependencies: Dependencies, target: TrialScreenshotTarget) {
  const resolved = await dependencies.readSession();
  if (!("session" in resolved)) fail(resolved.status, "session_required", resolved.error);
  const { session, fullAdmin } = resolved;
  if (session.role === "teacher") fail(403, "scope_forbidden", "老师账号不能核对试听交接。");
  const rows = await dependencies.readRows();
  const access = buildOpsAccessContext(rows, session.user, fullAdmin, session);
  if (!canWriteOpsTransaction(access, "lpItems", ["students", "lpItems", "tasks", "files"]) || access.restrictedStudentScope) fail(403, "scope_forbidden", "当前账号不能核对试听交接。");
  const students = records(rows, "students");
  let student: RecordValue | undefined;
  let fields: RecordValue = {};
  let sourceName: string | null = null;
  if ("lpItemId" in target) {
    const lp = records(rows, "lpItems").find((item) => item.id === target.lpItemId);
    if (!lp || !["试听 LP", "换老师试听"].includes(text(lp.workflowType))) fail(404, "target_not_found", "未找到可核对的试听 LP。");
    student = students.find((item) => item.id === lp.studentId);
    fields = record(lp.fields) ? lp.fields : {};
    if (!student || !canOperateStudent(access, String(student.id))
      || !fullAdmin && (normaliseDemoUserName(text(student.owner)) !== normaliseDemoUserName(session.user)
        || normaliseDemoUserName(text(fields.responsibleOperations) || text(student.owner)) !== normaliseDemoUserName(session.user))) fail(403, "scope_forbidden", "当前账号不能核对该试听学生。");
  } else {
    const source = await dependencies.readDraft({ sourceMessageId: target.sourceMessageId, actor: session.user, fullAdmin });
    if (!source || source.caseId !== target.caseId || source.sourceMessageId !== target.sourceMessageId) fail(404, "target_not_found", "未找到可核对的交接来源。");
    if (!fullAdmin && normaliseDemoUserName(text(source.operationsOwner)) !== normaliseDemoUserName(session.user)) fail(403, "scope_forbidden", "教务只能核对自己负责的交接。");
    if (source.sourceRevision !== target.sourceRevision) fail(409, "draft_conflict", "交接来源已变化，请刷新后重试。");
    if (["identity_conflict", "identity_ambiguous"].includes(source.status)) fail(409, "draft_conflict", "请先核对交接学生身份。");
    const studentId = source.confirmed?.studentId ?? matchWecomDraftStudent(source, students);
    student = students.find((item) => item.id === studentId);
    if (student && (!canOperateStudent(access, String(student.id)) || !fullAdmin && normaliseDemoUserName(text(student.owner)) !== normaliseDemoUserName(session.user))) fail(403, "scope_forbidden", "当前账号不能核对该试听学生。");
    fields = buildWecomLpDraft(source.messages).fields;
    sourceName = source.studentName;
  }
  const identity = studentIdentity(student, fields, sourceName);
  if (identity.memberId && students.filter((item) => item.importArchived !== true && String(item.jwbSourceRow ?? "") === identity.memberId).length !== 1) identity.memberId = null;
  return { fullAdmin, ...identity };
}
function json(payload: unknown, status = 200) { return Response.json(payload, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } }); }
function failure(error: unknown) {
  if (error instanceof MatchError) return json({ error: error.message, code: error.code }, error.status);
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "42501") return json({ error: "当前账号不能核对该试听交接。", code: "scope_forbidden" }, 403);
  if (code === "source_changed" || code === "40001") return json({ error: "教务宝课表快照已变化，请重试。", code: "source_changed" }, 409);
  return json({ error: "教务宝排课暂时无法核对，请重试。", code: "source_unavailable" }, 503);
}
export function createTrialScreenshotMatchHandler(dependencies: Dependencies) {
  return async (request: Request) => {
    try {
      if (Number(request.headers.get("content-length")) > 8192) fail(413, "request_too_large", "排课识别参数过长。");
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > 8192) fail(413, "request_too_large", "排课识别参数过长。");
      const parsed = parseRequest(JSON.parse(body));
      const identity = await authorizeTarget(dependencies, parsed.target);
      if (!identity.fullAdmin && !identity.memberId && !identity.names.size) return json({ candidates: [], ambiguous: false, hasMore: false, coverage: null, reason: "needs_identity" });
      const snapshot = await dependencies.readSnapshot({ windowStart: parsed.window.startsAt, windowEnd: parsed.window.endsAt, scope: "all", teacherLabels: null, studentMemberIds: null, studentNameKeys: null, limit: 1, cursor: null, revision: null });
      const covered = snapshot.sourceWindow !== null && snapshot.sourceWindow.start <= parsed.evidence.sourceDate && snapshot.sourceWindow.end >= parsed.evidence.sourceDate;
      const coverage = { state: snapshot.state, freshness: snapshot.freshness, sourceRevision: snapshot.revision, publishedAt: snapshot.publishedAt, sourceWindow: snapshot.sourceWindow, requestedWindow: parsed.window, timeZone: SOURCE_ZONE, complete: covered && ["complete", "stale"].includes(snapshot.state) };
      if (!coverage.complete || !snapshot.revision || !/^sha256:[a-f0-9]{64}$/u.test(snapshot.revision)) return json({ candidates: [], ambiguous: false, hasMore: false, coverage });
      const sourceRevision = snapshot.revision;
      const events = await dependencies.readSource(sourceRevision, parsed.window, {}, snapshot.freshness === "stale" ? snapshot.sourceWindow : null);
      const matched = events.flatMap((event): TrialScreenshotCandidate[] => {
        const evidence = parsed.evidence;
        if (event.sourceStudentsTruncated || event.sourceDate !== evidence.sourceDate
          || normalise(event.sourceTeacherLabel) !== normalise(evidence.teacherName)
          || normalise(event.courseName) !== normalise(evidence.courseName) && !(identity.fullAdmin && evidence.sharedAccountLetter)) return [];
        const start = DateTime.fromISO(event.startsAt, { zone: "utc" }).setZone(SOURCE_ZONE);
        const end = DateTime.fromISO(event.endsAt, { zone: "utc" }).setZone(SOURCE_ZONE);
        if (start.toISODate() !== evidence.sourceDate || end.toISODate() !== evidence.sourceDate
          || start.toFormat("HH:mm") !== evidence.startTime || end.toFormat("HH:mm") !== evidence.endTime) return [];
        const hint = jiaowubaoTrialStudentNameFromCourseTitle(event.courseName) ?? null;
        const shared = event.sourceParticipants.filter((participant) => trialAccountLetter(participant.label));
        const letters = new Set(shared.map((participant) => trialAccountLetter(participant.label)));
        if (evidence.sharedAccountLetter && (letters.size !== 1 || !letters.has(evidence.sharedAccountLetter))) return [];
        const memberMatch = Boolean(identity.memberId && event.sourceParticipants.some((participant) => participant.memberId === identity.memberId && !trialAccountLetter(participant.label)));
        if (!identity.fullAdmin && (hint && !identity.names.has(normalise(hint)) || !memberMatch && (!hint || !identity.names.has(normalise(hint))))) return [];
        const letter = letters.size === 1 ? [...letters][0] : null;
        return [{ eventId: event.eventId, sourceRevision, sourceDate: event.sourceDate, startsAt: event.startsAt, endsAt: event.endsAt,
          teacherName: event.sourceTeacherLabel, courseName: event.courseName, studentNameHint: hint && (identity.fullAdmin || identity.names.has(normalise(hint))) ? hint : null,
          sharedAccountLabel: letter ? shared.find((participant) => trialAccountLetter(participant.label) === letter)!.label : null,
          sharedAccountLetter: letter, durationMinutes: end.diff(start, "minutes").minutes }];
      }).sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.eventId.localeCompare(b.eventId));
      const exact = matched.filter((candidate) => normalise(candidate.courseName) === normalise(parsed.evidence.courseName));
      const candidates = exact.length ? exact : matched.length === 1 ? matched : [];
      return json({ candidates: candidates.slice(0, 5), ambiguous: candidates.length > 1 || !exact.length && matched.length > 1, hasMore: candidates.length > 5, coverage });
    } catch (error) {
      if (error instanceof SyntaxError) return json({ error: "排课识别参数无效。", code: "invalid_request" }, 400);
      return failure(error);
    }
  };
}
