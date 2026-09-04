import { createHash } from "node:crypto";

/**
 * Server-only connector for the documented Jiaowubao Open API.
 *
 * The vendor document advertises HTTP endpoints as well.  This connector
 * deliberately has no host configuration and never falls back to HTTP: an
 * API secret must only ever travel to the reviewed HTTPS endpoint below.
 */
const JIAOWUBAO_OPEN_API_GATEWAY = "https://cardi.jwbpro.com/open/jwb/gateway";
const JIAOWUBAO_OPEN_API_SECRET_ENV = "JIAOWUBAO_OPEN_API_SK";
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 500;
const MAX_QUERY_WINDOW_DAYS = 31;
const MAX_RESPONSE_BYTES = 1_500_000;
const REQUEST_TIMEOUT_MS = 12_000;
// The supplier's documented ceiling is 20 calls/minute per organisation/tool.
// Leave headroom for manual JWB use and separate server instances.
const MIN_REQUEST_INTERVAL_MS = 3_200;

type JsonRecord = Record<string, unknown>;

export type JiaowubaoScheduleListQuery = Readonly<{
  start: string;
  end: string;
  page?: number;
  limit?: number;
  cal_type?: number;
  hidden_leave?: number;
  time_start?: number;
  time_end?: number;
  appoint?: number;
  week?: number;
  over?: number;
  order?: "asc" | "desc";
}>;

export type JiaowubaoScheduleListResponse = Readonly<{
  lists: readonly JsonRecord[];
  [key: string]: unknown;
}>;

/**
 * The completed-lesson reader deliberately exposes no `over` parameter: the
 * integration is an evidence feed for completed lessons only, so every
 * upstream request is forced to `over: 1` by the server.
 */
export type JiaowubaoCompletedLessonListQuery = Readonly<{
  start: string;
  end: string;
  page?: number;
  limit?: number;
  sign?: -1 | 0 | 1 | 2 | 3 | 4 | 5;
  mem_id?: number;
  course_id?: number;
  team_id?: number;
}>;

export type JiaowubaoCompletedLessonListResponse = Readonly<{
  list: readonly JsonRecord[];
  [key: string]: unknown;
}>;

/** A bounded, server-only member-directory search for reviewed name linking. */
export type JiaowubaoMemberSimpleListQuery = Readonly<{
  page?: number;
  limit?: number;
  keyword?: string;
  teacher_id?: number;
  team_id?: number;
}>;

export type JiaowubaoMemberSimpleListResponse = Readonly<{
  list: readonly JsonRecord[];
  [key: string]: unknown;
}>;

export type JiaowubaoOpenApiErrorCode =
  | "not_configured"
  | "invalid_request"
  | "request_timeout"
  | "rate_limited"
  | "not_authorized"
  | "upstream_unavailable"
  | "invalid_response"
  | "response_oversize"
  | "upstream_rejected";

export type JiaowubaoOpenApiTool =
  | "query_schedule_list"
  | "query_lesson_list"
  | "query_member_simple_list";

/** This error intentionally never contains the endpoint, response body, or sk. */
export class JiaowubaoOpenApiError extends Error {
  constructor(
    readonly code: JiaowubaoOpenApiErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly tool?: JiaowubaoOpenApiTool,
  ) {
    super(message);
    this.name = "JiaowubaoOpenApiError";
  }
}

// The published gateway ceiling is per organisation *and interface*. Keep a
// separate courtesy queue per tool so a fixed monthly schedule+lesson pull can
// finish inside the route budget without making either upstream tool exceed
// its own 20/minute allowance.
const requestStartStates = new Map<JiaowubaoOpenApiTool, { nextRequestStartAt: number; queue: Promise<void> }>();
const inFlightListRequests = new Map<string, Promise<readonly JsonRecord[]>>();

