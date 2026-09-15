import { cookies } from "next/headers";
import Link from "next/link";
import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { readWecomArchiveInbox, readWecomMirrorReview } from "@/lib/ops-store";
import { mirrorReviewFilters, reviewText, type MirrorReview } from "@/lib/wecom-mirror-review";
import styles from "./review.module.css";
export const dynamic = "force-dynamic";
const labels = { task: "交接待办", schedule: "排课对照", finding: "核对发现", capture: "原始转录" };
function trialIdentityStatus(status: string | null) {
 switch (status) {
  case "identified": return "已确认学生身份";
  case "identity_conflict": return "姓名冲突 · 待核对";
  default: return "等待学生姓名";
 }
}
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
 const jar = await cookies();
 const resolved = await getCurrentDemoSession(jar.get(DEMO_COOKIE_NAME)?.value);
 if (!("session" in resolved) || !hasFullAdminAccess(resolved.session, jar.get(NIXON_COOKIE_NAME)?.value)) return <main className={styles.page}><h1>群交接核对</h1><p>请使用管理员账号登录后查看。</p><Link href="/">返回系统登录</Link></main>;
 const raw = await searchParams; const params = new URLSearchParams();
 for (const key of ["kind", "q", "page", "batch"]) if (typeof raw[key] === "string") params.set(key, raw[key]);
 const filter = mirrorReviewFilters(params);
 let data: MirrorReview;
 try { data = await readWecomMirrorReview(filter); } catch { return <main className={styles.page}><h1>群交接核对</h1><p role="alert">记录暂时无法读取，请刷新重试。</p><Link href="/">返回工作台</Link></main>; }
 const archiveInbox = await readWecomArchiveInbox(100).catch(() => []);
 const seenTrialHandoverIds = new Set<string>();
 const trialHandovers = archiveInbox.filter((row) => {
  if (!row.trial_handover_id || seenTrialHandoverIds.has(row.trial_handover_id)) return false;
  seenTrialHandoverIds.add(row.trial_handover_id);
  return true;
 });
 const selectedBatch = data.batch?.id || filter.batch;
 const href = (kind: string, page = 1) => `/handover-review?${new URLSearchParams({ kind, page: String(page), q: filter.query, batch: selectedBatch })}`;
 return <main className={styles.page}>
  <header className={styles.header}><div><p className={styles.eyebrow}>试听与 LP · 来源核对</p><h1>群交接核对</h1><p>{data.batch?.groupName || "等待导入群交接记录"}</p></div><Link href="/">返回工作台</Link></header>
  <div className={styles.notice}><strong>保留原文，先核对再进入正式流程</strong><p>这里保存镜像采集的交接资料和核对结果。导入不会自动标记 LP、收费或排课已完成；时间冲突和身份不明确的记录需继续核实。OCR 可能存在错字，以原始截图为准。</p>{data.batch && <small>采集截至 {new Date(data.batch.capturedAt).toLocaleString("zh-CN", { timeZone: "Australia/Melbourne" })}（墨尔本） · 对照为该次核对快照，不代表当前完成状态</small>}</div>
  <section className={styles.botTrialIntake} aria-labelledby="wecom-trial-intake-heading">
   <div className={styles.botTrialHeading}><div><p className={styles.eyebrow}>企业微信机器人 · 试听身份确认</p><h2 id="wecom-trial-intake-heading">待补学生姓名的试听交接</h2></div><span>{trialHandovers.length} 条</span></div>
   <p>首条交接按群内微信名收录；收到同一微信名和学生中英文姓名后，系统只会确认身份并保留原始资料，不会自动创建正式学生、LP、排课或付款。</p>
   {trialHandovers.length ? <div className={styles.botTrialRecords}>{trialHandovers.map((row) => <article className={styles.botTrialRecord} key={row.trial_handover_id ?? row.message_id}>
    <div><h3>{row.trial_identity_student_name || row.guardian_wechat_hint || "微信名待补"}</h3><p>微信名：{row.guardian_wechat_hint || "待填写"} · 收录于 {new Date(row.sent_at).toLocaleString("zh-CN", { timeZone: "Australia/Melbourne" })}</p><p>教务：{row.operations_owner_hint || "待填写"} · 课程规划老师：{row.course_planner_hint || "待填写"}</p></div>
    <span className={styles.botTrialStatus}>{trialIdentityStatus(row.trial_identity_status)}</span>
   </article>)}</div> : <p className={styles.botTrialEmpty}>目前没有机器人收录的试听身份记录。</p>}
  </section>
  <nav className={styles.tabs} aria-label="记录类型">{Object.entries(labels).map(([kind, label]) => <Link key={kind} href={href(kind)} aria-current={filter.kind === kind ? "page" : undefined}>{label}<span>{data.counts[kind as keyof typeof labels] || 0}</span></Link>)}</nav>
  <form className={styles.search}><input type="hidden" name="kind" value={filter.kind}/><label htmlFor="review-batch">群与采集批次</label><select id="review-batch" name="batch" defaultValue={selectedBatch}>{!data.batch && <option value="">选择已导入资料</option>}{data.batches.map(batch => <option key={batch.id} value={batch.id}>{batch.groupName} · {new Date(batch.capturedAt).toLocaleString("zh-CN", { timeZone: "Australia/Melbourne" })}</option>)}</select><label htmlFor="review-query">查找学生或任务</label><input id="review-query" name="q" type="search" maxLength={100} defaultValue={filter.query} placeholder="姓名、LP、备课、续费…"/><button type="submit">查看</button></form>
  <p className={styles.meta}>{data.total} 条记录 · 第 {data.page} 页</p>
  <section className={styles.records} aria-label={labels[filter.kind]}>{data.rows.map(row => {
   const b = row.body; const text = (key: string) => reviewText(b, key);
   return <article className={styles.record} key={row.rowNumber}>
    <div className={styles.recordHeading}><h2>{text("title") || text("studentLabel") || `转录片段 ${row.rowNumber}`}</h2><span className={styles.badge}>{row.kind === "schedule" ? text("status") === "consistent" ? "时间与老师一致" : "存在差异 · 待核对" : row.kind === "capture" ? "OCR 原文" : "待处理"}</span></div>
    {row.kind === "schedule" ? <><p>{text("date")} · {text("course")}</p><dl className={styles.compare}><div><dt>群内记录（未标时区）</dt><dd>{text("chatStart")}–{text("chatEnd")} · {text("chatTeacher")}</dd></div><div><dt>系统记录（{text("systemTimezone")}）</dt><dd>{text("systemStart")}–{text("systemEnd")} · {text("systemTeacher")}</dd></div></dl><p>{text("reason")}</p></> : <><p className={styles.body}>{text("text") || text("description")}</p>{text("owner") && <p>群内提及负责人：{text("owner")}</p>}{text("systemResult") && <p className={styles.result}>系统核对：{text("systemResult")}</p>}</>}
    {row.task && <p className={styles.result}>正式待办：{row.task.id} · {row.task.status === "done" ? "已关闭" : row.task.status ? "待跟进" : "任务已不在当前列表"}{row.task.owner && ` · ${row.task.owner}`}<br/>可在工作台 To Do 中按任务标题查找。核对任务不代表 LP、收费或排课已经完成。</p>}
    <small>来源截图：{row.sourceCapture} · 记录 #{row.rowNumber}</small>
   </article>;
  })}{data.rows.length === 0 && <p>当前筛选没有记录。</p>}</section>
  <nav className={styles.pagination} aria-label="分页">{data.page > 1 && <Link href={href(filter.kind, data.page - 1)}>上一页</Link>}{data.page * 30 < data.total && <Link href={href(filter.kind, data.page + 1)}>下一页</Link>}</nav>
 </main>;
}
