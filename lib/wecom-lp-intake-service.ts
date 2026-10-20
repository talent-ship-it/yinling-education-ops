import type { DemoSessionIdentity } from "./demo-session-token";
import { buildOpsAccessContext, canOperateStudent, canWriteOpsTransaction, filterOpsStateRows } from "./ops-access";
import { normaliseDemoUserName } from "./demo-users";
import { LpAtomicError } from "./lp-atomic-service";
import { buildWecomLpDraft } from "./wecom-lp-draft";
import { parseWecomLpDraftQuery } from "./wecom-lp-draft-query";
import { matchWecomDraftStudent, parseWecomLpConfirmation, type WecomLpConfirmation, type WecomLpDraftRawSource } from "./wecom-lp-intake";
import type { OpsStateRow, readWecomLpDraft, readWecomLpDrafts, confirmWecomLpDraftAtomic } from "./ops-store";

type Dependencies = {
  readSession: () => Promise<{ session: DemoSessionIdentity; fullAdmin: boolean } | { error: string; status: number }>;
  readRows: () => Promise<OpsStateRow[]>;
  readDraft: typeof readWecomLpDraft;
  readDrafts: typeof readWecomLpDrafts;
  confirm: typeof confirmWecomLpDraftAtomic;
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
function decorate(source: WecomLpDraftRawSource, rows: readonly OpsStateRow[]) {
  return { ...source, draft: buildWecomLpDraft(source.messages), matchedStudentId: matchWecomDraftStudent(source, studentsFrom(rows)) };
}
function authorizeExisting(ctx: Context, command: WecomLpConfirmation, student: Record<string, unknown> | undefined) {
  if (!command.studentId) return;
  if (!student || !canOperateStudent(ctx.access, command.studentId)) fail(403, "当前账号不能操作该学生。");
  if (!ctx.fullAdmin && normaliseDemoUserName(String(student.owner)) !== normaliseDemoUserName(ctx.session.user)) fail(403, "教务只能处理自己负责的学生交接。");
}
function authorizeAssignment(ctx: Context, command: WecomLpConfirmation) {
  if (!ctx.fullAdmin && normaliseDemoUserName(String(command.fields.responsibleOperations)) !== normaliseDemoUserName(ctx.session.user)) fail(403, "教务只能处理自己负责的学生交接。");
  if (command.newStudent && !canWriteOpsTransaction(ctx.access, "students", ["students", "lpItems", "tasks", "files"])) fail(403, "当前账号不能创建学生档案。");
}
async function prepareTarget(dependencies: Dependencies, ctx: Context, command: WecomLpConfirmation) {
  const source = await dependencies.readDraft({ sourceMessageId: command.sourceMessageId, actor: ctx.session.user, fullAdmin: ctx.fullAdmin });
  if (!source || source.caseId !== command.caseId) fail(404, "未找到可处理的交接来源。");
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
export function createWecomLpIntakeHandlers(dependencies: Dependencies) {
  return {
    GET: async (request: Request) => {
      try {
        const ctx = await context(dependencies);
        const query = parseWecomLpDraftQuery(new URL(request.url).searchParams);
        const page = await dependencies.readDrafts({ actor: ctx.session.user, fullAdmin: ctx.fullAdmin, ...query });
        const visible = filterOpsStateRows(ctx.rows, ctx.access);
        return json({ drafts: page.rows.map((source) => decorate(source, visible)), nextCursor: page.nextCursor, total: page.total });
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
