import { getLpWorkflowSchema, type LpFieldValues } from "./lp-workflows";

export const WECOM_LP_WORKFLOW_TYPES = ["试听 LP", "老师新 LP", "换老师试听", "老师 LP 修改"] as const;
export type WecomLpWorkflowType = typeof WECOM_LP_WORKFLOW_TYPES[number];

const workflowAliases: Readonly<Record<string, WecomLpWorkflowType>> = {
  "试听LP": "试听 LP", "老生新LP": "老师新 LP", "老生加课LP": "老师新 LP", "老师新LP": "老师新 LP",
  "二次试听": "换老师试听", "换老师试听": "换老师试听", "老生LP修改": "老师 LP 修改", "老师LP修改": "老师 LP 修改",
};

function workflowName(value: string) {
  const key = value.normalize("NFKC").replace(/[\s【】\[\]]/gu, "").replace(/lp/giu, "LP");
  return Object.hasOwn(workflowAliases, key) ? workflowAliases[key] : undefined;
}

export function wecomLpExplicitWorkflowTypes(text: string): readonly WecomLpWorkflowType[] {
  return cleanValue(text).split("\n").flatMap((line) => {
    const heading = line.replace(/\[Rose\]|\[玫瑰\]|🌹/giu, "").replace(/[\s【】\[\]]/gu, "");
    const title = /^(.*?)信息交接(?:表|单)?$/u.exec(heading)?.[1];
    const field = /^[\s【\[]*(?:LP类型|业务类型)[】\]]*\s*[:：]\s*(.*?)\s*$/u.exec(line)?.[1];
    const type = workflowName(title ?? field ?? "");
    return type ? [type] : [];
  });
}

function sourceWorkflowTypes(records: readonly WecomLpDraftSourceRecord[]) {
  const found = new Map<WecomLpWorkflowType, string[]>();
  for (const record of records) {
    for (const type of wecomLpExplicitWorkflowTypes(record.text)) {
      found.set(type, [...(found.get(type) ?? []), record.messageId]);
    }
  }
  return found;
}

type DraftValue = string | number | boolean;
type SourceValue = Readonly<{ value: string; messageId: string }>;

export type WecomLpDraftSourceRecord = Readonly<{
  messageId: string;
  text: string;
  sentAt: string;
  studentId?: string | null;
  studentNameHint?: string | null;
  guardianWechatHint?: string | null;
  operationsOwnerHint?: string | null;
  coursePlannerHint?: string | null;
}>;

export type WecomLpDraft = Readonly<{
  workflowType: WecomLpWorkflowType | null;
  fields: LpFieldValues;
  studentName: string | null;
  guardianWechat: string | null;
  operationsOwner: string | null;
  planner: string | null;
  conflicts: readonly Readonly<{ field: string; label: string; values: readonly string[]; messageIds: readonly string[] }>[];
  missingFields: readonly Readonly<{ field: string; label: string }>[];
  unresolvedValues: readonly Readonly<{ field: string; label: string; values: readonly string[] }>[];
  sourceMessageIds: readonly string[];
}>;

