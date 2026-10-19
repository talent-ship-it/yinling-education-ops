export type MaterialUploadSession = {
  endpoint: string;
  bucket: string;
  objectPath: string;
  token: string;
  headers?: Record<string, string>;
};

type ResumeTarget = Pick<MaterialUploadSession, "endpoint" | "bucket" | "objectPath"> & { location: string };
export type MaterialUploadResumeRecord = { fingerprint: string; requestKey: string; materialId?: string; upload?: ResumeTarget; uploaded?: boolean; expiresAt: number };

const CHUNK_BYTES = 6 * 1024 * 1024;

export function createMaterialUploadFolderResolver(parentId: string | null, createFolder: (parentId: string | null, name: string) => Promise<string>, parentDepth = 0) {
  const folders = new Map<string, Promise<string>>();
  return async (file: Pick<File, "name" | "webkitRelativePath">) => {
    if (!file.webkitRelativePath) return parentId;
    const components = file.webkitRelativePath.split("/");
    const fileName = components.pop();
    const parts = components.map((name) => name.normalize("NFC").trim());
    if (fileName !== file.name || !parts.length || parts.length + parentDepth > 32
      || parts.some((name) => !name.trim() || name.length > 160 || name === "." || name === ".." || /[\u0000-\u001f\u007f\\]/u.test(name))) {
      throw new Error("教材文件夹路径无效或超过 32 层");
    }
    let target = parentId;
    let path = "";
    for (const name of parts) {
      path += `/${name}`;
      const key = path;
      let folder = folders.get(key);
      if (!folder) {
        folder = createFolder(target, name).then((id) => {
          if (!id) throw new Error("未能创建教材文件夹");
          return id;
        }).catch((error) => { folders.delete(key); throw error; });
        folders.set(key, folder);
      }
      target = await folder;
    }
    return target;
  };
}

export function materialDropFiles(transfer: Pick<DataTransfer, "items" | "files">) {
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (!entry) throw new Error("无法读取拖放内容，请使用上传按钮");
    if (entry.isDirectory) throw new Error("请使用“上传文件夹”选择整个文件夹");
  }
  return Array.from(transfer.files);
}

function uploadError(status: number) {
  if (status === 401 || status === 403) return new Error("上传授权已过期，请重试");
  if (status === 409) return new Error("上传进度冲突，请重试以恢复进度");
  if (status === 413) return new Error("文件超过存储服务允许的大小");
  if (status === 429) return new Error("上传请求过多，请稍后重试");
  return new Error(`上传失败（${status}），请重试`);
}

function metadataValue(value: string) {
  const bytes = new TextEncoder().encode(value);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function validEndpoint(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !url.pathname.endsWith("/storage/v1/upload/resumable/sign")) {
    throw new Error("上传地址无效");
  }
  return url;
}

function validLocation(value: string, endpoint: string) {
  const destination = new URL(value, endpoint);
  const source = validEndpoint(endpoint);
  if (destination.origin !== source.origin || destination.username || destination.password || destination.hash
    || !destination.pathname.startsWith(`${source.pathname}/`)) throw new Error("存储服务返回了无效的上传地址");
  return destination;
}

export async function materialUploadFingerprint(file: File, folderId: string | null) {
  const metadata = new TextEncoder().encode(JSON.stringify([folderId, file.name, file.size, file.lastModified]));
  const first = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const last = new Uint8Array(await file.slice(Math.max(65536, file.size - 65536)).arrayBuffer());
  const bytes = new Uint8Array(metadata.length + first.length + last.length);
  bytes.set(metadata); bytes.set(first, metadata.length); bytes.set(last, metadata.length + first.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function resumeRecord(value: unknown): MaterialUploadResumeRecord | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.fingerprint)
    || typeof entry.requestKey !== "string" || !uuid.test(entry.requestKey)
    || typeof entry.expiresAt !== "number" || entry.expiresAt <= Date.now()
    || (entry.materialId !== undefined && (typeof entry.materialId !== "string" || !uuid.test(entry.materialId)))) return null;
  let upload: ResumeTarget | undefined;
  if (entry.upload && typeof entry.upload === "object") {
    const target = entry.upload as Record<string, unknown>;
    const { endpoint, bucket, objectPath, location } = target;
    if (typeof endpoint === "string" && typeof bucket === "string" && typeof objectPath === "string" && typeof location === "string") {
      try { const url = validLocation(location, endpoint); if (!url.search) upload = { endpoint, bucket, objectPath, location: url.href }; } catch { }
    }
  }
  return { fingerprint: entry.fingerprint, requestKey: entry.requestKey, materialId: entry.materialId as string | undefined,
    expiresAt: entry.expiresAt, uploaded: entry.uploaded === true, upload };
}

export class MaterialUploadResumeStore {
  private key: string | null;

  constructor(scope: string | undefined, private storage: Pick<Storage, "getItem" | "setItem">) {
    this.key = scope && /^[a-f0-9]{64}$/.test(scope) ? `insiderlead:classroom-upload:v1:${scope}` : null;
  }

