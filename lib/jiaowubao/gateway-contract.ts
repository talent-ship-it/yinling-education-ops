/**
 * The documented JiaoWuBao Open API gateway contract. Keeping it independent
 * of HTTP lets tests prove the credential stays in the gateway body rather
 * than accidentally becoming a browser-visible header or query parameter.
 */
export const JIAOWUBAO_GATEWAY_DEFAULT_URL = "https://card.jwbpro.com/open/jwb/gateway";
export const JIAOWUBAO_GATEWAY_LESSON_TOOL = "query_lesson_list";
export const JIAOWUBAO_GATEWAY_MEMBER_TOOL = "query_member_simple_list";
export const JIAOWUBAO_GATEWAY_SCHEDULE_TOOL = "query_schedule_list";
export const JIAOWUBAO_GATEWAY_PAGE_LIMIT = 100;
// 20 calls/minute is a rolling ceiling. 3.1 seconds keeps the 20th request
// outside the same 60-second window instead of relying on minute boundaries.
export const JIAOWUBAO_GATEWAY_REQUEST_GAP_MS = 3_100;
// A browser review and the scheduled GitHub job can run in separate processes.
// The gateway remains authoritative in that case, so retry a 429 only a small,
// bounded number of times rather than silently emitting a partial report.
export const JIAOWUBAO_GATEWAY_MAX_429_RETRIES = 2;
const JIAOWUBAO_GATEWAY_MIN_429_BACKOFF_MS = 61_000;
const JIAOWUBAO_GATEWAY_MAX_429_BACKOFF_MS = 5 * 60_000;

let latestGatewayRequestAt = 0;
let pendingGatewayRequest: Promise<void> = Promise.resolve();

/**
 * Serializes all gateway tools inside one server process. The documented cap is
 * per institution and interface; this deliberately more-conservative queue
 * avoids local bursts across tools. Separate serverless instances still fail
 * safely on a 429; scheduled exports run in one GitHub job.
 */
export async function waitForJiaowubaoGatewayRateLimit() {
  const previous = pendingGatewayRequest;
  let release: (() => void) | undefined;
  pendingGatewayRequest = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    const delay = Math.max(0, latestGatewayRequestAt + JIAOWUBAO_GATEWAY_REQUEST_GAP_MS - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    latestGatewayRequestAt = Date.now();
  } finally {
    release?.();
  }
}

/**
 * Converts a gateway Retry-After header into a bounded pause. The extra second
 * makes a rolling 20/minute limit safe even when the upstream omits a header.
 */
export function jiaowubaoGateway429BackoffMs(retryAfter: string | null, retryAttempt: number, now = Date.now()) {
  const numericSeconds = Number(retryAfter);
  const retryAfterMs = Number.isFinite(numericSeconds) && numericSeconds > 0
    ? Math.ceil(numericSeconds * 1_000)
    : (() => {
      const retryAt = retryAfter ? Date.parse(retryAfter) : Number.NaN;
      return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : 0;
    })();
  const escalatingMinimum = JIAOWUBAO_GATEWAY_MIN_429_BACKOFF_MS * (retryAttempt + 1);
  return Math.min(JIAOWUBAO_GATEWAY_MAX_429_BACKOFF_MS, Math.max(escalatingMinimum, retryAfterMs));
}

export async function waitForJiaowubaoGateway429Backoff(delayMs: number) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function documentedGatewayLessonRequest(sk: string, params: Record<string, unknown>) {
  return {
    sk,
    tool: JIAOWUBAO_GATEWAY_LESSON_TOOL,
    params,
  };
}

export function documentedGatewayMemberRequest(sk: string, params: Record<string, unknown>) {
  return {
    sk,
    tool: JIAOWUBAO_GATEWAY_MEMBER_TOOL,
    params,
  };
}

export function documentedGatewayScheduleRequest(sk: string, params: Record<string, unknown>) {
  return {
    sk,
    tool: JIAOWUBAO_GATEWAY_SCHEDULE_TOOL,
    params,
  };
}
