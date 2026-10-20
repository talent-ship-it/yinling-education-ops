import { DateTime } from "luxon";
import { TrialScreenshotError, screenshotFail as fail, screenshotRecord as record, screenshotText as text, screenshotNormalise as normalise, screenshotJson as json } from "./trial-screenshot-shared";
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
function evidenceDay(sourceDate: string) {
  const day = DateTime.fromISO(sourceDate, { zone: SOURCE_ZONE }).startOf("day");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(sourceDate) || !day.isValid || day.year < 1900 || day.year > 9998 || day.toISODate() !== sourceDate) fail(400, "invalid_request", "请核对截图中的日期。");
  return day;
}
function validClockRange(evidence: Evidence) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(evidence.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(evidence.endTime)) return false;
  if (evidence.endTime <= evidence.startTime) return false;
  return !evidence.sharedAccountLetter || /^[abc]$/u.test(evidence.sharedAccountLetter);
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
  const day = evidenceDay(evidence.sourceDate);
  if (!validClockRange(evidence)) fail(400, "invalid_request", "请核对截图中的日期和起止时间。");
  return { target, evidence, window: { startsAt: day.toUTC().toISO()!, endsAt: day.plus({ days: 1 }).startOf("day").toUTC().toISO()! } };
}
function records(rows: readonly OpsStateRow[], entity: string) {
  const state = rows.find((row) => row.entity === entity);
  if (!Array.isArray(state?.payload)) fail(503, "state_unavailable", "试听资料暂不可用，请重试。");
  for (const item of state.payload) {
    if (!record(item)) fail(503, "state_unavailable", "试听资料暂不可用，请重试。");
  }
  return state.payload as RecordValue[];
}
function realStudentName(student: RecordValue | undefined) {
  if (!student) return "";
  const name = text(student.name);
  if (normalise(name) === normalise(student.guardianWechat) || trialAccountLetter(name)) return "";
  return name;
}
function studentIdentity(student: RecordValue | undefined, fields: RecordValue, extraName?: string | null) {
  const names = new Set<string>();
  for (const name of [extraName, fields.studentNameKnown === true ? fields.studentName : "", realStudentName(student)]) {
    if (text(name)) names.add(normalise(name));
  }
  const source = student?.jwbSourceRow;
  const memberId = typeof source === "string" || Number.isSafeInteger(source) ? String(source) : null;
  return { names, memberId };
}
type TargetContext = Readonly<{ session: DemoSessionIdentity; fullAdmin: boolean; rows: OpsStateRow[]; access: ReturnType<typeof buildOpsAccessContext> }>;
function assertStudentScope(context: TargetContext, student: RecordValue, fields: RecordValue = {}) {
  if (!canOperateStudent(context.access, String(student.id))) fail(403, "scope_forbidden", "当前账号不能核对该试听学生。");
  if (context.fullAdmin) return;
  if (normaliseDemoUserName(text(student.owner)) !== normaliseDemoUserName(context.session.user)
    || normaliseDemoUserName(text(fields.responsibleOperations) || text(student.owner)) !== normaliseDemoUserName(context.session.user)) fail(403, "scope_forbidden", "当前账号不能核对该试听学生。");
}
function lpTarget(context: TargetContext, lpItemId: string) {
  const lpItem = records(context.rows, "lpItems").find((item) => item.id === lpItemId);
  if (!lpItem || !["试听 LP", "换老师试听"].includes(text(lpItem.workflowType))) fail(404, "target_not_found", "未找到可核对的试听 LP。");
  const student = records(context.rows, "students").find((item) => item.id === lpItem.studentId);
  if (!student) fail(403, "scope_forbidden", "当前账号不能核对该试听学生。");
  const fields = record(lpItem.fields) ? lpItem.fields : {};
  assertStudentScope(context, student, fields);
  return { lpItem, student, fields, sourceName: null };
}
function assertOptionalStudentScope(context: TargetContext, student: RecordValue | undefined) {
  if (student) assertStudentScope(context, student);
}
function sameDraftSource(source: Awaited<ReturnType<Dependencies["readDraft"]>>, target: Exclude<TrialScreenshotTarget, { lpItemId: string }>) {
  return source?.caseId === target.caseId && source.sourceMessageId === target.sourceMessageId;
}
async function draftTarget(dependencies: Pick<Dependencies, "readDraft">, context: TargetContext, target: Exclude<TrialScreenshotTarget, { lpItemId: string }>) {
  const source = await dependencies.readDraft({ sourceMessageId: target.sourceMessageId, actor: context.session.user, fullAdmin: context.fullAdmin });
  if (!source) fail(404, "target_not_found", "未找到可核对的交接来源。");
  if (!sameDraftSource(source, target)) fail(404, "target_not_found", "未找到可核对的交接来源。");
  if (!context.fullAdmin && normaliseDemoUserName(text(source.operationsOwner)) !== normaliseDemoUserName(context.session.user)) fail(403, "scope_forbidden", "教务只能核对自己负责的交接。");
  if (source.sourceRevision !== target.sourceRevision) fail(409, "draft_conflict", "交接来源已变化，请刷新后重试。");
  if (["identity_conflict", "identity_ambiguous"].includes(source.status)) fail(409, "draft_conflict", "请先核对交接学生身份。");
  const students = records(context.rows, "students");
  const studentId = source.confirmed?.studentId ?? matchWecomDraftStudent(source, students);
  const student = students.find((item) => item.id === studentId);
  assertOptionalStudentScope(context, student);
  return { student, fields: buildWecomLpDraft(source.messages).fields, sourceName: source.studentName, lpItem: undefined };
}
export async function authorizeTrialScreenshotTarget(dependencies: Pick<Dependencies, "readSession" | "readRows" | "readDraft">, target: TrialScreenshotTarget) {
  const resolved = await dependencies.readSession();
  if (!("session" in resolved)) fail(resolved.status, "session_required", resolved.error);
  const { session, fullAdmin } = resolved;
  if (session.role === "teacher") fail(403, "scope_forbidden", "老师账号不能核对试听交接。");
  const rows = await dependencies.readRows();
  const access = buildOpsAccessContext(rows, session.user, fullAdmin, session);
  if (!canWriteOpsTransaction(access, "lpItems", ["students", "lpItems", "tasks", "files"]) || access.restrictedStudentScope) fail(403, "scope_forbidden", "当前账号不能核对试听交接。");
  const context = { session, fullAdmin, rows, access };
  const resolvedTarget = "lpItemId" in target ? lpTarget(context, target.lpItemId) : await draftTarget(dependencies, context, target);
  const identity = studentIdentity(resolvedTarget.student, resolvedTarget.fields, resolvedTarget.sourceName);
  const students = records(rows, "students");
  if (identity.memberId && students.filter((item) => item.importArchived !== true && String(item.jwbSourceRow ?? "") === identity.memberId).length !== 1) identity.memberId = null;
  return { ...context, lpItem: resolvedTarget.lpItem, student: resolvedTarget.student, ...identity };
}
function failure(error: unknown) {
  if (error instanceof TrialScreenshotError) return json({ error: error.message, code: error.code }, error.status);
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "42501") return json({ error: "当前账号不能核对该试听交接。", code: "scope_forbidden" }, 403);
  if (code === "source_changed" || code === "40001") return json({ error: "教务宝课表快照已变化，请重试。", code: "source_changed" }, 409);
  return json({ error: "教务宝排课暂时无法核对，请重试。", code: "source_unavailable" }, 503);
}
type TargetIdentity = Awaited<ReturnType<typeof authorizeTrialScreenshotTarget>>;
type SourceEvent = JiaowubaoOpenApiScheduleSnapshotWindow["events"][number];
function sourceTextMatches(event: SourceEvent, evidence: Evidence, identity: TargetIdentity) {
  if (event.sourceStudentsTruncated || event.sourceDate !== evidence.sourceDate || normalise(event.sourceTeacherLabel) !== normalise(evidence.teacherName)) return false;
  return normalise(event.courseName) === normalise(evidence.courseName) || Boolean(identity.fullAdmin && evidence.sharedAccountLetter);
}
function sourceTimeMatches(event: SourceEvent, evidence: Evidence) {
  const start = DateTime.fromISO(event.startsAt, { zone: "utc" }).setZone(SOURCE_ZONE);
  const end = DateTime.fromISO(event.endsAt, { zone: "utc" }).setZone(SOURCE_ZONE);
  return start.toISODate() === evidence.sourceDate && end.toISODate() === evidence.sourceDate && start.toFormat("HH:mm") === evidence.startTime && end.toFormat("HH:mm") === evidence.endTime;
}
function sharedAccount(event: SourceEvent) {
  const shared = event.sourceParticipants.filter((participant) => trialAccountLetter(participant.label));
  const letters = new Set(shared.map((participant) => trialAccountLetter(participant.label)));
  const letter = letters.size === 1 ? [...letters][0] : null;
  return { letter: letter ?? null, label: letter ? shared.find((participant) => trialAccountLetter(participant.label) === letter)!.label : null };
}
function visibleCandidate(event: SourceEvent, hint: string | undefined, identity: TargetIdentity) {
  if (identity.fullAdmin) return true;
  const nameMatches = Boolean(hint && identity.names.has(normalise(hint)));
  if (hint && !nameMatches) return false;
  return nameMatches || Boolean(identity.memberId && event.sourceParticipants.some((participant) => participant.memberId === identity.memberId && !trialAccountLetter(participant.label)));
}
function sourceCandidate(event: SourceEvent, evidence: Evidence, identity: TargetIdentity, sourceRevision: string): TrialScreenshotCandidate[] {
  if (!sourceTextMatches(event, evidence, identity) || !sourceTimeMatches(event, evidence)) return [];
  const hint = jiaowubaoTrialStudentNameFromCourseTitle(event.courseName);
  const shared = sharedAccount(event);
  if (evidence.sharedAccountLetter && evidence.sharedAccountLetter !== shared.letter) return [];
  if (!visibleCandidate(event, hint, identity)) return [];
  return [{ eventId: event.eventId, sourceRevision, sourceDate: event.sourceDate, startsAt: event.startsAt, endsAt: event.endsAt,
    teacherName: event.sourceTeacherLabel, courseName: event.courseName, studentNameHint: hint ?? null,
    sharedAccountLabel: shared.label, sharedAccountLetter: shared.letter,
    durationMinutes: DateTime.fromISO(event.endsAt).diff(DateTime.fromISO(event.startsAt), "minutes").minutes }];
}
function selectCandidates(matched: TrialScreenshotCandidate[], evidence: Evidence) {
  const exact = matched.filter((candidate) => normalise(candidate.courseName) === normalise(evidence.courseName));
  const candidates = exact.length ? exact : matched.length === 1 ? matched : [];
  return { candidates: candidates.slice(0, 5), ambiguous: candidates.length > 1 || !exact.length && matched.length > 1, hasMore: candidates.length > 5 };
}
function snapshotCoverage(snapshot: JiaowubaoOpenApiScheduleSnapshotWindow, parsed: ReturnType<typeof parseRequest>) {
  const covered = snapshot.sourceWindow !== null && snapshot.sourceWindow.start <= parsed.evidence.sourceDate && snapshot.sourceWindow.end >= parsed.evidence.sourceDate;
  return { state: snapshot.state, freshness: snapshot.freshness, sourceRevision: snapshot.revision, publishedAt: snapshot.publishedAt, sourceWindow: snapshot.sourceWindow, requestedWindow: parsed.window, timeZone: SOURCE_ZONE, complete: covered && ["complete", "stale"].includes(snapshot.state) };
}
async function matchingResult(dependencies: Dependencies, parsed: ReturnType<typeof parseRequest>): Promise<TrialScreenshotMatchResult> {
  const identity = await authorizeTrialScreenshotTarget(dependencies, parsed.target);
  if (!identity.fullAdmin && !identity.memberId && !identity.names.size) return { candidates: [], ambiguous: false, hasMore: false, coverage: null, reason: "needs_identity" };
  const snapshot = await dependencies.readSnapshot({ windowStart: parsed.window.startsAt, windowEnd: parsed.window.endsAt, scope: "all", teacherLabels: null, studentMemberIds: null, studentNameKeys: null, limit: 1, cursor: null, revision: null });
  const coverage = snapshotCoverage(snapshot, parsed);
  if (!coverage.complete || !snapshot.revision || !/^sha256:[a-f0-9]{64}$/u.test(snapshot.revision)) return { candidates: [], ambiguous: false, hasMore: false, coverage };
  const events = await dependencies.readSource(snapshot.revision, parsed.window, {}, snapshot.freshness === "stale" ? snapshot.sourceWindow : null);
  const matched = events.flatMap((event) => sourceCandidate(event, parsed.evidence, identity, snapshot.revision!)).sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.eventId.localeCompare(b.eventId));
  return { ...selectCandidates(matched, parsed.evidence), coverage };
}
export function createTrialScreenshotMatchHandler(dependencies: Dependencies) {
  return async (request: Request) => {
    try {
      if (Number(request.headers.get("content-length")) > 8192) fail(413, "request_too_large", "排课识别参数过长。");
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > 8192) fail(413, "request_too_large", "排课识别参数过长。");
      return json(await matchingResult(dependencies, parseRequest(JSON.parse(body))));
    } catch (error) {
      if (error instanceof SyntaxError) return json({ error: "排课识别参数无效。", code: "invalid_request" }, 400);
      return failure(error);
    }
  };
}
