export type MaterialUploadSession = {
  endpoint: string;
  bucket: string;
  objectPath: string;
  token: string;
};

const CHUNK_BYTES = 6 * 1024 * 1024;

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
    || !url.pathname.endsWith("/storage/v1/upload/resumable")) {
    throw new Error("上传地址无效");
  }
  return url;
}

function readOffset(response: Response, size: number) {
  const value = response.headers.get("Upload-Offset");
  if (value === null || !/^\d+$/.test(value)) throw new Error("无法确认上传进度，请重试");
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset > size) throw new Error("上传进度无效，请重试");
  return offset;
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

  async run(signal: AbortSignal, onProgress: (bytes: number) => void) {
    const { endpoint, bucket, objectPath, token } = this.session;
    const headers = { "Tus-Resumable": "1.0.0", "x-signature": token, "x-upsert": "false" };
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
      const destination = new URL(location, endpoint);
      const source = validEndpoint(endpoint);
      if (destination.origin !== source.origin || destination.username || destination.password || destination.hash
        || !destination.pathname.startsWith(`${source.pathname}/`)) throw new Error("存储服务返回了无效的上传地址");
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
