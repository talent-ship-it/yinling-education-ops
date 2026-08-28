import type { OpsStateRow } from "@/lib/ops-store";
import { resolveDemoOperationsName, resolveDemoStaffName } from "@/lib/demo-users";
import {
  LP_WORKFLOW_TYPES,
  type LpFieldValues,
  type LpWorkflowType,
  validateCompleteLpWorkflowFields,
  validateLpDocumentUrl,
} from "@/lib/lp-workflows";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STUDENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const LP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export type LpAtomicOperation = "create" | "revise";

export type LpAtomicExpectedVersions = Readonly<{
  students: number;
  lpItems: number;
  tasks: number;
  files: number;
}>;

export type LpProvisionalIntake = Readonly<{
  course: string;
  guardianWechat: string;
  owner: string;
  planner: string;
}>;

export type LpAtomicCommand = Readonly<{
  commandKey: string;
  operation: LpAtomicOperation;
  studentId?: string;
  provisionalIntake?: LpProvisionalIntake;
  workflowType?: LpWorkflowType;
  lpItemId?: string;
  fields: LpFieldValues;
  revisionNote?: string;
  expectedVersions: LpAtomicExpectedVersions;
}>;

export class LpAtomicError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new LpAtomicError("invalid_command", `${field} 包含未允许的字段。`);
  }
}

function text(value: unknown, field: string, max = 2_000, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || (!optional && !value.trim()) || value.length > max) {
    throw new LpAtomicError("invalid_command", `${field} 无效。`);
  }
  return value.trim();
}

function versions(value: unknown): LpAtomicExpectedVersions {
  if (!record(value)) throw new LpAtomicError("invalid_command", "expectedVersions 必须是对象。");
  exactKeys(value, ["students", "lpItems", "tasks", "files"], "expectedVersions");
  const result = {} as { -readonly [K in keyof LpAtomicExpectedVersions]: number };
  for (const key of ["students", "lpItems", "tasks", "files"] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1) {
      throw new LpAtomicError("invalid_command", `${key} 版本号无效。`);
    }
    result[key] = value[key] as number;
  }
  return result;
}

function parseFields(value: unknown, operation: LpAtomicOperation, workflowType?: LpWorkflowType): LpFieldValues {
  if (!record(value)) throw new LpAtomicError("invalid_command", "LP fields 必须是对象。");
  if (operation === "create") {
    if (!workflowType) throw new LpAtomicError("invalid_command", "创建 LP 缺少 workflowType。");
    try {
      return validateCompleteLpWorkflowFields(workflowType, value as LpFieldValues);
    } catch (error) {
      throw new LpAtomicError("invalid_command", error instanceof Error ? error.message : "LP 字段无效。");
    }
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["documentUrl"].includes(key))) {
    throw new LpAtomicError("invalid_command", "LP 修订只允许提交文档链接。");
  }
  if (keys.length !== 1 || typeof value.documentUrl !== "string") {
    throw new LpAtomicError("invalid_command", "LP 修订必须提交文档链接。");
  }
  try {
    return { documentUrl: validateLpDocumentUrl(value.documentUrl) };
  } catch (error) {
    throw new LpAtomicError("invalid_command", error instanceof Error ? error.message : "文档链接无效。");
  }
}

function provisionalIntake(value: unknown): LpProvisionalIntake {
  if (!record(value)) throw new LpAtomicError("invalid_command", "provisionalIntake 必须是对象。");
  exactKeys(value, ["course", "guardianWechat", "owner", "planner"], "provisionalIntake");
  const owner = resolveDemoOperationsName(text(value.owner, "provisionalIntake.owner", 120));
  const planner = resolveDemoStaffName(text(value.planner, "provisionalIntake.planner", 120));
  if (!owner || !planner) throw new LpAtomicError("invalid_assignment", "临时学生的教务和规划老师必须是当前有效人员。");
  return {
    course: text(value.course, "provisionalIntake.course", 240)!,
    guardianWechat: text(value.guardianWechat, "provisionalIntake.guardianWechat", 240)!,
    owner,
    planner,
  };
}

