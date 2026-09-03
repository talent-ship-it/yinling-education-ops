import "server-only";

import {
  documentedGatewayLessonRequest,
  JIAOWUBAO_GATEWAY_DEFAULT_URL,
  JIAOWUBAO_GATEWAY_MAX_429_RETRIES,
  JIAOWUBAO_GATEWAY_PAGE_LIMIT,
  JIAOWUBAO_GATEWAY_REQUEST_GAP_MS,
  jiaowubaoGateway429BackoffMs,
  waitForJiaowubaoGateway429Backoff,
  waitForJiaowubaoGatewayRateLimit,
} from "@/lib/jiaowubao/gateway-contract";
import { parseMonthlyPeriod } from "@/lib/jiaowubao/monthly-payroll";
import { collectPagesUntilEmpty } from "@/lib/jiaowubao/pagination";

const MAX_RESPONSE_BYTES = 1_500_000;
const REQUEST_TIMEOUT_MS = 12_000;
const DIRECT_REQUEST_GAP_MS = 1_000;
// This integration always produces a complete month, never a scoped report.
// `mem_id`, `course_id`, and `team_id` are documented list filters, so they
// must be rejected alongside the pagination/date fields wherever they appear.
const FULL_MONTH_PROTECTED_FIELDS = ["start", "end", "sign", "page", "limit", "over", "mem_id", "course_id", "team_id"] as const;

type JsonObject = Record<string, unknown>;
type RequestMethod = "GET" | "POST";

export class JiaowubaoLessonApiError extends Error {
  readonly code: "configuration" | "upstream" | "protocol";

  constructor(message: string, code: "configuration" | "upstream" | "protocol") {
    super(message);
    this.name = "JiaowubaoLessonApiError";
    this.code = code;
  }
}

type LessonListConfig = {
  mode: "gateway" | "direct";
  url: string;
  method: RequestMethod;
  authHeader: string | null;
  authValue: string | null;
  extraParams: JsonObject;
  paramsKey: string | null;
  pageSize: number;
  maxPages: number;
  successPath: string | null;
  successValue: string | null;
  requestGapMs: number;
  gatewaySk: string | null;
};

let latestDirectRequestAt = 0;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: string | undefined, fallback: number, ceiling: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, ceiling);
}

function readExtraParams(value: string | undefined): JsonObject {
  if (!value?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isObject(parsed)) throw new Error("not_object");
    return parsed;
  } catch {
    throw new JiaowubaoLessonApiError("教务宝额外请求参数不是有效 JSON 对象。", "configuration");
  }
}

function requireConfig(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) throw new JiaowubaoLessonApiError(`缺少 ${name} 环境变量。`, "configuration");
  return result;
}

function readSuccessAssertion(environment: NodeJS.ProcessEnv) {
  const path = environment.JIAOWUBAO_LESSON_LIST_SUCCESS_PATH?.trim() || null;
  const value = environment.JIAOWUBAO_LESSON_LIST_SUCCESS_VALUE?.trim() || null;
  if ((path && !value) || (!path && value)) {
    throw new JiaowubaoLessonApiError("教务宝成功响应字段和成功值必须同时配置，或同时留空。", "configuration");
  }
  if (path && !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path)) {
    throw new JiaowubaoLessonApiError("JIAOWUBAO_LESSON_LIST_SUCCESS_PATH 只能是点分隔的字段路径。", "configuration");
  }
  if (environment.NODE_ENV === "production" && !path) {
    throw new JiaowubaoLessonApiError("生产环境必须配置教务宝成功响应字段和值，避免把 200 错误响应误导出为空表。", "configuration");
  }
  return { path, value };
}

function validatedEndpointUrl(value: string, name: string, environment: NodeJS.ProcessEnv, requireHttps = false): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("unsupported_protocol");
    if ((environment.NODE_ENV === "production" || requireHttps) && parsed.protocol !== "https:") throw new Error("insecure_protocol");
    if ([...parsed.searchParams.keys()].length) throw new Error("protected_query_parameter");
    return value;
  } catch {
    throw new JiaowubaoLessonApiError(`${name} 必须是有效的 HTTPS URL，且不能预置查询参数。`, "configuration");
  }
}