// Keep this module Node-only even when it is invoked from a local CLI. The
// Next.js-facing wrapper additionally imports `server-only` to reject client
// component imports at build time.
void createHash;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactDate(value: unknown, field: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new JiaowubaoOpenApiError("invalid_request", `${field} 必须使用 YYYY-MM-DD。`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new JiaowubaoOpenApiError("invalid_request", `${field} 无效。`);
  }
  return value;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new JiaowubaoOpenApiError("invalid_request", `${field} 无效。`);
  }
  return value as number;
}

function clock(value: unknown, field: string) {
  const compact = boundedInteger(value, field, 0, 2359);
  if (compact % 100 > 59) {
    throw new JiaowubaoOpenApiError("invalid_request", `${field} 无效。`);
  }
  return compact;
}

function optionalValue<T>(value: T | undefined, normalize: (candidate: T) => T) {
  return value === undefined ? undefined : normalize(value);
}

function normalizeScheduleQuery(input: JiaowubaoScheduleListQuery) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new JiaowubaoOpenApiError("invalid_request", "教务宝排课查询无效。");
  }
  const start = exactDate(input.start, "start");
  const end = exactDate(input.end, "end");
  if (end < start) {
    throw new JiaowubaoOpenApiError("invalid_request", "end 必须不早于 start。");
  }
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (endMs - startMs > (MAX_QUERY_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1_000) {
    throw new JiaowubaoOpenApiError("invalid_request", `教务宝排课读取最多跨 ${MAX_QUERY_WINDOW_DAYS} 天。`);
  }
  const page = input.page === undefined ? 1 : boundedInteger(input.page, "page", 1, MAX_PAGE);
  const limit = input.limit === undefined ? MAX_PAGE_SIZE : boundedInteger(input.limit, "limit", 1, MAX_PAGE_SIZE);
  const calType = optionalValue(input.cal_type, (value) => {
    if (value !== 1 && value !== 3) throw new JiaowubaoOpenApiError("invalid_request", "cal_type 无效。");
    return value;
  });
  const hiddenLeave = optionalValue(input.hidden_leave, (value) => {
    if (value !== -1 && value !== 1) throw new JiaowubaoOpenApiError("invalid_request", "hidden_leave 无效。");
    return value;
  });
  const timeStart = input.time_start === undefined ? undefined : clock(input.time_start, "time_start");
  const timeEnd = input.time_end === undefined ? undefined : clock(input.time_end, "time_end");
  if (timeStart !== undefined && timeEnd !== undefined && timeEnd < timeStart) {
    throw new JiaowubaoOpenApiError("invalid_request", "time_end 必须不早于 time_start。");
  }
  const appoint = optionalValue(input.appoint, (value) => {
    if (value !== -1 && value !== 0 && value !== 1) throw new JiaowubaoOpenApiError("invalid_request", "appoint 无效。");
    return value;
  });
  const week = optionalValue(input.week, (value) => boundedInteger(value, "week", 0, 6));
  const over = optionalValue(input.over, (value) => {
    if (value !== 0 && value !== 1) throw new JiaowubaoOpenApiError("invalid_request", "over 无效。");
    return value;
  });
  const order = input.order ?? "asc";
  if (order !== "asc" && order !== "desc") {
    throw new JiaowubaoOpenApiError("invalid_request", "order 无效。");
  }
  return Object.freeze({
    start,
    end,
    page,
    limit,
    ...(calType === undefined ? {} : { cal_type: calType }),
    ...(hiddenLeave === undefined ? {} : { hidden_leave: hiddenLeave }),
    ...(timeStart === undefined ? {} : { time_start: timeStart }),
    ...(timeEnd === undefined ? {} : { time_end: timeEnd }),
    ...(appoint === undefined ? {} : { appoint }),
    ...(week === undefined ? {} : { week }),
    ...(over === undefined ? {} : { over }),
    order,
  });
}

function positiveId(value: unknown, field: string) {
  return boundedInteger(value, field, 1, Number.MAX_SAFE_INTEGER);
}

