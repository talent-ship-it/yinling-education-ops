import { buildWecomLpDraft } from "./wecom-lp-draft";
import { DEFAULT_TEACHING_CONTROL_WATCHER, deterministicTaskId, formatTaskDeadline, statusForDueAt, type OpsTask } from "./ops-tasks";
import { completeTrialSchedulingReminderTasks, generateJiaowubaoTrialTasks, generateTrialManualRequestTasks, type TrialScheduleLink } from "./trial-operations";
import { completeTrialRequestFollowUps, trialRequestFollowUpRules } from "./trial-handover-tasks";
import { prepareWecomHandoverScheduleProjection } from "./wecom-handover-schedule-projection";
import type { WecomHandoverScheduleInput } from "./wecom-handover-schedule-types";
import type { WecomLpDraftRawSource } from "./wecom-lp-intake";

export type HandoverTaskSource = WecomLpDraftRawSource & { identityAt: string | null };
export type HandoverTaskState = { sourceMessageId: string; version: number; tasks: OpsTask[] };
export type HandoverTaskInput = Omit<WecomHandoverScheduleInput, "sources"> & { sources: HandoverTaskSource[]; states: HandoverTaskState[] };
export type HandoverTaskGroup = { source: HandoverTaskSource; version: number; studentName: string; schedule?: TrialScheduleLink; tasks: OpsTask[] };
export const HANDOVER_IDENTITY_RULE = "wecom.handover.identity";
const FOLLOW_UP_RULES = new Set(["trial.jiaowubao.request-follow-up-n3", "trial.jiaowubao.prep-n1"]);

