import { BookOpen, CalendarClock, CircleAlert, Coins, Database, Link2, ShieldCheck } from "lucide-react";

import {
  jiaowubaoAuthorityCadenceHealthy,
  type JiaowubaoAuthorityMatchStats,
  type JiaowubaoAuthorityStatus,
} from "@/lib/jiaowubao-authority-status";

function localTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function MatchCard({ label, stats }: { label: string; stats: JiaowubaoAuthorityMatchStats }) {
  const tone = stats.conflict > 0 ? "warning" : stats.total > 0 && stats.matched === stats.total ? "healthy" : "neutral";
  return <article className={`jwb-authority-match ${tone}`}>
    <span><strong>{label}</strong><em>{stats.matchRate.toFixed(2)}%</em></span>
    <small>{stats.matched}/{stats.total} 已对应 · {stats.unmatched} 未匹配 · {stats.conflict} 冲突</small>
  </article>;
}

export function JiaowubaoAuthorityStatusPanel({
  status,
  now,
}: {
  status: JiaowubaoAuthorityStatus | null;
  now?: number;
}) {
  if (!status) {
    return <section className="panel jwb-authority-panel" aria-labelledby="jwb-authority-title">
      <div className="jwb-authority-header">
        <span className="jwb-authority-mark"><Database size={19} /></span>
        <div>
          <p className="eyebrow">权威来源</p>
          <h2 id="jwb-authority-title">教务宝 Open API</h2>
          <p>数据库投影尚未产生状态。部署迁移并完成下一次计划同步后，这里会显示真实匹配率和异常数量。</p>
        </div>
        <span className="jwb-authority-pill waiting">等待首次投影</span>
      </div>
    </section>;
  }

  const cadenceHealthy = now === undefined
    ? jiaowubaoAuthorityCadenceHealthy(status)
    : jiaowubaoAuthorityCadenceHealthy(status, now);
  const hardAnomalies = status.anomalies.duplicateScheduleIds
    + status.anomalies.missingScheduleIds
    + status.anomalies.invalidTimeRecords
    + status.anomalies.missingStudentIds
    + status.anomalies.missingTeacherIds
    + status.anomalies.missingCourseIds
    + status.anomalies.identityConflicts;
  const priceRows = status.prices.schedulePriceRecords + status.prices.studentPriceRecords;

  return <section className="panel jwb-authority-panel" aria-labelledby="jwb-authority-title">
    <div className="jwb-authority-header">
      <span className="jwb-authority-mark"><ShieldCheck size={19} /></span>
      <div>
        <p className="eyebrow">权威来源 · 非唯一来源</p>
        <h2 id="jwb-authority-title">教务宝 Open API 已进入资料库</h2>
        <p>{status.coverage.nativeRecordsSynchronized
          ? "完整来源快照与规范化映射均长期保存在数据库；仅在证据唯一时同步现有资料，并保留其他权威来源的数据。"
          : "完整来源快照与规范化映射已保存在数据库；现有系统资料同步尚未完成，当前仅展示来源投影结果。"}</p>
      </div>
      <span className={`jwb-authority-pill ${cadenceHealthy ? "healthy" : "warning"}`}>
        {cadenceHealthy ? "30 分钟同步正常" : "同步已超过 75 分钟"}
      </span>
    </div>

    <div className="jwb-authority-facts">
      <article><CalendarClock size={17} /><span><small>最近成功检查</small><strong>{localTime(status.sourceSyncedAt)}</strong><em>墨尔本时间 · 每 {status.cadenceMinutes} 分钟</em></span></article>
      <article><Database size={17} /><span><small>当前来源快照</small><strong>{status.snapshotRows} 条课表</strong><em>{status.sourceWindow.start} 至 {status.sourceWindow.end}</em></span></article>
      <article><Link2 size={17} /><span><small>规范化映射</small><strong>{status.coverage.normalizedEntityRows} 个来源实体</strong><em>{status.coverage.nativeRecordsSynchronized ? `${status.coverage.matchedEntityRows} 个已对应系统资料` : "现有系统资料同步待完成"}</em></span></article>
      <article><CircleAlert size={17} /><span><small>数据异常</small><strong>{hardAnomalies} 项</strong><em>{status.anomalies.invalidTimeRecords} 时间 · {status.anomalies.identityConflicts} 冲突</em></span></article>
    </div>

    <div className="jwb-authority-matches" aria-label="教务宝匹配率">
      <MatchCard label="学生" stats={status.matches.student} />
      <MatchCard label="老师" stats={status.matches.teacher} />
      <MatchCard label="课程" stats={status.matches.course} />
      <MatchCard label="课表" stats={status.matches.schedule} />
    </div>

    <div className="jwb-authority-detail-grid">
      <article>
        <Coins size={18} />
        <span><strong>价格字段：{status.prices.present ? "已发现并私有保存" : "当前快照未发现"}</strong><small>{priceRows} 条价格记录；价格值不会发送到浏览器。</small></span>
      </article>
      <article>
        <BookOpen size={18} />
        <span><strong>字段覆盖：课表 {status.fields.topLevelFields.length} 个 · 学员 {status.fields.studentFields.length} 个</strong><small>当前已接入 Open API 工具 query_schedule_list；其他数据域需供应商提供正式 Open API 合同后接入。</small></span>
      </article>
    </div>

    <p className="jwb-authority-footnote">
      异常明细：课表重复 {status.anomalies.duplicateScheduleIds} · 课表缺失 ID {status.anomalies.missingScheduleIds} · 学生缺失 ID {status.anomalies.missingStudentIds} · 老师缺失 ID {status.anomalies.missingTeacherIds} · 课程缺失 ID {status.anomalies.missingCourseIds} · 身份冲突 {status.anomalies.identityConflicts}。来源快照、学生、老师、课程、班级、教室和课表映射均已入库；{status.coverage.nativeRecordsSynchronized ? "安全匹配的数据已同步，未安全匹配的数据保留在教务宝来源实体中。" : "现有系统资料尚未同步，所有来源数据仍保留在教务宝来源实体中。"}
    </p>
  </section>;
}
