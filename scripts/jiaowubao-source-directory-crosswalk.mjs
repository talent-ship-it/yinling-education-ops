#!/usr/bin/env node

import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

function usage() {
  return [
    "Usage:",
    "  node scripts/jiaowubao-source-directory-crosswalk.mjs \\",
    "    --plan '/absolute/path/to/small-batch-plan.json' \\",
    "    --browser-export '/absolute/path/to/jiaowubao-one-time-export' \\",
    "    --out '/absolute/path/to/new-crosswalk-dir'",
    "",
    "Local-only. Matches source labels only against the exported Jiaowubao directories.",
    "It does not identify a native teacher, subject, or student and does not write any service.",
  ].join("\n");
}

function arg(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function options(args) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const plan = arg(args, "--plan");
  const browserExport = arg(args, "--browser-export");
  const out = arg(args, "--out");
  if (!plan || !browserExport || !out) throw new Error("--plan, --browser-export, and --out are required.");
  return { plan: resolve(plan), browserExport: resolve(browserExport), out: resolve(out) };
}

async function file(path, label) {
  let stat;
  try { stat = await lstat(path); } catch { throw new Error(`${label} does not exist: ${path}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
}

async function directory(path, label) {
  let stat;
  try { stat = await lstat(path); } catch { throw new Error(`${label} does not exist: ${path}`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
}

async function assertNewOutput(path, inputs) {
  if (inputs.some((input) => path === input || path.startsWith(`${input}${sep}`))) throw new Error("--out must be outside inputs.");
  try { await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("--out must be a new directory.");
}

function text(value) { return typeof value === "string" ? value.trim() : ""; }

/** Exact name matching after harmless Unicode/space normalization only. */
function normalizedLabel(value) {
  return text(value).normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase("zh-Hans");
}

function directoryIndex(rows, idField) {
  const index = new Map();
  for (const row of rows) {
    const label = text(row?.title);
    const id = text(row?.[idField]);
    if (!label || !id) continue;
    const key = normalizedLabel(label);
    const entries = index.get(key) ?? [];
    entries.push({ id, label });
    index.set(key, entries);
  }
  return index;
}

function sourceMatch(index, label) {
  const matches = index.get(normalizedLabel(label)) ?? [];
  if (matches.length === 1) return { state: "unique_source_match", source: matches[0] };
  if (matches.length > 1) return { state: "ambiguous_source_match", sources: matches };
  return { state: "no_source_match" };
}

async function main() {
  const input = options(process.argv.slice(2));
  await file(input.plan, "--plan");
  await directory(input.browserExport, "--browser-export");
  await assertNewOutput(input.out, [input.plan, input.browserExport]);
  const plan = JSON.parse(await readFile(input.plan, "utf8"));
  if (plan.format !== "jiaowubao-static-small-batch-plan-v1") throw new Error("Unsupported small-batch plan format.");
  const sourceDir = join(input.browserExport, "sources");
  const teachers = JSON.parse(await readFile(join(sourceDir, "teachers.json"), "utf8"))?.data?.lists;
  const courses = JSON.parse(await readFile(join(sourceDir, "courses.json"), "utf8"))?.data?.lists;
  if (!Array.isArray(teachers) || !Array.isArray(courses)) throw new Error("Browser export does not contain valid teacher/course directories.");
  const teachersByLabel = directoryIndex(teachers, "teacher_id");
  const coursesByLabel = directoryIndex(courses, "course_id");
  const candidates = plan.candidates.map((candidate) => ({
    priorityRank: candidate.priorityRank,
    mappingKey: candidate.mappingKey,
    teacherLabel: candidate.teacherLabel,
    courseLabel: candidate.courseLabel,
    sourceDirectory: {
      teacher: sourceMatch(teachersByLabel, candidate.teacherLabel),
      course: sourceMatch(coursesByLabel, candidate.courseLabel),
    },
    nativeSystem: {
      teacherMapping: "not_attempted",
      subjectMapping: "not_attempted",
      studentAuthorityMatch: "not_attempted",
      bookingCreation: "forbidden",
    },
  }));
  const report = {
    format: "jiaowubao-source-directory-crosswalk-v1",
    sourceRevision: plan.sourceRevision,
    planFormat: plan.format,
    sourceDirectoryCounts: { teachers: teachers.length, courses: courses.length },
    candidates: {
      total: candidates.length,
      uniqueTeacherSourceMatch: candidates.filter((candidate) => candidate.sourceDirectory.teacher.state === "unique_source_match").length,
      uniqueCourseSourceMatch: candidates.filter((candidate) => candidate.sourceDirectory.course.state === "unique_source_match").length,
      uniquePairSourceMatch: candidates.filter((candidate) => candidate.sourceDirectory.teacher.state === "unique_source_match" && candidate.sourceDirectory.course.state === "unique_source_match").length,
    },
    safety: {
      sourceMatchOnly: true,
      nativeMapping: "not_performed",
      supabaseWrite: "not_performed",
      bookingCreation: "forbidden",
    },
  };
  const staging = `${input.out}.staging-${process.pid}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(staging, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(join(staging, "crosswalk.json"), `${JSON.stringify({ ...report, candidates }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(staging, input.out);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ status: "prepared", outputDirectory: basename(input.out), candidates: report.candidates })}\n`);
}

main().catch((error) => {
  process.stderr.write(`Jiaowubao source crosswalk failed: ${error instanceof Error ? error.message : "Unexpected failure."}\n`);
  process.exitCode = 1;
});
