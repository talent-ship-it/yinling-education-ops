import {
  JiaowubaoOpenApiError,
  type JiaowubaoScheduleListQuery,
  type JiaowubaoScheduleListResponse,
  type JiaowubaoScheduleRequestOptions,
} from "./jiaowubao-open-api-node";

const MCP_URL = "https://card.jwbpro.com/open/jwb/mcp";
const MAX_RESPONSE_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 12_000;
type JsonRecord = Record<string, unknown>;
type ReaderConfig = Readonly<{ token: string; fetchImpl?: typeof fetch; expectedBranchId?: string; expectedBranchTitle?: string }>;

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new JiaowubaoOpenApiError("invalid_response", "教务宝 MCP 返回无效内容。");
}

function upstreamRejected(): never {
  throw new JiaowubaoOpenApiError("upstream_rejected", "教务宝 MCP 未接受读取请求。");
}

function oversize(): never {
  throw new JiaowubaoOpenApiError("response_oversize", "教务宝 MCP 返回数据超过上限。");
}

function requestTimeout(): never {
  throw new JiaowubaoOpenApiError("request_timeout", "教务宝 MCP 请求超时。");
}

function toolText(content: unknown) {
  if (!Array.isArray(content) || content.length !== 1) invalidResponse();
  const item: unknown = content[0];
  if (!record(item) || item.type !== "text" || typeof item.text !== "string") invalidResponse();
  return item.text;
}

function assertToolSuccess(result: JsonRecord) {
  if (result.isError !== undefined && result.isError !== false) upstreamRejected();
}

function toolData(result: JsonRecord) {
  assertToolSuccess(result);
  const data: unknown = JSON.parse(toolText(result.content));
  if (!record(data)) invalidResponse();
  if ("ret" in data && data.ret !== "1" && data.ret !== 1) upstreamRejected();
  return data;
}

function sseField(line: string) {
  if (!line || line.startsWith(":")) return null;
  const colon = line.indexOf(":");
  return { field: colon < 0 ? line : line.slice(0, colon), value: colon < 0 ? "" : line.slice(colon + 1).replace(/^ /u, "") };
}

function sseData(frame: string) {
  const data: string[] = [];
  let event: string | undefined;
  for (const line of frame.split("\n")) {
    const pair = sseField(line);
    if (pair === null) continue;
    switch (pair.field) {
      case "data": data.push(pair.value); break;
      case "event":
        if (event !== undefined) invalidResponse();
        event = pair.value; break;
      case "id": case "retry": break;
      default: invalidResponse();
    }
  }
  return completeSseData(data, event);
}

function completeSseData(data: string[], event: string | undefined) {
  if (!data.length) return null;
  if (![undefined, "message"].includes(event)) invalidResponse();
  return data.join("\n");
}

function firstSseData(text: string) {
  for (const frame of text.replace(/\r\n/gu, "\n").split("\n\n").slice(0, -1)) {
    const data = sseData(frame);
    if (data !== null) return data;
  }
  return null;
}

function responseLength(response: Response) {
  const value = response.headers.get("Content-Length");
  if (value === null) return null;
  if (!/^(0|[1-9]\d*)$/u.test(value) || !Number.isSafeInteger(Number(value))) invalidResponse();
  const length = Number(value);
  if (length > MAX_RESPONSE_BYTES) oversize();
  return length;
}

async function discard(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

async function assertEmptyResponse(response: Response) {
  const declared = responseLength(response);
  if (declared !== null && declared !== 0) invalidResponse();
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    const chunk = await reader.read();
    if (!chunk.done) invalidResponse();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function responseType(response: Response) {
  const type = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json" && type !== "text/event-stream") invalidResponse();
  return type;
}

function sseJsonText(text: string) {
  const data = firstSseData(text);
  if (data === null) invalidResponse();
  return data;
}

async function readBody(reader: ReadableStreamDefaultReader<Uint8Array>, streamedSse: boolean) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) oversize();
    text += decoder.decode(chunk.value, { stream: true });
    if (streamedSse) {
      const data = firstSseData(text);
      if (data !== null) return { text: data, size };
    }
  }
  text += decoder.decode();
  return { text: streamedSse ? sseJsonText(text) : text, size };
}

