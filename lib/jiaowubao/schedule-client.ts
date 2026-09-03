import "server-only";

import {
  configuredJiaowubaoGatewaySk,
  documentedGatewayScheduleRequest,
  JIAOWUBAO_GATEWAY_DEFAULT_URL,
  JIAOWUBAO_GATEWAY_PAGE_LIMIT,
  waitForJiaowubaoGatewayRateLimit,
} from "@/lib/jiaowubao/gateway-contract";
import { collectPagesUntilEmpty } from "@/lib/jiaowubao/pagination";

const MAX_RESPONSE_BYTES = 1_500_000;
const REQUEST_TIMEOUT_MS = 12_000;
// This is a read-only interactive review. A broad date range that exceeds two
// pages must be narrowed rather than risking a long-running web request.
const MAX_INTERACTIVE_SCHEDULE_PAGES = 2;
type JsonObject = Record<string, unknown>;

export type JiaowubaoScheduleQuery = {
  start: string;
  end: string;
  over?: 0 | 1;
  calendarType?: 1 | 3;
  hiddenLeave?: -1 | 1;
  timeStart?: number;
  timeEnd?: number;
  appoint?: -1 | 0 | 1;
  week?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  order?: "asc" | "desc";
};

export type JiaowubaoScheduleTeacher = {
  role: "授课老师" | "助教" | "第三老师";
  teacherId: string | null;
  teacherName: string | null;
  hours: number | null;
};

export type JiaowubaoScheduleLesson = {
  calendarId: string;
  dated: string;
  timeStart: string | null;
  timeEnd: string | null;
  classType: number | null;
  completed: boolean;
  overState: number | null;
  classId: string | null;
  className: string | null;
  courseId: string | null;
  courseName: string | null;
  roomId: string | null;
  roomName: string | null;
  appointment: boolean | null;
  overTime: string | null;
  durationMinutes: number | null;
  lessonHours: number | null;
  memberCount: number | null;
  signedCount: number | null;
  notSignedCount: number | null;
  arrivedCount: number | null;
  leaveCount: number | null;
  arrivalPercent: string | null;
  notCommentedCount: number | null;
  consumedHours: number | null;
  scheduledHours: number | null;
  unconsumedHours: number | null;
  amount: number | null;
  trialArrivalCount: number | null;
  allLeave: boolean | null;
  studentDetailPolicy: "aggregate-only";
  teachers: JiaowubaoScheduleTeacher[];
};

export type JiaowubaoScheduleSummary = {
  lessons: number;
  completedLessons: number;
  pendingLessons: number;
  members: number;
  signedMembers: number;
  arrivedMembers: number;
  leaveMembers: number;
  consumedHours: number;
  scheduledHours: number;
  allLeaveLessons: number;
};

export class JiaowubaoScheduleApiError extends Error {
  readonly code: "configuration" | "upstream" | "protocol";

  constructor(message: string, code: "configuration" | "upstream" | "protocol") {
    super(message);
    this.name = "JiaowubaoScheduleApiError";
    this.code = code;
  }
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredGatewaySk() {
  const value = configuredJiaowubaoGatewaySk();
  if (!value) throw new JiaowubaoScheduleApiError("缺少 JIAOWUBAO_GATEWAY_SK（或旧变量 JIAOWUBAO_OPEN_API_SK）环境变量。", "configuration");
  return value;
}

function endpointUrl() {
  const value = process.env.JIAOWUBAO_GATEWAY_URL?.trim() || JIAOWUBAO_GATEWAY_DEFAULT_URL;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || [...url.searchParams.keys()].length) throw new Error("invalid_url");
    return value;
  } catch {
    throw new JiaowubaoScheduleApiError("JIAOWUBAO_GATEWAY_URL 必须是没有查询参数的 HTTPS URL。", "configuration");
  }
}

function validDate(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new JiaowubaoScheduleApiError(label + " 必须采用 YYYY-MM-DD 格式。", "configuration");
  }
  const parsed = new Date(value + "T00:00:00.000Z");
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new JiaowubaoScheduleApiError(label + " 不是有效日期。", "configuration");
  }
  return parsed;
}

