import {
  ClassroomMaterialsError, MATERIALS_BUCKET, MATERIALS_CHUNK_SIZE, MATERIALS_PROJECT_REF,
  MATERIALS_SIGNED_URL_SECONDS, materialRecord,
} from "./classroom-materials";

export function createMaterialsStorage(configuration: { url: string; key: string; publishableKey: string }, fetcher: typeof fetch = fetch) {
  if (configuration.url !== `https://${MATERIALS_PROJECT_REF}.supabase.co` || !configuration.key || !configuration.publishableKey) {
    throw new ClassroomMaterialsError("资料文件存储配置无效。", "materials_storage_invalid", 503);
  }
  const base = `${configuration.url}/storage/v1`;
  const key = configuration.key;
  async function responsePayload(response: Response) {
    try { return await response.json() as unknown; } catch { return null; }
  }
  async function storageRequest(path: string, method = "GET", body?: unknown) {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method, headers: { apikey: key, Authorization: `Bearer ${key}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), cache: "no-store", signal: AbortSignal.timeout(20_000),
      });
    } catch { throw new ClassroomMaterialsError("资料文件存储暂时无法连接。", "materials_storage_unavailable", 503); }
    const payload = await responsePayload(response);
    if (!response.ok) {
      const error = materialRecord(payload);
      const missing = [400, 404].includes(response.status) && error.code === "NoSuchKey" && String(error.statusCode) === "404";
      throw new ClassroomMaterialsError("资料文件尚未就绪，请稍后重试。", missing ? "materials_object_missing" : "materials_storage_unavailable", missing ? 409 : 503);
    }
    return materialRecord(payload);
  }

  async function requirePrivateBucket() {
    const bucket = await storageRequest(`/bucket/${MATERIALS_BUCKET}`);
    if (bucket.id !== MATERIALS_BUCKET || bucket.public !== false) throw new ClassroomMaterialsError("资料库必须使用私有文件存储。", "materials_storage_invalid", 503);
    return bucket;
  }

  function objectPath(material: Record<string, unknown>) {
    if (material.bucketId !== MATERIALS_BUCKET || typeof material.objectPath !== "string" || !/^materials\/[0-9a-f-]{36}\/source\.[a-z0-9]+$/u.test(material.objectPath) || material.objectPath.split("/")[1] !== material.id) {
      throw new ClassroomMaterialsError("资料文件路径无效。", "materials_storage_invalid", 503);
    }
    return `${MATERIALS_BUCKET}/${material.objectPath.split("/").map(encodeURIComponent).join("/")}`;
  }

  function signedStorageUrl(value: unknown, expectedPath: string) {
    if (typeof value !== "string") throw new ClassroomMaterialsError("资料签名无效。", "materials_storage_invalid", 503);
    const url = new URL(value, `${base}/`);
    if (url.origin !== new URL(base).origin || url.pathname !== expectedPath || url.username || url.password || url.hash || !url.searchParams.get("token")) {
      throw new ClassroomMaterialsError("资料签名无效。", "materials_storage_invalid", 503);
    }
    return url;
  }

  async function uploadDescriptor(material: Record<string, unknown>) {
    const bucket = await requirePrivateBucket();
    if (Number.isSafeInteger(bucket.file_size_limit) && Number(bucket.file_size_limit) > 0 && Number(material.byteSize) > Number(bucket.file_size_limit)) {
      throw new ClassroomMaterialsError("文件大小超出资料库当前存储限制。", "materials_invalid_size", 413);
    }
    const signed = await storageRequest(`/object/upload/sign/${objectPath(material)}`, "POST", {});
    const signedUrl = signedStorageUrl(typeof signed.url === "string" && signed.url.startsWith("/object/") ? `/storage/v1${signed.url}` : signed.url, `/storage/v1/object/upload/sign/${objectPath(material)}`);
    const token = signedUrl.searchParams.get("token");
    if (!token) throw new ClassroomMaterialsError("资料上传签名无效。", "materials_storage_invalid", 503);
    return {
      endpoint: `https://${MATERIALS_PROJECT_REF}.storage.supabase.co/storage/v1/upload/resumable/sign`, bucket: MATERIALS_BUCKET,
      objectPath: material.objectPath, token, chunkSize: MATERIALS_CHUNK_SIZE,
      headers: { apikey: configuration.publishableKey, "x-signature": token, "x-upsert": "false" },
      metadata: { bucketName: MATERIALS_BUCKET, objectName: material.objectPath, contentType: material.mimeType, cacheControl: "0" },
    };
  }

  async function objectInfo(material: Record<string, unknown>, options: { allowMissing?: boolean } = {}) {
    await requirePrivateBucket();
    try {
      return await storageRequest(`/object/info/${objectPath(material)}`);
    } catch (error) {
      if (options.allowMissing && error instanceof ClassroomMaterialsError && error.code === "materials_object_missing") return null;
      throw error;
    }
  }

  async function readUrl(material: Record<string, unknown>, download = false) {
    await requirePrivateBucket();
    const result = await storageRequest(`/object/sign/${objectPath(material)}`, "POST", { expiresIn: MATERIALS_SIGNED_URL_SECONDS });
    const value = result.signedURL ?? result.signedUrl;
    const url = signedStorageUrl(typeof value === "string" && value.startsWith("/object/") ? `/storage/v1${value}` : value, `/storage/v1/object/sign/${objectPath(material)}`);
    if (download) url.searchParams.set("download", String(material.fileName || material.title));
    return url.toString();
  }

  return { uploadDescriptor, objectInfo, readUrl };
}
