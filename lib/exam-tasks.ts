import {
  DEFAULT_TEACHING_CONTROL_WATCHER,
  sortTasksByDueAt,
  upsertTasksByRule,
  type OpsTask,
} from "./ops-tasks";
import type { ExamTaskAssigneeRole } from "./student-records";

export const EXAM_MANAGED_RULE_SUFFIXES = ["planning", "care", "recall", "results"] as const;
export const EXAM_RULE_NO_LONGER_APPLICABLE_RESULT = "考试日期或规则更新，任务自动关闭";

export const EXAM_ROLE_LABELS: Readonly<Record<ExamTaskAssigneeRole, string>> = Object.freeze({
  academic_coordinator: "负责教务",
  course_planner: "课程规划",
});

export type ExamTaskRoutingStudent = Readonly<{
  owner?: string;
  planner?: string;
}>;

export type ExamTaskRoutingResult =
  | { routing: null; unresolvedRoleLabels: string[] }
  | { routing: { owner: string; assignees: string[]; watchers: string[] }; unresolvedRoleLabels: [] };

export function configuredExamRecipient(value: string | undefined) {
  const candidate = value?.trim();
  return candidate && !/^(?:待分配|待确认|未知|角色待配置[:：])/.test(candidate) ? candidate : null;
}

/**
 * Routes a managed exam definition exclusively from the two persisted student
 * account fields. This pure helper is shared by the browser presentation and
 * the authenticated server submission service.
 */
export function routeExamTaskRecipients(
  roles: readonly ExamTaskAssigneeRole[],
  student: ExamTaskRoutingStudent,
): ExamTaskRoutingResult {
  if (!roles.length) throw new TypeError("exam task requires at least one assignee role");
  const routed = roles.map((role) => ({
    role,
    recipient: role === "academic_coordinator"
      ? configuredExamRecipient(student.owner)
      : configuredExamRecipient(student.planner),
  }));
  const unresolvedRoleLabels = routed
    .filter((entry) => !entry.recipient)
    .map((entry) => EXAM_ROLE_LABELS[entry.role]);
  if (unresolvedRoleLabels.length) return { routing: null, unresolvedRoleLabels };
  const recipients = routed.map((entry) => entry.recipient!);
  return {
    routing: {
      owner: recipients[0],
      assignees: [...new Set(recipients)],
      watchers: [DEFAULT_TEACHING_CONTROL_WATCHER],
    },
    unresolvedRoleLabels: [],
  };
}

function sameRecipient(left: string, right: string) {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

/**
 * Identifies an already-authorized managed exam task addressed to one account.
 * This is a presentation guard only: the server remains responsible for
 * proving the exam/student binding before returning a cross-owner task.
 */
export function isManagedExamTaskRecipient(task: OpsTask, recipient: string) {
  const match = task.ruleKey?.match(/^exam:([^:]+):(planning|care|recall|results)$/);
  if (!recipient.trim()
    || task.category !== "考试"
    || !match
    || task.anchorBookingId !== `exam:${match[1]}`) return false;
  return [task.owner, ...(task.assignees ?? []), ...(task.watchers ?? [])]
    .some((candidate) => sameRecipient(candidate, recipient));
}

function managedRuleKeys(examId: string) {
  return new Set(EXAM_MANAGED_RULE_SUFFIXES.map((suffix) => `exam:${examId}:${suffix}`));
}

function isAutomaticClosure(task: OpsTask) {
  return task.status === "done" && task.result === EXAM_RULE_NO_LONGER_APPLICABLE_RESULT;
}

/**
 * Reconciles the complete managed task set for one exam. Only tasks closed by
 * this reconciler may reopen; a task completed by a person remains completed.
 */
export function reconcileExamTasks<T extends OpsTask>(
  tasks: readonly T[],
  incoming: readonly T[],
  options: Readonly<{ examId: string; closedAt: string }>,
): T[] {
  const anchorBookingId = `exam:${options.examId}`;
  const managedRules = managedRuleKeys(options.examId);
  const incomingRules = new Set<string>();

  for (const task of incoming) {
    if (task.anchorBookingId !== anchorBookingId || !task.ruleKey || !managedRules.has(task.ruleKey)) {
      throw new TypeError("incoming exam task does not belong to the managed exam");
    }
    if (incomingRules.has(task.ruleKey)) throw new TypeError(`duplicate incoming exam task ${task.ruleKey}`);
    incomingRules.add(task.ruleKey);
  }

  const prepared = tasks.map((task) => {
    if (task.anchorBookingId !== anchorBookingId || !task.ruleKey || !managedRules.has(task.ruleKey)) {
      return { ...task };
    }
    if (!incomingRules.has(task.ruleKey)) {
      if (task.status === "done") return { ...task };
      return {
        ...task,
        status: "done" as const,
        tone: "green" as const,
        closedAt: options.closedAt,
        result: EXAM_RULE_NO_LONGER_APPLICABLE_RESULT,
      };
    }
    if (!isAutomaticClosure(task)) return { ...task };
    return {
      ...task,
      status: "waiting" as const,
      tone: "neutral" as const,
      closedAt: undefined,
      result: undefined,
    };
  });

  // upsertTasksByRule keeps a person's completed task sticky, while the
  // automatic closures above have first been made eligible to reopen.
  return sortTasksByDueAt(upsertTasksByRule(prepared, incoming));
}
