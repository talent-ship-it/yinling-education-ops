import { createJiaowubaoMcpCompletedLessonReader } from "./jiaowubao-mcp-node";
import {
  JiaowubaoOpenApiError,
  queryJiaowubaoCompletedLessonList,
  type JiaowubaoCompletedLessonListQuery,
  type JiaowubaoCompletedLessonListResponse,
} from "./jiaowubao-open-api-node";

type Config = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  beforeRequest: () => Promise<void>;
  deadlineAt: number;
}>;

function logicalQuery(query: JiaowubaoCompletedLessonListQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(page) || page < 1 || page > 60 || limit !== 100) {
    throw new JiaowubaoOpenApiError("invalid_request", "教务宝已消课分页无效。");
  }
  return { page, limit };
}

async function readNativePage(
  native: ReturnType<typeof createJiaowubaoMcpCompletedLessonReader>,
  input: Readonly<{ query: JiaowubaoCompletedLessonListQuery; offset: number; limit: number }>,
  config: Config,
) {
  let limit = input.limit;
  for (;;) {
    if (Date.now() >= config.deadlineAt) {
      throw new JiaowubaoOpenApiError("request_timeout", "教务宝已消课本轮读取时间已到。");
    }
    try {
      const response = await native({
        ...input.query, page: input.offset / limit + 1, limit,
      }, { deadlineAt: config.deadlineAt, rateGate: "database" });
      return { response, limit };
    } catch (error) {
      if (!(error instanceof JiaowubaoOpenApiError) || error.code !== "response_oversize" || limit === 5) throw error;
      limit = 5;
    }
  }
}

export function createJiaowubaoCompletedLessonReader(config: Config) {
  const env = config.env ?? process.env;
  const token = env.INSIDERLEADS_JWB_MCP_TOKEN ?? "";
  const expectedBranchId = env.JIAOWUBAO_MCP_EXPECTED_BRANCH_ID || undefined;
  const expectedBranchTitle = env.JIAOWUBAO_MCP_EXPECTED_BRANCH_TITLE || undefined;
  const useMcp = env.JIAOWUBAO_SCHEDULE_SOURCE === "mcp"
    || Boolean(token && (expectedBranchId || expectedBranchTitle));
  const native = useMcp ? createJiaowubaoMcpCompletedLessonReader({
    token,
    fetchImpl: config.fetchImpl,
    expectedBranchId,
    expectedBranchTitle,
    beforeRequest: config.beforeRequest,
  }) : null;
  return Object.freeze({
    source: useMcp ? "mcp" as const : "rest" as const,
    readPage: async (query: JiaowubaoCompletedLessonListQuery): Promise<JiaowubaoCompletedLessonListResponse> => {
      const logical = logicalQuery(query);
      if (!native) {
        await config.beforeRequest();
        return queryJiaowubaoCompletedLessonList(query);
      }
      const firstOffset = (logical.page - 1) * logical.limit;
      let nativeLimit = 10;
      let offset = firstOffset;
      let total: number | null = null;
      const records: JiaowubaoCompletedLessonListResponse["list"][number][] = [];
      for (;;) {
        const next = await readNativePage(native, { query, offset, limit: nativeLimit }, config);
        const response = next.response;
        nativeLimit = next.limit;
        if (total !== null && response.total !== total) {
          throw new JiaowubaoOpenApiError(
            logical.page === 1 ? "upstream_unavailable" : "invalid_response",
            "教务宝已消课学员总数在分页期间发生变化。",
          );
        }
        total = response.total;
        records.push(...response.list);
        offset += response.list.length;
        if (offset >= total || offset >= firstOffset + logical.limit) {
          return Object.freeze({ list: Object.freeze(records), total });
        }
      }
    },
  });
}
