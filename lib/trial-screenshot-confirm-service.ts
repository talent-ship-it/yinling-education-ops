import { DateTime } from "luxon";
import { TrialScreenshotError, screenshotFail as fail, screenshotRecord as record, screenshotText as text, screenshotNormalise as normalise, screenshotJson as json } from "./trial-screenshot-shared";
import type { DemoSessionIdentity } from "./demo-session-token";
import type { getJiaowubaoOpenApiScheduleSnapshotWindow, OpsStateRow, readWecomLpDraft } from "./ops-store";
import { filterOpsStateRows } from "./ops-access";
import type { readJiaowubaoTrialSourceWindow } from "./jiaowubao-trial-source-window";
import { prepareJiaowubaoTrialSyncProjection } from "./jiaowubao-trial-sync-projection";
import { authorizeTrialScreenshotTarget } from "./trial-screenshot-match-service";
import { jiaowubaoTrialStudentNameFromCourseTitle } from "./trial-operations";
import { trialAccountLetter } from "./trial-account-label";

type RecordValue = Record<string, unknown>;
export type TrialScreenshotConfirmCommand = Readonly<{
  commandKey: string; lpItemId: string; eventId: string; sourceRevision: string; sourceDate: string;
  expectedVersions: Readonly<{ students: number; lpItems: number; tasks: number }>;
}>;
export type TrialScreenshotConfirmationResult = Readonly<{
  command_key: string; applied: boolean; student_id: string; lp_item_id: string;
  lp_items_row: OpsStateRow; tasks_row: OpsStateRow; audit_entry_id: string;
}>;
export type TrialScreenshotConfirmationInput = Readonly<{
  commandKey: string; commandIntent: Omit<TrialScreenshotConfirmCommand, "commandKey">;
  expectedVersions: TrialScreenshotConfirmCommand["expectedVersions"];
  nextLpItems: readonly unknown[]; nextTasks: readonly unknown[]; actor: string; fullAdmin: boolean;
}>;
type ReceiptInput = Pick<TrialScreenshotConfirmationInput, "commandKey" | "commandIntent" | "actor" | "fullAdmin">;
type Dependencies = Readonly<{
  readSession: () => Promise<{ session: DemoSessionIdentity; fullAdmin: boolean } | { error: string; status: number }>;
  readRows: () => Promise<OpsStateRow[]>; readDraft: typeof readWecomLpDraft;
  readSnapshot: typeof getJiaowubaoOpenApiScheduleSnapshotWindow; readSource: typeof readJiaowubaoTrialSourceWindow;
  readReceipt: (input: ReceiptInput) => Promise<TrialScreenshotConfirmationResult[]>;
  commit: (input: TrialScreenshotConfirmationInput) => Promise<TrialScreenshotConfirmationResult[]>;
  now?: () => Date;
}>;
function keys(value: RecordValue, expected: readonly string[]) {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) fail(400, "invalid_request", "试听补全参数无效。");
}
function assertSourceDate(sourceDate: string) {
  const day = DateTime.fromISO(sourceDate, { zone: "Australia/Melbourne" });
  if (!day.isValid || day.year < 1900 || day.year > 9998 || day.toISODate() !== sourceDate) fail(400, "invalid_request", "排课日期无效。");
}
function parse(value: unknown): TrialScreenshotConfirmCommand {
  if (!record(value)) fail(400, "invalid_request", "试听补全参数无效。");
  keys(value, ["commandKey", "lpItemId", "eventId", "sourceRevision", "sourceDate", "expectedVersions"]);
  const patterns = { commandKey: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, lpItemId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u, eventId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u, sourceRevision: /^sha256:[a-f0-9]{64}$/u, sourceDate: /^\d{4}-\d{2}-\d{2}$/u };
  for (const [key, pattern] of Object.entries(patterns)) if (!pattern.test(text(value[key]))) fail(400, "invalid_request", "试听补全参数无效。");
  if (!record(value.expectedVersions)) fail(400, "invalid_request", "试听资料版本无效。");
  keys(value.expectedVersions, ["students", "lpItems", "tasks"]);
  if (Object.values(value.expectedVersions).some((version) => !Number.isSafeInteger(version) || Number(version) < 1)) fail(400, "invalid_request", "试听资料版本无效。");
  assertSourceDate(text(value.sourceDate));
  return value as TrialScreenshotConfirmCommand;
}
function failure(error: unknown) {
  if (error instanceof TrialScreenshotError) return json({ error: error.message, code: error.code }, error.status);
  const code = record(error) ? String(error.code ?? "") : "";
  const conflictCodes = ["40001", "23505", "55000", "source_changed", "match_rejected", "source_mismatch"];
  if (["42501", "scope_forbidden"].includes(code)) return json({ error: "当前账号不能补全该试听交接。", code: "scope_forbidden" }, 403);
  if (conflictCodes.includes(code)) return json({ error: "试听资料或教务宝课表已变化，请刷新后重新确认。", code: "confirmation_conflict" }, 409);
  if (code === "22023") return json({ error: "试听补全参数无效。", code: "invalid_request" }, 400);
  return json({ error: "试听补全暂未确认，请使用同一次操作重试。", code: "confirmation_unavailable" }, 503);
}
type Identity = Awaited<ReturnType<typeof authorizeTrialScreenshotTarget>>;
type SourceEvent = Awaited<ReturnType<Dependencies["readSource"]>>[number];
function assertSameLinkedEvent(link: unknown, eventId: string) {
  if (record(link) && text(link.eventId) && link.eventId !== eventId) fail(409, "event_conflict", "该试听 LP 已经确认过其他课节。");
}
function assertCurrentLp(command: TrialScreenshotConfirmCommand, identity: Identity) {
  for (const entity of ["students", "lpItems", "tasks"] as const) {
    if (identity.rows.find((row) => row.entity === entity)?.version !== command.expectedVersions[entity]) fail(409, "version_conflict", "试听资料已变化，请刷新后重试。");
  }
  const lp = identity.lpItem!;
  if (lp.stage === "完成" || lp.resultStatus === "已取消") fail(409, "lp_completed", "已完成或已取消的试听 LP 不能补全排课。");
  assertSameLinkedEvent(lp.trialSchedule, command.eventId);
  assertSameLinkedEvent(lp.trialScheduleReview, command.eventId);
  return lp;
}
function sourceWindow(sourceDate: string) {
  const day = DateTime.fromISO(sourceDate, { zone: "Australia/Melbourne" }).startOf("day");
  return { startsAt: day.toUTC().toISO()!, endsAt: day.plus({ days: 1 }).startOf("day").toUTC().toISO()! };
}
function sourceCoversDate(snapshot: Awaited<ReturnType<Dependencies["readSnapshot"]>>, command: TrialScreenshotConfirmCommand) {
  if (snapshot.revision !== command.sourceRevision || snapshot.state !== "complete" || snapshot.freshness !== "fresh") return false;
  if (!snapshot.sourceWindow) return false;
  return snapshot.sourceWindow.start <= command.sourceDate && snapshot.sourceWindow.end >= command.sourceDate;
}
async function trustedEvent(dependencies: Dependencies, command: TrialScreenshotConfirmCommand) {
  const window = sourceWindow(command.sourceDate);
  const snapshot = await dependencies.readSnapshot({ windowStart: window.startsAt, windowEnd: window.endsAt, scope: "all", teacherLabels: null, studentMemberIds: null, studentNameKeys: null, limit: 1, cursor: null, revision: null });
  if (!sourceCoversDate(snapshot, command)) fail(409, "source_changed", "教务宝课表需要更新后再确认。");
  const events = await dependencies.readSource(command.sourceRevision, window);
  const event = events.find((candidate) => candidate.eventId === command.eventId);
  if (!event || event.sourceDate !== command.sourceDate || event.sourceStudentsTruncated || !text(event.sourceTeacherLabel)) fail(409, "source_changed", "该教务宝课节已变化，请重新核对。");
  return { events, event };
}
function assertEventIdentity(event: SourceEvent, identity: Identity, fields: RecordValue) {
  const hint = jiaowubaoTrialStudentNameFromCourseTitle(event.courseName);
  const knownName = fields.studentNameKnown === true ? text(fields.studentName) : "";
  if (hint && knownName && normalise(knownName) !== normalise(hint)) fail(409, "identity_conflict", "课节姓名与该试听学生不同，请重新核对。");
  if (hint && identity.names.size > 0 && !identity.names.has(normalise(hint))) fail(409, "identity_conflict", "课节姓名与该试听学生不同，请重新核对。");
  return { hint, knownName };
}
function assertSourceScope(event: SourceEvent, identity: Identity, hint: string | undefined) {
  if (identity.fullAdmin) return;
  if (hint && identity.names.has(normalise(hint))) return;
  const memberMatch = Boolean(identity.memberId && event.sourceParticipants.some((participant) => participant.memberId === identity.memberId && !trialAccountLetter(participant.label)));
  if (!memberMatch) fail(403, "scope_forbidden", "请先核对该课节对应的试听学生身份。");
}
function enrichedIntake(intake: unknown, studentName: string | undefined, durationPatch: Partial<{ trialDurationMinutes: number }>) {
  if (!record(intake)) return undefined;
  return { ...intake, ...(studentName ? { studentName } : {}), ...durationPatch };
}
function enrichLp(lp: RecordValue, event: SourceEvent, identity: Identity) {
  const fields = record(lp.fields) ? lp.fields : {};
  const { hint, knownName } = assertEventIdentity(event, identity, fields);
  assertSourceScope(event, identity, hint);
  if (lp.workflowType === "换老师试听" && normalise(fields.newTeacher) !== normalise(event.sourceTeacherLabel)) fail(409, "teacher_conflict", "排课教师与换老师试听不符。");
  const duration = DateTime.fromISO(event.endsAt).diff(DateTime.fromISO(event.startsAt), "minutes").minutes;
  const durationPatch = [45, 60].includes(duration) ? { trialDurationMinutes: duration } : {};
  const namePatch = !knownName && hint ? { studentNameKnown: true, studentName: hint } : {};
  const nextFields = { ...fields, assignedTeacher: text(event.sourceTeacherLabel), ...namePatch, ...durationPatch };
  const intake = enrichedIntake(lp.trialIntake, knownName ? undefined : hint, durationPatch);
  return { ...lp, fields: nextFields, ...(intake ? { trialIntake: intake } : {}), trialScheduleReview: { source: "screenshot-review", eventId: event.eventId }, trialSchedule: { source: "jiaowubao-open-api", confirmation: "screenshot-review", eventId: event.eventId } };
}
function receiptResponse(receipt: TrialScreenshotConfirmationResult, identity: Identity) {
  const rows = filterOpsStateRows([receipt.lp_items_row, receipt.tasks_row], identity.access);
  const lpItemsRow = rows.find((row) => row.entity === "lpItems");
  const tasksRow = rows.find((row) => row.entity === "tasks");
  if (!lpItemsRow || !tasksRow) fail(403, "scope_forbidden", "当前账号不能读取试听补全结果。");
  return json({ committed: true, applied: receipt.applied, commandKey: receipt.command_key, lpItemId: receipt.lp_item_id, studentId: receipt.student_id, lpItemsRow, tasksRow });
}
async function confirm(dependencies: Dependencies, command: TrialScreenshotConfirmCommand) {
  const identity = await authorizeTrialScreenshotTarget(dependencies, { lpItemId: command.lpItemId });
  const { commandKey, ...commandIntent } = command;
  const receiptInput = { commandKey, commandIntent, actor: identity.session.user, fullAdmin: identity.fullAdmin };
  const prior = await dependencies.readReceipt(receiptInput);
  if (prior.length) return receiptResponse({ ...prior[0]!, applied: false }, identity);
  const lp = assertCurrentLp(command, identity);
  const { events, event } = await trustedEvent(dependencies, command);
  const nextLp = enrichLp(lp, event, identity);
  const matchedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const rows = identity.rows.map((row) => row.entity === "lpItems" ? { ...row, payload: (row.payload as RecordValue[]).map((item) => item.id === lp.id ? nextLp : item) } : row);
  const projection = prepareJiaowubaoTrialSyncProjection({ rows, references: [{ lpItemId: command.lpItemId, eventId: event.eventId, startsAt: event.startsAt }], rawEvents: events, snapshotRevision: command.sourceRevision, matchedAt });
  const receipts = await dependencies.commit({ ...receiptInput, expectedVersions: command.expectedVersions, nextLpItems: projection.nextLpItems, nextTasks: projection.nextTasks });
  if (receipts.length !== 1) fail(503, "confirmation_unavailable", "试听补全暂未确认，请使用同一次操作重试。");
  return receiptResponse(receipts[0]!, identity);
}
export function createTrialScreenshotConfirmHandler(dependencies: Dependencies) {
  return async (request: Request) => {
    try {
      if (Number(request.headers.get("content-length")) > 4096) fail(413, "request_too_large", "试听补全参数过长。");
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > 4096) fail(413, "request_too_large", "试听补全参数过长。");
      return await confirm(dependencies, parse(JSON.parse(body)));
    } catch (error) {
      if (error instanceof SyntaxError) return json({ error: "试听补全参数无效。", code: "invalid_request" }, 400);
      return failure(error);
    }
  };
}
