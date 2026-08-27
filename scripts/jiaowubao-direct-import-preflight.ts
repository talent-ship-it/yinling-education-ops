#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  canonicalJson,
  prepareJiaowubaoDirectStaging,
} from "../lib/jiaowubao-direct-import-preflight";
import {
  parseJiaowubaoStaticXlsxExports,
  type JiaowubaoStaticSourceInput,
  type JiaowubaoStaticXlsxExportInput,
} from "../lib/jiaowubao-static-xlsx-parser";

type SourceInputKey = keyof JiaowubaoStaticXlsxExportInput;

/** The seven user-supplied August 2026 exports, matched by their exact file names. */
const REQUIRED_EXPORTS: Readonly<Record<SourceInputKey, string>> = Object.freeze({
  quickList: "吟领教育 2026-08-18 学员快速列表.xlsx",
  students: "吟领教育  学员列表.xlsx",
  contracts: "吟领教育 学员合约.xlsx",
  hours: "吟领教育  学员课时列表.xlsx",
  classMemberships: "吟领教育 班级学员名单.xlsx",
  schedule: "吟领教育 2021-08-03至 2029-08-02 课表.xlsx",
  leaveMakeups: "吟领教育 2026-08-11至2026-08-25 请假补课记录.xlsx",
});

type CliArguments = Readonly<{
  inputDir: string;
  outputDir: string;
}>;

function usage() {
  return [
    "Usage:",
    "  node --import tsx scripts/jiaowubao-direct-import-preflight.ts \\",
    "    --input-dir '/absolute/path/to/教务宝数据' \\",
    "    --out '/absolute/path/to/new-preflight-output'",
    "",
    "This is local-only. It does not contact Supabase, Tencent, or any other service.",
    "The output directory must not already exist. It contains source records and is written owner-only.",
  ].join("\n");
}

function argumentValue(args: readonly string[], flag: string) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path.`);
  return value;
}

function parseArguments(args: readonly string[]): CliArguments {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const accepted = new Set(["--input-dir", "--out"]);
  for (const argument of args) {
    if (argument.startsWith("--") && !accepted.has(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  const inputDir = argumentValue(args, "--input-dir");
  const outputDir = argumentValue(args, "--out");
  if (!inputDir || !outputDir) throw new Error("Both --input-dir and --out are required.");
  return Object.freeze({ inputDir: resolve(inputDir), outputDir: resolve(outputDir) });
}

async function requireDirectory(path: string) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new Error(`Input directory does not exist: ${path}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("--input-dir must be a real directory.");
}

async function assertNewOutputDirectory(path: string, inputDir: string) {
  if (path === inputDir || path.startsWith(`${inputDir}${sep}`)) {
    throw new Error("--out must be outside --input-dir.");
  }
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("--out must be a new directory; refusing to overwrite an existing artifact.");
}

async function readWorkbook(inputDir: string, workbookName: string): Promise<JiaowubaoStaticSourceInput> {
  const path = join(inputDir, workbookName);
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new Error(`Required Jiaowubao workbook is missing: ${workbookName}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Required Jiaowubao workbook is not a regular file: ${workbookName}`);
  }
  const bytes = new Uint8Array(await readFile(path));
  if (!bytes.byteLength) throw new Error(`Required Jiaowubao workbook is empty: ${workbookName}`);
  return Object.freeze({
    workbookName,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  });
}

async function readInputs(inputDir: string): Promise<JiaowubaoStaticXlsxExportInput> {
  const entries = await Promise.all(Object.entries(REQUIRED_EXPORTS).map(async ([key, fileName]) => [
    key,
    await readWorkbook(inputDir, fileName),
  ] as const));
  return Object.freeze(Object.fromEntries(entries)) as JiaowubaoStaticXlsxExportInput;
}

async function writeOwnerOnly(path: string, value: unknown) {
  // The manifest SHA-256 and byte count describe this exact on-disk payload.
  await writeFile(path, canonicalJson(value), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function writeArtifacts(outputDir: string, inputDir: string) {
  const parsed = parseJiaowubaoStaticXlsxExports(await readInputs(inputDir));
  const prepared = prepareJiaowubaoDirectStaging(parsed);
  const parent = dirname(outputDir);
  const staging = await mkdtemp(join(parent, `.${basename(outputDir)}-staging-`));
  try {
    await chmod(staging, 0o700);
    const chunksDirectory = join(staging, "chunks");
    await mkdir(chunksDirectory, { mode: 0o700 });
    await chmod(chunksDirectory, 0o700);
    for (const chunkManifest of prepared.manifest.chunks) {
      const chunk = prepared.chunks[chunkManifest.index];
      const chunkPath = join(staging, chunkManifest.fileName);
      await writeOwnerOnly(chunkPath, chunk);
    }
    await writeOwnerOnly(join(staging, "manifest.json"), prepared.manifest);
    await writeOwnerOnly(join(staging, "reconciliation.json"), prepared.reconciliation);
    await rename(staging, outputDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  // Deliberately aggregate-only terminal output: never log a JWB row.
  process.stdout.write(`${canonicalJson(Object.freeze({
    status: "prepared",
    outputDirectory: relative(dirname(outputDir), outputDir) || basename(outputDir),
    reconciliation: prepared.reconciliation,
  }))}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await requireDirectory(options.inputDir);
  await assertNewOutputDirectory(options.outputDir, options.inputDir);
  await writeArtifacts(options.outputDir, options.inputDir);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected preflight failure.";
  process.stderr.write(`Jiaowubao direct preflight failed: ${message}\n`);
  process.exitCode = 1;
});
