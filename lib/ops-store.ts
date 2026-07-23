import "server-only";

export type OpsStateRow = {
  entity: string;
  payload: unknown;
  version: number;
  updated_at: string;
  updated_by: string;
};

export type OpsVersionRow = Omit<OpsStateRow, "payload">;

export type OpsSourceRow = {
  source_id: string;
  title: string;
  source_type: string;
  url: string | null;
  modified_at: string | null;
  synced_at: string;
  row_count: number;
  status: string;
  payload: unknown;
};

export class OpsStoreError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

function configuration() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secret = process.env.OPS_API_SECRET;

  if (!url || !publishableKey || !secret) {
    throw new OpsStoreError("Supabase 共享数据环境变量尚未配置。", "missing_configuration");
  }

  return { url: url.replace(/\/$/, ""), publishableKey, secret };
}

async function rpc<T>(name: string, body: Record<string, unknown>) {
  const { url, publishableKey } = configuration();
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${publishableKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload as { message?: string; code?: string; details?: string } | null;
    throw new OpsStoreError(error?.message || "Supabase 请求失败。", error?.code, error?.details);
  }

  return payload as T;
}

export function getOpsState(entities?: string[]) {
  const { secret } = configuration();
  return rpc<OpsStateRow[]>("get_ops_state", {
    p_secret: secret,
    p_entities: entities?.length ? entities : null,
  });
}

export function getOpsVersions() {
  const { secret } = configuration();
  return rpc<OpsVersionRow[]>("get_ops_versions", { p_secret: secret });
}

export function getOpsSources() {
  const { secret } = configuration();
  return rpc<OpsSourceRow[]>("get_ops_sources", { p_secret: secret });
}

export function putOpsState(input: {
  entity: string;
  payload: unknown;
  expectedVersion: number;
  actor: string;
}) {
  const { secret } = configuration();
  return rpc<OpsStateRow[]>("put_ops_state", {
    p_secret: secret,
    p_entity: input.entity,
    p_payload: input.payload,
    p_expected_version: input.expectedVersion,
    p_actor: input.actor,
  });
}