function normalizeCompletedLessonQuery(input: JiaowubaoCompletedLessonListQuery) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new JiaowubaoOpenApiError("invalid_request", "教务宝已消课查询无效。");
  }
  const start = exactDate(input.start, "start");
  const end = exactDate(input.end, "end");
  if (end < start) {
    throw new JiaowubaoOpenApiError("invalid_request", "end 必须不早于 start。");
  }
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (endMs - startMs > (MAX_QUERY_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1_000) {
    throw new JiaowubaoOpenApiError("invalid_request", `教务宝已消课读取最多跨 ${MAX_QUERY_WINDOW_DAYS} 天。`);
  }
  const page = input.page === undefined ? 1 : boundedInteger(input.page, "page", 1, MAX_PAGE);
  const limit = input.limit === undefined ? MAX_PAGE_SIZE : boundedInteger(input.limit, "limit", 1, MAX_PAGE_SIZE);
  const sign = input.sign === undefined ? -1 : input.sign;
  if (!Number.isSafeInteger(sign) || sign < -1 || sign > 5) {
    throw new JiaowubaoOpenApiError("invalid_request", "sign 无效。");
  }
  const memberId = input.mem_id === undefined ? undefined : positiveId(input.mem_id, "mem_id");
  const courseId = input.course_id === undefined ? undefined : positiveId(input.course_id, "course_id");
  const teamId = input.team_id === undefined ? undefined : positiveId(input.team_id, "team_id");
  return Object.freeze({
    start,
    end,
    sign,
    // Never accept a caller-controlled lesson completion state. This feed is
    // the source of evidence behind the monthly report and must remain
    // complete-only even if a future UI accidentally forwards an `over` field.
    over: 1 as const,
    page,
    limit,
    ...(memberId === undefined ? {} : { mem_id: memberId }),
    ...(courseId === undefined ? {} : { course_id: courseId }),
    ...(teamId === undefined ? {} : { team_id: teamId }),
  });
}

function normalizeMemberSimpleQuery(input: JiaowubaoMemberSimpleListQuery) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new JiaowubaoOpenApiError("invalid_request", "教务宝学员查询无效。");
  }
  const page = input.page === undefined ? 1 : boundedInteger(input.page, "page", 1, MAX_PAGE);
  const limit = input.limit === undefined ? MAX_PAGE_SIZE : boundedInteger(input.limit, "limit", 1, MAX_PAGE_SIZE);
  const keyword = input.keyword === undefined ? undefined : input.keyword.trim();
  if (keyword !== undefined && (!keyword || keyword.length > 100 || /[\u0000-\u001f\u007f]/u.test(keyword))) {
    throw new JiaowubaoOpenApiError("invalid_request", "keyword 无效。");
  }
  const teacherId = input.teacher_id === undefined ? undefined : positiveId(input.teacher_id, "teacher_id");
  const teamId = input.team_id === undefined ? undefined : positiveId(input.team_id, "team_id");
  // Directory reads are intentionally not a browser-accessible roster dump.
  // A reviewed exact-name lookup supplies a keyword; staff may instead scope
  // the query to an already-known teacher or class ID.
  if (!keyword && teacherId === undefined && teamId === undefined) {
    throw new JiaowubaoOpenApiError("invalid_request", "学员查询必须限定姓名、老师或班级。");
  }
  return Object.freeze({
    page,
    limit,
    ...(keyword ? { keyword } : {}),
    ...(teacherId === undefined ? {} : { teacher_id: teacherId }),
    ...(teamId === undefined ? {} : { team_id: teamId }),
  });
}