function optionalChoice<T extends number>(value: T | undefined, label: string, choices: readonly T[]) {
  if (value === undefined) return undefined;
  if (!choices.includes(value)) throw new JiaowubaoScheduleApiError(label + " 参数不在文档允许范围内。", "configuration");
  return value;
}

function optionalTime(value: number | undefined, label: string) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 2359 || value % 100 > 59) {
    throw new JiaowubaoScheduleApiError(label + " 必须是类似 930 或 1730 的有效整数时间。", "configuration");
  }
  return value;
}

function requestParams(query: JiaowubaoScheduleQuery) {
  const start = validDate(query.start, "start");
  const end = validDate(query.end, "end");
  const rangeDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (rangeDays < 1 || rangeDays > 31) {
    throw new JiaowubaoScheduleApiError("排课查询日期范围最多 31 天，请缩小范围后再试。", "configuration");
  }
  const over = optionalChoice(query.over, "over", [0, 1] as const);
  const calType = optionalChoice(query.calendarType, "cal_type", [1, 3] as const);
  const hiddenLeave = optionalChoice(query.hiddenLeave, "hidden_leave", [-1, 1] as const);
  const appoint = optionalChoice(query.appoint, "appoint", [-1, 0, 1] as const);
  const week = optionalChoice(query.week, "week", [0, 1, 2, 3, 4, 5, 6] as const);
  const timeStart = optionalTime(query.timeStart, "time_start");
  const timeEnd = optionalTime(query.timeEnd, "time_end");
  if (timeStart !== undefined && timeEnd !== undefined && timeStart > timeEnd) {
    throw new JiaowubaoScheduleApiError("time_start 不能晚于 time_end。", "configuration");
  }
  if (query.order !== undefined && query.order !== "asc" && query.order !== "desc") {
    throw new JiaowubaoScheduleApiError("order 只能是 asc 或 desc。", "configuration");
  }
  return {
    start: query.start,
    end: query.end,
    page: 1,
    limit: JIAOWUBAO_GATEWAY_PAGE_LIMIT,
    ...(over === undefined ? {} : { over }),
    ...(calType === undefined ? {} : { cal_type: calType }),
    ...(hiddenLeave === undefined ? {} : { hidden_leave: hiddenLeave }),
    ...(timeStart === undefined ? {} : { time_start: timeStart }),
    ...(timeEnd === undefined ? {} : { time_end: timeEnd }),
    ...(appoint === undefined ? {} : { appoint }),
    ...(week === undefined ? {} : { week }),
    ...(query.order === undefined ? {} : { order: query.order }),
  };
}

function responseRows(payload: unknown): JsonObject[] {
  if (!isObject(payload)) throw new JiaowubaoScheduleApiError("教务宝排课列表返回格式不是对象。", "protocol");
  if (String(payload.ret) !== "1") {
    const detail = typeof payload.err_msg === "string" ? payload.err_msg.trim() : "";
    throw new JiaowubaoScheduleApiError(
      detail ? "教务宝网关拒绝 query_schedule_list：" + detail : "教务宝网关未确认 query_schedule_list 成功。",
      "protocol",
    );
  }
  const data = isObject(payload.data) ? payload.data : null;
  if (!Array.isArray(data?.lists)) {
    throw new JiaowubaoScheduleApiError("教务宝网关成功响应中没有 data.lists 排课数组。", "protocol");
  }
  if (!data.lists.every(isObject)) {
    throw new JiaowubaoScheduleApiError("教务宝排课列表中存在非对象记录。", "protocol");
  }
  return data.lists;
}

function optionalId(value: unknown) {
  const raw = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!/^\d+$/.test(raw)) return null;
  const normalized = raw.replace(/^0+(?=\d)/, "");
  return normalized === "0" ? null : normalized;
}

function requiredId(value: unknown, label: string) {
  const result = optionalId(value);
  if (!result) throw new JiaowubaoScheduleApiError("教务宝排课记录缺少有效 " + label + "。", "protocol");
  return result;
}

function optionalText(value: unknown) {
  const result = typeof value === "string" ? value.trim() : "";
  return result || null;
}

function optionalTimeText(value: unknown) {
  const result = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return result || null;
}

function validRecordDate(value: string) {
  try {
    validDate(value, "教务宝 dated");
  } catch {
    throw new JiaowubaoScheduleApiError("教务宝排课记录的 dated 不是有效日期。", "protocol");
  }
}

