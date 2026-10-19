import { PresentationWhiteboardUiDataNames } from "bigbluebutton-html-plugin-sdk";

export function boardFilename(value: string) {
  const cleaned = value.trim().replace(/\.png$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120).trim();
  return `${cleaned || "课堂板书"}.png`;
}

export function pngDataUrl(value: string) {
  const raw = value.startsWith("data:image/png;base64,") ? value.slice(22) : value;
  if (raw.length > 56_000_000 || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(raw)) {
    throw new Error("课堂没有返回有效的板书图片。");
  }
  return `data:image/png;base64,${raw}`;
}

type SnapshotApi = { getUiData?: (name: PresentationWhiteboardUiDataNames.CURRENT_PAGE_SNAPSHOT) => Promise<{ base64Png: string } | undefined> };

export async function captureBoard(api: SnapshotApi, timeoutMs = 8000) {
  if (!api.getUiData) throw new Error("当前课堂不支持保存板书。");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      api.getUiData(PresentationWhiteboardUiDataNames.CURRENT_PAGE_SNAPSHOT),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("请先显示教材或白板页面，再重试保存。")), timeoutMs);
      }),
    ]);
    if (!snapshot?.base64Png) throw new Error("请先显示教材或白板页面，再重试保存。");
    return pngDataUrl(snapshot.base64Png);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function whiteBackgroundPng(source: string): Promise<Blob> {
  const image = new Image();
  image.src = pngDataUrl(source);
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  if (!canvas.width || !canvas.height || canvas.width * canvas.height > 40_000_000) {
    throw new Error("板书图片尺寸无法保存，请缩小页面后重试。");
  }
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法保存板书图片。");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error("板书图片生成失败，请重试。"));
  }, "image/png"));
}

export function downloadBoard(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = boardFilename(filename);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