const aliases: Readonly<Record<string, readonly string[]>> = {
  studentName: ["学生姓名", "学生名", "学生", "姓名(如提到)", "姓名"],
  guardianWechat: ["家长微信名", "家长微信", "微信名", "微信名称"],
  responsibleOperations: ["教务老师", "负责教务", "对接教务", "所属教务", "教务"],
  planner: ["课程规划老师", "课程规划师", "课程规划", "所属销售", "规划老师"],
  assignedTeacher: ["安排教师", "安排老师", "任课教师", "任课老师", "授课老师", "老师", "教师"],
  subject: ["安排科目", "试听科目", "课程科目", "科目", "学科", "涉及科目"],
  teacher: ["LP老师"],
  originalTeacher: ["原老师", "原教师", "原任课老师"],
  newTeacher: ["新老师", "新教师", "新任课老师"],
  changeReason: ["二次试听原因+注意事项", "二次试听原因", "重听原因+注意事项", "重听原因", "换老师原因", "更换原因"],
  modificationRequirements: ["变动内容", "修改要求", "LP修改要求"],
  documentUrl: ["LP链接", "LP文档链接", "文档链接"],
  oneSentenceDescription: ["一句话描述", "学生情况", "学生基本情况"],
  locationTimezone: ["所在地(时区)", "所在地/时区", "所在地", "所在地区", "时区"],
  contactPerson: ["家长Or学生本人", "家长或学生本人", "家长/学生本人", "对接对象"],
  contactParents: ["对接家长", "是否对接家长"],
  contactStudent: ["对接学生本人", "是否对接学生本人"],
  contactNote: ["对接备注"],
  specifiedContentStatus: ["是否要指定内容", "要指定内容", "指定内容状态", "是否指定内容", "需要跟进家长指定内容", "是否需要跟进家长指定内容", "家长是否有指定内容"],
  writingRequired: ["是否要写作", "要写作", "是否写作", "写作要求"],
  writingNote: ["写作备注"],
  paperRequired: ["是否发试卷收试卷", "是否发试卷、收试卷", "是否发试卷/收试卷", "是否要试卷", "试卷要求"],
  paperNote: ["试卷备注"],
  timeMentioned: ["是否提到时间", "是否提及时间", "是否有提到时间"],
  preferredTime: ["偏好时间", "意向时间", "期望时间", "试听时间"],
  studentNameKnown: ["是否知道学生姓名", "是否知道学生名字", "是否提到学生姓名", "是否提到姓名"],
  preparationFollowUp: ["是否跟进老师备课内容", "是否需要跟进老师备课内容", "是否跟进备课", "备课跟进"],
  preparationNote: ["备课跟进备注", "备课要求", "备课备注"],
  trialDurationMinutes: ["试听时长", "试听时长(分钟)", "试听时长分钟"],
  trialDurationNote: ["时长备注"],
  trialPaymentMethod: ["试听付费方式", "付费方式", "试听类型", "试听付款方式"],
  specialNotes: ["特殊备注", "特别备注", "其他备注"],
  isUniversityStudent: ["大学学生", "是否大学学生", "是否大学生"],
  universityMajor: ["专业", "大学专业"],
  universityYear: ["年级", "大学年级"],
};

