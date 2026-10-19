import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const output = fileURLToPath(new URL("../../public/classroom-tools/", import.meta.url));
await mkdir(output, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("src/index.tsx", import.meta.url))],
  outfile: `${output}/InsiderClassroomTools.js`, bundle: true, minify: true,
  format: "iife", target: ["es2020"], jsx: "automatic", legalComments: "eof",
  define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile(new URL("manifest.json", import.meta.url), `${output}/manifest.json`);