function gatewayLessonListConfig(environment: NodeJS.ProcessEnv): LessonListConfig | null {
  const sk = environment.JIAOWUBAO_GATEWAY_SK?.trim();
  if (!sk) return null;
  const url = validatedEndpointUrl(environment.JIAOWUBAO_GATEWAY_URL?.trim() || JIAOWUBAO_GATEWAY_DEFAULT_URL, "JIAOWUBAO_GATEWAY_URL", environment, true);
  return {
    mode: "gateway",
    url,
    method: "POST",
    authHeader: null,
    authValue: null,
    extraParams: {},
    paramsKey: null,
    pageSize: JIAOWUBAO_GATEWAY_PAGE_LIMIT,
    maxPages: positiveInteger(environment.JIAOWUBAO_LESSON_LIST_MAX_PAGES, 100, 500),
    successPath: "ret",
    successValue: "1",
    requestGapMs: JIAOWUBAO_GATEWAY_REQUEST_GAP_MS,
    gatewaySk: sk,
  };
}

function lessonListConfig(environment = process.env): LessonListConfig {
  const gateway = gatewayLessonListConfig(environment);
  if (gateway) return gateway;

  const url = validatedEndpointUrl(requireConfig(environment.JIAOWUBAO_LESSON_LIST_URL, "JIAOWUBAO_LESSON_LIST_URL"), "JIAOWUBAO_LESSON_LIST_URL", environment);

  const method = (environment.JIAOWUBAO_LESSON_LIST_METHOD ?? "").trim().toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new JiaowubaoLessonApiError("JIAOWUBAO_LESSON_LIST_METHOD 必须明确设为 GET 或 POST。", "configuration");
  }

  const header = environment.JIAOWUBAO_LESSON_LIST_AUTH_HEADER?.trim() || null;
  const authValue = environment.JIAOWUBAO_LESSON_LIST_AUTH_VALUE?.trim() || null;
  if ((header && !authValue) || (!header && authValue)) {
    throw new JiaowubaoLessonApiError("教务宝授权请求头名称和值必须同时配置，或同时留空。", "configuration");
  }
  if (header && !/^[A-Za-z0-9-]+$/.test(header)) {
    throw new JiaowubaoLessonApiError("教务宝授权请求头名称不合法。", "configuration");
  }

  const paramsKey = environment.JIAOWUBAO_LESSON_LIST_PARAMS_KEY?.trim() || null;
  if (paramsKey && !/^[A-Za-z0-9_]+$/.test(paramsKey)) {
    throw new JiaowubaoLessonApiError("JIAOWUBAO_LESSON_LIST_PARAMS_KEY 不合法。", "configuration");
  }
  if (method === "GET" && paramsKey) {
    throw new JiaowubaoLessonApiError("GET 调用不支持 JIAOWUBAO_LESSON_LIST_PARAMS_KEY 包装。", "configuration");
  }
  const successAssertion = readSuccessAssertion(environment);

  return {
    mode: "direct",
    url,
    method,
    authHeader: header,
    authValue,
    extraParams: readExtraParams(environment.JIAOWUBAO_LESSON_LIST_EXTRA_PARAMS_JSON),
    paramsKey,
    pageSize: positiveInteger(environment.JIAOWUBAO_LESSON_LIST_PAGE_SIZE, 200, 500),
    maxPages: positiveInteger(environment.JIAOWUBAO_LESSON_LIST_MAX_PAGES, 100, 500),
    successPath: successAssertion.path,
    successValue: successAssertion.value,
    requestGapMs: DIRECT_REQUEST_GAP_MS,
    gatewaySk: null,
  };
}