function optionalNonNegativeNumber(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) {
    throw new JiaowubaoScheduleApiError("教务宝排课记录的 " + label + " 不是非负数字。", "protocol");
  }
  return result;
}

function optionalBinary(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  const result = Number(value);
  if (result !== 0 && result !== 1) {
    throw new JiaowubaoScheduleApiError("教务宝排课记录的 " + label + " 不是 0 或 1。", "protocol");
  }
  return result === 1;
}

function scheduleTeacher(record: JsonObject, role: JiaowubaoScheduleTeacher["role"], idField: string, nameField: string, hoursField: string) {
  return {
    role,
    teacherId: optionalId(record[idField]),
    teacherName: optionalText(record[nameField]),
    hours: optionalNonNegativeNumber(record[hoursField], hoursField),
  };
}

function scheduleLesson(record: JsonObject): JiaowubaoScheduleLesson {
  const dated = optionalText(record.dated);
  if (!dated) throw new JiaowubaoScheduleApiError("教务宝排课记录缺少 dated。", "protocol");
  validRecordDate(dated);
  const completed = optionalBinary(record.over, "over");
  if (completed === null) throw new JiaowubaoScheduleApiError("教务宝排课记录缺少 over。", "protocol");
  const classType = optionalNonNegativeNumber(record.type, "type");
  return {
    calendarId: requiredId(record.cal_id, "cal_id"),
    dated,
    timeStart: optionalTimeText(record.time_start),
    timeEnd: optionalTimeText(record.time_end),
    classType,
    completed,
    overState: optionalNonNegativeNumber(record.over_state, "over_state"),
    classId: optionalId(record.team_id),
    className: optionalText(record.team_title),
    courseId: optionalId(record.course_id),
    courseName: optionalText(record.course_title),
    roomId: optionalId(record.room_id),
    roomName: optionalText(record.room_title),
    appointment: optionalBinary(record.appoint, "appoint"),
    overTime: optionalText(record.over_time),
    durationMinutes: optionalNonNegativeNumber(record.cal_length, "cal_length"),
    lessonHours: optionalNonNegativeNumber(record.hours, "hours"),
    memberCount: optionalNonNegativeNumber(record.mem_num, "mem_num"),
    signedCount: optionalNonNegativeNumber(record.mem_num_sign, "mem_num_sign"),
    notSignedCount: optionalNonNegativeNumber(record.mem_num_not_sign, "mem_num_not_sign"),
    arrivedCount: optionalNonNegativeNumber(record.mem_arrive, "mem_arrive"),
    leaveCount: optionalNonNegativeNumber(record.mem_leave ?? record.mem_num_leave, "mem_leave"),
    arrivalPercent: optionalText(record.arrive_percent),
    notCommentedCount: optionalNonNegativeNumber(record.mem_not_comment, "mem_not_comment"),
    consumedHours: optionalNonNegativeNumber(record.ks_num ?? record.ks_mem, "ks_num"),
    scheduledHours: optionalNonNegativeNumber(record.ks_reception, "ks_reception"),
    unconsumedHours: optionalNonNegativeNumber(record.ks_not, "ks_not"),
    amount: optionalNonNegativeNumber(record.price_mem, "price_mem"),
    trialArrivalCount: optionalNonNegativeNumber(record.try_arrive, "try_arrive"),
    allLeave: optionalBinary(record.all_leave, "all_leave"),
    // data.lists.stu_list is incomplete for group lessons. Do not surface it
    // or join it to our mutable Booking/Student records.
    studentDetailPolicy: "aggregate-only",
    teachers: [
      scheduleTeacher(record, "授课老师", "teacher_id", "teacher_title", "teacher_hour"),
      scheduleTeacher(record, "助教", "teacher_s", "teacher_s_title", "teacher_s_hour"),
      scheduleTeacher(record, "第三老师", "teacher_t", "teacher_t_title", "teacher_t_hour"),
    ].filter((teacher) => teacher.teacherId || teacher.teacherName || (teacher.hours !== null && teacher.hours > 0)),
  };
}

