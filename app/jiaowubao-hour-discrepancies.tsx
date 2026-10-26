"use client";

import { useEffect, useState } from "react";
import type { MonthlyHourDiscrepancyReport } from "../lib/jiaowubao-monthly-hour-discrepancies-service";
import type { MonthlyHourDiscrepancy } from "../lib/jiaowubao-monthly-hour-discrepancies";

type Query = { month: string; owner: string; reload: number };
type Result = { report: MonthlyHourDiscrepancyReport | null; loading: boolean; error: string | null };
const roles = { primary: "主教", assistant: "助教", third: "第三老师" };
const hours = (value: number | null, awaitingSource: boolean) => value === null ? awaitingSource ? "待关联来源" : "来源未提供或异常" : String(value);

function DiscrepancyRow({ item }: { item: MonthlyHourDiscrepancy }) {
  return <tr>
    <td><time dateTime={item.lessonDate}>{item.lessonDate}</time><br />{item.timeTitle ?? "时间未提供"}</td>
    <td>{item.courseTitle ?? "课程未提供"}</td>
    <td>{item.students.map((student) => student.name).join("、") || "未匹配学生"}</td>
    <td>{item.teacher}<br />{roles[item.teacherRole]}</td>
    <td>{hours(item.teacherHours, item.sourceMatch === "unlinked")}{item.sourceMatch === "candidate" && <><br />候选来源</>}</td>
    <td>{hours(item.studentHours, item.students.length === 0)}</td>
    <td>{item.sourceMatch === "candidate" ? "分校待确认" : item.difference === null ? "不可核对" : String(item.difference)}</td>
    <td>{[...item.operationsOwners, ...(item.ownerUnmatched ? ["未匹配教务"] : [])].join("、")}</td>
    <td><span className="status-pill amber">{item.status}</span><br />{item.reason}</td>
  </tr>;
}

export function JiaowubaoHourDiscrepancyTable({ rows }: { rows: readonly MonthlyHourDiscrepancy[] }) {
  const [page, setPage] = useState(0);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 100) - 1));
  const visible = rows.slice(currentPage * 100, (currentPage + 1) * 100);
  return <><div className="trial-ledger-scroll"><table className="trial-ledger-table" style={{ minWidth: 1120 }}>
    <caption>月度课时待核查记录 · 日期与时间（墨尔本）</caption>
    <thead><tr>{["日期与时间", "课程", "学生", "老师", "老师课时", "学生课时合计", "差异", "教务", "核查状态"].map((title) => <th scope="col" key={title}>{title}</th>)}</tr></thead>
    <tbody>{visible.map((item) => <DiscrepancyRow key={item.id} item={item} />)}</tbody>
  </table></div>
    <div className="panel-header"><span>共 {rows.length} 条待核查 · 第 {currentPage + 1} 页</span><div>
      <button type="button" className="secondary-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
      <button type="button" className="secondary-button" disabled={(currentPage + 1) * 100 >= rows.length} onClick={() => setPage(currentPage + 1)}>下一页</button>
    </div></div>
  </>;
}

async function readReport(query: Query, signal: AbortSignal) {
  const params = new URLSearchParams();
  if (query.month) params.set("month", query.month);
  if (query.owner) params.set("owner", query.owner);
  const response = await fetch(`/api/jiaowubao-open-api/hour-discrepancies?${params}`, { cache: "no-store", signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "月度课时读取失败。");
  return body as MonthlyHourDiscrepancyReport;
}

export function JiaowubaoHourDiscrepanciesPanel() {
  const [query, setQuery] = useState<Query>({ month: "", owner: "", reload: 0 });
  const [result, setResult] = useState<Result>({ report: null, loading: true, error: null });
  const changeQuery = (next: Query) => { setResult((current) => ({ ...current, loading: true, error: null })); setQuery(next); };
  useEffect(() => {
    const controller = new AbortController();
    void readReport(query, controller.signal).then((report) => {
      if (!controller.signal.aborted) setResult({ report, loading: false, error: null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResult((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "月度课时读取失败。" }));
    });
    return () => controller.abort();
  }, [query]);
  const report = result.report;
  return <section className="panel data-panel" aria-label="月度课时核查">
    <div className="panel-header"><h2>月度课时核查</h2><button type="button" className="secondary-button" disabled={result.loading} onClick={() => changeQuery({ ...query, reload: query.reload + 1 })}>刷新</button></div>
    <div className="form-grid">
      <label>月份<input type="month" aria-label="课时核查月份" max={report?.defaultMonth} value={query.month || report?.month || ""} onChange={(event) => changeQuery({ ...query, month: event.target.value, owner: "" })} /></label>
      <label>教务<select aria-label="课时核查教务" value={query.owner} onChange={(event) => changeQuery({ ...query, owner: event.target.value })}>
        <option value="">全部教务</option>{report?.operationsOwners.map((owner) => <option key={owner} value={owner}>{owner}</option>)}<option value="unmatched">未匹配教务</option>
      </select></label>
    </div>
    {result.loading && <p className="empty-inline" role="status">正在读取月度课时…</p>}
    {!result.loading && result.error && <p className="form-error" role="alert">{result.error}</p>}
    {!result.loading && !result.error && report && (report.rows.length ? <JiaowubaoHourDiscrepancyTable key={`${report.month}:${query.owner}:${report.revision}`} rows={report.rows} /> : <p className="empty-inline" role="status">该月份及筛选范围内没有待核查课节。</p>)}
  </section>;
}
