import "server-only";

import {
  ClassroomMaterialsError, MATERIALS_PROJECT_REF, materialRecord,
} from "@/lib/classroom-materials";
import { createMaterialsStorage } from "@/lib/classroom-materials-storage";

function databaseConfiguration() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secret = process.env.OPS_API_SECRET;
  if (url !== `https://${MATERIALS_PROJECT_REF}.supabase.co` || !key || !secret) {
    throw new ClassroomMaterialsError("资料库数据服务尚未配置。", "materials_unconfigured", 503);
  }
  return { url, key, secret };
}

export function materialsStorageConfigured() {
  return Boolean(process.env.CLASSROOM_MATERIALS_STORAGE_KEY?.trim());
}

async function responsePayload(response: Response) {
  try { return await response.json() as unknown; } catch { return null; }
}

export async function materialRpc<T = Record<string, unknown>>(accountId: string, operation: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { url, key, secret } = databaseConfiguration();
  let response: Response;
  try {
    response = await fetch(`${url}/rest/v1/rpc/classroom_materials_request`, {
      method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_secret: secret, p_account_id: accountId, p_operation: operation, p_payload: payload }),
      cache: "no-store", signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new ClassroomMaterialsError("资料库暂时无法连接。", "materials_unavailable", 503); }
  const result = await responsePayload(response);
  if (!response.ok) {
    const message = String(materialRecord(result).message ?? "");
    const statuses: Record<string, number> = { materials_forbidden: 403, materials_not_found: 404, materials_conflict: 409, materials_invalid_input: 400 };
    const code = Object.keys(statuses).find((item) => message === item);
    if (code) throw new ClassroomMaterialsError(code === "materials_forbidden" ? "当前账号没有此资料权限。" : code === "materials_not_found" ? "资料不存在或尚未授权。" : code === "materials_conflict" ? "资料请求与已有记录不一致。" : "资料参数无效。", code, statuses[code]);
    throw new ClassroomMaterialsError("资料库数据接口尚未就绪。", "materials_contract_unavailable", 503);
  }
  return result as T;
}

function storageClient() {
  const { url, key: publishableKey } = databaseConfiguration();
  const key = process.env.CLASSROOM_MATERIALS_STORAGE_KEY?.trim();
  if (!key) throw new ClassroomMaterialsError("资料文件存储尚未配置。", "materials_storage_unconfigured", 503);
  return createMaterialsStorage({ url, key, publishableKey });
}

export async function materialUploadDescriptor(material: Record<string, unknown>) {
  return storageClient().uploadDescriptor(material);
}

export async function materialObjectInfo(material: Record<string, unknown>) {
  return storageClient().objectInfo(material);
}

export async function materialReadUrl(material: Record<string, unknown>, download = false) {
  return storageClient().readUrl(material, download);
}
