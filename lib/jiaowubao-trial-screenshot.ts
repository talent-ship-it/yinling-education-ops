import { trialAccountLetter } from "./trial-account-label";
import { jiaowubaoTrialStudentNameFromCourseTitle } from "./trial-operations";

export type TrialScreenshotExtraction = Readonly<{
  sourceDate: string | null;
  startTime: string | null;
  endTime: string | null;
  teacherName: string | null;
  courseName: string | null;
  sharedAccountLabel: string | null;
  sharedAccountLetter: "a" | "b" | "c" | null;
  durationMinutes: number | null;
  studentNameHint: string | null;
  warnings: readonly string[];
}>;

type Field = "teacherName" | "courseName" | "sharedAccountLabel";
type Validator = (value: string) => string | null;
const MAX_TEXT_LENGTH = 20_000;
const fieldLabels = { teacherName: "老师", courseName: "课程", sharedAccountLabel: "共享试听账号" };
const labels = new Map<string, Field | null>([
  ["课程名称", "courseName"], ["课程", "courseName"],
  ["班级名称", "sharedAccountLabel"], ["班级", "sharedAccountLabel"], ["试听账号", "sharedAccountLabel"], ["学员账号", "sharedAccountLabel"],
  ["授课老师", "teacherName"], ["授课教师", "teacherName"], ["任课老师", "teacherName"], ["任课教师", "teacherName"], ["上课老师", "teacherName"], ["老师", "teacherName"], ["教师", "teacherName"],
  ...["上课时间", "排课时间", "上课日期", "排课日期", "日期", "时间", "上课", "教室", "学员", "学生", "课时", "状态", "签到", "考勤", "备注", "费用", "结课", "已结课", "未结课", "已付款", "已支付", "取消排课"].map((label) => [label, null] as const),
]);
const labelPattern = new RegExp(`(?:^|\\n|[ \\t]+)[【\\[]?(${[...labels.keys()].join("|")})[】\\]]?(?:[ \\t]*:[ \\t]*|[ \\t]+|(?=\\n|$))`, "gu");
const datePattern = /(?<![\d+-])(?:\d{4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?)(?!\d)/gu;
const timeRangePattern = /(?<![\d:+-])(\d{1,2}\s*:\s*\d{2})\s*[-–—~至到]\s*(\d{1,2}\s*:\s*\d{2})(?![\d:])/gu;

function normalizedText(value: string) {
  if (typeof value !== "string") throw new TypeError("截图识别内容必须是文字。");
  if (value.length > MAX_TEXT_LENGTH) throw new RangeError("截图识别内容过长。");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new TypeError("截图识别内容包含无效字符。");
  const text = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (text.length > MAX_TEXT_LENGTH) throw new RangeError("截图识别内容过长。");
  return text;
}

function resolveValue(values: readonly string[], label: string, validate: Validator, warnings: string[]) {
  if (!values.length) { warnings.push(`未识别${label}。`); return null; }
  const parsed = values.map(validate);
  if (parsed.includes(null)) { warnings.push(`${label}格式无效，需人工核对。`); return null; }
  const distinct = [...new Set(parsed)];
  if (distinct.length > 1) { warnings.push(`${label}存在冲突，未自动选择。`); return null; }
  if (values.length > 1) warnings.push(`${label}重复出现，需核对原图。`);
  return distinct[0] ?? null;
}

function calendarDate(value: string) {
  const parts = value.match(/\d+/gu)?.map(Number);
  if (!parts || parts.length !== 3) return null;
  const [year, month, day] = parts;
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  if (year! < 1900 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function clockTime(value: string) {
  const [hour, minute] = value.replace(/\s/gu, "").split(":").map(Number);
  if (hour! > 23 || minute! > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function timeRange(value: string) {
  const times = value.split("|").map(clockTime);
  if (times.includes(null) || times[0]! >= times[1]!) return null;
  return times.join("|");
}

function scheduleTimes(text: string, warnings: string[]) {
  const ranges = [...text.matchAll(timeRangePattern)].map((match) => `${match[1]}|${match[2]}`);
  const range = resolveValue(ranges, "上课时间范围", timeRange, warnings);
  if (!range) return { startTime: null, endTime: null, durationMinutes: null };
  const [startTime, endTime] = range.split("|");
  const minutes = (value: string) => { const [hour, minute] = value.split(":").map(Number); return hour! * 60 + minute!; };
  return { startTime: startTime!, endTime: endTime!, durationMinutes: minutes(endTime!) - minutes(startTime!) };
}

function labelledValues(text: string) {
  const matches = [...text.matchAll(labelPattern)];
  const values: Record<Field, string[]> = { teacherName: [], courseName: [], sharedAccountLabel: [] };
  matches.forEach((match, index) => {
    const field = labels.get(match[1]!);
    if (!field) return;
    const value = text.slice(match.index! + match[0].length, matches[index + 1]?.index ?? text.length);
    values[field].push(value.replace(/\s+/gu, " ").trim());
  });
  return values;
}

function boundedValue(value: string, limit: number) {
  return value && value.length <= limit && !/^(?:未知|待定|待确认|未安排|无|n\/?a|[-?]+)$/iu.test(value) ? value : null;
}

function teacherValue(value: string) {
  return boundedValue(value.replace(/\s*\(\s*\d+(?:\.\d+)?\s*(?:课\s*时|学\s*时|小\s*时|hours?|hrs?|h)\s*\)\s*$/iu, "").trim(), 160);
}

function sharedAccountValue(value: string) {
  if (!boundedValue(value, 160)) return null;
  if (trialAccountLetter(value)) return value;
  const compact = value.replace(/\s/gu, "");
  return /^(?:[试视]听(?:学[员生]|账号)|trial(?:student|account))[abc]\([^()]{1,40}\)(?:19|20)\d{2}$/iu.test(compact) ? value : null;
}

function accountLetter(value: string | null): TrialScreenshotExtraction["sharedAccountLetter"] {
  const candidate = value?.replace(/\s/gu, "").toLowerCase().match(/^(?:[试视]听(?:学[员生]|账号)|trial(?:student|account))([abc])(?:\(|(?:19|20)\d{2}|$)/u)?.[1];
  const letter = trialAccountLetter(value) ?? candidate;
  return letter === "a" || letter === "b" || letter === "c" ? letter : null;
}

function studentHint(courseName: string | null) {
  if (!courseName || /\.{2,}|…|⋯/u.test(courseName) || !/[-–—]\s+\S/u.test(courseName)) return null;
  const name = jiaowubaoTrialStudentNameFromCourseTitle(courseName);
  return name && !trialAccountLetter(name) ? name : null;
}

export function parseTrialScreenshotText(value: string): TrialScreenshotExtraction {
  const text = normalizedText(value);
  const warnings = ["截图时间尚未确认时区。"];
  const fields = labelledValues(text);
  const sourceDate = resolveValue([...text.matchAll(datePattern)].map((match) => match[0]), "上课日期", calendarDate, warnings);
  const teacherName = resolveValue(fields.teacherName, fieldLabels.teacherName, teacherValue, warnings);
  const courseName = resolveValue(fields.courseName, fieldLabels.courseName, (course) => boundedValue(course, 600), warnings);
  const sharedAccountLabel = resolveValue(fields.sharedAccountLabel, fieldLabels.sharedAccountLabel, sharedAccountValue, warnings);
  const sharedAccountLetter = accountLetter(sharedAccountLabel);
  if (sharedAccountLabel && !trialAccountLetter(sharedAccountLabel)) warnings.push("共享试听账号附注无法确认，账号字母仅供核对。");
  return Object.freeze({ sourceDate, ...scheduleTimes(text, warnings), teacherName, courseName, sharedAccountLabel,
    sharedAccountLetter, studentNameHint: studentHint(courseName), warnings: Object.freeze(warnings) });
}
