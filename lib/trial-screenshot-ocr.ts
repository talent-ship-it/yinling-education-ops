type OcrMessage = { type?: unknown; progress?: unknown; text?: unknown };

function receiveOcrMessage(message: OcrMessage, onProgress: (value: number) => void, complete: (error: Error | null, text?: string) => void) {
  if (message.type === "progress" && typeof message.progress === "number" && Number.isFinite(message.progress)) {
    onProgress(Math.min(100, Math.max(0, message.progress)));
  }
  if (message.type === "result" && typeof message.text === "string") complete(null, message.text);
  if (message.type === "error") complete(new Error("截图识别失败，请重试。"));
}

function recognizeInOwnedWorker(file: File, onProgress: (progress: number) => void, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker("/trial-screenshot-ocr.worker.js", { name: "trial-screenshot-ocr" });
    let settled = false;
    const finish = (error: Error | null, text = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error);
      else resolve(text);
    };
    const abort = () => finish(new DOMException("已取消识别", "AbortError"));
    const timeout = setTimeout(() => finish(new Error("截图识别超时，请重试。")), 90_000);
    worker.onmessage = (event: MessageEvent<OcrMessage>) => receiveOcrMessage(event.data, onProgress, finish);
    worker.onerror = (event) => { event.preventDefault(); finish(new Error("截图识别失败，请重试。")); };
    worker.onmessageerror = () => finish(new Error("截图识别失败，请重试。"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else {
      try { worker.postMessage(file); }
      catch { finish(new Error("截图识别失败，请重试。")); }
    }
  });
}

export async function recognizeTrialScreenshot(file: File, onProgress: (progress: number) => void, signal: AbortSignal) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size === 0 || file.size > 3 * 1024 * 1024) {
    throw new Error("请选择不超过 3 MB 的 PNG、JPG 或 WebP 截图。");
  }
  if (signal.aborted) throw new DOMException("已取消识别", "AbortError");
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width < 100 || bitmap.height < 80 || bitmap.width * bitmap.height > 12_000_000) throw new Error("截图尺寸不合适，请裁剪小课表后重试。");
  } finally { bitmap.close(); }
  if (signal.aborted) throw new DOMException("已取消识别", "AbortError");
  return recognizeInOwnedWorker(file, onProgress, signal);
}
