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

export function TrialScheduleDetails({ schedule }: { schedule?: TrialScheduleLink }) {
  if (!schedule || schedule.source !== "jiaowubao-open-api") return <span className="inline-meta">未关联</span>;
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