async function responsePayload(response: Response): Promise<unknown> {
  const type = responseType(response);
  const declared = responseLength(response);
  if (!response.body) invalidResponse();
  const reader = response.body.getReader();
  try {
    const body = await readBody(reader, type === "text/event-stream" && declared === null);
    if (declared !== null && body.size !== declared) invalidResponse();
    const text = type === "text/event-stream" && declared !== null ? sseJsonText(body.text) : body.text;
    return JSON.parse(text);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function retryAfter(response: Response) {
  const retry = response.headers.get("Retry-After") ?? "";
  if (!/^\d+$/u.test(retry) || Number(retry) <= 0 || Number(retry) > 3600) return undefined;
  return Number(retry);
}

function assertHttpStatus(response: Response, expected: number) {
  if (response.status >= 300 && response.status < 400) upstreamRejected();
  if (response.status === 401 || response.status === 403) {
    throw new JiaowubaoOpenApiError("not_authorized", "教务宝 MCP 授权不可用。");
  }
  if (response.status === 429) {
    throw new JiaowubaoOpenApiError("rate_limited", "教务宝 MCP 读取被限流。", retryAfter(response));
  }
  if (response.status !== expected) {
    throw new JiaowubaoOpenApiError("upstream_unavailable", "教务宝 MCP 服务暂时不可用。");
  }
}

function rpcResult(payload: unknown, id: number) {
  if (!record(payload) || payload.jsonrpc !== "2.0" || payload.id !== id) invalidResponse();
  if ("error" in payload) upstreamRejected();
  if (!record(payload.result)) invalidResponse();
  return payload.result;
}

function invalidRequest(): never {
  throw new JiaowubaoOpenApiError("invalid_request", "教务宝 MCP 课表查询无效。");
}

function exactDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) invalidRequest();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) invalidRequest();
  return value;
}

function boundedInteger(value: unknown, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) invalidRequest();
  return value as number;
}

function scheduleArguments(query: JiaowubaoScheduleListQuery) {
  if (!record(query) || Object.keys(query).some((key) => !["start", "end", "page", "limit", "order"].includes(key))) invalidRequest();
  const start = exactDate(query.start);
  const end = exactDate(query.end);
  const span = Date.parse(end) - Date.parse(start);
  if (![span >= 0, span <= 30 * 86_400_000].every(Boolean)) invalidRequest();
  const page = boundedInteger(query.page ?? 1, 500);
  const limit = boundedInteger(query.limit ?? 100, 100);
  const order = query.order ?? "asc";
  if (!["asc", "desc"].includes(order)) invalidRequest();
  return { start, end, page, limit, order, detail: 1 };
}

function validScheduleRecord(row: unknown) {
  return record(row) && typeof row.cal_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(row.cal_id);
}

function* decodedStrings(text: string): Generator<unknown> {
  try { yield JSON.parse(text); } catch (error) {
    if (!(error instanceof SyntaxError)) invalidResponse();
  }
  yield text.replace(/%([0-9a-f]{2})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  yield text.replace(/[+]/gu, " ");
  yield text.replace(/\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/giu, (_match, unicode: string | undefined, hex: string | undefined) => String.fromCharCode(Number.parseInt(unicode ?? hex!, 16)));
  yield text.replaceAll("\\\\", "\\").replaceAll("\\/", "/");
  for (const [encoded] of text.matchAll(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{4,}={0,2}(?![A-Za-z0-9+/_=-])/gu)) {
    if (encoded.replace(/=+$/u, "").length % 4 === 1) continue;
    let decoded: string;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64")); } catch { continue; }
    yield decoded;
  }
}

function* responseValues(value: unknown): Generator<unknown> {
  if (Array.isArray(value)) yield* value;
  else if (record(value)) {
    for (const pair of Object.entries(value)) yield* pair;
  }
}

function enqueueDecodedStrings(text: string, depth: number, enqueue: (value: unknown, depth: number) => void) {
  for (const decoded of decodedStrings(text)) {
    if (decoded !== text) enqueue(decoded, depth + 1);
  }
}

function assertNoToken(value: unknown, token: string) {
  const pending: [unknown, number][] = [];
  const seen = new Set<string>();
  const variants = [token];
  for (const encoding of ["base64", "base64url"] as const) {
    const encoded = Buffer.from(token).toString(encoding);
    variants.push(encoded, encoded.replace(/=+$/u, ""));
  }
  let nodes = 0;
  let bytes = 0;
  function enqueue(item: unknown, depth: number) {
    if (depth > 64 || ++nodes > 200_000) invalidResponse();
    pending.push([item, depth]);
  }
  enqueue(value, 0);
  while (pending.length) {
    const [item, depth] = pending.pop()!;
    for (const child of responseValues(item)) enqueue(child, depth + 1);
    if (typeof item !== "string" || seen.has(item)) continue;
    if (variants.some((variant) => item.includes(variant))) invalidResponse();
    seen.add(item);
    bytes += Buffer.byteLength(item);
    if (bytes > 32 * MAX_RESPONSE_BYTES) invalidResponse();
    enqueueDecodedStrings(item, depth, enqueue);
  }
}

function checkedRpcResult(payload: unknown, id: number, method: string, token: string) {
  const result = rpcResult(payload, id);
  if (method === "tools/call") assertToolSuccess(result);
  assertNoToken(payload, token);
  return result;
}

function scheduleLists(data: JsonRecord, limit: number) {
  const lists = data.lists;
  if (!Array.isArray(lists) || lists.length > limit) invalidResponse();
  if (lists.some((row) => !validScheduleRecord(row))) invalidResponse();
  return lists as JsonRecord[];
}

function scheduleTotal(value: unknown) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/u.test(value)) invalidResponse();
  const total = Number(value);
  if (!Number.isSafeInteger(total) || total > 6000) invalidResponse();
  return total;
}