export function parseLpAtomicCommand(input: unknown): LpAtomicCommand {
  if (!record(input)) throw new LpAtomicError("invalid_command", "LP 命令必须是对象。");
  const operation = input.operation;
  if (operation !== "create" && operation !== "revise") throw new LpAtomicError("invalid_command", "LP 操作类型无效。");
  const hasProvisionalIntake = operation === "create" && input.provisionalIntake !== undefined;
  const expected = operation === "create"
    ? hasProvisionalIntake
      ? ["commandKey", "operation", "workflowType", "fields", "provisionalIntake", "expectedVersions"]
      : ["commandKey", "operation", "studentId", "workflowType", "fields", "expectedVersions"]
    : ["commandKey", "operation", "studentId", "lpItemId", "fields", "revisionNote", "expectedVersions"];
  exactKeys(input, expected, "command");
  const commandKey = text(input.commandKey, "commandKey", 80);
  if (!commandKey || !UUID_V4.test(commandKey)) throw new LpAtomicError("invalid_command", "commandKey 必须是 UUID v4。");
  const studentId = hasProvisionalIntake ? undefined : text(input.studentId, "studentId", 120);
  if (studentId && (!STUDENT_ID.test(studentId) || studentId.toLowerCase().includes("temp"))) {
    throw new LpAtomicError("invalid_command", "studentId 无效。");
  }
  const workflowType = input.workflowType as LpWorkflowType | undefined;
  if (operation === "create" && !(LP_WORKFLOW_TYPES as readonly string[]).includes(workflowType ?? "")) {
    throw new LpAtomicError("invalid_command", "workflowType 无效。");
  }
  if (operation === "create" && workflowType === "学生直报（无试听）") {
    throw new LpAtomicError("direct_enrollment_required", "学生直报必须使用学生直报专用原子事务，不能通过普通 LP 入口保存。");
  }
  if (hasProvisionalIntake && workflowType !== "试听 LP") {
    throw new LpAtomicError("invalid_command", "只有试听 LP 可以创建无姓名临时档案。");
  }
  const lpItemId = operation === "revise" ? text(input.lpItemId, "lpItemId", 160) : undefined;
  if (lpItemId && !LP_ID.test(lpItemId)) throw new LpAtomicError("invalid_command", "lpItemId 无效。");
  const fields = parseFields(input.fields, operation, workflowType);
  const revisionNote = operation === "revise" ? text(input.revisionNote, "revisionNote", 2_000, true) : undefined;
  const parsedProvisionalIntake = hasProvisionalIntake ? provisionalIntake(input.provisionalIntake) : undefined;
  if (parsedProvisionalIntake && fields.responsibleOperations !== parsedProvisionalIntake.owner) {
    throw new LpAtomicError("invalid_assignment", "临时学生负责人必须与 LP 所属教务一致。");
  }
  return {
    commandKey,
    operation,
    ...(studentId ? { studentId } : {}),
    ...(parsedProvisionalIntake ? { provisionalIntake: parsedProvisionalIntake } : {}),
    ...(workflowType ? { workflowType } : {}),
    ...(lpItemId ? { lpItemId } : {}),
    fields,
    ...(revisionNote ? { revisionNote } : {}),
    expectedVersions: versions(input.expectedVersions),
  };
}

export function lpAtomicIntent(command: LpAtomicCommand) {
  return {
    operation: command.operation,
    ...(command.studentId ? { studentId: command.studentId } : {}),
    ...(command.provisionalIntake ? { provisionalIntake: command.provisionalIntake } : {}),
    ...(command.workflowType ? { workflowType: command.workflowType } : {}),
    ...(command.lpItemId ? { lpItemId: command.lpItemId } : {}),
    fields: command.fields,
    ...(command.revisionNote ? { revisionNote: command.revisionNote } : {}),
    expectedVersions: command.expectedVersions,
  } as const;
}

