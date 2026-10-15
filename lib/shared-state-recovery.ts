export const SHARED_STATE_REQUEST_TIMEOUT_MS = 10_000;

export type SharedStateRow<T = unknown> = Readonly<{
  entity: string;
  payload: T;
  version: number;
  updated_at: string;
  updated_by: string;
}>;

export type SharedStateFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type SharedStateRecoveryResult<T> = Readonly<{
  outcome: "authoritative" | "baseline";
  row: SharedStateRow<T>;
  error?: Error;
}>;

function validRow<T>(value: unknown, entity: string): value is SharedStateRow<T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<SharedStateRow<T>>;
  return row.entity === entity
    && Number.isSafeInteger(row.version)
    && (row.version as number) >= 1
    && "payload" in row
    && typeof row.updated_at === "string"
    && typeof row.updated_by === "string";
}

export async function fetchWithTimeout(
  fetchImpl: SharedStateFetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = SHARED_STATE_REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Keeps the same abort deadline active until the response body is consumed. */
export async function fetchJsonWithTimeout<T = ReturnType<typeof JSON.parse>>(
  fetchImpl: SharedStateFetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = SHARED_STATE_REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    const body = await response.json().catch((error: unknown) => {
      if (controller.signal.aborted) throw error;
      return null;
    }) as T | null;
    return { response, body } as const;
  } finally {
    clearTimeout(timeoutId);
    init.signal?.removeEventListener("abort", abort);
  }
}

/**
 * Resolve a generic PUT whose commit status is unknown. The response is read
 * from the server as a complete entity snapshot; local pending changes are
 * deliberately not merged back into that snapshot. If the read is also
 * unavailable, the caller receives the exact committed baseline captured
 * before the PUT and the normal poller can repair it later.
 */
export async function recoverSharedStateAfterUnknownWrite<T>(input: Readonly<{
  entity: string;
  committedBaseline: SharedStateRow<T>;
  fetchImpl: SharedStateFetch;
  timeoutMs?: number;
}>): Promise<SharedStateRecoveryResult<T>> {
  try {
    const { response, body } = await fetchJsonWithTimeout<{ rows?: unknown; error?: unknown }>(
      input.fetchImpl,
      `/api/app-state?entities=${encodeURIComponent(input.entity)}`,
      { cache: "no-store" },
      input.timeoutMs,
    );
    if (!response.ok) throw new Error(body && "error" in body && typeof body.error === "string" ? body.error : `${input.entity} 权威状态读取失败`);
    const row = Array.isArray(body?.rows) ? body.rows.find((candidate) => validRow<T>(candidate, input.entity)) : undefined;
    if (!validRow<T>(row, input.entity) || row.version < input.committedBaseline.version) {
      throw new Error(`${input.entity} 权威状态响应不完整。`);
    }
    return { outcome: "authoritative", row };
  } catch (error) {
    return {
      outcome: "baseline",
      row: input.committedBaseline,
      error: error instanceof Error ? error : new Error(`${input.entity} 权威状态读取失败`),
    };
  }
}

export function matchesCommittedSharedPayload(entity: string, actual: unknown, desired: unknown) {
  if (entity !== "tasks") return JSON.stringify(actual) === JSON.stringify(desired);
  const withoutNoteDates = (value: unknown) => Array.isArray(value)
    ? value.map((task: unknown) => task && typeof task === "object" && !Array.isArray(task)
      ? Object.fromEntries(Object.entries(task).filter(([field]) => field !== "completionNoteUpdatedAt"))
      : task)
    : value;
  const canonical = (value: unknown) => JSON.stringify(withoutNoteDates(value), (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
    }
    return item;
  });
  return canonical(actual) === canonical(desired);
}