function normalizedLabel(value: string) {
  return value.normalize("NFKC").replace(/[\s【】\[\]“”‘’"'、，,]/gu, "").toLocaleLowerCase("en-AU");
}

const fieldByLabel = new Map(Object.entries(aliases).flatMap(([field, labels]) => labels.map((label) => [normalizedLabel(label), field] as const)));
const labels = new Map<string, string>(WECOM_LP_WORKFLOW_TYPES.flatMap((type) => getLpWorkflowSchema(type).fields.map((field) => [field.key, field.label] as const)));
labels.set("guardianWechat", "微信名");

function cleanValue(value: string) {
  return value.normalize("NFKC").replace(/\r\n?/gu, "\n")
    .replace(/[ \t]*@教务\s*AI\s*助手[ \t]*$/iu, "").trim();
}

function unknown(value: string) {
  return /^(?:未知|不详|不清楚|不知道|未提供|待定|待补充|待确认|暂未提供|暂不清楚|暂无|未提到|没提到|无信息|未填|空|无|unknown|tbd|n\/?a|[?？-]+)[。.!！]?$/iu.test(value.trim());
}

function booleanValue(value: string): boolean | null {
  if (/^(?:是|需要|要|有|yes|true)(?:$|[\s(,，。.;；:：])/iu.test(value)) return true;
  if (/^(?:否|不需要|不要|不用|没有|无|no|false)(?:$|[\s(,，。.;；:：])/iu.test(value)) return false;
  return null;
}

function durationValue(value: string): number | null {
  const compact = value.replace(/\s/gu, "").toLocaleLowerCase("en-AU");
  if (/^(?:45(?:分钟|分|min(?:utes?)?|m)?|0\.75(?:小时|h(?:ours?)?|hr)|四十五分钟|三刻钟)(?:$|[(,，])/u.test(compact)) return 45;
  if (/^(?:60(?:分钟|分|min(?:utes?)?|m)?|1(?:\.0)?(?:小时|h(?:ours?)?|hr)|一小时)(?:$|[(,，])/u.test(compact)) return 60;
  return null;
}

function specifiedContent(value: string): string | null {
  if (["已指定", "无需指定", "需教务跟进", "需要跟进"].includes(value)) return value;
  if (booleanValue(value) === false) return "无需指定";
  if (/已(?:指定|提供|发|给)|已经(?:发|提供|给)/u.test(value)) return "已指定";
  return booleanValue(value) === true ? "需教务跟进" : null;
}

function paymentMethod(value: string): string | null {
  const compact = value.replace(/\s/gu, "");
  if (/^(?:后置付费试听|后置付费|先上后付)$/u.test(compact)) return "后置付费试听";
  if (/^(?:免费试听|免费)$/u.test(compact)) return "免费试听";
  if (/^(?:在读学生付费试听|在读付费试听)$/u.test(compact)) return "在读学生付费试听";
  if (/^(?:付费试听\(已付费\)|已付费|付费试听已付费)$/u.test(compact)) return "付费试听（已付费）";
  if (/^(?:付费试听\(未付费\)|未付费|付费试听未付费)$/u.test(compact)) return "付费试听（未付费）";
  return null;
}

function contactPerson(value: string): string | null {
  if (/^(?:家长|父母|parent)(?:$|[\s(,，])/iu.test(value)) return "家长";
  if (/^(?:学生本人|学生|student)(?:$|[\s(,，])/iu.test(value)) return "学生本人";
  return null;
}

const booleanFields = new Set(["contactParents", "contactStudent", "writingRequired", "paperRequired", "timeMentioned", "studentNameKnown", "isUniversityStudent"]);
const noteForField: Readonly<Record<string, string>> = {
  contactPerson: "contactNote",
  writingRequired: "writingNote",
  paperRequired: "paperNote",
  preparationFollowUp: "preparationNote",
  trialDurationMinutes: "trialDurationNote",
};

function preparationFollowUp(value: string): string | null {
  const parsed = booleanValue(value);
  return parsed === null ? null : parsed ? "是" : "否";
}

const fieldParsers: Readonly<Record<string, (value: string) => DraftValue | null>> = {
  trialDurationMinutes: durationValue,
  specifiedContentStatus: specifiedContent,
  trialPaymentMethod: paymentMethod,
  contactPerson,
  preparationFollowUp,
};

function parsedValue(field: string, value: string): DraftValue | null {
  if (booleanFields.has(field)) return booleanValue(value);
  if (unknown(value)) return null;
  const parser = fieldParsers[field];
  return parser ? parser(value) : value;
}

function collectText(text: string, add: (field: string, value: string) => void) {
  let currentField: string | null = null;
  let currentLines: string[] = [];
  const flush = () => {
    if (currentField) add(currentField, currentLines.join("\n"));
    currentField = null;
    currentLines = [];
  };
  const lines = text.replace(/\r\n?/gu, "\n").replace(/([^\n])(?=【[^\n】]{1,80}】[ \t]*[:：])/gu, "$1\n").split("\n");
  for (const line of lines) {
    const match = /^[ \t]*([^\n:：]{1,100})[:：][ \t]*(.*)$/u.exec(line);
    const field = match ? fieldByLabel.get(normalizedLabel(match[1]!)) : undefined;
    if (field) {
      flush();
      currentField = field;
      currentLines = [match![2]!];
    } else if (/^[ \t]*(?:【[^】\n]+】|\[[^\]\n]+\])[ \t]*[:：]/u.test(line)) {
      flush();
    } else if (currentField) {
      currentLines.push(line);
    }
  }
  flush();
}

type DraftState = {
  values: Record<string, DraftValue>;
  conflicts: WecomLpDraft["conflicts"][number][];
  unresolvedValues: WecomLpDraft["unresolvedValues"][number][];
};

function collectRecordValues(records: readonly WecomLpDraftSourceRecord[], workflowType: WecomLpWorkflowType | null) {
  const raw = new Map<string, SourceValue[]>();
  const add = (field: string, value: string, messageId: string) => {
    const cleaned = cleanValue(value);
    if (!cleaned) return;
    if (field === "assignedTeacher" && workflowType && workflowType !== "试听 LP") field = workflowType === "换老师试听" ? "newTeacher" : "teacher";
    const entries = raw.get(field) ?? [];
    entries.push({ value: cleaned, messageId });
    raw.set(field, entries);
  };
  for (const record of records) {
    collectText(record.text, (field, value) => add(field, value, record.messageId));
    for (const [field, value] of [
      ["studentName", record.studentNameHint], ["guardianWechat", record.guardianWechatHint],
      ["responsibleOperations", record.operationsOwnerHint], ["planner", record.coursePlannerHint],
    ] as const) if (value) add(field, value, record.messageId);
  }
  return raw;
}

function resolveField(state: DraftState, field: string, entries: readonly SourceValue[]) {
  const byValue = new Map<string, { value: DraftValue; entries: SourceValue[] }>();
  const unresolved: string[] = [];
  for (const entry of entries) {
    const parsed = parsedValue(field, entry.value);
    if (parsed === null) {
      unresolved.push(entry.value);
      continue;
    }
    const key = typeof parsed === "string" ? parsed.replace(/[ \t]+/gu, " ").toLocaleLowerCase("en-AU") : JSON.stringify(parsed);
    const existing = byValue.get(key);
    if (existing) existing.entries.push(entry);
    else byValue.set(key, { value: parsed, entries: [entry] });
  }
  const label = labels.get(field) ?? field;
  if (unresolved.length) state.unresolvedValues.push({ field, label, values: [...new Set(unresolved)] });
  if (byValue.size > 1) {
    state.conflicts.push({ field, label, values: [...new Set([...byValue.values()].flatMap((entry) => entry.entries.map((source) => source.value)))], messageIds: [...new Set(entries.map((entry) => entry.messageId))] });
  } else if (byValue.size === 1) state.values[field] = [...byValue.values()][0]!.value;
}

function resolveSourceFields(raw: ReadonlyMap<string, SourceValue[]>) {
  const state: DraftState = { values: {}, conflicts: [], unresolvedValues: [] };
  for (const [field, entries] of raw) resolveField(state, field, entries);
  for (const [field, noteField] of Object.entries(noteForField)) {
    const entries = raw.get(field)?.filter((entry) => /[\n(,，]/u.test(entry.value) || parsedValue(field, entry.value) === null);
    if (entries?.length && !raw.has(noteField)) resolveField(state, noteField, entries);
  }
  return state;
}

function hasFieldConflict(state: DraftState, field: string) {
  return state.conflicts.some((conflict) => conflict.field === field);
}

function addDerivedValue(state: DraftState, raw: ReadonlyMap<string, SourceValue[]>, field: string, value: DraftValue, sourceField: string) {
  if (hasFieldConflict(state, field)) return;
  if (state.values[field] === undefined || state.values[field] === value) state.values[field] = value;
  else {
    state.conflicts.push({ field, label: labels.get(field) ?? field, values: [String(state.values[field]), String(value)], messageIds: [...new Set([...(raw.get(field) ?? []), ...(raw.get(sourceField) ?? [])].map((entry) => entry.messageId))] });
    delete state.values[field];
  }
}

function deriveStudentNameKnown(records: readonly WecomLpDraftSourceRecord[], raw: ReadonlyMap<string, SourceValue[]>, state: DraftState) {
  if (typeof state.values.studentName === "string" && !hasFieldConflict(state, "studentName") && !hasFieldConflict(state, "studentNameKnown")) {
    const nameRecordIndex = records.findIndex((record) => raw.get("studentName")?.some((entry) => entry.messageId === record.messageId && !unknown(entry.value)));
    const flagRecordIndex = records.reduce((latest, record, index) => raw.get("studentNameKnown")?.some((entry) => entry.messageId === record.messageId) ? index : latest, -1);
    if (state.values.studentNameKnown === false && flagRecordIndex < nameRecordIndex) state.values.studentNameKnown = true;
    else addDerivedValue(state, raw, "studentNameKnown", true, "studentName");
  } else if (!hasFieldConflict(state, "studentName") && raw.get("studentName")?.every((entry) => unknown(entry.value))) {
    addDerivedValue(state, raw, "studentNameKnown", false, "studentName");
  }
}

function deriveContactAndTime(raw: ReadonlyMap<string, SourceValue[]>, state: DraftState) {
  if (state.values.preferredTime !== undefined) addDerivedValue(state, raw, "timeMentioned", true, "preferredTime");
  if (state.values.contactPerson === "家长" || state.values.contactPerson === "学生本人") {
    addDerivedValue(state, raw, "contactParents", state.values.contactPerson === "家长", "contactPerson");
    addDerivedValue(state, raw, "contactStudent", state.values.contactPerson === "学生本人", "contactPerson");
  }
}

function resolvePlanner(state: DraftState, planner: string | null) {
  if (!planner) return;
  const canonicalPlanner = /^(Tara|Eileen|Abby)(?:\s*@\s*Insider\s*Leads)?$/iu.exec(planner)?.[1];
  if (canonicalPlanner) state.values.planner = ["Tara", "Eileen", "Abby"].find((name) => name.toLowerCase() === canonicalPlanner.toLowerCase())!;
  else {
    delete state.values.planner;
    state.unresolvedValues.push({ field: "planner", label: labels.get("planner")!, values: [planner] });
  }
}

function setSourceTimestamp(records: readonly WecomLpDraftSourceRecord[], values: Record<string, DraftValue>) {
  const earliestSource = records.filter((record) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(record.sentAt) && Number.isFinite(Date.parse(record.sentAt)))
    .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt))[0];
  if (earliestSource) values.requestSentAt = new Date(earliestSource.sentAt).toISOString();
}

function missingDraftFields(values: Record<string, DraftValue>, guardianWechat: string | null, workflowType: WecomLpWorkflowType | null) {
  const requiredFields = [
    { key: "studentName", label: "学生姓名" }, ...(workflowType === "试听 LP" ? [{ key: "guardianWechat", label: "微信名" }] : []),
    ...getLpWorkflowSchema(workflowType ?? "试听 LP").fields.filter((field) => field.requirement === "required" || (field.requirement === "university-only" && values.isUniversityStudent === true)),
  ];
  return requiredFields.filter((field) => field.key === "guardianWechat" ? guardianWechat === null : values[field.key] === undefined)
    .map((field) => ({ field: field.key, label: field.label }));
}

function stringValue(values: Record<string, DraftValue>, field: string) {
  return typeof values[field] === "string" ? values[field] : null;
}

export function buildWecomLpDraft(records: readonly WecomLpDraftSourceRecord[]): WecomLpDraft {
  const ordered = [...records].sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.messageId.localeCompare(b.messageId));
  const types = sourceWorkflowTypes(ordered);
  const workflowType = types.size > 1 ? null : [...types.keys()][0] ?? "试听 LP";
  const raw = collectRecordValues(ordered, workflowType);
  const state = resolveSourceFields(raw);
  deriveStudentNameKnown(ordered, raw, state);
  deriveContactAndTime(raw, state);
  if (workflowType === null) state.conflicts.push({ field: "workflowType", label: "LP 类型", values: [...types.keys()], messageIds: [...new Set([...types.values()].flat())] });
  const { values, conflicts, unresolvedValues } = state;
  const studentName = stringValue(values, "studentName");
  const guardianWechat = stringValue(values, "guardianWechat");
  const operationsOwner = stringValue(values, "responsibleOperations");
  const planner = stringValue(values, "planner");
  delete values.guardianWechat;
  resolvePlanner(state, planner);
  setSourceTimestamp(ordered, values);
  const allowedFields = new Set<string>(getLpWorkflowSchema(workflowType ?? "试听 LP").fields.map((field) => field.key));
  const fields = Object.fromEntries(Object.entries(values).filter(([key]) => allowedFields.has(key)));
  return {
    workflowType, fields, studentName, guardianWechat, operationsOwner, planner,
    conflicts, missingFields: missingDraftFields(values, guardianWechat, workflowType), unresolvedValues,
    sourceMessageIds: [...new Set(ordered.map((record) => record.messageId))],
  };
}