function assertPagination(data: JsonRecord, count: number, query: ReturnType<typeof scheduleArguments>) {
  const total = scheduleTotal(data.total);
  if (data.is_more !== "0" && data.is_more !== "1") invalidResponse();
  const offset = (query.page - 1) * query.limit;
  const hasMore = data.is_more === "1";
  if (count === 0 ? offset < total : offset + count > total) invalidResponse();
  if (hasMore !== (offset + count < total) || (hasMore && count !== query.limit)) invalidResponse();
}

function schedulePage(data: JsonRecord, query: ReturnType<typeof scheduleArguments>): JiaowubaoScheduleListResponse {
  const lists = scheduleLists(data, query.limit);
  assertPagination(data, lists.length, query);
  return Object.freeze({ lists: Object.freeze([...lists]) });
}

function responseSession(response: Response, previous: string | null, initializing: boolean) {
  const session = response.headers.get("Mcp-Session-Id");
  if (session !== null && (!/^[\x21-\x7e]{1,256}$/u.test(session) || session.includes(","))) invalidResponse();
  if (!initializing && session !== null && session !== previous) invalidResponse();
  return initializing ? session : previous;
}

function initializedVersion(result: JsonRecord) {
  const version = result.protocolVersion;
  if (typeof version !== "string" || !["2025-11-25", "2025-06-18", "2025-03-26"].includes(version)) invalidResponse();
  if (!record(result.capabilities) || !record(result.capabilities.tools)) invalidResponse();
  return version;
}

function assertInstitution(data: JsonRecord, config: ReaderConfig) {
  if (!record(data.branch)) upstreamRejected();
  if (config.expectedBranchTitle !== undefined && data.branch.title !== config.expectedBranchTitle) upstreamRejected();
  if (config.expectedBranchId !== undefined) {
    const ids = [data.branch_id, data.branch.branch_id].filter((value) => value !== undefined);
    if (!ids.length || ids.some((id) => id !== config.expectedBranchId)) upstreamRejected();
  }
}

function readTimeout(options: JiaowubaoScheduleRequestOptions) {
  const remaining = options.deadlineAt === undefined ? REQUEST_TIMEOUT_MS : options.deadlineAt - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) requestTimeout();
  return Math.min(REQUEST_TIMEOUT_MS, remaining);
}

async function fetchMcpResponse(fetchImpl: typeof fetch, init: RequestInit, signal: AbortSignal) {
  try {
    return await fetchImpl(MCP_URL, { ...init, method: "POST", redirect: "manual", cache: "no-store", signal });
  } catch {
    if (signal.aborted) requestTimeout();
    throw new JiaowubaoOpenApiError("upstream_unavailable", "教务宝 MCP 服务暂时不可用。");
  }
}

export function createJiaowubaoMcpScheduleReader(config: ReaderConfig) {
  if (typeof config.token !== "string" || config.token.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(config.token)) {
    throw new JiaowubaoOpenApiError("not_configured", "教务宝 MCP 尚未安全配置。");
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  let session: string | null = null;
  let initialized = false;
  let version = "2025-11-25";
  let nextId = 1;

  async function post(method: string, signal: AbortSignal, params?: JsonRecord): Promise<JsonRecord> {
    const id = method === "notifications/initialized" ? undefined : nextId++;
    const response = await fetchMcpResponse(fetchImpl, {
        headers: {
          Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", "Accept-Encoding": "identity",
          Accept: "application/json, text/event-stream", "MCP-Protocol-Version": version,
          ...(session === null ? {} : { "Mcp-Session-Id": session }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
    }, signal);
    try {
      assertHttpStatus(response, id === undefined ? 202 : 200);
      const encoding = response.headers.get("Content-Encoding");
      if (encoding !== null && encoding.toLowerCase() !== "identity") invalidResponse();
      session = responseSession(response, session, method === "initialize");
      if (id === undefined) {
        await assertEmptyResponse(response);
        return {};
      }
      return checkedRpcResult(await responsePayload(response), id, method, config.token);
    } finally {
      await discard(response);
    }
  }

  return async (query: JiaowubaoScheduleListQuery, options: JiaowubaoScheduleRequestOptions = {}): Promise<JiaowubaoScheduleListResponse> => {
    const args = scheduleArguments(query);
    const timeout = readTimeout(options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      if (!initialized) {
        version = initializedVersion(await post("initialize", controller.signal, { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "insiderleads-schedule-sync", version: "1.0" } }));
        await post("notifications/initialized", controller.signal);
        if (config.expectedBranchId !== undefined || config.expectedBranchTitle !== undefined) {
          assertInstitution(toolData(await post("tools/call", controller.signal, { name: "get_branch_detail", arguments: {} })), config);
        }
        initialized = true;
      }
      const data = toolData(await post("tools/call", controller.signal, { name: "query_schedule_list", arguments: args }));
      return schedulePage(data, args);
    } catch (error) {
      if (controller.signal.aborted) requestTimeout();
      if (error instanceof JiaowubaoOpenApiError) throw error;
      invalidResponse();
    } finally {
      clearTimeout(timer);
    }
  };
}
