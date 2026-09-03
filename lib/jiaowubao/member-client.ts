import "server-only";

import {
  documentedGatewayMemberRequest,
  JIAOWUBAO_GATEWAY_DEFAULT_URL,
  JIAOWUBAO_GATEWAY_PAGE_LIMIT,
  waitForJiaowubaoGatewayRateLimit,
} from "@/lib/jiaowubao/gateway-contract";
import { collectPagesUntilEmpty } from "@/lib/jiaowubao/pagination";

const MAX_RESPONSE_BYTES = 1_500_000;
const REQUEST_TIMEOUT_MS = 12_000;
// This is an on-demand directory lookup, not a background data migration.
// Requiring filters plus two data pages keeps it well within an interactive
// request budget and asks the operator to refine overly broad searches.
export const JIAOWUBAO_MEMBER_QUERY_MAX_PAGES = 2;
type JsonObject = Record<string, unknown>;

export type JiaowubaoMemberQuery = {
  teacherId?: string | number;
  teamId?: string | number;
  keyword?: string;
};

export type JiaowubaoMember = {
  memberId: string;
  memberName: string | null;
  teacherId: string | null;
  teamId: string | null;
};

export type JiaowubaoMemberQueryOptions = {
  maxPages?: number;
};

export class JiaowubaoMemberApiError extends Error {
  readonly code: "configuration" | "upstream" | "protocol";

  constructor(message: string, code: "configuration" | "upstream" | "protocol") {
    super(message);
    this.name = "JiaowubaoMemberApiError";
    this.code = code;
  }
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredGatewaySk() {
  const value = process.env.JIAOWUBAO_GATEWAY_SK?.trim();
  if (!value) throw new JiaowubaoMemberApiError("缺少 JIAOWUBAO_GATEWAY_SK 环境变量。", "configuration");
  return value;
}

function endpointUrl() {
  const value = process.env.JIAOWUBAO_GATEWAY_URL?.trim() || JIAOWUBAO_GATEWAY_DEFAULT_URL;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || [...url.searchParams.keys()].length) throw new Error("invalid_url");
    return value;
  } catch {
    throw new JiaowubaoMemberApiError("JIAOWUBAO_GATEWAY_URL 必须是没有查询参数的 HTTPS URL。", "configuration");
  }
}

function optionalPositiveId(value: string | number | undefined, label: string) {
  if (value === undefined || String(value).trim() === "") return undefined;
  const id = String(value).trim();
  if (!/^[1-9]\d*$/.test(id)) {
    throw new JiaowubaoMemberApiError(label + " 必须是正整数。", "configuration");
  }
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId)) {
    throw new JiaowubaoMemberApiError(label + " 超出安全整数范围。", "configuration");
  }
  return numericId;
}

function requestFilters(query: JiaowubaoMemberQuery) {
  const teacherId = optionalPositiveId(query.teacherId, "teacher_id");
  const teamId = optionalPositiveId(query.teamId, "team_id");
  const keyword = query.keyword?.trim();
  if (keyword && keyword.length > 100) {
    throw new JiaowubaoMemberApiError("学员关键词不能超过 100 个字符。", "configuration");
  }
  if (keyword && keyword.length < 2) {
    throw new JiaowubaoMemberApiError("学员关键词至少需要两个字符；也可以改用教师 ID 或班级 ID 查询。", "configuration");
  }
  const filters = {
    ...(teacherId ? { teacher_id: teacherId } : {}),
    ...(teamId ? { team_id: teamId } : {}),
    ...(keyword ? { keyword } : {}),
  };
  if (!Object.keys(filters).length) {
    throw new JiaowubaoMemberApiError("为保护学员资料，请至少填写学员关键词、教师 ID 或班级 ID 后再查询。", "configuration");
  }
  return filters;
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new JiaowubaoMemberApiError("教务宝学员列表返回内容超过安全大小限制。", "protocol");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new JiaowubaoMemberApiError("教务宝学员列表返回内容超过安全大小限制。", "protocol");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new JiaowubaoMemberApiError("教务宝没有返回可读取的 JSON 学员列表。", "protocol");
  }
}

function gatewayError(payload: JsonObject) {
  const detail = typeof payload.err_msg === "string" ? payload.err_msg.trim() : "";
  return detail
    ? "教务宝网关拒绝 query_member_simple_list：" + detail
    : "教务宝网关未确认 query_member_simple_list 成功。";
}

