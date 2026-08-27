#!/usr/bin/env node

import { chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

const PROJECT_REF = "orvsgisjjrzgtxuwwsms";

function required(args, flag) {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} is required.`);
  return resolve(value);
}

function normalise(value) {
  return typeof value === "string"
    ? value.trim().normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase("zh-Hans")
    : "";
}

async function realFile(path, label) {
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a real file.`);
}

async function realDirectory(path, label) {
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
}

async function runQuery(profile, sqlPath) {
  const child = spawn("npx", [
    "--yes", "supabase@2.115.0", "db", "query",
    "--profile", profile,
    "--linked", "--project-ref", PROJECT_REF,
    "--output-format", "json", "--file", sqlPath,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  if (code !== 0) throw new Error(`Supabase read failed: ${stderr.trim().slice(0, 300)}`);
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error("Supabase read returned no JSON.");
  return JSON.parse(stdout.slice(start));
}

const SQL = `
with flattened as (
  select entity, item
  from public.ops_state
  cross join lateral jsonb_array_elements(payload) as item
  where entity in ('teachers', 'courses')
)
select entity,
  jsonb_agg(
    case entity
      when 'teachers' then jsonb_build_object(
        'id', item->>'id',
        'name', item->>'name',
        'subjects', coalesce(item->'subjects', '[]'::jsonb),
        'acceptsStudents', item->'acceptsStudents',
        'availabilityStatus', item->>'availabilityStatus'
      )
      else jsonb_build_object(
        'id', item->>'id',
        'name', item->>'name',
        'status', item->>'status',
        'source', item->>'source'
      )
    end
    order by item->>'id'
  ) as rows
from flattened
group by entity
order by entity;
`;

function indexByName(rows) {
  const index = new Map();
  for (const row of rows) {
    const key = normalise(row.name);
    if (!key) continue;
    const entries = index.get(key) ?? [];
    entries.push(row);
    index.set(key, entries);
  }
  return index;
}

function exact(index, label, field) {
  const matches = index.get(normalise(label)) ?? [];
  if (matches.length === 0) return { state: "no_exact_match" };
  if (matches.length > 1) return { state: "ambiguous_exact_match", ids: matches.map((row) => row.id) };
  return { state: "unique_exact_match", id: matches[0].id, [field]: matches[0][field] };
}

function subjectSuggestions(subjects, courseLabel) {
  const source = normalise(courseLabel);
  return subjects
    .filter((subject) => {
      const candidate = normalise(subject);
      return candidate.length >= 3 && (source.includes(candidate) || candidate.includes(source));
    })
    .map((subject) => ({ subject, reason: "normalised_label_containment_only" }));
}

async function main() {
  const args = process.argv.slice(2);
  const planPath = required(args, "--plan");
  const profilePath = required(args, "--profile");
  const outputPath = required(args, "--out");
  await Promise.all([realFile(planPath, "--plan"), realFile(profilePath, "--profile")]);
  const outputParent = resolve(outputPath, "..");
  await realDirectory(outputParent, "--out parent");
  if (outputPath.startsWith(`${planPath}${sep}`) || outputPath === planPath) throw new Error("--out must be outside --plan.");
  if (await lstat(outputPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error))) {
    throw new Error("--out must be new.");
  }
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  if (plan.format !== "jiaowubao-static-small-batch-plan-v1") throw new Error("Unsupported plan format.");
  const scratch = await mkdtemp(join(tmpdir(), "jwb-authority-read-"));
  await chmod(scratch, 0o700);
  try {
    const sqlPath = join(scratch, "query.sql");
    await writeFile(sqlPath, SQL, { encoding: "utf8", mode: 0o600 });
    const result = await runQuery(profilePath, sqlPath);
    const source = Object.fromEntries((result.rows ?? []).map((row) => [row.entity, Array.isArray(row.rows) ? row.rows : []]));
    const teachers = source.teachers ?? [];
    const courses = source.courses ?? [];
    const teachersByName = indexByName(teachers);
    const coursesByName = indexByName(courses);
    const candidates = plan.candidates.map((candidate) => {
      const teacherRows = teachersByName.get(normalise(candidate.teacherLabel)) ?? [];
      const teacher = exact(teachersByName, candidate.teacherLabel, "name");
      const course = exact(coursesByName, candidate.courseLabel, "name");
      const exactSubjects = teacherRows.length === 1
        ? (Array.isArray(teacherRows[0].subjects) ? teacherRows[0].subjects : [])
          .filter((subject) => normalise(subject) === normalise(candidate.courseLabel))
        : [];
      const reviewSubjects = teacherRows.length === 1 && Array.isArray(teacherRows[0].subjects)
        ? teacherRows[0].subjects
        : [];
      return {
        priorityRank: candidate.priorityRank,
        mappingKey: candidate.mappingKey,
        teacherLabel: candidate.teacherLabel,
        courseLabel: candidate.courseLabel,
        authority: {
          teacher,
          course,
          teacherSubject: exactSubjects.length === 1
            ? { state: "unique_exact_subject", subject: exactSubjects[0] }
            : { state: "no_exact_subject" },
          teacherSubjectsForReview: reviewSubjects,
          subjectSuggestions: subjectSuggestions(reviewSubjects, candidate.courseLabel),
        },
        decision: {
          state: "human_confirmation_required",
          mappingWrite: "not_performed",
          bookingCreation: "forbidden",
        },
      };
    });
    const report = {
      format: "jiaowubao-authoritative-teacher-course-read-v1",
      projectRef: PROJECT_REF,
      sourceRevision: plan.sourceRevision,
      authorityCounts: { teachers: teachers.length, courses: courses.length },
      candidates: {
        total: candidates.length,
        uniqueExactTeacher: candidates.filter((candidate) => candidate.authority.teacher.state === "unique_exact_match").length,
        uniqueExactCourse: candidates.filter((candidate) => candidate.authority.course.state === "unique_exact_match").length,
        uniqueExactTeacherSubject: candidates.filter((candidate) => candidate.authority.teacherSubject.state === "unique_exact_subject").length,
      },
      safety: {
        managementApiReadOnly: true,
        mappingWrite: "not_performed",
        bookingCreation: "forbidden",
      },
    };
    const staging = `${outputPath}.staging-${process.pid}`;
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(staging, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await writeFile(join(staging, "teacher-course-candidates.json"), `${JSON.stringify(candidates, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(staging, outputPath);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    process.stdout.write(`${JSON.stringify({ status: "prepared", outputDirectory: basename(outputPath), report: { authorityCounts: report.authorityCounts, candidates: report.candidates } })}\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Jiaowubao authority read failed: ${error instanceof Error ? error.message : "Unexpected failure."}\n`);
  process.exitCode = 1;
});
