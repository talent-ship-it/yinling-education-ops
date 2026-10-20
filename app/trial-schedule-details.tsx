import { dateTimeFormat } from "../lib/date-time-format";
import { isLessonDuration } from "../lib/lesson-duration";
import type { TrialScheduleLink } from "../lib/trial-operations";

const MELBOURNE = "Australia/Melbourne";

function scheduleRange(schedule: TrialScheduleLink) {
  const start = new Date(schedule.startsAt);
  const end = new Date(schedule.endsAt);
  const minutes = (end.getTime() - start.getTime()) / 60_000;
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const date = dateTimeFormat("en-CA", { timeZone: MELBOURNE, year: "numeric", month: "2-digit", day: "2-digit" });
  const clock = dateTimeFormat("en-GB", { timeZone: MELBOURNE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const startDate = date.format(start);
  const endDate = date.format(end);
  return {
    date: startDate === endDate ? startDate : `${startDate} – ${endDate}`,
    time: `${clock.format(start)} – ${clock.format(end)}`,
    duration: isLessonDuration(minutes) ? minutes : null,
  };
}

function sharedAccount(schedule: TrialScheduleLink) {
  const label = schedule.sharedAccountLabel?.trim();
  if (label) return label;
  const letter = schedule.sharedAccountLetter?.trim().toUpperCase();
  return letter && /^[ABC]$/.test(letter) ? `试听账号 ${letter}` : "未关联";
}

export function trialSchedulePendingLabel(input: {
  archived?: boolean;
  stage: string;
  resultStatus?: string;
  studentNameConfirmed: boolean;
  requestAt?: string;
  windowStartsAt: string;
  loading: boolean;
  sourceState?: string;
}) {
  if (input.archived) return "已归档 · 待核对历史课表";
  if (input.resultStatus === "已取消") return "已取消";
  if (input.stage === "完成") return "已完成 · 待核对历史课表";
  if (input.loading) return "正在读取教务宝";
  if (input.sourceState === "stale") return "课表快照已过期";
  if (input.sourceState !== "complete") return "等待教务宝课表";
  if (!input.studentNameConfirmed) return "待核对学生姓名";
  const requestTime = Date.parse(input.requestAt ?? "");
  if (requestTime < Date.parse(input.windowStartsAt)) return "历史交接 · 待核对课表";
  return "待匹配教务宝课表";
}

export function TrialScheduleDetails({ schedule, pendingLabel = "待匹配教务宝课表", onComplete }: {
  schedule?: TrialScheduleLink;
  pendingLabel?: string;
  onComplete?: () => void;
}) {
  if (!schedule || schedule.source !== "jiaowubao-open-api") return <div className="ledger-edit-cell automatic">
    <span className="inline-meta">{pendingLabel}</span>
    {onComplete && <button className="secondary-button" type="button" onClick={onComplete}>补全教务宝小课表</button>}
  </div>;
  const range = scheduleRange(schedule);
  const duration = isLessonDuration(schedule.durationMinutes) ? schedule.durationMinutes : range?.duration;
  const entries = [
    ["教务宝老师", schedule.teacherName || "未记录"],
    ["教务宝课程", schedule.courseName || "未记录"],
    ["上课日期（墨尔本）", range?.date ?? "未记录"],
    ["上课时间（墨尔本）", range?.time ?? "未记录"],
    ["排课时长", duration ? `${duration} 分钟` : "未记录"],
    ["共享试听账号", sharedAccount(schedule)],
  ];
  return <section aria-label="教务宝小课表"><div className="detail-section split">
    {entries.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
  </div></section>;
}
