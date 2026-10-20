import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "../..");
const tesseract = dirname(require.resolve("tesseract.js/package.json"));
const core = dirname(require.resolve("tesseract.js-core/package.json"));
let server: Server;
let origin = "";
let languageMode: "hold" | "fail" | "serve" = "hold";
const pending = new Set<ServerResponse>();
const requests: string[] = [];

function assetPath(path: string) {
  if (path === "/trial-screenshot-ocr.worker.js") return join(root, "public/trial-screenshot-ocr.worker.js");
  if (path === "/trial-ocr/v7/tesseract.min.js") return join(tesseract, "dist/tesseract.min.js");
  if (path === "/trial-ocr/v7/worker.min.js") return join(tesseract, "dist/worker.min.js");
  if (/^\/trial-ocr\/v7\/core\/tesseract-core(?:-[a-z]+)*\.wasm(?:\.js)?$/.test(path)) return join(core, path.split("/").at(-1)!);
  const language = path.match(/^\/trial-ocr\/v7\/lang\/(eng|chi_sim)\.traineddata\.gz$/)?.[1];
  if (!language) return null;
  return join(dirname(require.resolve(`@tesseract.js-data/${language}/package.json`)), "4.0.0_best_int", `${language}.traineddata.gz`);
}

async function serve(path: string, response: ServerResponse) {
  if (path === "/") { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<!doctype html><title>Synthetic OCR lifecycle</title>"); return; }
  const asset = assetPath(path);
  if (!asset) { response.writeHead(404); response.end(); return; }
  requests.push(path);
  if (path.includes("/lang/") && languageMode === "hold") {
    pending.add(response);
    response.once("close", () => pending.delete(response));
    return;
  }
  if (path.includes("/lang/") && languageMode === "fail") { response.writeHead(404); response.end(); return; }
  const body = await readFile(asset);
  response.writeHead(200, { "Content-Type": path.endsWith(".js") ? "application/javascript" : "application/octet-stream" });
  response.end(body);
}

test.beforeAll(async () => {
  server = createServer((request, response) => { void serve(new URL(request.url!, "http://localhost").pathname, response).catch(() => { response.writeHead(500); response.end(); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic OCR fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  pending.forEach((response) => response.destroy());
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
test.beforeEach(() => { languageMode = "hold"; requests.length = 0; });

type Harness = { start: () => Promise<void>; cancel: () => void; status: string; result: string };
async function harness(page: Page) {
  await page.goto(origin);
  const source = await readFile(join(root, "lib/trial-screenshot-ocr.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  await page.addScriptTag({ content: `(() => { const exports = {}; ${compiled}; window.ocrRecognize = exports.recognizeTrialScreenshot; })();` });
  await page.evaluate(() => {
    const state: Harness = { status: "idle", result: "", cancel: () => {}, start: async () => {
      const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 220;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "black"; context.font = "60px Arial"; context.fillText("HELLO SYNTHETIC", 40, 130);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
      const controller = new AbortController(); state.cancel = () => controller.abort(); state.status = "running";
      const recognize = (window as unknown as { ocrRecognize: (file: File, progress: (value: number) => void, signal: AbortSignal) => Promise<string> }).ocrRecognize;
      void recognize(new File([blob], "synthetic.png", { type: "image/png" }), () => {}, controller.signal).then((text) => { state.status = "complete"; state.result = text; }, (error: Error) => { state.status = "error"; state.result = error.message; });
    } };
    (window as unknown as { ocr: Harness }).ocr = state;
  });
  return async () => page.evaluate(() => ({ status: (window as unknown as { ocr: Harness }).ocr.status, result: (window as unknown as { ocr: Harness }).ocr.result }));
}
async function start(page: Page) { await page.evaluate(() => (window as unknown as { ocr: Harness }).ocr.start()); }
async function workerCount(page: Page) {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfos } = await session.send("Target.getTargets");
    return targetInfos.filter((target) => target.type === "worker" && (target.url.includes("trial-screenshot-ocr.worker.js") || target.url.includes("/trial-ocr/v7/worker.min.js"))).length;
  } finally { await session.detach(); }
}
async function expectClean(page: Page) {
  await expect.poll(() => workerCount(page)).toBe(0);
  await expect.poll(() => pending.size).toBe(0);
}

test("cancel during model initialization terminates both owned and nested OCR workers and pending downloads", async ({ page }) => {
  const state = await harness(page);
  await start(page);
  await expect.poll(() => pending.size).toBeGreaterThan(0);
  await expect.poll(() => workerCount(page)).toBe(2);
  await page.evaluate(() => (window as unknown as { ocr: Harness }).ocr.cancel());
  await expect.poll(state).toEqual({ status: "error", result: "已取消识别" });
  await expectClean(page);
  const count = requests.length;
  await page.waitForTimeout(150);
  expect(requests.length).toBe(count);
});

test("timeout during model initialization terminates the entire OCR worker tree", async ({ page }) => {
  await page.clock.install();
  const state = await harness(page);
  await start(page);
  await expect.poll(() => pending.size).toBeGreaterThan(0);
  await page.clock.fastForward(90_000);
  await expect.poll(state).toEqual({ status: "error", result: "截图识别超时，请重试。" });
  await expectClean(page);
});

test("a failed language load releases workers immediately and a retry can be canceled cleanly", async ({ page }) => {
  languageMode = "fail";
  const state = await harness(page);
  await start(page);
  await expect.poll(state).toEqual({ status: "error", result: "截图识别失败，请重试。" });
  await expectClean(page);
  languageMode = "hold";
  await start(page);
  await expect.poll(() => pending.size).toBeGreaterThan(0);
  await page.evaluate(() => (window as unknown as { ocr: Harness }).ocr.cancel());
  await expect.poll(state).toEqual({ status: "error", result: "已取消识别" });
  await expectClean(page);
});

test("the owned wrapper recognizes a synthetic image using only same-origin assets and releases workers on success", async ({ page, context }) => {
  languageMode = "serve";
  const external: string[] = [];
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === origin) await route.continue();
    else { external.push(route.request().url()); await route.abort(); }
  });
  const state = await harness(page);
  await start(page);
  await expect.poll(async () => (await state()).status, { timeout: 45_000 }).toBe("complete");
  expect((await state()).result).toMatch(/HELLO SYNTHETIC/);
  expect(external).toEqual([]);
  expect(requests).toContain("/trial-ocr/v7/tesseract.min.js");
  expect(requests).toContain("/trial-ocr/v7/worker.min.js");
  expect(requests).toContain("/trial-ocr/v7/lang/eng.traineddata.gz");
  expect(requests).toContain("/trial-ocr/v7/lang/chi_sim.traineddata.gz");
  await expectClean(page);
});