function records(rows: readonly OpsStateRow[], entity: string) {
  const payload = rows.find((row) => row.entity === entity)?.payload;
  return Array.isArray(payload) ? payload.filter(record) : [];
}

export function prepareLpAtomicCommand(input: { command: LpAtomicCommand; rows: readonly OpsStateRow[]; canOperateStudent: boolean; actor: string; fullAdmin: boolean }) {
  for (const entity of ["students", "lpItems", "tasks", "files"] as const) {
    const row = input.rows.find((candidate) => candidate.entity === entity);
    if (!row) throw new LpAtomicError("invalid_shared_state", `${entity} 共享状态缺失。`);
    if (row.version !== input.command.expectedVersions[entity]) throw new LpAtomicError("version_conflict", "共享资料刚刚发生变化，请刷新后重试。");
  }
  if (input.command.provisionalIntake) {
    if (!input.fullAdmin) throw new LpAtomicError("provisional_forbidden", "无姓名临时建档需要超级管理员处理。");
    return {
      ...input.command,
      authorizedAssignment: {
        owner: input.command.provisionalIntake.owner,
        planner: input.command.provisionalIntake.planner,
        mayReassign: true,
      },
      commandIntent: lpAtomicIntent(input.command),
      actor: input.actor,
    } as const;
  }
  if (!input.canOperateStudent) throw new LpAtomicError("student_scope_forbidden", "当前账号不能操作该学生。");
  const student = records(input.rows, "students").find((item) => item.id === input.command.studentId);
  if (!student) throw new LpAtomicError("student_not_found", "学生档案不存在。");
  if (student.importArchived === true) throw new LpAtomicError("student_archived", "已归档学生不能创建或修订 LP。");
  if (input.command.operation === "revise" && !records(input.rows, "lpItems").some((item) => item.id === input.command.lpItemId && item.studentId === input.command.studentId)) {
    throw new LpAtomicError("lp_not_found", "LP 工作流不存在或不属于该学生。");
  }
  const lockedOwner = typeof student.owner === "string" ? student.owner.trim() : "";
  const lockedPlanner = typeof student.planner === "string" ? student.planner.trim() : "";
  if (input.command.operation === "revise") {
    if (!lockedOwner) throw new LpAtomicError("invalid_assignment", "学生当前负责人缺失，不能修订 LP。");
    return {
      ...input.command,
      authorizedAssignment: { owner: lockedOwner, planner: lockedPlanner, mayReassign: false },
      commandIntent: lpAtomicIntent(input.command),
      actor: input.actor,
    } as const;
  }
  const requestedOwner = typeof input.command.fields.responsibleOperations === "string"
    ? input.command.fields.responsibleOperations.trim()
    : lockedOwner;
  const requestedPlanner = input.command.workflowType === "学生报名交接" && typeof input.command.fields.planner === "string"
    ? input.command.fields.planner.trim()
    : lockedPlanner;
  const owner = input.fullAdmin ? resolveDemoOperationsName(requestedOwner) : requestedOwner === lockedOwner ? lockedOwner : null;
  const planner = input.command.workflowType === "学生报名交接"
    ? input.fullAdmin ? resolveDemoStaffName(requestedPlanner) : requestedPlanner === lockedPlanner ? resolveDemoStaffName(lockedPlanner) : null
    : lockedPlanner;
  if (!owner) throw new LpAtomicError("assignment_forbidden", "LP 负责人必须来自学生当前归属；只有超级管理员可改为有效教务人员。");
  if (input.command.workflowType === "学生报名交接" && !planner) {
    throw new LpAtomicError("invalid_planner", "学生报名交接必须指派当前有效的规划老师。");
  }
  return {
    ...input.command,
    authorizedAssignment: { owner, planner: planner ?? lockedPlanner, mayReassign: input.fullAdmin },
    commandIntent: lpAtomicIntent(input.command),
    actor: input.actor,
  } as const;
}
