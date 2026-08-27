"use client";

import { useEffect, useState } from "react";

import { CircleAlert } from "lucide-react";

import type {
  JiaowubaoDirectLeaveMakeupHistoryItem,
  JiaowubaoDirectStudentHistory,
  JiaowubaoDirectSupplementalHistoryItem,
} from "@/lib/ops-store";

const SUPPLEMENTAL_KINDS = new Set<JiaowubaoDirectSupplementalHistoryItem["kind"]>([
  "student_snapshot",
  "quick_list",
  "contract",
  "hour_balance",
  "class_membership",
]);

const LEAVE_MAKEUP_KINDS = new Set<JiaowubaoDirectLeaveMakeupHistoryItem["kind"]>([
  "leave",
  "makeup",
  "unknown",
]);

const SUPPLEMENTAL_KIND_LABELS: Record<JiaowubaoDirectSupplementalHistoryItem["kind"], string> = {
  student_snapshot: "学员资料",
  quick_list: "学员快速列表",
  contract: "学员合约",
  hour_balance: "学员课时",
  class_membership: "班级学员名单",
};

const LEAVE_MAKEUP_KIND_LABELS: Record<JiaowubaoDirectLeaveMakeupHistoryItem["kind"], string> = {
  leave: "请假",
  makeup: "补课",
  unknown: "待核对",
};

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function nullableString(value: unknown, message: string) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(message);
  return value;
}

function booleanValue(value: unknown, message: string) {
  if (typeof value !== "boolean") throw new Error(message);
  return value;
}

function supplementalItem(value: unknown): JiaowubaoDirectSupplementalHistoryItem {
  const source = objectValue(value, "教务宝补充资料格式无效。");
  if (typeof source.kind !== "string" || !SUPPLEMENTAL_KINDS.has(source.kind as JiaowubaoDirectSupplementalHistoryItem["kind"])) {
    throw new Error("教务宝补充资料类型无效。");
  }
  return {
    kind: source.kind as JiaowubaoDirectSupplementalHistoryItem["kind"],
    courseName: nullableString(source.courseName, "教务宝补充资料科目格式无效。"),
    className: nullableString(source.className, "教务宝补充资料班级格式无效。"),
    classType: nullableString(source.classType, "教务宝补充资料班型格式无效。"),
    studentType: nullableString(source.studentType, "教务宝补充资料学员类型格式无效。"),
    totalHours: nullableString(source.totalHours, "教务宝补充资料总课时格式无效。"),
    usedHours: nullableString(source.usedHours, "教务宝补充资料已消课时格式无效。"),
    remainingHours: nullableString(source.remainingHours, "教务宝补充资料剩余课时格式无效。"),
  };
}

function leaveMakeupItem(value: unknown): JiaowubaoDirectLeaveMakeupHistoryItem {
  const source = objectValue(value, "教务宝请假补课资料格式无效。");
  if (typeof source.kind !== "string" || !LEAVE_MAKEUP_KINDS.has(source.kind as JiaowubaoDirectLeaveMakeupHistoryItem["kind"])) {
    throw new Error("教务宝请假补课类型无效。");
  }
  return {
    date: nullableString(source.date, "教务宝请假补课日期格式无效。"),
    timeText: nullableString(source.timeText, "教务宝请假补课时间格式无效。"),
    kind: source.kind as JiaowubaoDirectLeaveMakeupHistoryItem["kind"],
    courseName: nullableString(source.courseName, "教务宝请假补课科目格式无效。"),
  };
}

/** Validates the curated API response before it is shown in the student modal. */
export function parseJiaowubaoImportedStudentHistory(value: unknown): JiaowubaoDirectStudentHistory {
  const source = objectValue(value, "教务宝补充历史响应格式无效。");
  if (source.state !== "absent" && source.state !== "complete") throw new Error("教务宝补充历史状态无效。");
  const supplemental = objectValue(source.supplemental, "教务宝补充历史资料格式无效。");
  const leaveMakeups = objectValue(source.leaveMakeups, "教务宝请假补课历史格式无效。");
  if (!Array.isArray(supplemental.items) || !Array.isArray(leaveMakeups.items)) {
    throw new Error("教务宝补充历史列表格式无效。");
  }

  return {
    state: source.state,
    supplemental: {
      items: supplemental.items.map(supplementalItem),
      truncated: booleanValue(supplemental.truncated, "教务宝补充历史截断状态无效。"),
    },
    leaveMakeups: {
      items: leaveMakeups.items.map(leaveMakeupItem),
      truncated: booleanValue(leaveMakeups.truncated, "教务宝请假补课截断状态无效。"),
    },
  };
}

function supplementalSummary(item: JiaowubaoDirectSupplementalHistoryItem) {
  return [
    item.courseName ? `科目：${item.courseName}` : null,
    item.className ? `班级：${item.className}` : null,
    item.classType ? `班型：${item.classType}` : null,
    item.studentType ? `学员类型：${item.studentType}` : null,
  ].filter((value): value is string => Boolean(value));
}