  private records(): MaterialUploadResumeRecord[] {
    if (!this.key) return [];
    try {
      const records: unknown = JSON.parse(this.storage.getItem(this.key) || "[]");
      if (!Array.isArray(records)) return [];
      return records.map(resumeRecord).filter((entry): entry is MaterialUploadResumeRecord => entry !== null);
    } catch { return []; }
  }

  get(fingerprint: string) { return this.records().find((entry) => entry.fingerprint === fingerprint); }

  save(record: MaterialUploadResumeRecord) {
    if (!this.key) return;
    const safeRecord = resumeRecord(record);
    if (!safeRecord) return;
    try { this.storage.setItem(this.key, JSON.stringify([...this.records().filter((entry) => entry.fingerprint !== record.fingerprint), safeRecord].slice(-500))); }
    catch { }
  }

  remove(fingerprint: string) {
    if (!this.key) return;
    try { this.storage.setItem(this.key, JSON.stringify(this.records().filter((entry) => entry.fingerprint !== fingerprint))); }
    catch { }
  }
}

function readOffset(response: Response, size: number) {
  const value = response.headers.get("Upload-Offset");
  if (value === null || !/^\d+$/.test(value)) throw new Error("无法确认上传进度，请重试");
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset > size) throw new Error("上传进度无效，请重试");
  return offset;
}

function verifyMetadata(response: Response, session: MaterialUploadSession, contentType: string) {
  try {
    const entries = (response.headers.get("Upload-Metadata") || "").split(",").map((pair) => {
      const [key, value = ""] = pair.trim().split(" ");
      return [key, new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)))] as const;
    });
    const metadata = new Map(entries);
    if (metadata.size !== entries.length || metadata.get("bucketName") !== session.bucket
      || metadata.get("objectName") !== session.objectPath || metadata.get("contentType") !== contentType) throw new Error();
  } catch { throw new Error("待续传文件与存储记录不匹配"); }
}

export class ResumableMaterialUpload {
  private session: MaterialUploadSession;
  private location: string | null = null;

  constructor(private file: Blob, session: MaterialUploadSession, private contentType = file.type || "application/octet-stream") {
    validEndpoint(session.endpoint);
    this.session = session;
  }

  refreshSession(session: MaterialUploadSession) {
    validEndpoint(session.endpoint);
    if (session.endpoint !== this.session.endpoint || session.bucket !== this.session.bucket
      || session.objectPath !== this.session.objectPath) {
      throw new Error("上传目标已改变，无法继续此文件");
    }
    this.session = session;
  }

  restore(target: ResumeTarget) {
    if (target.endpoint !== this.session.endpoint || target.bucket !== this.session.bucket || target.objectPath !== this.session.objectPath) {
      throw new Error("待续传文件与上传目标不匹配");
    }
    const url = validLocation(target.location, this.session.endpoint);
    if (url.search) throw new Error("无法恢复此上传地址");
    this.location = url.href;
  }

  checkpoint(): ResumeTarget | undefined {
    if (!this.location) return;
    const url = validLocation(this.location, this.session.endpoint);
    if (url.search) return;
    const { endpoint, bucket, objectPath } = this.session;
    return { endpoint, bucket, objectPath, location: url.href };
  }

  async run(signal: AbortSignal, onProgress: (bytes: number) => void) {
    const { endpoint, bucket, objectPath, token } = this.session;
    const headers = { ...this.session.headers, "Tus-Resumable": "1.0.0", "x-signature": token, "x-upsert": "false" };
    const request = (url: string, init: RequestInit) => fetch(url, {
      ...init, signal, credentials: "omit", redirect: "error", cache: "no-store",
      headers: { ...headers, ...init.headers },
    });
    let offset = 0;
    if (this.location) {
      const response = await request(this.location, { method: "HEAD" });
      if (response.status === 404 || response.status === 410) this.location = null;
      else {
        if (!response.ok) throw uploadError(response.status);
        offset = readOffset(response, this.file.size);
        const length = response.headers.get("Upload-Length");
        if (length !== String(this.file.size)) throw new Error("上传文件大小不匹配");
        verifyMetadata(response, this.session, this.contentType);
      }
    }
    if (!this.location) {
      const metadata = { bucketName: bucket, objectName: objectPath, contentType: this.contentType, cacheControl: "0" };
      const response = await request(endpoint, {
        method: "POST",
        headers: {
          "Upload-Length": String(this.file.size),
          "Upload-Metadata": Object.entries(metadata).map(([key, value]) => `${key} ${metadataValue(value)}`).join(","),
        },
      });
      if (response.status !== 201) throw uploadError(response.status);
      const location = response.headers.get("Location");
      if (!location) throw new Error("存储服务未返回上传地址");
      const destination = validLocation(location, endpoint);
      this.location = destination.href;
    }
    onProgress(offset);
    while (offset < this.file.size) {
      signal.throwIfAborted();
      const end = Math.min(offset + CHUNK_BYTES, this.file.size);
      const response = await request(this.location, {
        method: "PATCH",
        headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(offset) },
        body: this.file.slice(offset, end),
      });
      if (response.status !== 204) throw uploadError(response.status);
      const nextOffset = readOffset(response, this.file.size);
      if (nextOffset !== end) throw new Error("存储服务未确认完整分片，请重试");
      offset = nextOffset;
      onProgress(offset);
    }
  }
}
