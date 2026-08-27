#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

const PLAN_FORMAT = "jiaowubao-static-small-batch-plan-v1";

function usage() {
  return [
    "Usage:",
    "  node scripts/jiaowubao-static-small-batch-plan.mjs \\",
    "    --priority '/absolute/path/to/priority-review-queue.json' \\",
    "    --preflight '/absolute/path/to/jiaowubao-static-preflight' \\",
    "    --out '/absolute/path/to/new-plan-dir' [--limit 10]",
    "",
    "Local-only dry-run planning. It does not contact Supabase and performs no writes.",
  ].join("\n");
}

function arg(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseArgs(args) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const priority = arg(args, "--priority");
  const preflight = arg(args, "--preflight");
  const out = arg(args, "--out");
  const rawLimit = arg(args, "--limit") ?? "10";
  const limit = Number(rawLimit);
  if (!priority || !preflight || !out) throw new Error("--priority, --preflight, and --out are required.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("--limit must be an integer from 1 to 50.");
  return { priority: resolve(priority), preflight: resolve(preflight), out: resolve(out), limit };
}

async function directory(path, label) {
  let stat;
  try { stat = await lstat(path); } catch { throw new Error(`${label} does not exist: ${path}`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
}

async function newOutput(path, inputs) {
  if (inputs.some((input) => path === input || path.startsWith(`${input}${sep}`))) {
    throw new Error("--out must be outside input directories.");
  }
  try { await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("--out must be a new directory.");
}

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function isoDate(value) { return text(value).match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null; }
function digest(teacher, course) { return createHash("sha256").update(`${teacher}\u0000${course}`).digest("hex"); }

async function loadRecords(preflight) {
  const manifest = JSON.parse(await readFile(join(preflight, "manifest.json"), "utf8"));
  const records = [];
  const sourceKeyToChunk = new Map();
  const pairEvents = new Map();
  for (const chunkManifest of [...manifest.chunks].sort((a, b) => a.index - b.index)) {
    const chunk = JSON.parse(await readFile(join(preflight, chunkManifest.fileName), "utf8"));
    for (const record of chunk.records) {
      if (record.kind !== "schedule_event") continue;
      const source = record.payload?.source ?? {};
      const teacher = text(source.teacher);
      const course = text(source.course);
      const date = isoDate(source.sourceDate);
      if (!teacher || !course || !date || source.parseStatus?.kind !== "parsed") continue;
      const pairKey = digest(teacher, course);
      const event = { sourceKey: text(record.sourceKey), date, chunkIndex: chunkManifest.index };
      records.push(event);
      sourceKeyToChunk.set(event.sourceKey, chunkManifest.index);
      const list = pairEvents.get(pairKey) ?? [];
      list.push(event);
      pairEvents.set(pairKey, list);
    }
  }
  return { manifest, pairEvents, sourceKeyToChunk };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await directory(options.preflight, "--preflight");
  await directory(resolve(options.priority, ".."), "priority parent");
  await newOutput(options.out, [options.preflight, options.priority]);
  const priority = JSON.parse(await readFile(options.priority, "utf8"));
  if (priority.format !== "jiaowubao-static-priority-review-v1") throw new Error("Unsupported priority queue format.");
  const { manifest, pairEvents, sourceKeyToChunk } = await loadRecords(options.preflight);
  const selected = priority.candidates.slice(0, options.limit);
  if (!selected.length) throw new Error("Priority queue has no candidates.");
  const start = priority.window.startDate;
  const end = priority.window.endDateExclusive;
  const selectedCandidates = selected.map((candidate) => {
    const pairKey = candidate.mappingKey.replace("local-jwb-pair-v1:", "");
    const events = (pairEvents.get(pairKey) ?? []).filter((event) => event.date >= start && event.date < end);
    const chunkIndexes = [...new Set(events.map((event) => event.chunkIndex))].sort((a, b) => a - b);
    return {
      priorityRank: candidate.priorityRank,
      mappingKey: candidate.mappingKey,
      teacherLabel: candidate.teacherLabel,
      courseLabel: candidate.courseLabel,
      nextSourceDate: candidate.nextSourceDate,
      windowEventCount: events.length,
      requiredChunkIndexes: chunkIndexes,
      sampleSourceKeys: candidate.sampleSourceKeys,
      review: candidate.review,
    };
  });
  const requiredChunkIndexes = [...new Set(selectedCandidates.flatMap((candidate) => candidate.requiredChunkIndexes))].sort((a, b) => a - b);
  const chunkByIndex = new Map(manifest.chunks.map((chunk) => [chunk.index, chunk]));
  const requiredChunks = requiredChunkIndexes.map((index) => {
    const chunk = chunkByIndex.get(index);
    if (!chunk) throw new Error(`Missing chunk manifest index: ${index}`);
    return { index: chunk.index, fileName: chunk.fileName, sha256: chunk.sha256, bytes: chunk.bytes, recordCount: chunk.recordCount };
  });
  const plan = {
    format: PLAN_FORMAT,
    sourceRevision: priority.sourceRevision,
    sourceTimezone: priority.window.timezone,
    priorityWindow: priority.window,
    selection: { limit: options.limit, selectedCount: selectedCandidates.length, estimatedScheduleEvents: selectedCandidates.reduce((sum, candidate) => sum + candidate.windowEventCount, 0) },
    candidates: selectedCandidates,
    requiredChunks,
    safety: {
      mode: "dry_run_pending_human_confirmation",
      teacherMapping: "required",
      courseMapping: "required",
      studentAuthorityMatch: "required",
      scheduleToBookingExpansion: "forbidden",
      supabaseWrite: "not_performed",
    },
    sourceKeyIndexVerified: sourceKeyToChunk.size > 0,
  };
  const staging = `${options.out}.staging-${process.pid}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await chmod(staging, 0o700);
  try {
    await writeFile(join(staging, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(join(staging, "README.txt"), [
      "This is a local dry-run batch plan.",
      "No Supabase write, Booking creation, student attachment, or task creation was performed.",
      "Every selected pair remains unresolved until teacher/course/student authority is explicitly confirmed.",
      `Source revision: ${plan.sourceRevision}`,
      `Window: ${start} <= sourceDate < ${end} (${plan.sourceTimezone})`,
    ].join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(staging, options.out);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ status: "prepared", outputDirectory: basename(options.out), selection: plan.selection, requiredChunks: requiredChunks.length })}\n`);
}

main().catch((error) => {
  process.stderr.write(`Jiaowubao small-batch plan failed: ${error instanceof Error ? error.message : "Unexpected failure."}\n`);
  process.exitCode = 1;
});
