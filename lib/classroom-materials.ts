import { isIP } from "node:net";

export class ClassroomMaterialsError extends Error {
  constructor(message: string, public code: string, public status = 400) {
    super(message);
    this.name = "ClassroomMaterialsError";
  }
}

export const MATERIALS_BUCKET = "classroom-materials";
export const MATERIALS_PROJECT_REF = "orvsgisjjrzgtxuwwsms";
export const MATERIALS_CHUNK_SIZE = 6 * 1024 * 1024;
export const MATERIALS_SIGNED_URL_SECONDS = 300;
const MATERIALS_DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

const formats: Record<string, string> = {
  pdf: "application/pdf", ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", mp4: "video/mp4",
};

export function materialRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function materialId(value: unknown, optional = false): string | null {
  if (optional && (value === undefined || value === null || value === "root" || value === "")) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ClassroomMaterialsError("资料 ID 无效。", "materials_invalid_id");
  }
  return value.toLowerCase();
}

export function materialTitle(value: unknown, maxLength = 240): string {
  if (typeof value !== "string") throw new ClassroomMaterialsError("请输入资料名称。", "materials_invalid_title");
  const title = value.normalize("NFC").trim();
  if (!title || title.length > maxLength || /[\u0000-\u001f\u007f/\\]/u.test(title) || title === "." || title === "..") {
    throw new ClassroomMaterialsError("资料名称无效。", "materials_invalid_title");
  }
  return title;
}

function publicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || /\.(localhost|local|internal|test|invalid|example|home|lan)$/u.test(host)) return false;
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const [a, b] = host.split(".").map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0))
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19));
  }
  if (ipVersion === 6) return false;
  return host.includes(".") && !host.split(".").some((part) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(part));
}

export function externalMaterialUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new ClassroomMaterialsError("在线资料链接无效。", "materials_invalid_url");
  let url: URL;
  try { url = new URL(value); } catch { throw new ClassroomMaterialsError("在线资料链接无效。", "materials_invalid_url"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !publicHost(url.hostname)) {
    throw new ClassroomMaterialsError("请使用不含账号密码的公开 HTTPS 资料链接。", "materials_invalid_url");
  }
  return url.toString();
}

export function materialMaxBytes(value = process.env.CLASSROOM_MATERIALS_MAX_FILE_BYTES): number {
  const parsed = value === undefined || value === "" ? MATERIALS_DEFAULT_MAX_BYTES : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 5 * 1024 * 1024 * 1024) {
    throw new ClassroomMaterialsError("资料上传大小配置无效。", "materials_configuration_invalid", 503);
  }
  return parsed;
}

export function materialUploadInput(value: unknown, maxBytes: number) {
  const input = materialRecord(value);
  const fileName = materialTitle(input.fileName);
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  const mimeType = formats[extension];
  if (!mimeType) throw new ClassroomMaterialsError("暂不支持此资料格式。", "materials_unsupported_type", 415);
  const suppliedMime = typeof input.mimeType === "string" ? input.mimeType.toLowerCase().split(";")[0].trim() : "";
  const aliases = mimeType === "audio/wav" ? ["audio/x-wav", "audio/wave"] : mimeType === "audio/mp4" ? ["audio/x-m4a"] : [];
  if (suppliedMime && suppliedMime !== "application/octet-stream" && suppliedMime !== mimeType && !aliases.includes(suppliedMime)) {
    throw new ClassroomMaterialsError("文件扩展名与格式不一致。", "materials_invalid_type");
  }
  if (!Number.isSafeInteger(input.byteSize) || Number(input.byteSize) < 1 || Number(input.byteSize) > maxBytes) {
    throw new ClassroomMaterialsError("文件大小超出当前上传限制。", "materials_invalid_size", 413);
  }
  return {
    folderId: materialId(input.folderId, true), title: materialTitle(input.title || fileName), fileName,
    mimeType, byteSize: Number(input.byteSize), requestKey: materialId(input.requestKey)!,
  };
}

export function materialGrantsInput(value: unknown) {
  const input = materialRecord(value);
  if (input.targetType !== "folder" && input.targetType !== "material") throw new ClassroomMaterialsError("授权对象无效。", "materials_invalid_target");
  const teacherIds = input.teacherIds;
  const downloadTeacherIds = input.downloadTeacherIds ?? [];
  if (!Array.isArray(teacherIds) || !Array.isArray(downloadTeacherIds) || teacherIds.length > 1000 || downloadTeacherIds.length > 1000
    || [...teacherIds, ...downloadTeacherIds].some((id) => typeof id !== "string" || !id.trim() || id.length > 180)) {
    throw new ClassroomMaterialsError("教师授权参数无效。", "materials_invalid_grants");
  }
  const display = [...new Set(teacherIds as string[])];
  const download = [...new Set(downloadTeacherIds as string[])];
  if (download.some((id) => !display.includes(id))) throw new ClassroomMaterialsError("下载授权必须包含在使用授权内。", "materials_invalid_grants");
  return { targetType: input.targetType, targetId: materialId(input.targetId)!, teacherIds: display, downloadTeacherIds: download };
}

export function verifyMaterialObject(object: unknown, material: Record<string, unknown>) {
  const info = materialRecord(object);
  const metadata = materialRecord(info.metadata);
  const size = info.size ?? metadata.size;
  const mime = info.content_type ?? metadata.mimetype;
  if (info.bucket_id !== MATERIALS_BUCKET || info.name !== material.objectPath || !Number.isSafeInteger(size)
    || size !== material.byteSize || mime !== material.mimeType) {
    throw new ClassroomMaterialsError("上传文件尚未完成或文件信息不匹配。", "materials_object_mismatch", 409);
  }
}

export function materialUsesExternalViewer(mimeType: string) {
  return mimeType.startsWith("audio/") || mimeType.startsWith("video/");
}
