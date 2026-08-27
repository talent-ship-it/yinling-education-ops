import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  JiaowubaoOpenApiError,
} from "../lib/jiaowubao-open-api-node";
import {
  collectJiaowubaoScheduleSnapshot,
  validateJiaowubaoScheduleSnapshotWindow,
  type JiaowubaoScheduleSnapshotManifest,
} from "../lib/jiaowubao-open-api-schedule-snapshot";

const OWNER_DIR_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;

export type ScheduleExportOptions = Readonly<{
  start: string;
  end: string;
  out: string;
}>;

export type ScheduleExportManifest = JiaowubaoScheduleSnapshotManifest;

function fail(message: string): never {
  throw new Error(message);
}

export function validateScheduleExportOptions(input: ScheduleExportOptions): ScheduleExportOptions {
  validateJiaowubaoScheduleSnapshotWindow(input);
  if (!input.out || input.out.trim().length === 0) fail("out 不能为空。");
  return Object.freeze({ start: input.start, end: input.end, out: input.out });
}

async function writeOwnerFile(path: string, contents: string) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: OWNER_FILE_MODE, flag: "wx" });
  await chmod(temporaryPath, OWNER_FILE_MODE);
  await rename(temporaryPath, path);
}

async function prepareOutputDirectory(out: string) {
  const existing = await lstat(out).catch(() => null);
  if (existing) fail("out 必须是尚不存在的目录，避免覆盖已有导出。");
  const parent = join(out, "..");
  const temporary = await mkdtemp(join(parent, ".jwb-schedule-export-"));
  await chmod(temporary, OWNER_DIR_MODE);
  return temporary;
}

/**
 * Fetches and stores a bounded, immutable local snapshot. The collector is
 * shared with the production cron so its source evidence and manifest hashes
 * have exactly one implementation.
 */
export async function exportJiaowubaoScheduleSnapshot(
  rawOptions: ScheduleExportOptions,
  fetchPage?: Parameters<typeof collectJiaowubaoScheduleSnapshot>[1],
) {
  const options = validateScheduleExportOptions(rawOptions);
  const temporaryDirectory = await prepareOutputDirectory(options.out);
  let published = false;

  try {
    const snapshot = await collectJiaowubaoScheduleSnapshot(
      { start: options.start, end: options.end },
      fetchPage,
    );
    for (const page of snapshot.pages) {
      await writeOwnerFile(join(temporaryDirectory, page.file), `${JSON.stringify(page.records)}\n`);
    }
    const manifest = snapshot.manifest;
    await writeOwnerFile(join(temporaryDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporaryDirectory, options.out);
    published = true;
    return manifest;
  } finally {
    if (!published) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function argumentValue(args: readonly string[], name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function parseArguments(args: readonly string[]): ScheduleExportOptions {
  const allowed = new Set(["--start", "--end", "--out"]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!allowed.has(arg) || seen.has(arg) || !args[index + 1] || args[index + 1].startsWith("--")) {
      fail("用法：tsx scripts/jiaowubao-open-api-schedule-export.ts --start YYYY-MM-DD --end YYYY-MM-DD --out DIR");
    }
    seen.add(arg);
    index += 1;
  }
  const start = argumentValue(args, "--start");
  const end = argumentValue(args, "--end");
  const out = argumentValue(args, "--out");
  if (!start || !end || !out || seen.size !== 3) {
    fail("用法：tsx scripts/jiaowubao-open-api-schedule-export.ts --start YYYY-MM-DD --end YYYY-MM-DD --out DIR");
  }
  return { start, end, out };
}

export async function main(args = process.argv.slice(2)) {
  try {
    const manifest = await exportJiaowubaoScheduleSnapshot(parseArguments(args));
    process.stdout.write(`导出完成：pages=${manifest.pageCount} records=${manifest.recordCount} out=owner-only\n`);
  } catch (error) {
    if (error instanceof JiaowubaoOpenApiError) {
      process.stderr.write(`导出失败：${error.message}\n`);
    } else {
      process.stderr.write(`导出失败：${error instanceof Error ? error.message : "未知错误"}\n`);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