function scheduleSummary(lessons: JiaowubaoScheduleLesson[]): JiaowubaoScheduleSummary {
  return lessons.reduce<JiaowubaoScheduleSummary>((summary, lesson) => ({
    lessons: summary.lessons + 1,
    completedLessons: summary.completedLessons + (lesson.completed ? 1 : 0),
    pendingLessons: summary.pendingLessons + (lesson.completed ? 0 : 1),
    members: summary.members + (lesson.memberCount ?? 0),
    signedMembers: summary.signedMembers + (lesson.signedCount ?? 0),
    arrivedMembers: summary.arrivedMembers + (lesson.arrivedCount ?? 0),
    leaveMembers: summary.leaveMembers + (lesson.leaveCount ?? 0),
    consumedHours: summary.consumedHours + (lesson.consumedHours ?? 0),
    scheduledHours: summary.scheduledHours + (lesson.scheduledHours ?? 0),
    allLeaveLessons: summary.allLeaveLessons + (lesson.allLeave ? 1 : 0),
  }), {
    lessons: 0,
    completedLessons: 0,
    pendingLessons: 0,
    members: 0,
    signedMembers: 0,
    arrivedMembers: 0,
    leaveMembers: 0,
    consumedHours: 0,
    scheduledHours: 0,
    allLeaveLessons: 0,
  });
}

function normalizeScheduleRecords(records: JsonObject[]) {
  const lessons = records.map(scheduleLesson);
  return { lessons, summary: scheduleSummary(lessons) };
}

/**
 * Pure normalization boundary for the documented schedule response. It never
 * returns stu_list because that field is incomplete for group lessons.
 */
export function normalizeJiaowubaoScheduleResponse(payload: unknown) {
  return normalizeScheduleRecords(responseRows(payload));
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new JiaowubaoScheduleApiError("教务宝排课列表返回内容超过安全大小限制。", "protocol");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new JiaowubaoScheduleApiError("教务宝排课列表返回内容超过安全大小限制。", "protocol");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new JiaowubaoScheduleApiError("教务宝没有返回可读取的 JSON 排课列表。", "protocol");
  }
}

function upstreamError(status: number) {
  if (status === 401) return "JIAOWUBAO_GATEWAY_SK 无效或已禁用。";
  if (status === 403) return "当前 JIAOWUBAO_GATEWAY_SK 没有 query_schedule_list 授权。";
  if (status === 429) return "教务宝网关已触发 20 次/分钟限流；排课查询未生成任何部分结果，请稍后重试。";
  return "教务宝排课查询失败。";
}

async function requestPage(url: string, sk: string, params: JsonObject) {
  await waitForJiaowubaoGatewayRateLimit();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(documentedGatewayScheduleRequest(sk, params)),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new JiaowubaoScheduleApiError(upstreamError(response.status), "upstream");
    }
    return responseRows(await readLimitedJson(response));
  } catch (error) {
    if (error instanceof JiaowubaoScheduleApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new JiaowubaoScheduleApiError("教务宝排课查询超时。", "upstream");
    }
    throw new JiaowubaoScheduleApiError("无法连接教务宝排课接口。", "upstream");
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJiaowubaoSchedule(query: JiaowubaoScheduleQuery) {
  const sk = requiredGatewaySk();
  const url = endpointUrl();
  const baseParams = requestParams(query);
  const result = await collectPagesUntilEmpty({
    maxPages: MAX_INTERACTIVE_SCHEDULE_PAGES,
    requestPage: (page) => requestPage(url, sk, { ...baseParams, page }),
    recordKey: (record) => requiredId(record.cal_id, "cal_id"),
    protocolError: (message) => new JiaowubaoScheduleApiError(
      message.includes("超过安全上限")
        ? "排课查询结果超过 200 节；请缩小日期范围或加入筛选后再试，系统没有返回部分结果。"
        : message,
      "protocol",
    ),
  });
  const normalized = normalizeScheduleRecords(result.rows);
  const lessons = normalized.lessons;
  if (lessons.some((lesson) => lesson.dated < query.start || lesson.dated > query.end)) {
    throw new JiaowubaoScheduleApiError("教务宝返回了查询日期范围外的排课记录，已停止避免混入本次核对。", "protocol");
  }
  return { pages: result.pages, ...normalized };
}
