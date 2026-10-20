import { copyFile, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const destination = resolve(import.meta.dirname, "../public/trial-ocr/v7");
await mkdir(join(destination, "core"), { recursive: true });
await mkdir(join(destination, "lang"), { recursive: true });
await copyFile(join(dirname(require.resolve("tesseract.js/package.json")), "dist/worker.min.js"), join(destination, "worker.min.js"));
await copyFile(join(dirname(require.resolve("tesseract.js/package.json")), "dist/tesseract.min.js"), join(destination, "tesseract.min.js"));
const core = dirname(require.resolve("tesseract.js-core/package.json"));
for (const name of await readdir(core)) {
  if (/^tesseract-core(?:-[a-z]+)*\.wasm(?:\.js)?$/.test(name)) await copyFile(join(core, name), join(destination, "core", name));
}
const languageData = {
  eng: dirname(require.resolve("@tesseract.js-data/eng/package.json")),
  chi_sim: dirname(require.resolve("@tesseract.js-data/chi_sim/package.json")),
};
for (const [language, source] of Object.entries(languageData)) {
  await copyFile(join(source, "4.0.0_best_int", `${language}.traineddata.gz`), join(destination, "lang", `${language}.traineddata.gz`));
}
console.log("Trial OCR assets: ready");
