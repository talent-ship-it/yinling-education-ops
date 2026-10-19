"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ClassroomMaterialsPanel from "@/app/classroom-materials-panel";

type Teacher = { id: string; name: string };
function teacherRecord(value: Partial<Teacher> | null): Teacher[] {
  if (!value) return [];
  if (typeof value.id !== "string") return [];
  if (typeof value.name !== "string") return [];
  return [{ id: value.id, name: value.name }];
}

function teacherRows(body: { rows?: Array<{ entity: string; payload: unknown }> }) {
  if (!Array.isArray(body.rows)) return [];
  const payload = body.rows.find((row) => row.entity === "teachers")?.payload;
  return Array.isArray(payload) ? payload.flatMap(teacherRecord) : [];
}

async function responseBody(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "白色板书打开失败");
  return body;
}

export default function MaterialsWorkspace({ selectedClassroom }: { selectedClassroom?: { bookingId: string; occurrenceId: string; sourceDate: string } }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [teachers, setTeachers] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/app-state?entities=teachers", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json();
        if (controller.signal.aborted) return;
        setTeachers(teacherRows(body));
      }).catch(() => undefined);
    return () => controller.abort();
  }, []);
  return <main style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 16px" }}>
    <Link className="secondary-button" href="/#section=classroom">返回网上教室</Link>
    {selectedClassroom && <button className="secondary-button" type="button" disabled={busy} onClick={async () => {
      setBusy(true);
      setMessage("");
      try {
        const response = await fetch("/api/classroom", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "whiteboard", ...selectedClassroom }) });
        await responseBody(response);
        setMessage("白色板书已提交到课堂");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "白色板书打开失败");
      } finally {
        setBusy(false);
      }
    }}>打开白色板书</button>}
    {message && <p role="status">{message}</p>}
    <ClassroomMaterialsPanel teachers={teachers} selectedClassroom={selectedClassroom} notify={setMessage} />
  </main>;
}
