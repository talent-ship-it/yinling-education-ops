"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import type { TrialScreenshotExtraction } from "../lib/jiaowubao-trial-screenshot";
import { recognizeTrialScreenshot } from "../lib/trial-screenshot-ocr";
import {
  TrialScreenshotImportFlow,
  confirmableScreenshotCandidate,
  proposedScreenshotFields,
  requestTrialScreenshotMatch,
  screenshotCandidateKey,
  screenshotMelbourneTime,
  selectedScreenshotFields,
  type TrialScreenshotImportSnapshot,
  type TrialScreenshotTarget,
  type TrialScreenshotCandidate,
} from "./trial-screenshot-import-state";

export type { TrialScreenshotTarget, TrialScreenshotCandidate } from "./trial-screenshot-import-state";

type Props = Readonly<{
  target: TrialScreenshotTarget;
  currentFields: Record<string, unknown>;
  onApply: (fields: Record<string, unknown>, candidate?: TrialScreenshotCandidate) => void;
  disabled?: boolean;
  mode?: "prefill" | "confirm";
}>;
const fieldLabels: Record<string, string> = { assignedTeacher: "老师", studentName: "学生姓名", trialDurationMinutes: "试听时长（分钟）" };

function ParsedScreenshot({ extraction }: { extraction: TrialScreenshotExtraction }) {
  const rows = [
    ["老师", extraction.teacherName], ["课程原文", extraction.courseName], ["学生姓名线索", extraction.studentNameHint],
    ["时长（分钟）", extraction.durationMinutes], ["日期", extraction.sourceDate],
    ["时间（截图时区未标注）", extraction.startTime && extraction.endTime ? `${extraction.startTime}–${extraction.endTime}` : null],
    ["共享账户", extraction.sharedAccountLabel],
  ];
  return <>
    <div className="trial-ledger-scroll"><table className="trial-ledger-table" style={{ minWidth: 0 }}>
      <caption>截图解析结果（待核对）</caption>
      <tbody>{rows.map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{value ?? "未识别"}</td></tr>)}</tbody>
    </table></div>
    <ul className="form-footnote" aria-label="截图识别提醒">{extraction.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
  </>;
}

function MatchStatus({ snapshot }: { snapshot: TrialScreenshotImportSnapshot }) {
  const match = snapshot.match;
  if (!match) return null;
  if (match.reason === "needs_identity") return <p className="empty-inline">请先补充并保存学生身份，再核对教务宝课节。</p>;
  if (!match.coverage?.complete) return <p className="empty-inline">教务宝课表覆盖不完整，暂不能确认排课。</p>;
  if (match.coverage.freshness !== "fresh") return <p className="empty-inline">教务宝课表已过期，请刷新课表后重新核对。</p>;
  if (!match.candidates.length) return <p className="empty-inline">未找到可核对教务宝课节</p>;
  if (match.hasMore) return <p role="status">候选较多，仅显示前 5 节；请核对完整课程名。</p>;
  if (match.ambiguous) return <p role="status">找到多个候选，请手动选择对应课节。</p>;
  return null;
}

function ScreenshotCandidates({ snapshot, flow, disabled }: { snapshot: TrialScreenshotImportSnapshot; flow: TrialScreenshotImportFlow; disabled: boolean }) {
  const radioName = useId();
  if (!snapshot.match?.candidates.length) return null;
  return <div className="trial-ledger-scroll"><table className="trial-ledger-table" style={{ minWidth: 0 }}>
    <caption>教务宝候选课节 · 墨尔本（Australia/Melbourne）</caption>
    <thead><tr><th scope="col">选择</th><th scope="col">课程</th><th scope="col">老师</th><th scope="col">日期与时间（墨尔本）</th><th scope="col">共享账户</th></tr></thead>
    <tbody>{snapshot.match.candidates.map((candidate) => <tr key={screenshotCandidateKey(candidate)}>
      <td><input type="radio" name={radioName} value={screenshotCandidateKey(candidate)} checked={snapshot.selectedCandidate === screenshotCandidateKey(candidate)} disabled={disabled} onChange={() => flow.selectCandidate(screenshotCandidateKey(candidate))} aria-label={`选择课节：${candidate.courseName ?? "未命名课程"} · ${candidate.teacherName ?? "未识别老师"}`} /></td>
      <td>{candidate.courseName ?? "未识别"}</td><td>{candidate.teacherName ?? "未识别"}</td>
      <td><time dateTime={candidate.startsAt}>{screenshotMelbourneTime(candidate.startsAt)}</time>–<time dateTime={candidate.endsAt}>{screenshotMelbourneTime(candidate.endsAt)}</time></td>
      <td>{candidate.sharedAccountLabel ?? "未识别"}</td>
    </tr>)}</tbody>
  </table></div>;
}

function displayField(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) || "未填写" : "未填写";
}

