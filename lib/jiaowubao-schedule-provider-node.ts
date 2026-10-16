import { createJiaowubaoMcpScheduleReader } from "./jiaowubao-mcp-node";
import { queryJiaowubaoScheduleList } from "./jiaowubao-open-api-node";

type ProviderConfig = Readonly<{ env?: Readonly<Record<string, string | undefined>>; fetchImpl?: typeof fetch }>;

export function createJiaowubaoScheduleReader(config: ProviderConfig = {}) {
  const env = config.env ?? process.env;
  const token = env.INSIDERLEADS_JWB_MCP_TOKEN;
  if (env.JIAOWUBAO_SCHEDULE_SOURCE !== "mcp" || !token) {
    return Object.freeze({ source: "rest" as const, readPage: queryJiaowubaoScheduleList });
  }
  return Object.freeze({
    source: "mcp" as const,
    readPage: createJiaowubaoMcpScheduleReader({
      token, fetchImpl: config.fetchImpl,
      expectedBranchId: env.JIAOWUBAO_MCP_EXPECTED_BRANCH_ID || undefined,
      expectedBranchTitle: env.JIAOWUBAO_MCP_EXPECTED_BRANCH_TITLE || undefined,
    }),
  });
}

export type JiaowubaoScheduleReader = ReturnType<typeof createJiaowubaoScheduleReader>;
