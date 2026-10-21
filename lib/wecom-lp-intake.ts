import type { LpAtomicExpectedVersions } from "./lp-atomic-service";
import { LpAtomicError, parseLpAtomicCommand } from "./lp-atomic-service";
import { displayTimezoneOptions } from "./display-preferences";
import { isRetiredOperationsIdentity, normaliseDemoUserName, resolveDemoOperationsName, resolveDemoStaffName } from "./demo-users";
import type { LpFieldValues } from "./lp-workflows";
import type { StudentCreationFields } from "./student-creation-service";
import { buildWecomLpDraft, type WecomLpDraft, type WecomLpDraftSourceRecord } from "./wecom-lp-draft";
import type { TrialScheduleLink } from "./trial-operations";

export type WecomLpDraftSource = Readonly<{
  id: string; sourceMessageId: string; caseId: string; sourceRevision: string;
  wechatName: string; studentName: string | null; operationsOwner: string | null;
  coursePlanner: string | null; status: "awaiting_student_name" | "identified" | "identity_conflict" | "identity_ambiguous";
  createdAt: string; handoverAt?: string; messages: readonly WecomLpDraftSourceRecord[];
  confirmed: null | Readonly<{ studentId: string; lpItemId: string }>;
  draft: WecomLpDraft; matchedStudentId?: string | null;
  resolvedStudentName?: string | null; trialSchedule?: TrialScheduleLink;
}>;
export type WecomLpDraftRawSource = Omit<WecomLpDraftSource, "draft" | "matchedStudentId" | "resolvedStudentName" | "trialSchedule">;
export type WecomLpDraftPage = Readonly<{ rows: readonly WecomLpDraftRawSource[]; nextCursor: string | null; total: number }>;
export type WecomLpConfirmation = Readonly<{
  commandKey: string; caseId: string; sourceMessageId: string; sourceRevision: string;
  studentId?: string; newStudent?: StudentCreationFields; fields: LpFieldValues;
  expectedVersions: LpAtomicExpectedVersions;
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, max: number) { return typeof value === "string" && value.trim().length <= max ? value.trim() : ""; }
function fail(message: string): never { throw new LpAtomicError("invalid_command", message); }
function parseConfirmationSource(input: Record<string, unknown>) {
  const allowed = ["commandKey", "caseId", "sourceMessageId", "sourceRevision", "studentId", "newStudent", "fields", "expectedVersions"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) fail("交接确认包含未允许的字段。");
  const caseId = text(input.caseId, 36);
  const sourceMessageId = text(input.sourceMessageId, 240);
  const sourceRevision = text(input.sourceRevision, 64);
  if (!UUID.test(caseId) || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,239}$/u.test(sourceMessageId) || !/^[0-9a-f]{64}$/u.test(sourceRevision)) fail("交接来源无效，请刷新草稿。");
  return { caseId, sourceMessageId, sourceRevision };
}
function parseNewStudentContact(input: unknown) {
  if (!record(input) || Object.keys(input).sort().join(",") !== "guardianWechat,timezone") fail("新学生参数无效。");
  const guardianWechat = text(input.guardianWechat, 240);
  const timezone = text(input.timezone, 100);
  if (!guardianWechat || !displayTimezoneOptions.some((option) => option.id === timezone)) fail("请核对家长微信名和学生时区。");
  return { guardianWechat, timezone };
}
function parseNewStudentAssignment(fields: LpFieldValues) {
  const owner = resolveDemoOperationsName(fields.responsibleOperations);
  const planner = resolveDemoStaffName(fields.planner);
  if (!owner || isRetiredOperationsIdentity(owner) || !planner || !["Tara", "Eileen", "Abby"].includes(planner)) fail("请选择当前有效的教务和课程规划老师。");
  return { owner, planner };
}
function deriveNewStudent(input: unknown, fields: LpFieldValues): StudentCreationFields {
  const { guardianWechat, timezone } = parseNewStudentContact(input);
  const { owner, planner } = parseNewStudentAssignment(fields);
  const name = fields.studentNameKnown === true ? text(fields.studentName, 240) : guardianWechat;
  if (!name) fail("请核对学生姓名。");
  return { name, guardianWechat, timezone, owner, planner, course: String(fields.subject), segment: "试听", lpNeed: "试听LP", grade: "待确认", location: String(fields.locationTimezone), notes: "无特殊备注" };
}
export function parseWecomLpConfirmation(input: unknown): WecomLpConfirmation {
  if (!record(input)) fail("交接确认参数无效。");
  const source = parseConfirmationSource(input);
  const hasNewStudent = input.newStudent !== undefined;
  if (hasNewStudent === (input.studentId !== undefined)) fail("请选择已有学生，或确认创建学生档案。");
  const parsed = parseLpAtomicCommand({ commandKey: input.commandKey, operation: "create", workflowType: "试听 LP", studentId: hasNewStudent ? "STU-WECOM-DRAFT" : input.studentId, fields: input.fields, expectedVersions: input.expectedVersions });
  const newStudent = hasNewStudent ? deriveNewStudent(input.newStudent, parsed.fields) : undefined;
  return { commandKey: parsed.commandKey, ...source, ...(newStudent ? { newStudent } : { studentId: parsed.studentId }), fields: parsed.fields, expectedVersions: parsed.expectedVersions };
}
function guardianKey(value: unknown) {
  if (typeof value !== "string") return "";
  const label = value.normalize("NFKC").replace(/(?:\s*@教务\s*AI\s*助手)+\s*$/iu, "").trim();
  const marker = label.toLocaleLowerCase("en-AU").replace(/[\s\p{P}\p{S}]+/gu, "");
  if (!marker || marker === "教务ai助手" || !label.includes("@") && /^(?:待补充|待确认|待填写|暂无|未知|无|未提供|na|none|null|unknown|tbd)$/u.test(marker)) return "";
  return normaliseDemoUserName(label).replace(/\s+/gu, "");
}
export function matchWecomDraftStudent(source: WecomLpDraftRawSource, students: readonly Record<string, unknown>[]) {
  if (["identity_conflict", "identity_ambiguous"].includes(source.status)) return null;
  const hintedIds = new Set(source.messages.map((message) => "studentId" in message ? message.studentId : undefined).filter((id): id is string => typeof id === "string" && Boolean(id)));
  if (hintedIds.size > 1) return null;
  const key = (value: unknown) => typeof value === "string" ? normaliseDemoUserName(value).replace(/\s+/gu, "") : "";
  const guardian = guardianKey(source.wechatName);
  const draft = buildWecomLpDraft(source.messages);
  const messageGuardian = guardianKey(draft.guardianWechat);
  if (draft.conflicts.some((conflict) => conflict.field === "guardianWechat") || messageGuardian && messageGuardian !== guardian) return null;
  const candidates = students.filter((student) => student.importArchived !== true && (
    hintedIds.size === 1 ? hintedIds.has(String(student.id))
      : guardian && guardianKey(student.guardianWechat) === guardian
        && (!source.studentName || key(student.name) === key(source.studentName))
  ));
  return candidates.length === 1 && typeof candidates[0].id === "string" ? candidates[0].id : null;
}

export { wecomDraftTimezone } from "./wecom-lp-draft-timezone";