function assertFullMonthExtraParams(params: unknown, path = "") {
  const protectedKeys = new Set<string>(FULL_MONTH_PROTECTED_FIELDS);
  if (Array.isArray(params)) {
    params.forEach((value, index) => assertFullMonthExtraParams(value, `${path}[${index}]`));
    return;
  }
  if (!isObject(params)) return;
  for (const [key, value] of Object.entries(params)) {
    const keyPath = path ? `${path}.${key}` : key;
    if (protectedKeys.has(key.toLowerCase())) {
      throw new JiaowubaoLessonApiError(`额外请求参数不能加入会让完整月报变成局部数据的字段 ${keyPath}。`, "configuration");
    }
    assertFullMonthExtraParams(value, keyPath);
  }
}

function safeExtraParams(params: JsonObject): JsonObject {
  assertFullMonthExtraParams(params);
  return params;
}

async function waitForRateLimit(requestGapMs: number, isGateway: boolean) {
  if (isGateway) {
    await waitForJiaowubaoGatewayRateLimit();
    return;
  }
  const delay = Math.max(0, latestDirectRequestAt + requestGapMs - Date.now());
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  latestDirectRequestAt = Date.now();
}

function stringifyParameter(value: unknown, name: string): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  throw new JiaowubaoLessonApiError(`额外请求参数 ${name} 只能是字符串、数字或布尔值。`, "configuration");
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new JiaowubaoLessonApiError("教务宝返回内容超过安全大小限制。", "protocol");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new JiaowubaoLessonApiError("教务宝返回内容超过安全大小限制。", "protocol");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new JiaowubaoLessonApiError("教务宝没有返回可读取的 JSON 课节列表。", "protocol");
  }
}

function fieldAtPath(payload: JsonObject, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => isObject(value) ? value[key] : undefined, payload);
}

function gatewayErrorMessage(payload: JsonObject) {
  const detail = typeof payload.err_msg === "string" ? payload.err_msg.trim() : "";
  return detail
    ? `教务宝网关拒绝 query_lesson_list：${detail}`
    : "教务宝网关未确认 query_lesson_list 成功，已停止导出以避免生成空表。";
}

function responseList(payload: unknown, config: Pick<LessonListConfig, "mode" | "successPath" | "successValue">): { rows: JsonObject[] } {
  if (!isObject(payload)) throw new JiaowubaoLessonApiError("教务宝返回格式不是对象。", "protocol");

  if (config.successPath && String(fieldAtPath(payload, config.successPath)) !== config.successValue) {
    throw new JiaowubaoLessonApiError(config.mode === "gateway" ? gatewayErrorMessage(payload) : "教务宝响应未满足已配置的成功条件，已停止导出以避免生成空表。", "protocol");
  }

  const data = isObject(payload.data) ? payload.data : null;
  if (config.mode === "gateway") {
    if (Array.isArray(data?.lists)) {
      throw new JiaowubaoLessonApiError("当前网关返回的是 query_schedule_list 课节汇总，不含多人课的完整学生明细；不能生成完整版。请为该 sk 授权 query_lesson_list。", "protocol");
    }
    if (!Array.isArray(data?.list)) {
      throw new JiaowubaoLessonApiError("教务宝网关成功响应中没有 data.list 逐学生课时数组，已停止导出以避免漏学生。", "protocol");
    }
    if (!data.list.every(isObject)) throw new JiaowubaoLessonApiError("教务宝网关课时列表中存在非对象记录。", "protocol");
    return { rows: data.list };
  }

  const candidates = [payload.list, payload.rows, payload.lists, data?.list, data?.rows, data?.lists];
  const list = candidates.find((value): value is unknown[] => Array.isArray(value));
  if (!list) throw new JiaowubaoLessonApiError("教务宝返回中没有 list 课节数组。", "protocol");
  if (!list.every(isObject)) throw new JiaowubaoLessonApiError("教务宝课节列表中存在非对象记录。", "protocol");

  // The supplied tool document does not define a total/has_more envelope. Do
  // not infer completion from undocumented fields: a gateway can cap pages or
  // use a total with a different meaning. We deliberately stop only on an
  // empty page below.
  return { rows: list };
}

