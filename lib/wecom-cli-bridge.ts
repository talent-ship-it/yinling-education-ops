import "server-only";

export type WecomCliRecipient = {
  ref: string;
  label: string;
};

export type WecomCliDispatchResult =
  | { kind: "sent" }
  | { kind: "failed"; code: string }
  | { kind: "unknown" };

const recipientRefPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const bridgeTimeoutMs = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function listWecomCliRecipients(): WecomCliRecipient[] {
  const raw = process.env.WECOM_CLI_PUBLIC_RECIPIENTS_JSON || "";
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return [];

    return Object.entries(parsed)
      .flatMap(([ref, value]) => {
        if (!recipientRefPattern.test(ref) || !isRecord(value) || typeof value.label !== "string") return [];
        const label = value.label.trim();
        return label && label.length <= 80 ? [{ ref, label }] : [];
      })
      .sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
  } catch {
    return [];
  }
}

export function isKnownWecomCliRecipient(ref: unknown) {
  return typeof ref === "string" && listWecomCliRecipients().some((recipient) => recipient.ref === ref);
}

export function normalizeWecomCliText(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && byteLength(text) <= 20_480 ? text : null;
}

function bridgeConfiguration() {
  const rawUrl = process.env.WECOM_CLI_BRIDGE_URL || "";
  const token = process.env.WECOM_CLI_BRIDGE_TOKEN || "";
  if (!rawUrl || token.length < 32) return null;

  try {
    const url = new URL(rawUrl);
    const loopbackHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !loopbackHttp) return null;
    return { url, token };
  } catch {
    return null;
  }
}

function failureCode(value: unknown) {
  return typeof value === "string" && /^[a-z_]{3,64}$/.test(value) ? value : "bridge_rejected";
}

export async function dispatchWecomCliText(input: {
  deliveryId: string;
  recipientRef: string;
  text: string;
}): Promise<WecomCliDispatchResult> {
  const configuration = bridgeConfiguration();
  if (!configuration) return { kind: "failed", code: "bridge_not_configured" };

  const endpoint = new URL("/v1/messages/send", configuration.url);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...input, action: "send_text" }),
      cache: "no-store",
      signal: AbortSignal.timeout(bridgeTimeoutMs),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;

    if (response.ok && payload?.ok === true && payload.deliveryId === input.deliveryId) return { kind: "sent" };
    if (response.status >= 500) return { kind: "unknown" };
    return { kind: "failed", code: failureCode(payload?.code) };
  } catch {
    return { kind: "unknown" };
  }
}