function supplementalHours(item: JiaowubaoDirectSupplementalHistoryItem) {
  return [
    item.totalHours ? `总课时 ${item.totalHours}` : null,
    item.usedHours ? `已消 ${item.usedHours}` : null,
    item.remainingHours ? `剩余 ${item.remainingHours}` : null,
  ].filter((value): value is string => Boolean(value));
}

export type JiaowubaoImportedStudentHistoryPanelProps = Readonly<{
  history: JiaowubaoDirectStudentHistory | null;
  loading: boolean;
  error: boolean;
}>;

/**
 * Curated historical records shown alongside the student's current profile.
 */
export function JiaowubaoImportedStudentHistoryPanel({
  history,
  loading,
  error,
}: JiaowubaoImportedStudentHistoryPanelProps) {
  const supplemental = history?.supplemental.items ?? [];
  const leaveMakeups = history?.leaveMakeups.items ?? [];
  const truncated = Boolean(history?.supplemental.truncated || history?.leaveMakeups.truncated);
  const noItems = !supplemental.length && !leaveMakeups.length;

  return (
    <section className="jiaowubao-imported-student-history" aria-labelledby="jiaowubao-imported-student-history-title">
      <header className="jiaowubao-imported-student-history-header">
        <div>
          <h2 id="jiaowubao-imported-student-history-title">历史资料</h2>
        </div>
      </header>

      {loading ? <div className="jiaowubao-imported-student-history-empty" role="status" aria-live="polite">正在读取历史资料…</div> : null}
      {!loading && error ? <div className="jiaowubao-imported-student-history-empty" role="alert">历史资料暂时无法读取。</div> : null}
      {!loading && !error && (history?.state === "absent" || (history?.state === "complete" && noItems)) ? <div className="jiaowubao-imported-student-history-empty" role="status">暂无历史资料。</div> : null}

      {!loading && !error && history?.state === "complete" && supplemental.length > 0 ? (
        <div className="jiaowubao-imported-student-history-section">
          <div className="jiaowubao-imported-student-history-section-title"><strong>课时、合约与班级资料</strong></div>
          <div className="jiaowubao-imported-student-history-list">
            {supplemental.map((item, index) => {
              const summary = supplementalSummary(item);
              const hours = supplementalHours(item);
              return (
                <article className="jiaowubao-imported-student-history-row" key={`${item.kind}-${index}`}>
                  <span className="jiaowubao-imported-student-history-kind">{SUPPLEMENTAL_KIND_LABELS[item.kind]}</span>
                  <span>
                    <strong>{summary.length ? summary.join(" · ") : "资料字段待补充"}</strong>
                    {hours.length ? <small>{hours.join(" · ")}</small> : null}
                  </span>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}

      {!loading && !error && history?.state === "complete" && leaveMakeups.length > 0 ? (
        <div className="jiaowubao-imported-student-history-section">
          <div className="jiaowubao-imported-student-history-section-title"><strong>请假与补课记录</strong></div>
          <div className="jiaowubao-imported-student-history-list">
            {leaveMakeups.map((item, index) => (
              <article className="jiaowubao-imported-student-history-row" key={`${item.kind}-${item.date ?? "undated"}-${index}`}>
                <span className="jiaowubao-imported-student-history-kind">{LEAVE_MAKEUP_KIND_LABELS[item.kind]}</span>
                <span>
                  <strong>{[item.date, item.timeText].filter(Boolean).join(" · ") || "时间待核对"}</strong>
                  {item.courseName ? <small>科目：{item.courseName}</small> : null}
                </span>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {!loading && !error && history?.state === "complete" && truncated ? (
        <div className="jiaowubao-imported-student-history-warning" role="status">
          <CircleAlert size={16} />
          <span>仅显示每类前 200 条记录。</span>
        </div>
      ) : null}
    </section>
  );
}

/**
 * This component is mounted only inside the pre-existing student-record modal.
 * It makes no request until an authorized user has opened that modal.
 */
export function JiaowubaoImportedStudentHistory({ studentId }: Readonly<{ studentId: string }>) {
  const [history, setHistory] = useState<JiaowubaoDirectStudentHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A newly opened student modal must not show another student's source history while its authorized read is in flight.
    setHistory(null);
    setLoading(true);
    setError(false);

    void fetch(`/api/jiaowubao-direct-import/students/${encodeURIComponent(studentId)}/history`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error("教务宝补充历史读取失败。");
        return parseJiaowubaoImportedStudentHistory(body);
      })
      .then((nextHistory) => {
        if (!controller.signal.aborted) setHistory(nextHistory);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [studentId]);

  return <JiaowubaoImportedStudentHistoryPanel history={history} loading={loading} error={error} />;
}
