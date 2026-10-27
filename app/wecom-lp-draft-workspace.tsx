"use client";

import { useRef, useState, type FormEvent, type ComponentType, type ReactNode } from "react";
import { BookOpen } from "lucide-react";
import { RecordPicker } from "@/app/record-picker";
import { LpWorkflowFields, parseLpWorkflowFormData, type LpWorkflowFieldsProps } from "@/app/lp-workflow-fields";
import { WecomLpDraftsPanel, type DraftRange, type HandoverTimeDisplay } from "@/app/wecom-lp-drafts-panel";
import type { WecomLpDraftSource } from "@/lib/wecom-lp-intake";
import { wecomDraftTimezone } from "@/lib/wecom-lp-draft-timezone";
import { WECOM_LP_WORKFLOW_TYPES } from "@/lib/wecom-lp-draft";
import type { LpAtomicExpectedVersions } from "@/lib/lp-atomic-service";

type Commit = Readonly<{ studentId: string; lpItemId: string; studentsRow: unknown; lpItemsRow: unknown; tasksRow: unknown; filesRow: unknown }>;
type Props = Readonly<{
  timeDisplay: HandoverTimeDisplay;
  range: DraftRange;
  onRangeChange: (range: DraftRange) => void;
  students: readonly { id: string; name: string; course: string; owner?: string; planner?: string }[];
  expectedVersions: LpAtomicExpectedVersions;
  fieldOptions: Pick<LpWorkflowFieldsProps, "responsibleOperationsOptions" | "teacherOptions" | "subjectOptions" | "timezoneOptions" | "plannerOptions">;
  Dialog: ComponentType<{ title: string; children: ReactNode; onClose: () => void }>;
  notify: (message: string) => void;
  onCommitted: (result: Commit) => void;
}>;

class DraftSaveError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function sourceConflict(error: unknown): error is DraftSaveError { return error instanceof DraftSaveError && error.status === 409; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "交接草稿确认失败，可重试"; }
function reviewedFields(data: FormData, notify: Props["notify"], expectedType: WecomLpDraftSource["draft"]["workflowType"]) {
  try {
    const parsed = parseLpWorkflowFormData(data);
    if (!expectedType || parsed.workflowType !== expectedType || !WECOM_LP_WORKFLOW_TYPES.some((type) => type === parsed.workflowType)) throw new Error("不支持此交接类型");
    return parsed;
  } catch (error) { notify(errorMessage(error)); return null; }
}
function confirmationTarget(createStudent: boolean, data: FormData, studentId: string) {
  return createStudent
    ? { newStudent: { guardianWechat: String(data.get("wecomGuardianWechat") ?? "").trim(), timezone: String(data.get("wecomStudentTimezone") ?? "").trim() } }
    : { studentId };
}
async function saveDraft(command: unknown) {
  const response = await fetch("/api/operations/wecom-lp-drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
  const body = await response.json();
  if (!response.ok || body.committed !== true) throw new DraftSaveError(response.status, typeof body.error === "string" ? body.error : "交接草稿确认失败");
  if (["studentsRow", "lpItemsRow", "tasksRow", "filesRow"].some((key) => !body[key])) throw new Error("交接已确认，请刷新查看 LP");
  return body as Commit & { applied: boolean };
}

function SourceNotes({ source }: { source: WecomLpDraftSource }) {
  return <>
      <details className="span-2"><summary>交接原文</summary>{source.messages.map((message) => <p key={message.messageId} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.text}</p>)}</details>
      {source.draft.conflicts.length > 0 && <div className="form-error span-2" role="alert">请核对冲突字段：{source.draft.conflicts.map((conflict) => `${conflict.label}（${conflict.values.join(" / ")}）`).join("；")}</div>}
      {source.draft.unresolvedValues.length > 0 && <div className="form-notice span-2">待核对：{source.draft.unresolvedValues.map((item) => `${item.label}（${item.values.join(" / ")}）`).join("；")}</div>}
  </>;
}

