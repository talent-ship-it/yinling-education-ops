import { WecomReceiverHealthError } from "@/lib/wecom-receiver-health";

export type WecomReceiverHealthFailure = Readonly<{
  status: number;
  payload: Readonly<{ error: string; code: string }>;
  logCategory: string | null;
}>;

function requestFailure(error: unknown): WecomReceiverHealthFailure | null {
  if (error instanceof RangeError) return {
    status: 413,
    payload: { error: "WeCom health request is too large.", code: "payload_too_large" },
    logCategory: null,
  };
  if (error instanceof SyntaxError) return {
    status: 400,
    payload: { error: "WeCom health request is not valid JSON.", code: "invalid_json" },
    logCategory: null,
  };
  if (error instanceof WecomReceiverHealthError) return {
    status: 422,
    payload: { error: error.message, code: error.code },
    logCategory: null,
  };
  return null;
}

function missingContract(code: string | undefined) {
  return code === "PGRST202" || code === "42883";
}

function commitFailure(code: string | undefined): WecomReceiverHealthFailure {
  if (missingContract(code)) return {
    status: 501,
    payload: {
      error: "WeCom receiver health contract is not deployed.",
      code: "contract_unavailable",
    },
    logCategory: "contract_unavailable",
  };
  return {
    status: 503,
    payload: {
      error: "WeCom receiver health was not committed.",
      code: "health_commit_failed",
    },
    logCategory: code ?? "health",
  };
}

export function wecomReceiverHealthFailure(
  error: unknown,
  opsStoreErrorCode?: string,
): WecomReceiverHealthFailure {
  const direct = requestFailure(error);
  if (direct) return direct;
  return commitFailure(opsStoreErrorCode);
}