function PrefillFields({ snapshot, currentFields, flow, disabled }: { snapshot: TrialScreenshotImportSnapshot; currentFields: Record<string, unknown>; flow: TrialScreenshotImportFlow; disabled: boolean }) {
  const proposed = Object.entries(proposedScreenshotFields(snapshot));
  if (!proposed.length) return null;
  return <div className="trial-ledger-scroll"><table className="trial-ledger-table" style={{ minWidth: 0 }}>
    <caption>勾选填入字段</caption>
    <thead><tr><th scope="col">填入</th><th scope="col">字段</th><th scope="col">表单现值</th><th scope="col">将填入</th></tr></thead>
    <tbody>{proposed.map(([field, value]) => <tr key={field}>
      <td><input type="checkbox" checked={snapshot.selectedFields.includes(field)} disabled={disabled} aria-label={`填入${fieldLabels[field]}`} onChange={() => flow.toggleField(field)} /></td>
      <th scope="row">{fieldLabels[field]}</th><td>{displayField(currentFields[field])}</td><td>{displayField(value)}{currentFields[field] && currentFields[field] !== value ? "（与现值不同）" : ""}</td>
    </tr>)}</tbody>
  </table></div>;
}

function ScreenshotApply({ snapshot, mode, disabled, onApply }: { snapshot: TrialScreenshotImportSnapshot; mode: "prefill" | "confirm"; disabled: boolean; onApply: Props["onApply"] }) {
  const candidate = confirmableScreenshotCandidate(snapshot);
  const fields = selectedScreenshotFields(snapshot);
  if (mode === "confirm") return <button type="button" className="primary-button" disabled={disabled || !candidate} onClick={() => { if (candidate) onApply({}, candidate); }}>确认补全交接与排课</button>;
  return <button type="button" className="secondary-button" disabled={disabled || !Object.keys(fields).length} onClick={() => onApply(fields)}>填入待核对表单</button>;
}

function ScreenshotTextControls({ snapshot, flow, disabled }: { snapshot: TrialScreenshotImportSnapshot; flow: TrialScreenshotImportFlow; disabled: boolean }) {
  const busy = snapshot.phase !== "idle";
  return <>
    <div className="form-grid">
      <label className="upload-field span-2">截图文件（本地识别，最多 3 MB）
        <input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void flow.upload(file);
        }} />
      </label>
      <label className="span-2">识别文字（可修正）
        <textarea rows={5} maxLength={20000} value={snapshot.text} disabled={disabled || snapshot.phase === "recognizing"} onChange={(event) => flow.setText(event.target.value)} />
      </label>
    </div>
    <ScreenshotImportStatus snapshot={snapshot} />
    <div className="button-row">
      <button type="button" className="secondary-button" disabled={disabled || busy || !snapshot.text.trim()} onClick={() => { void flow.parseAndMatch(); }}>解析并核对教务宝</button>
      {busy ? <button type="button" className="secondary-button" onClick={flow.cancel}>取消</button> : null}
    </div>
  </>;
}

function ScreenshotImportStatus({ snapshot }: { snapshot: TrialScreenshotImportSnapshot }) {
  return <>
    {snapshot.phase === "recognizing" ? <p role="status">本地识别中 {snapshot.progress}%</p> : null}
    {snapshot.phase === "matching" ? <p role="status">正在核对教务宝课节…</p> : null}
    {snapshot.error ? <p className="form-error" role="alert">{snapshot.error}</p> : null}
  </>;
}

function TrialScreenshotImportSession({ target, currentFields, onApply, disabled = false, mode = "prefill" }: Props) {
  const [flow] = useState(() => new TrialScreenshotImportFlow(target, { recognize: recognizeTrialScreenshot, match: requestTrialScreenshotMatch }));
  const snapshot = useSyncExternalStore(flow.subscribe, flow.getSnapshot, flow.getSnapshot);
  useEffect(() => () => flow.cancel(), [flow]);
  const unavailable = disabled || snapshot.phase !== "idle";
  return <section className="detail-section span-2" aria-label="教务宝排课截图导入">
    <strong>教务宝排课截图</strong>
    <ScreenshotTextControls snapshot={snapshot} flow={flow} disabled={disabled} />
    {snapshot.extraction ? <ParsedScreenshot extraction={snapshot.extraction} /> : null}
    <MatchStatus snapshot={snapshot} />
    <ScreenshotCandidates snapshot={snapshot} flow={flow} disabled={unavailable} />
    {mode === "prefill" ? <PrefillFields snapshot={snapshot} currentFields={currentFields} flow={flow} disabled={unavailable} /> : null}
    <div className="button-row"><ScreenshotApply snapshot={snapshot} mode={mode} disabled={unavailable} onApply={onApply} /></div>
  </section>;
}

export function TrialScreenshotImport(props: Props) {
  return <TrialScreenshotImportSession key={JSON.stringify(props.target)} {...props} />;
}