function recordKey(record: JsonObject): string {
  const id = (value: unknown) => {
    const raw = typeof value === "string" || typeof value === "number" ? String(value) : "";
    return /^\d+$/.test(raw) ? raw.replace(/^0+(?=\d)/, "") : raw;
  };
  const branch = id(record.branch_id) || "unknown";
  const cal = id(record.cal_id);
  const member = id(record.mem_id);
  if (!cal || !member) throw new JiaowubaoLessonApiError("教务宝返回的课节缺少 cal_id 或 mem_id。", "protocol");
  return `${branch}:${cal}:${member}`;
}

function gatewayHttpError(status: number) {
  if (status === 401) return "JIAOWUBAO_GATEWAY_SK 无效或已禁用。";
  if (status === 403) return "当前 JIAOWUBAO_GATEWAY_SK 没有 query_lesson_list 授权；不能用 query_schedule_list 替代完整学生明细。";
  if (status === 429) return "教务宝网关已触发 20 次/分钟限流；本次导出已停止，稍后重试。";
  return "教务宝网关课节查询失败。";
}

function canRetryGateway429() {
  // An interactive route should return the precise rate-limit error promptly;
  // a 61+ second sleep often exceeds a browser host's request deadline. The
  // single GitHub Actions export explicitly opts in to bounded retries.
  return process.env.JIAOWUBAO_GATEWAY_RETRY_429?.trim() === "true";
}

async function requestPage(config: LessonListConfig, params: JsonObject): Promise<{ rows: JsonObject[] }> {
  const headers = new Headers({ Accept: "application/json" });
  if (config.authHeader && config.authValue) headers.set(config.authHeader, config.authValue);
  const directBodyParams = config.mode === "direct" ? { ...safeExtraParams(config.extraParams), ...params } : null;
  let url = config.url;
  let body: string | undefined;
  if (config.method === "GET") {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(directBodyParams ?? params)) query.set(key, stringifyParameter(value, key));
    url = `${url}?${query.toString()}`;
  } else {
    headers.set("Content-Type", "application/json");
    body = config.mode === "gateway"
      ? JSON.stringify(documentedGatewayLessonRequest(config.gatewaySk as string, params))
      : JSON.stringify(config.paramsKey ? { ...config.extraParams, [config.paramsKey]: params } : directBodyParams);
  }

  for (let retryAttempt = 0; ; retryAttempt += 1) {
    await waitForRateLimit(config.requestGapMs, config.mode === "gateway");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: config.method,
        headers,
        body,
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        if (config.mode === "gateway" && response.status === 429 && canRetryGateway429() && retryAttempt < JIAOWUBAO_GATEWAY_MAX_429_RETRIES) {
          const delay = jiaowubaoGateway429BackoffMs(response.headers.get("retry-after"), retryAttempt);
          await response.body?.cancel().catch(() => undefined);
          await waitForJiaowubaoGateway429Backoff(delay);
          continue;
        }
        await response.body?.cancel().catch(() => undefined);
        throw new JiaowubaoLessonApiError(config.mode === "gateway" ? gatewayHttpError(response.status) : "教务宝课节查询失败。", "upstream");
      }
      const payload = await readLimitedJson(response);
      return responseList(payload, config);
    } catch (error) {
      if (error instanceof JiaowubaoLessonApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new JiaowubaoLessonApiError("教务宝课节查询超时。", "upstream");
      }
      throw new JiaowubaoLessonApiError("无法连接教务宝课节接口。", "upstream");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function fetchCompletedLessons(periodValue: string): Promise<{ lessons: JsonObject[]; pages: number }> {
  const period = parseMonthlyPeriod(periodValue);
  const config = lessonListConfig();
  const result = await collectPagesUntilEmpty({
    maxPages: config.maxPages,
    requestPage: async (page) => {
      const response = await requestPage(config, {
        start: period.start,
        end: period.end,
        sign: -1,
        over: 1,
        page,
        limit: config.pageSize,
      });
      for (const row of response.rows) {
        if (Number(row.over) !== 1) throw new JiaowubaoLessonApiError("教务宝返回了未结课记录，已停止导入。", "protocol");
      }
      return response.rows;
    },
    recordKey,
    protocolError: (message) => new JiaowubaoLessonApiError(message, "protocol"),
  });
  return { lessons: result.rows, pages: result.pages };
}