function DraftStudentFields({ source, students, timezoneOptions, createStudent, onCreateStudentChange, studentId, onStudentIdChange }: {
  source: WecomLpDraftSource;
  students: Props["students"];
  timezoneOptions: LpWorkflowFieldsProps["timezoneOptions"];
  createStudent: boolean;
  onCreateStudentChange: (value: boolean) => void;
  studentId: string;
  onStudentIdChange: (value: string) => void;
}) {
  const isTrial = source.draft.workflowType === "试听 LP";
  return <>
    {isTrial && <label>学生档案<select value={createStudent ? "new" : "existing"} onChange={(event) => onCreateStudentChange(event.target.value === "new")}><option value="existing">关联已有学生</option><option value="new">确认时创建学生档案</option></select></label>}
    {isTrial && createStudent ? <><label>家长微信名<input name="wecomGuardianWechat" defaultValue={source.draft.guardianWechat ?? source.wechatName} required /></label><label>学生时区<select name="wecomStudentTimezone" defaultValue={wecomDraftTimezone(source.draft.fields.locationTimezone)} required><option value="">请选择时区</option>{timezoneOptions?.map((option) => <option value={option.value} key={option.value}>{option.label ?? option.value}</option>)}</select></label></> : <label>关联学生<RecordPicker name="studentId" options={students.map((student) => ({ id: student.id, name: student.name, detail: student.course }))} value={studentId} onChange={onStudentIdChange} /></label>}
  </>;
}

export function WecomLpDraftWorkspace({ timeDisplay, range, onRangeChange, students, expectedVersions, fieldOptions, Dialog, notify, onCommitted }: Props) {
  const [source, setSource] = useState<WecomLpDraftSource | null>(null);
  const [createStudent, setCreateStudent] = useState(false);
  const [studentId, setStudentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const busyRef = useRef(false);
  const commands = useRef(new Map<string, { intent: string; commandKey: string; expectedVersions: LpAtomicExpectedVersions }>());
  function close() { if (!busyRef.current) setSource(null); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!source || busyRef.current) return;
    const data = new FormData(event.currentTarget);
    const reviewed = reviewedFields(data, notify, source.draft.workflowType);
    if (!reviewed) return;
    const { workflowType, fields } = reviewed;
    const target = confirmationTarget(createStudent, data, studentId);
    const intent = JSON.stringify({ caseId: source.caseId, sourceMessageId: source.sourceMessageId, sourceRevision: source.sourceRevision, workflowType, ...target, fields });
    const prior = commands.current.get(source.sourceMessageId);
    const pending = prior?.intent === intent ? prior : { intent, commandKey: crypto.randomUUID(), expectedVersions };
    commands.current.set(source.sourceMessageId, pending);
    busyRef.current = true;
    setBusy(true);
    try {
      const body = await saveDraft({ commandKey: pending.commandKey, caseId: source.caseId, sourceMessageId: source.sourceMessageId, sourceRevision: source.sourceRevision, workflowType, ...target, fields, expectedVersions: pending.expectedVersions });
      onCommitted(body as Commit);
      commands.current.delete(source.sourceMessageId);
      setSource(null);
      setRefresh((value) => value + 1);
      notify(body.applied === false ? "这条交接已创建 LP，没有重复创建" : "交接已确认，学生档案、LP 和待办已保存");
    } catch (error) {
      if (sourceConflict(error)) {
        commands.current.delete(source.sourceMessageId);
        setSource(null);
        setRefresh((value) => value + 1);
        notify(`${error.message} 请重新打开最新草稿核对。`);
      } else notify(errorMessage(error));
    }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <>
    <WecomLpDraftsPanel timeDisplay={timeDisplay} range={range} onRangeChange={onRangeChange} refreshKey={refresh} onSelect={(draft) => { setSource(draft); setStudentId(draft.matchedStudentId ?? ""); setCreateStudent(draft.draft.workflowType === "试听 LP" && !draft.matchedStudentId); }} />
    {source && <Dialog title="核对机器人交接" onClose={close}><form key={`${source.sourceMessageId}:${source.sourceRevision}`} className="form-grid" onSubmit={submit}>
      <SourceNotes source={source} />
      <DraftStudentFields source={source} students={students} timezoneOptions={fieldOptions.timezoneOptions} createStudent={createStudent} onCreateStudentChange={setCreateStudent} studentId={studentId} onStudentIdChange={setStudentId} />
      <LpWorkflowFields screenshotTarget={{ caseId: source.caseId, sourceMessageId: source.sourceMessageId, sourceRevision: source.sourceRevision }} key={`${source.sourceMessageId}:${studentId}`} initialType={source.draft.workflowType ?? "试听 LP"} requireExplicitSelection initialValues={{ responsibleOperations: source.draft.operationsOwner ?? students.find((student) => student.id === studentId)?.owner ?? "", ...source.draft.fields } as LpWorkflowFieldsProps["initialValues"]} {...fieldOptions} />
      <footer><button className="secondary-button" type="button" disabled={busy} onClick={close}>取消</button><button className="primary-button" type="submit" disabled={busy || !source.draft.workflowType}><BookOpen size={16} />{busy ? "正在保存…" : "确认并创建 LP"}</button></footer>
    </form></Dialog>}
  </>;
}
