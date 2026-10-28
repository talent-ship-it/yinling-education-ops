import type { DemoSessionIdentity } from "./demo-session-token";
import { normaliseDemoUserName } from "./demo-users";
import { buildOpsAccessContext, canReadOpsEntity, canWriteOpsEntity } from "./ops-access";
import { completeTrialTaskWithHandbookFollowUps, reopenTrialTaskWithHandbookFollowUps, TRIAL_SCHEDULING_REMINDER_RULE_KEYS } from "./trial-operations";
import { HANDOVER_IDENTITY_RULE, handoverTaskGroups, type HandoverTaskGroup, type HandoverTaskInput } from "./wecom-handover-tasks";
import type { saveWecomHandoverTasks } from "./ops-store";

type Dependencies = {
  identify: () => Promise<{ session: DemoSessionIdentity; fullAdmin: boolean } | { error: string; status: number }>;
  read: () => Promise<HandoverTaskInput>;
  save: typeof saveWecomHandoverTasks;
  now: () => Date;
};
class TaskError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function json(payload: unknown, status = 200) { return Response.json(payload, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } }); }
function failure(error: unknown) {
  if (error instanceof TaskError) return json({ error: error.message }, error.status);
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["PT409", "40001"].includes(code)) return json({ error: "任务来源已变化，请刷新后重试。" }, 409);
  if (code === "42501") return json({ error: "当前账号不能处理该交接任务。" }, 403);
  return json({ error: "交接任务暂时无法读取或保存。" }, 503);
}
async function identity(deps: Dependencies, write = false) {
  const result = await deps.identify();
  if (!("session" in result)) throw new TaskError(result.status, result.error);
  const access = buildOpsAccessContext([], result.session.user, result.fullAdmin, result.session);
  if (result.session.role === "teacher" || access.restrictedStudentScope || !canReadOpsEntity(access, "tasks")
    || write && !canWriteOpsEntity(access, "tasks")) throw new TaskError(403, "当前账号不能处理交接任务。");
  return { ...result, fullAdmin: result.fullAdmin || access.limitedAdmin };
}
function visible(group: HandoverTaskGroup, actor: string, fullAdmin: boolean) {
  return fullAdmin || normaliseDemoUserName(group.source.operationsOwner ?? "") === normaliseDemoUserName(actor);
}
function presented(groups: HandoverTaskGroup[]) {
  return { tasks: groups.flatMap((group) => group.tasks), students: groups.map((group) => ({ id: `WECOM:${group.source.caseId}`, name: group.studentName })),
    schedules: groups.flatMap((group) => group.schedule ? group.tasks.map((task) => ({ taskId: task.id, startsAt: group.schedule!.startsAt, endsAt: group.schedule!.endsAt })) : []) };
}
function validCommandFields(input: Record<string, unknown>) {
  return !Object.keys(input).some((key) => !["taskId", "action", "note"].includes(key))
    && typeof input.taskId === "string" && input.taskId.length <= 240
    && ["complete", "reopen", "cannot", "note"].includes(String(input.action));
}
function commandNote(value: unknown) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 2000) throw new TaskError(400, "任务参数无效。");
  return value.trim();
}
function command(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaskError(400, "任务参数无效。");
  const input = value as Record<string, unknown>;
  if (!validCommandFields(input)) throw new TaskError(400, "任务参数无效。");
  return { taskId: input.taskId as string, action: String(input.action), note: commandNote(input.note) };
}
function updateNote(task: HandoverTaskGroup["tasks"][number], input: ReturnType<typeof command>, now: Date) {
  const result = { ...task, completionNote: input.note, completionNoteUpdatedAt: now.toISOString() };
  if (input.action === "cannot") return { ...result, status: "done" as const, tone: "red" as const, completionOutcome: "cannot_do" as const, closedAt: now.toISOString(), result: `无法完成：${input.note}` };
  return task.completionOutcome === "cannot_do" ? { ...result, result: `无法完成：${input.note}` } : result;
}
function assertNote(group: HandoverTaskGroup["tasks"][number], input: ReturnType<typeof command>) {
  if (!input.note && (input.action === "cannot" || group.completionOutcome === "cannot_do")) throw new TaskError(400, "无法完成原因不能为空。");
}
function changedTasks(group: HandoverTaskGroup, input: ReturnType<typeof command>, now: Date) {
  const source = group.tasks.find((task) => task.id === input.taskId)!;
  if (input.action !== "note" && (source.ruleKey === HANDOVER_IDENTITY_RULE || (TRIAL_SCHEDULING_REMINDER_RULE_KEYS as readonly string[]).includes(source.ruleKey ?? ""))) throw new TaskError(409, "该任务由身份和真实排课自动完成。");
  if (input.action === "complete") return completeTrialTaskWithHandbookFollowUps(group.tasks, { taskId: source.id, completedAt: now });
  if (input.action === "reopen") return reopenTrialTaskWithHandbookFollowUps(group.tasks, { taskId: source.id, reopenedAt: now, timeZone: "Asia/Shanghai" });
  assertNote(source, input);
  return group.tasks.map((task) => task.id === source.id ? updateNote(task, input, now) : task);
}
export function createWecomHandoverTaskHandlers(deps: Dependencies) {
  return {
    GET: async () => {
      try {
        const actor = await identity(deps);
        const groups = handoverTaskGroups(await deps.read(), deps.now()).filter((group) => visible(group, actor.session.user, actor.fullAdmin));
        return json(presented(groups));
      } catch (error) { return failure(error); }
    },
    POST: async (request: Request) => {
      try {
        const actor = await identity(deps, true);
        const input = command(await request.json().catch(() => null));
        const authority = await deps.read();
        const groups = handoverTaskGroups(authority, deps.now());
        const group = groups.find((entry) => entry.tasks.some((task) => task.id === input.taskId));
        if (!group) throw new TaskError(404, "未找到可处理的交接任务。");
        if (!visible(group, actor.session.user, actor.fullAdmin)) throw new TaskError(403, "当前账号不能处理该交接任务。");
        const tasks = changedTasks(group, input, deps.now());
        await deps.save({ sourceMessageId: group.source.sourceMessageId, sourceRevision: group.source.sourceRevision,
          snapshotRevision: authority.snapshotRevision, inputRevision: authority.inputRevision, expectedVersion: group.version,
          tasks, actor: actor.session.user, fullAdmin: actor.fullAdmin });
        const after = handoverTaskGroups(await deps.read(), deps.now()).filter((entry) => visible(entry, actor.session.user, actor.fullAdmin));
        return json(presented(after));
      } catch (error) { return failure(error); }
    },
  };
}
