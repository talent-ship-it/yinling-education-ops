import test from "node:test";
import assert from "node:assert/strict";
Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { currentScript: null } });
const { boardFilename, captureBoard, pngDataUrl, whiteBackgroundPng } = await import("../src/snapshot");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

test("captures the actual BBB current page with the pinned SDK base64Png response", async () => {
  const calls: string[] = [];
  const value = await captureBoard({ getUiData: async (name) => { calls.push(name); return { base64Png: png }; } });
  assert.deepEqual(calls, ["CURRENT_PAGE_SNAPSHOT"]);
  assert.equal(value, `data:image/png;base64,${png}`);
  assert.equal(pngDataUrl(value), value);
});

test("fails closed when the classroom cannot provide the actual whiteboard", async () => {
  await assert.rejects(captureBoard({}), /不支持/);
  await assert.rejects(captureBoard({ getUiData: async () => undefined }), /显示教材或白板/);
  await assert.rejects(captureBoard({ getUiData: () => new Promise(() => {}) }, 5), /显示教材或白板/);
  await assert.rejects(captureBoard({ getUiData: async () => ({ base64Png: "data:image/jpeg;base64,AAAA" }) }), /有效/);
});

test("composites white beneath the captured board without erasing the presentation", async () => {
  const calls: unknown[][] = [];
  const originalImage = globalThis.Image;
  const originalDocument = globalThis.document;
  class TestImage {
    src = ""; naturalWidth = 100; naturalHeight = 50;
    async decode() { calls.push(["decode", this.src]); }
  }
  Object.defineProperty(globalThis, "Image", { configurable: true, writable: true, value: TestImage });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({
      set fillStyle(value: string) { calls.push(["fillStyle", value]); },
      fillRect: (...args: unknown[]) => calls.push(["fillRect", ...args]),
      drawImage: (...args: unknown[]) => calls.push(["drawImage", ...args]),
    }), toBlob: (callback: (blob: Blob) => void, type: string) => callback(new Blob(["png"], { type })) }),
  } });
  try {
    const blob = await whiteBackgroundPng(png);
    assert.equal(blob.type, "image/png");
    assert.deepEqual(calls[1], ["fillStyle", "#fff"]);
    assert.deepEqual(calls[2], ["fillRect", 0, 0, 100, 50]);
    assert.equal(calls[3][0], "drawImage");
  } finally {
    Object.defineProperty(globalThis, "Image", { configurable: true, writable: true, value: originalImage });
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: originalDocument });
  }
});

test("normalizes safe PNG filenames without accepting filesystem paths", () => {
  assert.equal(boardFilename("Lesson 1.png"), "Lesson 1.png");
  assert.equal(boardFilename("../lesson:name"), ".._lesson_name.png");
  assert.equal(boardFilename("   "), "课堂板书.png");
  assert.equal(boardFilename("x".repeat(200)).length, 124);
});