function memberId(value: unknown): string {
  const raw = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  const normalized = /^\d+$/.test(raw) ? raw.replace(/^0+(?=\d)/, "") : "";
  if (!normalized || normalized === "0") {
    throw new JiaowubaoMemberApiError("教务宝学员记录缺少有效 mem_id。", "protocol");
  }
  return normalized;
}

function optionalMemberId(value: unknown) {
  const raw = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!raw || !/^\d+$/.test(raw)) return null;
  const normalized = raw.replace(/^0+(?=\d)/, "");
  return normalized === "0" ? null : normalized;
}

function memberName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";
  return name || null;
}

function responseRows(payload: unknown): JsonObject[] {
  if (!isObject(payload)) throw new JiaowubaoMemberApiError("教务宝学员列表返回格式不是对象。", "protocol");
  if (String(payload.ret) !== "1") throw new JiaowubaoMemberApiError(gatewayError(payload), "protocol");
  const data = isObject(payload.data) ? payload.data : null;
  if (!Array.isArray(data?.list)) {
    throw new JiaowubaoMemberApiError("教务宝网关成功响应中没有 data.list 学员数组。", "protocol");
  }
  if (!data.list.every(isObject)) {
    throw new JiaowubaoMemberApiError("教务宝学员列表中存在非对象记录。", "protocol");
  }
  return data.list;
}

function upstreamError(status: number) {
  if (status === 401) return "JIAOWUBAO_GATEWAY_SK 无效或已禁用。";
  if (status === 403) return "当前 JIAOWUBAO_GATEWAY_SK 没有 query_member_simple_list 授权。";
  if (status === 429) return "教务宝网关已触发 20 次/分钟限流；本次学员同步已停止。";
  return "教务宝学员列表查询失败。";
}

async function requestPage(url: string, sk: string, params: JsonObject) {
  const body = JSON.stringify(documentedGatewayMemberRequest(sk, params));
  await waitForJiaowubaoGatewayRateLimit();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new JiaowubaoMemberApiError(upstreamError(response.status), "upstream");
    }
    return responseRows(await readLimitedJson(response));
  } catch (error) {
    if (error instanceof JiaowubaoMemberApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new JiaowubaoMemberApiError("教务宝学员列表查询超时。", "upstream");
    }
    throw new JiaowubaoMemberApiError("无法连接教务宝学员列表接口。", "upstream");
  } finally {
    clearTimeout(timeout);
  }
}

function safeMaxPages(value: number | undefined) {
  if (value === undefined) return JIAOWUBAO_MEMBER_QUERY_MAX_PAGES;
  if (!Number.isInteger(value) || value < 1 || value > JIAOWUBAO_MEMBER_QUERY_MAX_PAGES) {
    throw new JiaowubaoMemberApiError("学员查询最多读取两页；结果过多时请缩小关键词、教师 ID 或班级 ID。", "configuration");
  }
  return value;
}

export function prepareJiaowubaoMemberQuery(query: JiaowubaoMemberQuery = {}, options: JiaowubaoMemberQueryOptions = {}) {
  return { filters: requestFilters(query), maxPages: safeMaxPages(options.maxPages) };
}

export async function fetchJiaowubaoMembers(
  query: JiaowubaoMemberQuery = {},
  options: JiaowubaoMemberQueryOptions = {},
): Promise<{ members: JiaowubaoMember[]; pages: number }> {
  const sk = requiredGatewaySk();
  const url = endpointUrl();
  const { filters, maxPages } = prepareJiaowubaoMemberQuery(query, options);
  const result = await collectPagesUntilEmpty({
    maxPages,
    requestPage: (page) => requestPage(url, sk, { ...filters, page, limit: JIAOWUBAO_GATEWAY_PAGE_LIMIT }),
    recordKey: (record) => memberId(record.mem_id),
    protocolError: (message) => new JiaowubaoMemberApiError(message, "protocol"),
  });
  return {
    pages: result.pages,
    members: result.rows.map((record) => {
      const id = memberId(record.mem_id);
      return {
        memberId: id,
        // The supplied member-tool request sheet does not document its response
        // fields. mem_id is required to keep records distinguishable; optional
        // labels remain null until a real authorized response confirms them.
        memberName: memberName(record.mem_title),
        teacherId: optionalMemberId(record.teacher_id),
        teamId: optionalMemberId(record.team_id ?? record.class_id),
      };
    }),
  };
}