function apiSecret() {
  const secret = process.env[JIAOWUBAO_OPEN_API_SECRET_ENV]?.trim();
  if (!secret || secret.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(secret)) {
    throw new JiaowubaoOpenApiError("not_configured", "教务宝开放 API 尚未安全配置。");
  }
  return secret;
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Per-instance serialisation and coalescing are deliberately only a courtesy
 * layer; the upstream 429 is still handled explicitly because Vercel can run
 * more than one instance. A future high-volume sync must use a durable queue.
 */
async function reserveRequestStart(tool: JiaowubaoOpenApiTool) {
  const state = requestStartStates.get(tool) ?? { nextRequestStartAt: 0, queue: Promise.resolve() };
  requestStartStates.set(tool, state);
  let release: (() => void) | undefined;
  const preceding = state.queue;
  state.queue = new Promise<void>((resolve) => { release = resolve; });
  await preceding;
  try {
    const wait = Math.max(0, state.nextRequestStartAt - Date.now());
    if (wait > 0) await sleep(wait);
    state.nextRequestStartAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
  } finally {
    release?.();
  }
}

function retryAfterSeconds(response: Response) {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw || !/^\d+$/u.test(raw)) return undefined;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 3_600 ? seconds : undefined;
}

async function discard(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // A closed/failed response does not need a second network action.
  }
}

function contentLength(response: Response) {
  const raw = response.headers.get("content-length")?.trim();
  if (!raw) return null;
  if (!/^\d+$/u.test(raw)) throw new JiaowubaoOpenApiError("invalid_response", "教务宝返回无法识别的内容。");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new JiaowubaoOpenApiError("invalid_response", "教务宝返回无法识别的内容。");
  }
  return value;
}

