"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
type Leave = { id: string; teacher_id: string; teacherName: string; start_date: string; end_date: string; reason: string };
export function TeacherLeavePanel({ teacherId, onProcess }: { teacherId?: string; onProcess?: (request: Leave) => void }) {
 const [requests, setRequests] = useState<Leave[]>([]);
 const [error, setError] = useState("");
 const [busy, setBusy] = useState(false);
 const [open, setOpen] = useState(false);
 const key = useRef<string | null>(null);
 const intent = useRef("");
 async function refresh(signal?: AbortSignal) {
  const response = await fetch("/api/teacher-leave-requests", { cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "读取失败");
  setRequests(result.requests);
 }
 useEffect(() => { const controller = new AbortController(); void fetch("/api/teacher-leave-requests", { cache: "no-store", signal: controller.signal }).then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error || "读取失败"); if (!controller.signal.aborted) setRequests(result.requests); }).catch((error) => { if (!controller.signal.aborted) setError(error.message); }); return () => controller.abort(); }, [teacherId]);
 async function submit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (busy) return;
  const form = event.currentTarget;
  const data = new FormData(form);
  const input = { teacherId, start: String(data.get("start")), end: String(data.get("end")), reason: String(data.get("reason")) };
  const serialized = JSON.stringify(input);
  if (intent.current !== serialized) { key.current = crypto.randomUUID(); intent.current = serialized; }
  setBusy(true); setError("");
  try {
   const response = await fetch("/api/teacher-leave-requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, id: key.current }) });
   const result = await response.json(); if (!response.ok) throw new Error(result.error || "提交失败");
   setOpen(false); key.current = null; intent.current = ""; form.reset(); await refresh();
  } catch (error) { setError(error instanceof Error ? error.message : "提交失败，请重试"); } finally { setBusy(false); }
 }
 return <section className="panel teacher-leave-panel"><header className="panel-header"><h2>{teacherId ? "我的请假申请" : "老师请假申请"}</h2><div className="teacher-leave-actions">{teacherId && <button className="secondary-button" type="button" onClick={() => setOpen(!open)}>提交请假申请</button>}<button className="secondary-button" type="button" onClick={() => { setError(""); void refresh().catch((error) => setError(error.message)); }}>刷新</button></div></header><div className="teacher-leave-body"><p className="teacher-leave-description">申请提交后由教务确认和安排；提交本身不会取消课程或改变扣课。</p>{open && <form className="form-grid" onSubmit={submit}><label>开始日期<input name="start" type="date" required /></label><label>结束日期<input name="end" type="date" required /></label><label className="span-2">请假原因<textarea name="reason" minLength={8} maxLength={1000} required /></label><button className="primary-button" disabled={busy} type="submit">{busy ? "提交中…" : "提交申请"}</button></form>}{error && <p role="alert">{error}</p>}<div className="record-list">{requests.map((request) => <div className="record-row" key={request.id}><div><strong>{request.teacherName} · {request.start_date}–{request.end_date}</strong><p>{request.reason}</p></div>{onProcess && <button type="button" className="secondary-button" onClick={() => onProcess(request)}>查看受影响课程</button>}</div>)}</div>{!requests.length && !error && <div className="teacher-leave-empty" role="status"><strong>暂无请假申请</strong><p>新的请假申请会显示在这里，方便教务确认和安排。</p></div>}</div></section>;
}
