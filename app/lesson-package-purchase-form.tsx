"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { LessonPackageForm, parseLessonPackageFormData, type LessonPackageFormProps } from "./student-record-forms";
import { assertManualLessonPackageTarget, lessonPackagePendingKey, parseLessonPackagePurchaseCommand, SOURCE_OWNED_PACKAGE_NOTICE, type LessonPackagePurchaseCommand } from "../lib/lesson-package-purchase-command";

export function LessonPackagePurchaseForm({ actor, studentId, packages, onSaved, onClose, onBusyChange, ...fields }: LessonPackageFormProps & {
  actor: string;
  studentId: string;
  packages: readonly { id: string; subjectIds: readonly string[] }[];
  onSaved: (studentRow: unknown) => void;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [pending, setPending] = useState<LessonPackagePurchaseCommand | null>(null);
  const [draft, setDraft] = useState<LessonPackagePurchaseCommand | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const storageKey = lessonPackagePendingKey(actor, studentId);
  useEffect(() => {
    let stopped = false;
    // Restore before enabling submission, including after a full page reload.
    void Promise.resolve().then(() => {
      try {
        const raw = window.localStorage.getItem(storageKey);
        const restored = raw ? parseLessonPackagePurchaseCommand(JSON.parse(raw)) : null;
        if (restored && restored.studentId !== studentId) throw new Error("购买恢复记录与学生不一致，请先核对原记录");
        if (!stopped) { setPending(restored); setReady(true); }
      } catch {
        if (!stopped) setError("无法读取上次购买记录。为避免重复充值，请先恢复浏览器存储后再试。");
      }
    });
    return () => { stopped = true; };
  }, [storageKey, studentId]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || !ready) return;
    inFlight.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const stored = window.localStorage.getItem(storageKey);
      const command = stored ? parseLessonPackagePurchaseCommand(JSON.parse(stored)) : pending ?? parseLessonPackagePurchaseCommand({
        ...parseLessonPackageFormData(new FormData(event.currentTarget)),
        commandKey: crypto.randomUUID(), studentId, purchasedAt: new Date().toISOString(),
      });
      if (command.studentId !== studentId) throw new Error("购买记录与学生不一致，请先核对原记录");
      if (!stored && !pending) assertManualLessonPackageTarget(packages, command);
      const serialized = JSON.stringify(command);
      // A storage failure must happen before any request can credit hours.
      window.localStorage.setItem(storageKey, serialized);
      if (window.localStorage.getItem(storageKey) !== serialized) throw new Error("无法安全保存购买记录，请稍后重试");
      setPending(command);
      const response = await fetch("/api/students/lesson-package", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: serialized,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.committed !== true || body.commandKey !== command.commandKey) {
        if (!response.ok && body?.rejectedBeforeCommit === true) {
          if (window.localStorage.getItem(storageKey) === serialized) window.localStorage.removeItem(storageKey);
          setDraft(command);
          setPending(null);
        }
        throw new Error(body?.error ?? "尚未确认购买结果，请重试同一笔购买");
      }
      // Do not remove a different pending command created in another tab.
      if (window.localStorage.getItem(storageKey) === serialized) window.localStorage.removeItem(storageKey);
      onSaved(body.studentRow);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "购买结果尚未确认，请重试同一笔购买");
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  };

  const shown = pending ?? draft;
  return <form className="form-grid" onSubmit={submit}>
    {packages.some((pkg) => pkg.id.startsWith("PKG-JWB-")) ? <p className="form-notice span-2">{SOURCE_OWNED_PACKAGE_NOTICE}。手工课包仅用于其他未由教务宝管理的科目。</p> : null}
    {pending ? <div className="form-notice span-2" role="status">待确认购买：{pending.packageMode === "new" ? pending.newPackageName : pending.packageId} · 购买 {pending.purchasedHours} + 赠送 {pending.bonusHours} 课时。重试会核对同一笔记录，不会重复增加课时。</div> : null}
    <fieldset className="lesson-package-purchase-fields form-grid span-2" disabled={!ready || busy || !!pending} key={pending?.commandKey ?? "new"}>
      <legend className="visually-hidden">课包购买明细</legend>
      <LessonPackageForm {...fields} {...(shown ? {
        initialMode: shown.packageMode,
        initialPackageId: shown.packageMode === "existing" ? shown.packageId : undefined,
        initialNewPackageName: shown.packageMode === "new" ? shown.newPackageName : undefined,
        initialSubjectIds: shown.subjectIds,
        initialPurchasedHours: shown.purchasedHours,
        initialBonusHours: shown.bonusHours,
        initialPurchaseNote: shown.purchaseNote,
      } : {})} />
    </fieldset>
    {error ? <p className="form-error span-2" role="alert">{error}</p> : null}
    <footer><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>关闭</button><button className="primary-button" type="submit" disabled={busy || !ready}><Check size={16} />{busy ? "正在确认购买…" : pending ? "重试同一笔购买" : "保存课包"}</button></footer>
  </form>;
}