function nameKey(value: string) { return value.normalize("NFKC").toLocaleLowerCase("en-AU").replace(/\s+/gu, ""); }
function taskSchedule(source: HandoverTaskSource, input: HandoverTaskInput, now: Date) {
  if (source.status !== "identified" || !source.studentName) return undefined;
  const sources = input.sources.filter((entry) => entry.status === "identified" && entry.studentName);
  const evidence = prepareWecomHandoverScheduleProjection({ ...input, sources, targetSourceMessageIds: [source.sourceMessageId], checkedAt: now })[0];
  if (!evidence || !["matched", "candidate"].includes(evidence.status) || evidence.candidates.length !== 1) return undefined;
  const candidate = evidence.candidates[0]!;
  if (nameKey(candidate.studentName) !== nameKey(source.studentName)) return undefined;
  const event = input.events.find((entry) => entry.eventId === candidate.schedule.eventId && !entry.historical);
  if (!event) return undefined;
  const peers = input.sources.filter((peer) => peer.sourceMessageId !== source.sourceMessageId && !peer.confirmed
    && peer.studentName && nameKey(peer.studentName) === nameKey(source.studentName!));
  if (peers.some((peer) => buildWecomLpDraft(peer.messages).fields.subject === buildWecomLpDraft(source.messages).fields.subject)) return undefined;
  return candidate.schedule;
}
function identityTask(source: HandoverTaskSource, now: Date): OpsTask {
  const requestedAt = new Date(source.handoverAt ?? source.messages.find((message) => message.messageId === source.sourceMessageId)!.sentAt);
  const dueAt = new Date(requestedAt.valueOf() + 86_400_000).toISOString();
  const done = source.status === "identified" && Boolean(source.studentName) && Boolean(source.identityAt);
  return {
    id: deterministicTaskId(source.sourceMessageId, HANDOVER_IDENTITY_RULE), ruleKey: HANDOVER_IDENTITY_RULE,
    title: `《教务+教统》【核对交接信息】<${source.studentName || source.wechatName}> <${source.wechatName}>`,
    studentId: `WECOM:${source.caseId}`, owner: source.operationsOwner!,
    assignees: [source.operationsOwner!, DEFAULT_TEACHING_CONTROL_WATCHER], watchers: [DEFAULT_TEACHING_CONTROL_WATCHER],
    dueAt, due: formatTaskDeadline(dueAt, "Asia/Shanghai")!, status: done ? "done" : statusForDueAt(dueAt, now),
    tone: done ? "green" : "blue", category: "试听", anchorBookingId: source.sourceMessageId,
    trigger: "企业微信试听交接", ...(done ? { closedAt: new Date(source.identityAt!).toISOString(), completionOutcome: "done" as const, result: "真名和微信名已关联" } : {}),
  };
}
function manualIntake(fields: ReturnType<typeof buildWecomLpDraft>["fields"], source: HandoverTaskSource, requestAt: string) {
  return { planner: source.coursePlanner as "Tara" | "Eileen" | "Abby", requestSentAt: requestAt,
    contactParents: fields.contactParents === true, contactStudent: fields.contactStudent === true,
    writingRequired: fields.writingRequired === true, paperRequired: fields.paperRequired === true,
    trialDurationMinutes: fields.trialDurationMinutes === 45 ? 45 as const : 60 as const };
}
function sourceTasks(source: HandoverTaskSource, schedule: TrialScheduleLink | undefined, now: Date) {
  const draft = buildWecomLpDraft(source.messages);
  const fields = draft.fields;
  const identity = identityTask(source, now);
  const tasks = [identity];
  if (draft.conflicts.length || source.status !== "identified" || !source.studentName) return tasks;
  const requestAt = String(fields.requestSentAt);
  if (!Number.isFinite(Date.parse(requestAt))) return tasks;
  const manual = generateTrialManualRequestTasks({
    lpItemId: source.sourceMessageId, studentId: identity.studentId, studentName: source.studentName,
    guardianWechat: source.wechatName, owner: identity.owner, specifiedContentStatus: String(fields.specifiedContentStatus ?? ""),
    intake: manualIntake(fields, source, requestAt), now,
  });
  tasks.push(...(schedule ? completeTrialSchedulingReminderTasks(manual, { lpItemId: source.sourceMessageId, eventId: schedule.eventId, completedAt: schedule.matchedAt }) : manual));
  if (schedule) tasks.push(...generateJiaowubaoTrialTasks({ lpItemId: source.sourceMessageId, studentId: identity.studentId,
    studentName: source.studentName, owner: identity.owner, planner: source.coursePlanner ?? "", requestSentAt: requestAt,
    preparationFollowUp: fields.preparationFollowUp === "是", requestFollowUpRules: trialRequestFollowUpRules(fields, undefined), link: schedule, now,
  }).filter((task) => FOLLOW_UP_RULES.has(task.ruleKey ?? "")));
  return tasks;
}
function restoreTask(task: OpsTask, prior: OpsTask | undefined): OpsTask {
  const note = { completionNote: prior?.completionNote, completionNoteUpdatedAt: prior?.completionNoteUpdatedAt };
  if (task.ruleKey === HANDOVER_IDENTITY_RULE || task.status === "done") return { ...task, ...note };
  if (prior?.status === "done") return { ...task, ...note, status: prior.status, tone: prior.tone, result: prior.result, closedAt: prior.closedAt, completionOutcome: prior.completionOutcome };
  return { ...task, ...note };
}
function sentPaper(tasks: OpsTask[]) {
  return tasks.some((parent) => parent.ruleKey === "trial.manual-request.paper-send" && parent.status === "done" && parent.completionOutcome !== "cannot_do");
}
function closeCompletedFollowUps(tasks: OpsTask[], now: Date) {
  return tasks.reduce((current, action) => action.status === "done" && action.completionOutcome !== "cannot_do"
    ? completeTrialRequestFollowUps(current, action, action.closedAt ?? now.toISOString()) : current, tasks);
}
function restorePaperTasks(current: OpsTask[], previous: OpsTask[], sourceMessageId: string) {
  if (!sentPaper(current)) return;
  for (const task of previous) {
    if (task.ruleKey === "trial.manual-request.paper-receive" && task.anchorBookingId === sourceMessageId
      && !current.some((candidate) => candidate.id === task.id)) current.push(task);
  }
}
function mergeHistory(generated: OpsTask[], state: HandoverTaskState | undefined, source: HandoverTaskSource, now: Date): OpsTask[] {
  const byId = new Map((state?.tasks ?? []).map((task) => [task.id, task]));
  const current = generated.map((task) => restoreTask(task, byId.get(task.id)));
  restorePaperTasks(current, state?.tasks ?? [], source.sourceMessageId);
  return closeCompletedFollowUps(current, now);
}
export function handoverTaskGroups(input: HandoverTaskInput, now: Date): HandoverTaskGroup[] {
  return input.sources.filter((source) => !source.confirmed && source.operationsOwner
    && !["identity_conflict", "identity_ambiguous"].includes(source.status)
    && buildWecomLpDraft(source.messages).workflowType === "试听 LP").map((source) => {
    const schedule = taskSchedule(source, input, now);
    const state = input.states.find((entry) => entry.sourceMessageId === source.sourceMessageId);
    return { source, version: state?.version ?? 0, studentName: source.studentName || source.wechatName,
      ...(schedule ? { schedule } : {}), tasks: mergeHistory(sourceTasks(source, schedule, now), state, source, now) };
  });
}
