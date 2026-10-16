"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DateTime } from "luxon";
import { assertValidTeacherAvailability, expandTeacherAvailability, type TeacherAvailabilityWindow, type TeacherAvailabilityOccurrence } from "@/lib/teacher-availability";
import { calendarEditorInstant, calendarEditorOffsets } from "@/lib/ava-calendar-editor";
import type { AvaCalendarLiveWindow } from "@/lib/ava-calendar-live-client";
import styles from "./calendar.module.css";

type SelfData = { teacherId: string; version: number; windows: TeacherAvailabilityWindow[] };
export type AvailabilityDraft = { commandKey: string; startsAt: string; endsAt: string; windowId?: string; date?: string };
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "本人开放时段暂不可用。"; }
function assertSelfVersion(value: number) { if (!Number.isSafeInteger(value) || value < 1) throw new Error("本人开放时段暂不可用。"); }
function saveActionLabel(uncertain: boolean) { return uncertain ? "重试同一操作" : "保存"; }
function assertSelfIdentity(value: SelfData) {
  if (!value || typeof value.teacherId !== "string") throw new Error("本人开放时段暂不可用。");
  assertSelfVersion(value.version);
}
function selfData(value: SelfData) {
  assertSelfIdentity(value);
  if (!Array.isArray(value.windows) || value.windows.length > 64 || value.windows.some((item) => item.teacherId !== value.teacherId)) throw new Error("本人开放时段暂不可用。");
  assertValidTeacherAvailability(value.windows);
  return value;
}
async function readSelfData() {
  const response = await fetch("/api/teacher-availability/self", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(15000) });
  if ([401, 403].includes(response.status)) return null;
  if (!response.ok) throw new Error("本人开放时段暂不可用。");
  return selfData(await response.json());
}
async function writeSelfData(body: Record<string, unknown>) {
  const response = await fetch("/api/teacher-availability/self", { method: "POST", cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || "保存失败，请重试。"), { status: response.status });
  return selfData(result);
}
export function useTeacherSelfAvailability(refreshKey: unknown) {
  const [data, setData] = useState<SelfData | null>(null);
  const [failure, setFailure] = useState("");
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    try {
      const body = await readSelfData();
      if (current === generation.current) { setData(body); setFailure(""); }
    } catch (error) { if (current === generation.current) { setData(null); setFailure(errorMessage(error)); } }
  }, []);
  useEffect(() => { const timer = setTimeout(() => void reload(), 0); return () => { clearTimeout(timer); }; }, [refreshKey, reload]);
  async function save(body: Record<string, unknown>) {
    try { setData(await writeSelfData(body)); }
    catch (error) { await reload(); throw error; }
    await reload();
  }
  const clear = useCallback(() => { generation.current++; setData(null); setFailure(""); }, []);
  return { data, failure, reload, save, clear };
}
function localValue(instant: string, zone: string) { return DateTime.fromISO(instant).setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm"); }
function originalOffset(instant: string, zone: string) {
  const dates = calendarEditorOffsets(localValue(instant, zone), zone);
  return dates.length < 2 ? "" : dates[0]!.toMillis() === Date.parse(instant) ? "earlier" : "later";
}
function TimeField({ label, value, setValue, zone, offset, setOffset, disabled }: { label: string; value: string; setValue: (value: string) => void; zone: string; offset: string; setOffset: (value: string) => void; disabled: boolean }) {
  let offsets: ReturnType<typeof calendarEditorOffsets> = [];
  try { offsets = calendarEditorOffsets(value, zone); } catch { offsets = []; }
  return <label className={styles.editorField}>{label}<input type="datetime-local" required step="60" value={value} disabled={disabled} onChange={(event) => { setValue(event.target.value); setOffset(""); }} />
    {offsets.length > 1 && <select aria-label={`${label} UTC 偏移`} value={offset} disabled={disabled} onChange={(event) => setOffset(event.target.value)}><option value="">选择 UTC 偏移</option><option value="earlier">{offsets[0]!.toFormat("ZZ")}</option><option value="later">{offsets.at(-1)!.toFormat("ZZ")}</option></select>}
  </label>;
}
function statusCode(error: unknown) { return error && typeof error === "object" && "status" in error ? error.status : null; }
function uncertainWrite(error: unknown, sent: boolean) {
  if (!sent) return false;
  const status = statusCode(error);
  return status === null || typeof status === "number" && status >= 500;
}
function offsetChoice(offset: string) { return offset === "earlier" || offset === "later" ? offset : undefined; }
function commandTiming(remove: boolean, values: { start: string; end: string; startOffset: string; endOffset: string }, zone: string) {
  if (remove) return {};
  return { startsAt: calendarEditorInstant(values.start, zone, offsetChoice(values.startOffset)), endsAt: calendarEditorInstant(values.end, zone, offsetChoice(values.endOffset)), timezone: zone };
}
function editorCommand(draft: AvailabilityDraft, version: number, remove: boolean) {
  const target = draft.windowId ? { windowId: draft.windowId, date: draft.date } : {};
  return { commandKey: draft.commandKey, expectedVersion: version, action: remove ? "delete" : draft.windowId ? "update" : "create", ...target };
}
function EditorHeading({ existing, disabled, close }: { existing: boolean; disabled: boolean; close: () => void }) {
  return <header className={styles.dialogHeader}><h2 id="self-availability-title">{existing ? "修改开放时段" : "新开放时段"}</h2><button type="button" className={styles.iconButton} aria-label="关闭开放时段" disabled={disabled} onClick={close}>×</button></header>;
}
function EditorActions({ existing, busy, uncertain, remove }: { existing: boolean; busy: boolean; uncertain: boolean; remove: () => void }) {
  const label = busy ? "保存中…" : saveActionLabel(uncertain);
  return <footer className={styles.editorFooter}>{existing && <button type="button" disabled={busy || uncertain} onClick={remove}>删除开放时段</button>}<button form="self-availability-form" type="submit" disabled={busy}>{label}</button></footer>;
}
function EditorFailure({ failure }: { failure: string }) { return failure ? <p role="alert">{failure}</p> : null; }
function AvailabilityEditor({ draft, zone, version, save, close, saved }: { draft: AvailabilityDraft; zone: string; version: number; save: (body: Record<string, unknown>) => Promise<void>; close: () => void; saved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<Record<string, unknown> | null>(null);
  const [start, setStart] = useState(() => localValue(draft.startsAt, zone));
  const [end, setEnd] = useState(() => localValue(draft.endsAt, zone));
  const [startOffset, setStartOffset] = useState(() => originalOffset(draft.startsAt, zone));
  const [endOffset, setEndOffset] = useState(() => originalOffset(draft.endsAt, zone));
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [failure, setFailure] = useState("");
  const locked = busy || uncertain;
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function commit(remove = false) {
    if (busy) return;
    setFailure("");
    try {
      const body = pending.current ?? { ...editorCommand(draft, version, remove), ...commandTiming(remove, { start, end, startOffset, endOffset }, zone) };
      pending.current = body; setBusy(true);
      await save(body); pending.current = null; saved(); close();
    } catch (error) { reportFailure(error); } finally { setBusy(false); }
  }
  function reportFailure(error: unknown) {
    const unknown = uncertainWrite(error, pending.current !== null);
    setUncertain(unknown);
    if (!unknown) pending.current = null;
    setFailure(errorMessage(error) + (unknown ? " 保存结果待确认，请重试同一操作。" : ""));
  }
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="self-availability-title" onCancel={(event) => { event.preventDefault(); if (!locked) close(); }}>
    <EditorHeading existing={!!draft.windowId} disabled={locked} close={close} />
    <form id="self-availability-form" className={styles.editorBody} onSubmit={(event) => { event.preventDefault(); void commit(); }}>
      <p>{zone}</p>
      <TimeField label="开始" value={start} setValue={setStart} zone={zone} offset={startOffset} setOffset={setStartOffset} disabled={locked} />
      <TimeField label="结束" value={end} setValue={setEnd} zone={zone} offset={endOffset} setOffset={setEndOffset} disabled={locked} />
      <EditorFailure failure={failure} />
    </form>
    <EditorActions existing={!!draft.windowId} busy={busy} uncertain={uncertain} remove={() => void commit(true)} />
  </dialog>;
}
function visibleOccurrences(data: SelfData, range: AvaCalendarLiveWindow | null, zone: string) {
  if (!range) return [];
  try {
    return expandTeacherAvailability(data.windows, { from: DateTime.fromISO(range.start).minus({ days: 2 }).toISODate()!, to: DateTime.fromISO(range.end).plus({ days: 2 }).toISODate()!, displayTimezone: zone })
      .filter((item) => item.startsAt < range.end && item.endsAt > range.start);
  } catch { return []; }
}
function AvailabilityManager({ data, range, zone, edit, close }: { data: SelfData; range: AvaCalendarLiveWindow | null; zone: string; edit: (item: AvailabilityDraft) => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  function select(item: TeacherAvailabilityOccurrence) { close(); edit({ commandKey: crypto.randomUUID(), startsAt: item.startsAt, endsAt: item.endsAt, windowId: item.windowId, date: item.sourceDate }); }
  const items = visibleOccurrences(data, range, zone);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="self-availability-manager" onCancel={(event) => { event.preventDefault(); close(); }}>
    <header className={styles.dialogHeader}><h2 id="self-availability-manager">我的开放时段</h2><button type="button" className={styles.iconButton} aria-label="关闭时段列表" onClick={close}>×</button></header>
    <div className={styles.editorBody}>{items.length ? items.map((item) => <div className={styles.availabilityRow} key={item.id}><span>{item.displayStartDate} {item.displayStart} – {item.displayEndDate} {item.displayEnd}</span><button type="button" onClick={() => select(item)}>修改</button></div>) : <p>当前范围无开放时段</p>}</div>
  </dialog>;
}
export function SelfAvailabilityButton({ available, open }: { available: boolean; open: () => void }) { return available ? <button type="button" onClick={open}>我的开放时段</button> : null; }
export function SelfAvailabilityDialogs({ data, manager, draft, range, zone, edit, closeManager, closeDraft, save, saved }: { data: SelfData | null; manager: boolean; draft: AvailabilityDraft | null; range: AvaCalendarLiveWindow | null; zone: string; edit: (item: AvailabilityDraft) => void; closeManager: () => void; closeDraft: () => void; save: (body: Record<string, unknown>) => Promise<void>; saved: () => void }) {
  if (!data) return null;
  return <>
    {manager && <AvailabilityManager data={data} range={range} zone={zone} close={closeManager} edit={edit} />}
    {draft && <AvailabilityEditor key={draft.commandKey} draft={draft} zone={zone} version={data.version} save={save} close={closeDraft} saved={saved} />}
  </>;
}
