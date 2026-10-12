import { createHash, timingSafeEqual } from "node:crypto";

export type AvaCalendarMachineCapability = Readonly<{
  kind: "machine";
  subject: "ava-calendar-service";
  permission: "calendar:read";
  scope: "company";
  tokenSha256: string;
}>;

export function authorizeAvaCalendarMachineRequest(request: Request, readTokenSha256: () => string | undefined): AvaCalendarMachineCapability | { error: string; status: 401 | 503 } {
  let configured: string | undefined;
  try { configured = readTokenSha256(); } catch { return { error: "课表服务暂不可用。", status: 503 }; }
  if (typeof configured !== "string" || configured.length !== 64 || !/^[a-f0-9]{64}$/.test(configured)) return { error: "课表服务暂不可用。", status: 503 };
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer ([a-f0-9]{64})$/);
  if (!match || authorization!.length !== 71) return { error: "请提供有效的课表服务凭据。", status: 401 };
  const supplied = createHash("sha256").update(match[1]!, "utf8").digest();
  if (!timingSafeEqual(supplied, Buffer.from(configured, "hex"))) return { error: "请提供有效的课表服务凭据。", status: 401 };
  return Object.freeze({ kind: "machine", subject: "ava-calendar-service", permission: "calendar:read", scope: "company", tokenSha256: configured });
}
