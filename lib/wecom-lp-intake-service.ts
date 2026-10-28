import type { DemoSessionIdentity } from "./demo-session-token";
import { buildOpsAccessContext, canOperateStudent, canWriteOpsTransaction, filterOpsStateRows } from "./ops-access";
import { normaliseDemoUserName } from "./demo-users";
import { LpAtomicError } from "./lp-atomic-service";
import { buildWecomLpDraft } from "./wecom-lp-draft";
import { decorateWecomLpDraft } from "./wecom-lp-draft-enrichment";
import { applyWecomHandoverScheduleEvidence } from "./wecom-handover-schedule-display";
import { parseWecomLpDraftQuery, type WecomLpDraftQuery } from "./wecom-lp-draft-query";
import { matchWecomDraftStudent, parseWecomLpConfirmation, type WecomLpConfirmation, type WecomLpDraftSource } from "./wecom-lp-intake";
import type { OpsStateRow, readWecomLpDraft, readWecomLpDrafts, readWecomHandoverScheduleEvidence, confirmWecomLpDraftAtomic } from "./ops-store";

type Dependencies = {
  readSession: () => Promise<{ session: DemoSessionIdentity; fullAdmin: boolean } | { error: string; status: number }>;
  readRows: () => Promise<OpsStateRow[]>;
  readDraft: typeof readWecomLpDraft;
  readDrafts: typeof readWecomLpDrafts;
  confirm: typeof confirmWecomLpDraftAtomic;
  readScheduleEvidence: typeof readWecomHandoverScheduleEvidence;
};
class IntakeError extends Error {
  constructor(readonly status: number, message: string, readonly code = "invalid_draft") { super(message); }
}
function fail(status: number, message: string, code?: string): never { throw new IntakeError(status, message, code); }
function json(payload: unknown, status = 200) { return Response.json(payload, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } }); }
const storeFailures: Record<string, readonly [number, string, string]> = {
  PGRST202: [501, "交接草稿数据库功能尚未就绪。", "contract_unavailable"],
  "42883": [501, "交接草稿数据库功能尚未就绪。", "contract_unavailable"],
  "40001": [409, "交接来源已变化或已确认，请刷新草稿后重试。", "draft_conflict"],
  "23505": [409, "交接来源已变化或已确认，请刷新草稿后重试。", "draft_conflict"],
  "42501": [403, "当前账号不能处理这条交接。", "scope_forbidden"],
  P0002: [404, "未找到交接来源。", "source_not_found"],
  "22023": [400, "交接内容需要核对，未创建学生或 LP。", "invalid_draft"],
};
function failure(error: unknown) {
  if (error instanceof IntakeError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof LpAtomicError) return json({ error: error.message, code: error.code }, 400);
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const mapped = storeFailures[code];
  if (mapped) return json({ error: mapped[1], code: mapped[2] }, mapped[0]);
  return json({ error: "交接草稿暂时无法读取或保存，请重试。", code: "unavailable" }, 503);
}
async function context(dependencies: Dependencies) {
  const resolved = await dependencies.readSession();
  if (!("session" in resolved)) fail(resolved.status, resolved.error);
  const { session, fullAdmin } = resolved;
  if (session.role === "teacher") fail(403, "老师账号不能处理交接草稿。");
  const rows = await dependencies.readRows();
  const access = buildOpsAccessContext(rows, session.user, fullAdmin, session);
  if (!canWriteOpsTransaction(access, "lpItems", ["students", "lpItems", "tasks", "files"]) || access.restrictedStudentScope) fail(403, "当前账号不能处理交接草稿。");
  return { session, fullAdmin, rows, access };
}
type Context = Awaited<ReturnType<typeof context>>;
function studentsFrom(rows: readonly OpsStateRow[]) {
  const payload = rows.find((row) => row.entity === "students")?.payload;
  return Array.isArray(payload) ? payload as Record<string, unknown>[] : [];
}
function authorizeExisting(ctx: Context, command: WecomLpConfirmation, student: Record<string, unknown> | undefined) {
  if (!command.studentId) return;
  if (!student || student.importArchived === true || !canOperateStudent(ctx.access, command.studentId)) fail(403, "当前账号不能操作该学生。");
  if (!ctx.fullAdmin && normaliseDemoUserName(String(student.owner)) !== normaliseDemoUserName(ctx.session.user)) fail(403, "教务只能处理自己负责的学生交接。");
}
function authorizeAssignment(ctx: Context, command: WecomLpConfirmation) {
  if (!ctx.fullAdmin && normaliseDemoUserName(String(command.fields.responsibleOperations)) !== normaliseDemoUserName(ctx.session.user)) fail(403, "教务只能处理自己负责的学生交接。");
  if (command.newStudent && !canWriteOpsTransaction(ctx.access, "students", ["students", "lpItems", "tasks", "files"])) fail(403, "当前账号不能创建学生档案。");
}
function assertSourceWorkflowType(source: import("./wecom-lp-intake").WecomLpDraftRawSource, command: WecomLpConfirmation) {
  const draft = buildWecomLpDraft(source.messages);
  if (!draft.workflowType || draft.workflowType !== command.workflowType) fail(409, "交接类型与原文不一致，请核对交接来源。", "workflow_conflict");
}
async function prepareTarget(dependencies: Dependencies, ctx: Context, command: WecomLpConfirmation) {
  const source = await dependencies.readDraft({ sourceMessageId: command.sourceMessageId, actor: ctx.session.user, fullAdmin: ctx.fullAdmin });
  if (!source || source.caseId !== command.caseId) fail(404, "未找到可处理的交接来源。");
  if (!source.confirmed) assertSourceWorkflowType(source, command);
  const students = studentsFrom(ctx.rows);
  const student = students.find((row) => row.id === command.studentId);
  authorizeExisting(ctx, command, student);
  authorizeAssignment(ctx, command);
  if (command.newStudent && !source.confirmed && matchWecomDraftStudent(source, students)) fail(409, "已找到对应学生档案，请选择已有学生。", "student_exists");
  return { owner: String(command.fields.responsibleOperations), planner: String(student?.planner ?? command.fields.planner), mayReassign: ctx.fullAdmin };
}
function committedResponse(result: Awaited<ReturnType<Dependencies["confirm"]>>[number] | undefined, ctx: Context) {
  if (!result?.students_row || !result.lp_items_row || !result.tasks_row || !result.files_row) fail(503, "交接确认结果暂不可用，请重试。", "invalid_commit_result");
  const rows = [result.students_row, result.lp_items_row, result.tasks_row, result.files_row] as OpsStateRow[];
  const visible = filterOpsStateRows(rows, buildOpsAccessContext(rows, ctx.session.user, ctx.fullAdmin, ctx.session));
  return json({ committed: true, applied: result.applied, studentId: result.student_id, lpItemId: result.lp_item_id, studentsRow: visible.find((row) => row.entity === "students"), lpItemsRow: visible.find((row) => row.entity === "lpItems"), tasksRow: visible.find((row) => row.entity === "tasks"), filesRow: visible.find((row) => row.entity === "files") });
}
async function decoratePage(dependencies: Dependencies, ctx: Context, sources: readonly import("./wecom-lp-intake").WecomLpDraftRawSource[]) {
  const visible = filterOpsStateRows(ctx.rows, ctx.access);
  const drafts = sources.map((source) => decorateWecomLpDraft(source, studentsFrom(ctx.rows), visible));
  const isTrialDraft = (source: typeof drafts[number]) => source.draft.workflowType === "试听 LP" || source.draft.workflowType === "换老师试听";
  const trialDrafts = drafts.filter(isTrialDraft);
  if (!trialDrafts.length) return drafts;
  try {
    const evidence = await dependencies.readScheduleEvidence({ sourceMessageIds: trialDrafts.map((source) => source.sourceMessageId), actor: ctx.session.user, fullAdmin: ctx.fullAdmin });
    if (!Array.isArray(evidence)) throw new Error("invalid_handover_schedule_evidence");
    return drafts.map((source) => isTrialDraft(source) ? applyWecomHandoverScheduleEvidence(source, evidence.find((entry) => entry.sourceMessageId === source.sourceMessageId), visible) : source);
  } catch {
    return drafts.map((source) => isTrialDraft(source) ? { ...source, scheduleEvidenceUnavailable: true } : source);
  }
}
function matchesDraftFilters(source: WecomLpDraftSource, query: WecomLpDraftQuery) {
  if (query.scheduleMatch) {
    const trial = source.draft.workflowType === "试听 LP" || source.draft.workflowType === "换老师试听";
    const schedule = Boolean(source.trialSchedule || source.scheduleEvidence?.candidates.length);
    if (!trial || (query.scheduleMatch === "matched" ? !schedule : schedule || source.scheduleEvidenceUnavailable)) return false;
  }
  if (!query.query) return true;
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-AU").replace(/[\s\p{P}\p{S}_]+/gu, "");
  const text = [source.studentName, source.resolvedStudentName, source.wechatName, source.operationsOwner, source.coursePlanner, source.draft.workflowType,
    ...Object.values(source.draft.fields), ...source.messages.map((message) => message.text)].filter((value): value is string => typeof value === "string").join("\n");
  const haystack = normalize(text);
  return query.query.split(/\s+/u).map(normalize).filter(Boolean).every((token) => haystack.includes(token));
}
async function filteredDraftPage(dependencies: Dependencies, ctx: Context, query: WecomLpDraftQuery) {
  const drafts: WecomLpDraftSource[] = [];
  const sources = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let afterCursor = query.cursor === null;
  let total = 0;
  do {
    const page = await dependencies.readDrafts({ actor: ctx.session.user, fullAdmin: ctx.fullAdmin, from: query.from, before: query.before, cursor });
    for (const source of await decoratePage(dependencies, ctx, page.rows)) {
      if (sources.has(source.sourceMessageId)) fail(503, "交接分页数据已变化，请刷新后重试。", "invalid_draft_page");
      sources.add(source.sourceMessageId);
      const matches = matchesDraftFilters(source, query);
      if (matches) total += 1;
      if (afterCursor && matches && drafts.length < 31) drafts.push(source);
      if (source.sourceMessageId === query.cursor) afterCursor = true;
    }
    cursor = page.nextCursor;
    if (cursor && (!page.rows.length || cursors.has(cursor))) fail(503, "交接分页数据已变化，请刷新后重试。", "invalid_draft_page");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (!afterCursor) fail(400, "分页参数已失效，请刷新后重试。", "invalid_command");
  return { drafts: drafts.slice(0, 30), nextCursor: drafts.length > 30 ? drafts[29].sourceMessageId : null, total };
}
export function createWecomLpIntakeHandlers(dependencies: Dependencies) {
  return {
    GET: async (request: Request) => {
      try {
        const ctx = await context(dependencies);
        const query = parseWecomLpDraftQuery(new URL(request.url).searchParams);
        if (query.query || query.scheduleMatch) return json(await filteredDraftPage(dependencies, ctx, query));
        const page = await dependencies.readDrafts({ actor: ctx.session.user, fullAdmin: ctx.fullAdmin, ...query });
        return json({ drafts: await decoratePage(dependencies, ctx, page.rows), nextCursor: page.nextCursor, total: page.total });
      } catch (error) { return failure(error); }
    },
    POST: async (request: Request) => {
      try {
        const ctx = await context(dependencies);
        const command = parseWecomLpConfirmation(await request.json().catch(() => null));
        const authorizedAssignment = await prepareTarget(dependencies, ctx, command);
        const result = await dependencies.confirm({ ...command, actor: ctx.session.user, fullAdmin: ctx.fullAdmin, authorizedAssignment });
        return committedResponse(result[0], ctx);
      } catch (error) { return failure(error); }
    },
  };
}
