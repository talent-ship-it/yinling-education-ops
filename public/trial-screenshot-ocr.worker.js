let started = false;

async function recognize(file) {
  let worker;
  try {
    globalThis.importScripts("/trial-ocr/v7/tesseract.min.js");
    worker = await globalThis.Tesseract.createWorker(["eng", "chi_sim"], 1, {
      workerPath: `${globalThis.location.origin}/trial-ocr/v7/worker.min.js`,
      corePath: `${globalThis.location.origin}/trial-ocr/v7/core`,
      langPath: `${globalThis.location.origin}/trial-ocr/v7/lang`,
      workerBlobURL: false,
      cacheMethod: "none",
      errorHandler: () => globalThis.postMessage({ type: "error" }),
      logger: (message) => globalThis.postMessage({ type: "progress", progress: message.status === "recognizing text" ? Math.round(message.progress * 100) : 0 }),
    });
    await worker.setParameters({ tessedit_pageseg_mode: globalThis.Tesseract.PSM.AUTO });
    const { data } = await worker.recognize(file);
    globalThis.postMessage({ type: "result", text: data.text });
  } catch {
    globalThis.postMessage({ type: "error" });
  } finally {
    await worker?.terminate();
    globalThis.close();
  }
}

globalThis.onmessage = ({ data }) => {
  if (started) return;
  started = true;
  void recognize(data);
};