async function readTextWithinLimit(response: Response) {
  let declared: number | null;
  try {
    declared = contentLength(response);
  } catch (error) {
    await discard(response);
    throw error;
  }
  if (declared !== null && declared > MAX_RESPONSE_BYTES) {
    await discard(response);
    throw new JiaowubaoOpenApiError("response_oversize", "教务宝返回的数据过大。", undefined);
  }
  if (!response.body) {
    throw new JiaowubaoOpenApiError("invalid_response", "教务宝返回无法识别的内容。");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new JiaowubaoOpenApiError("response_oversize", "教务宝返回的数据过大。");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

type GatewayListField = "list" | "lists" | "list_or_lists";

function readList(data: JsonRecord, field: GatewayListField, label: string): readonly JsonRecord[] {
  let candidate: unknown;
  if (field === "list") {
    candidate = data.list;
  } else if (field === "lists") {
    candidate = data.lists;
  } else {
    const hasList = Array.isArray(data.list);
    const hasLists = Array.isArray(data.lists);
    // The vendor documentation names this field `list`, while the earlier
    // schedule endpoint returns `lists`.  Accept either representation, but
    // never silently choose one if an upstream response contains both: that
    // ambiguity could turn a non-empty monthly payroll export into an empty
    // one without an observable error.
    if (hasList && hasLists) {
      throw new JiaowubaoOpenApiError("invalid_response", `教务宝返回了冲突的${label}列表。`);
    }
    candidate = hasList ? data.list : data.lists;
  }
  if (!Array.isArray(candidate) || candidate.length > MAX_PAGE_SIZE || candidate.some((item) => !isRecord(item))) {
    throw new JiaowubaoOpenApiError("invalid_response", `教务宝返回无法识别的${label}。`);
  }
  return Object.freeze([...candidate] as JsonRecord[]);
}

async function requestGatewayList(
  tool: JiaowubaoOpenApiTool,
  params: Record<string, unknown>,
  field: GatewayListField,
  label: string,
): Promise<readonly JsonRecord[]> {
  const secret = apiSecret();
  await reserveRequestStart(tool);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    try {
      response = await fetch(JIAOWUBAO_OPEN_API_GATEWAY, {
        method: "POST",
        // The request body contains the server-only sk. Never follow an
        // upstream redirect, because it could send that body to another host.
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({
          sk: secret,
          tool,
          params,
        }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new JiaowubaoOpenApiError("request_timeout", `教务宝${label}请求超时。`);
      }
      throw new JiaowubaoOpenApiError("upstream_unavailable", `教务宝${label}服务暂时不可用。`);
    }

    if (response.status === 429) {
      const retryAfter = retryAfterSeconds(response);
      await discard(response);
      throw new JiaowubaoOpenApiError("rate_limited", `教务宝${label}读取正被限流，请稍后再试。`, retryAfter);
    }
    if (response.status === 401 || response.status === 403) {
      await discard(response);
      throw new JiaowubaoOpenApiError("not_authorized", "教务宝开放 API 授权不可用。");
    }
    if (!response.ok) {
      await discard(response);
      throw new JiaowubaoOpenApiError("upstream_unavailable", `教务宝${label}服务暂时不可用。`);
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(await readTextWithinLimit(response));
    } catch (error) {
      if (controller.signal.aborted) {
        throw new JiaowubaoOpenApiError("request_timeout", `教务宝${label}请求超时。`);
      }
      if (error instanceof JiaowubaoOpenApiError) throw error;
      throw new JiaowubaoOpenApiError("invalid_response", "教务宝返回无法识别的内容。");
    }
    if (!isRecord(envelope)) {
      throw new JiaowubaoOpenApiError("invalid_response", "教务宝返回无法识别的内容。");
    }
    if (envelope.ret !== "1" && envelope.ret !== 1) {
      throw new JiaowubaoOpenApiError(
        "upstream_rejected",
        `教务宝未接受${label}读取请求。`,
        undefined,
        tool,
      );
    }
    if (!isRecord(envelope.data)) {
      throw new JiaowubaoOpenApiError("invalid_response", "教务宝返回无法识别的内容。");
    }
    return readList(envelope.data, field, label);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Reads one bounded page only. This function never writes source data,
 * bookings, students, packages, tasks, or AVA; a separate reviewed import
 * pipeline is required before live data can affect operations.
 */
export async function queryJiaowubaoScheduleList(input: JiaowubaoScheduleListQuery) {
  const params = normalizeScheduleQuery(input);
  const key = `query_schedule_list:${JSON.stringify(params)}`;
  const existing = inFlightListRequests.get(key);
  if (existing) return Object.freeze({ lists: await existing });
  const request = requestGatewayList("query_schedule_list", params, "lists", "排课");
  inFlightListRequests.set(key, request);
  try {
    return Object.freeze({ lists: await request });
  } finally {
    if (inFlightListRequests.get(key) === request) {
      inFlightListRequests.delete(key);
    }
  }
}

/** Reads exactly one page of completed (`over=1`) lesson evidence. */
export async function queryJiaowubaoCompletedLessonList(input: JiaowubaoCompletedLessonListQuery) {
  const params = normalizeCompletedLessonQuery(input);
  const key = `query_lesson_list:${JSON.stringify(params)}`;
  const existing = inFlightListRequests.get(key);
  if (existing) return Object.freeze({ list: await existing });
  const request = requestGatewayList("query_lesson_list", params, "list_or_lists", "已消课");
  inFlightListRequests.set(key, request);
  try {
    return Object.freeze({ list: await request });
  } finally {
    if (inFlightListRequests.get(key) === request) {
      inFlightListRequests.delete(key);
    }
  }
}

/** Reads one bounded, scope-limited page from the member directory. */
export async function queryJiaowubaoMemberSimpleList(input: JiaowubaoMemberSimpleListQuery) {
  const params = normalizeMemberSimpleQuery(input);
  const key = `query_member_simple_list:${JSON.stringify(params)}`;
  const existing = inFlightListRequests.get(key);
  if (existing) return Object.freeze({ list: await existing });
  const request = requestGatewayList("query_member_simple_list", params, "list", "学员目录");
  inFlightListRequests.set(key, request);
  try {
    return Object.freeze({ list: await request });
  } finally {
    if (inFlightListRequests.get(key) === request) {
      inFlightListRequests.delete(key);
    }
  }
}
