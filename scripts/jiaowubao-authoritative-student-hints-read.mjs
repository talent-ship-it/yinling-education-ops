#!/usr/bin/env node

import { chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

const PROJECT_REF = "orvsgisjjrzgtxuwwsms";

function arg(args, flag) {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} is required.`);
  return resolve(value);
}

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function normalise(value) { return text(value).normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase("zh-Hans"); }
function sourceDate(value) { return text(value).match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null; }

async function stat(path, type, label) {
  const result = await lstat(path).catch(() => null);
  if (!result || result.isSymbolicLink() || (type === "file" ? !result.isFile() : !result.isDirectory())) {
    throw new Error(`${label} is not a real ${type}.`);
  }
}

async function query(profile, sqlFile) {
  const child = spawn("npx", [
    "--yes", "supabase@2.115.0", "db", "query",
    "--profile", profile, "--linked", "--project-ref", PROJECT_REF,
    "--output-format", "json", "--file", sqlFile,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value) => { stdout += value; });
  child.stderr.on("data", (value) => { stderr += value; });
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  if (code !== 0) throw new Error(`Supabase student hint read failed: ${stderr.trim().slice(0, 300)}`);
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error("Supabase student hint read returned no JSON.");
  return JSON.parse(stdout.slice(start));
}

const SQL = `
select jsonb_agg(
  jsonb_build_object(
    'id', item->>'id',
    'name', item->>'name',
    'status', item->>'status',
    'importArchived', coalesce(item->'importArchived', 'false'::jsonb),
    'jwbMatchStatus', item->>'jwbMatchStatus',
    'masterSourceKey', item->>'masterSourceKey'
  )
  order by item->>'id'
) as rows
from public.ops_state
cross join lateral jsonb_array_elements(payload) as item
where entity = 'students';
`;

async function collectSourceHints(plan, preflight) {
  const selected = new Set(plan.candidates.map((candidate) => `${normalise(candidate.teacherLabel)}\u0000${normalise(candidate.courseLabel)}`));
  const manifest = JSON.parse(await readFile(join(preflight, "manifest.json"), "utf8"));
  const hints = new Set();
  for (const chunkManifest of manifest.chunks) {
    const chunk = JSON.parse(await readFile(join(preflight, chunkManifest.fileName), "utf8"));
    for (const record of chunk.records) {
      if (record.kind !== "schedule_event") continue;
      const source = record.payload?.source ?? {};
      const date = sourceDate(source.sourceDate);
      if (!date || date < plan.priorityWindow.startDate || date >= plan.priorityWindow.endDateExclusive) continue;
      if (source.parseStatus?.kind !== "parsed") continue;
      if (!selected.has(`${normalise(source.teacher)}\u0000${normalise(source.course)}`)) continue;
      for (const identity of Array.isArray(source.identities) ? source.identities : []) {
        const name = text(identity?.name);
        if (name) hints.add(name);
      }
    }
  }
  return [...hints].sort((left, right) => left.localeCompare(right));
}

async function main() {
  const args = process.argv.slice(2);
  const planPath = arg(args, "--plan");
  const preflightPath = arg(args, "--preflight");
  const profilePath = arg(args, "--profile");
  const outputPath = arg(args, "--out");
  await Promise.all([stat(planPath, "file", "--plan"), stat(preflightPath, "directory", "--preflight"), stat(profilePath, "file", "--profile")]);
  if (outputPath === preflightPath || outputPath.startsWith(`${preflightPath}${sep}`)) throw new Error("--out must be outside --preflight.");
  if (await lstat(outputPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error))) throw new Error("--out must be new.");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  if (plan.format !== "jiaowubao-static-small-batch-plan-v1") throw new Error("Unsupported plan format.");
  const scratch = await mkdtemp(join(tmpdir(), "jwb-student-hints-"));
  await chmod(scratch, 0o700);
  try {
    const sqlPath = join(scratch, "students.sql");
    await writeFile(sqlPath, SQL, { encoding: "utf8", mode: 0o600 });
    const result = await query(profilePath, sqlPath);
    const students = result.rows?.[0]?.rows;
    if (!Array.isArray(students)) throw new Error("Unexpected student authority response.");
    const byName = new Map();
    for (const student of students) {
      if (student.importArchived === true) continue;
      const key = normalise(student.name);
      if (!key) continue;
      const rows = byName.get(key) ?? [];
      rows.push(student);
      byName.set(key, rows);
    }
    const sourceHints = await collectSourceHints(plan, preflightPath);
    const hints = sourceHints.map((sourceLabel) => {
      const matches = byName.get(normalise(sourceLabel)) ?? [];
      const match = matches.length === 0
        ? { state: "no_exact_active_name_match" }
        : matches.length === 1
          ? { state: "unique_exact_active_name_hint", nativeStudentId: matches[0].id, jwbMatchStatus: matches[0].jwbMatchStatus ?? null }
          : { state: "ambiguous_exact_active_name_hint", nativeStudentIds: matches.map((student) => student.id) };
      return {
        sourceLabel,
        match,
        authority: "name_hint_only_not_an_attachment",
        decision: "server_side_authoritative_match_required",
      };
    });
    const report = {
      format: "jiaowubao-authoritative-student-hints-read-v1",
      projectRef: PROJECT_REF,
      sourceRevision: plan.sourceRevision,
      authorityCount: { activeStudents: students.filter((student) => student.importArchived !== true).length },
      hints: {
        total: hints.length,
        uniqueExactActiveName: hints.filter((hint) => hint.match.state === "unique_exact_active_name_hint").length,
        ambiguousExactActiveName: hints.filter((hint) => hint.match.state === "ambiguous_exact_active_name_hint").length,
        noExactActiveName: hints.filter((hint) => hint.match.state === "no_exact_active_name_match").length,
      },
      safety: {
        managementApiReadOnly: true,
        studentAttachment: "not_performed",
        bookingCreation: "forbidden",
      },
    };
    const staging = `${outputPath}.staging-${process.pid}`;
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(staging, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await writeFile(join(staging, "student-name-hints.json"), `${JSON.stringify(hints, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(staging, outputPath);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    process.stdout.write(`${JSON.stringify({ status: "prepared", outputDirectory: basename(outputPath), hints: report.hints })}\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Jiaowubao student hint read failed: ${error instanceof Error ? error.message : "Unexpected failure."}\n`);
  process.exitCode = 1;
});
