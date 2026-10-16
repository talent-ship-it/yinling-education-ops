import { randomUUID } from "node:crypto";
import type { OpsRpcOptions, OpsRpcDiagnostic } from "./ops-store";

type Phase = "session" | "rows" | "snapshot" | "accounts" | "metadata" | "versions" | "publication";
function safeCode(value: unknown) {
  return typeof value === "string" && (/^(?:[0-9]{2}|P0|XX|HV|FD)[0-9A-Z]{3}$/.test(value)
    || ["timeout", "deadline", "cancelled", "transport", "source_unavailable", "source_changed", "invalid_window", "missing_configuration", "invalid_response"].includes(value)) ? value : "source_unavailable";
}

export function createAvaCalendarReadDiagnostics(request: Request, deadlineAt: number, now = () => Date.now()) {
  const requestId = randomUUID();
  const incomingEdge = request.headers.get("x-vercel-id");
  const edgeId = incomingEdge && /^[a-z]{3}[0-9]::(?:[a-z]{3}[0-9]::)?[a-z0-9]{5}-[0-9]{13}-[a-f0-9]{12}$/.test(incomingEdge) ? incomingEdge : null;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  const startedAt = now();
  let reported = false;
  function report(phase: Phase, code: unknown, detail: Omit<OpsRpcDiagnostic, "code" | "rpc"> & { rpc: string | null } = {
    rpc: null, httpStatus: null, upstreamRequestId: null, elapsedMs: Math.max(0, now() - startedAt),
  }) {
    reported = true;
    try {
      console.warn(JSON.stringify({ event: "ava_calendar_read_failure", requestId, edgeId, phase, code: safeCode(code),
        rpc: detail.rpc, httpStatus: detail.httpStatus, upstreamRequestId: detail.upstreamRequestId, elapsedMs: detail.elapsedMs }));
    } catch {}
  }
  return {
    options(phase: Phase): OpsRpcOptions {
      return { deadlineAt, signal: controller.signal, onDiagnostic: (event) => {
        if (event.code !== null) report(event.rpc === "get_ops_sources" ? "metadata" : phase, event.code, event);
      } };
    },
    async read<T>(phase: Phase, read: () => Promise<T>): Promise<T> {
      try {
        const result = await read();
        if (result && typeof result === "object" && "status" in result && result.status === 503) report(phase, "source_unavailable");
        return result;
      } catch (error) {
        report(phase, error && typeof error === "object" && "code" in error ? error.code : "source_unavailable");
        throw error;
      }
    },
    finish(response: Response) {
      const interrupted = controller.signal.aborted || now() >= deadlineAt;
      if (response.ok && interrupted) {
        report("publication", controller.signal.aborted ? "cancelled" : "deadline");
        response = Response.json({ error: "课表暂时无法完整读取，请稍后重试。" }, { status: 503,
          headers: { "Cache-Control": "private, no-store, max-age=0", Vary: response.headers.get("Vary") ?? "Cookie" } });
      }
      if (response.status === 503 && !reported) report("publication", "source_unavailable");
      request.signal.removeEventListener("abort", cancel);
      controller.abort();
      response.headers.set("X-Request-ID", requestId);
      return response;
    },
  };
}
