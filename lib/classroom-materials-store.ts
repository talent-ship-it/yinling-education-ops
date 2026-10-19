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

const materialRpcErrors: Record<string, { message: string; status: number }> = {
  materials_forbidden: { message: "当前账号没有此资料权限。", status: 403 },
  materials_not_found: { message: "资料不存在或尚未授权。", status: 404 },
  materials_conflict: { message: "资料请求与已有记录不一致。", status: 409 },
  materials_invalid_input: { message: "资料参数无效。", status: 400 },
};

function materialRpcError(result: unknown) {
  const code = String(materialRecord(result).message ?? "");
  const known = Object.hasOwn(materialRpcErrors, code) ? materialRpcErrors[code] : undefined;
  if (known) return new ClassroomMaterialsError(known.message, code, known.status);
  return new ClassroomMaterialsError("资料库数据接口尚未就绪。", "materials_contract_unavailable", 503);
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
    throw materialRpcError(result);
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

export async function materialObjectInfo(material: Record<string, unknown>, options: { allowMissing?: boolean } = {}) {
  return storageClient().objectInfo(material, options);
}

export async function materialReadUrl(material: Record<string, unknown>, download = false) {
  return storageClient().readUrl(material, download);
}
