"use client";

import { useRef, useState, type ComponentType, type ReactNode } from "react";
import { TrialScreenshotImport, type TrialScreenshotCandidate } from "./trial-screenshot-import";

type Props = Readonly<{
  item: { id: string; studentId: string; title: string; fields?: Record<string, unknown> };
  studentName: string;
  expectedVersions: { students: number; lpItems: number; tasks: number };
  Dialog: ComponentType<{ title: string; children: ReactNode; onClose: () => void }>;
  onClose: () => void;
  notify: (message: string) => void;
  onCommitted: (result: { lpItemsRow: unknown; tasksRow: unknown }) => void;
}>;

function saveErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "小课表补全失败，可重试。";
}

async function saveScreenshotConfirmation(command: unknown, onConflict: () => void) {
  const response = await fetch("/api/operations/trial-screenshot-confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.committed !== true) {
    if (response.status === 409) onConflict();
    throw new Error(typeof body.error === "string" ? body.error : "小课表补全失败，可重试。");
  }
  if (!body.lpItemsRow || !body.tasksRow) throw new Error("补全已确认，请刷新查看；可使用本次操作安全重试。");
  return body as Parameters<Props["onCommitted"]>[0] & { applied?: boolean };
}

export function TrialScreenshotConfirmWorkspace({ item, studentName, expectedVersions, Dialog, onClose, notify, onCommitted }: Props) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const versions = useRef(expectedVersions);
  const pending = useRef<{ intent: string; commandKey: string } | null>(null);
  async function confirm(candidate?: TrialScreenshotCandidate) {
    if (!candidate || busyRef.current) return;
    const command = { lpItemId: item.id, eventId: candidate.eventId, sourceDate: candidate.sourceDate, sourceRevision: candidate.sourceRevision, expectedVersions: versions.current };
    const intent = JSON.stringify(command);
    if (pending.current?.intent !== intent) pending.current = { intent, commandKey: crypto.randomUUID() };
    const commandKey = pending.current.commandKey;
    busyRef.current = true;
    setBusy(true);
    try {
      const body = await saveScreenshotConfirmation({ commandKey, ...command }, () => { pending.current = null; onClose(); });
      onCommitted(body);
      notify(body.applied === false ? "这条小课表已补全，没有重复保存" : "试听交接、排课和相关待办已补全");
      onClose();
    } catch (error) { notify(saveErrorMessage(error)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <Dialog title="补全教务宝小课表" onClose={() => { if (!busyRef.current) onClose(); }}>
    <div className="form-grid">
      <dl className="span-2"><div><dt>本次试听学员</dt><dd>{studentName}</dd></div><div><dt>试听交接</dt><dd>{item.title}</dd></div></dl>
      <TrialScreenshotImport target={{ lpItemId: item.id }} currentFields={item.fields ?? {}} disabled={busy} mode="confirm" onApply={(_fields, candidate) => { void confirm(candidate); }} />
      <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button></footer>
    </div>
  </Dialog>;
}
