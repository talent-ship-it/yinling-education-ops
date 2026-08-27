#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

const SOURCE_TIMEZONE = "Australia/Melbourne";
const REPORT_FORMAT = "jiaowubao-static-candidate-report-v1";

function usage() {
  return [
    "Usage:",
    "  node scripts/jiaowubao-static-candidate-report.mjs \\",
    "    --input '/absolute/path/to/jiaowubao-static-preflight' \\",
    "    --out '/absolute/path/to/new-candidate-report'",
    "",
    "Local-only. Reads the prepared static staging chunks and writes review candidates.",
    "It never contacts Supabase and never creates a Booking, task, student, or operation.",
  ].join("\n");
}

function value(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${flag} requires a path.`);
  return next;
}

function parseArgs(args) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const accepted = new Set(["--input", "--out"]);
  for (const arg of args) {
    if (arg.startsWith("--") && !accepted.has(arg)) throw new Error(`Unknown option: ${arg}`);
  }
  const input = value(args, "--input");
  const out = value(args, "--out");
  if (!input || !out) throw new Error("Both --input and --out are required.");
  return { input: resolve(input), out: resolve(out) };
}

async function requireDirectory(path, label) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
}

async function assertNewOutput(path, input) {
  if (path === input || path.startsWith(`${input}${sep}`)) {
    throw new Error("--out must be outside --input.");
  }
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("--out must be a new directory; refusing to overwrite an existing report.");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
}

function stableJson(value) {
  return JSON.stringify(canonical(value));
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sourceOf(record) {
  const payload = record?.payload;
  return payload && typeof payload === "object" && payload.source && typeof payload.source === "object"
    ? payload.source
    : {};
}

function isoDate(value) {
  const match = text(value).match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid date: ${dateString}`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

async function loadChunks(input) {
  const manifest = JSON.parse(await readFile(join(input, "manifest.json"), "utf8"));
  if (manifest.format !== "jiaowubao-direct-staging-v1") throw new Error("Unsupported staging manifest format.");
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length === 0) throw new Error("Manifest has no chunks.");

  const records = [];
  const seenSourceKeys = new Map();
  const verifiedChunks = [];
  for (const chunkManifest of [...manifest.chunks].sort((a, b) => a.index - b.index)) {
    const path = join(input, chunkManifest.fileName);
    const bytes = await readFile(path);
    if (bytes.byteLength !== chunkManifest.bytes) throw new Error(`Chunk byte count mismatch: ${chunkManifest.fileName}`);
    if (sha256(bytes) !== chunkManifest.sha256) throw new Error(`Chunk digest mismatch: ${chunkManifest.fileName}`);
    const chunk = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(chunk.records) || chunk.records.length !== chunkManifest.recordCount) {
      throw new Error(`Chunk record count mismatch: ${chunkManifest.fileName}`);
    }
    for (const record of chunk.records) {
      const sourceKey = text(record?.sourceKey);
      if (!sourceKey) throw new Error(`Chunk contains a record without sourceKey: ${chunkManifest.fileName}`);
      increment(seenSourceKeys, sourceKey);
      records.push(record);
    }
    verifiedChunks.push({ index: chunkManifest.index, fileName: chunkManifest.fileName, records: chunk.records.length });
  }
  return { manifest, records, seenSourceKeys, verifiedChunks };
}

function makeMappingCandidates(records, asOfDate, windowEndDate) {
  const pairs = new Map();
  const schedule = { total: 0, parsed: 0, invalid: 0, paired: 0, missingTeacher: 0, missingCourse: 0, futureParsed: 0, futurePaired: 0 };
  const duplicatePairSourceKeys = new Map();

  for (const record of records) {
    if (record?.kind !== "schedule_event") continue;
    schedule.total += 1;
    const source = sourceOf(record);
    const parsed = source?.parseStatus?.kind === "parsed";
    if (!parsed) {
      schedule.invalid += 1;
      continue;
    }
    schedule.parsed += 1;
    const date = isoDate(source.sourceDate);
    const future = Boolean(date && date >= asOfDate);
    const inPriorityWindow = Boolean(date && date >= asOfDate && date < windowEndDate);
    if (future) schedule.futureParsed += 1;
    const teacherLabel = text(source.teacher);
    const courseLabel = text(source.course);
    if (!teacherLabel) schedule.missingTeacher += 1;
    if (!courseLabel) schedule.missingCourse += 1;
    if (!teacherLabel || !courseLabel) continue;
    schedule.paired += 1;
    if (future) schedule.futurePaired += 1;
    const pairDigest = sha256(`${teacherLabel}\u0000${courseLabel}`);
    let candidate = pairs.get(pairDigest);
    if (!candidate) {
      candidate = {
        mappingKey: `local-jwb-pair-v1:${pairDigest}`,
        teacherLabel,
        courseLabel,
        eventCount: 0,
        futureEventCount: 0,
        windowEventCount: 0,
        firstSourceDate: date,
        lastSourceDate: date,
        nextSourceDate: future ? date : null,
        sampleSourceKeys: [],
        review: {
          status: "unresolved",
          requiresTeacherMapping: true,
          requiresCourseMapping: true,
          studentIdentityReview: true,
          canCreateNativeBooking: false,
          sourceEvidenceOnly: true,
        },
      };
      pairs.set(pairDigest, candidate);
    }
    candidate.eventCount += 1;
    if (future) {
      candidate.futureEventCount += 1;
      if (!candidate.nextSourceDate || date < candidate.nextSourceDate) candidate.nextSourceDate = date;
    }
    if (inPriorityWindow) candidate.windowEventCount += 1;
    if (date && (!candidate.firstSourceDate || date < candidate.firstSourceDate)) candidate.firstSourceDate = date;
    if (date && (!candidate.lastSourceDate || date > candidate.lastSourceDate)) candidate.lastSourceDate = date;
    if (candidate.sampleSourceKeys.length < 3) candidate.sampleSourceKeys.push(text(record.sourceKey));
    increment(duplicatePairSourceKeys, `${pairDigest}:${text(record.sourceKey)}`);
  }

  const candidates = [...pairs.values()].sort((a, b) => {
    if (b.futureEventCount !== a.futureEventCount) return b.futureEventCount - a.futureEventCount;
    if ((a.nextSourceDate ?? "9999-99-99") !== (b.nextSourceDate ?? "9999-99-99")) return (a.nextSourceDate ?? "9999-99-99").localeCompare(b.nextSourceDate ?? "9999-99-99");
    return a.mappingKey.localeCompare(b.mappingKey);
  });
  return {
    candidates,
    schedule: { ...schedule, candidatePairCount: candidates.length },
    duplicatePairSourceKeys: [...duplicatePairSourceKeys.values()].filter((count) => count > 1).length,
  };
}

function makeLeaveMakeupCandidates(records) {
  const candidates = [];
  let pending = 0;
  let withMakeupDetail = 0;
  for (const record of records) {
    if (record?.kind !== "leave_makeup") continue;
    const source = sourceOf(record);
    const status = text(source.status);
    if (status === "待补课") pending += 1;
    const rawFields = source?.raw?.fields && typeof source.raw.fields === "object" ? source.raw.fields : {};
    const detail = text(rawFields["补课详情"]);
    if (detail) withMakeupDetail += 1;
    candidates.push({
      sourceKey: text(record.sourceKey),
      sourceDate: isoDate(source.sourceDate),
      sourceTime: text(source.sourceTime),
      courseLabel: text(source.course),
      teacherLabel: text(source.teacher),
      status: status || "unknown",
      hasMakeupDetail: Boolean(detail),
      review: {
        status: "manual_review_only",
        bookingCreation: "forbidden",
        requiresStudentMatch: true,
        requiresReplacementTeacher: true,
        requiresExplicitConfirmation: true,
      },
    });
  }
  candidates.sort((a, b) => `${a.sourceDate ?? "9999"}:${a.sourceKey}`.localeCompare(`${b.sourceDate ?? "9999"}:${b.sourceKey}`));
  return { candidates, pending, withMakeupDetail };
}

function makeEvidenceSummary(records) {
  const summary = {
    hourRows: 0,
    positiveRemainingRows: 0,
    negativeRemainingRows: 0,
    hourDeadlineRows: 0,
    contractRows: 0,
    contractEndRows: 0,
    studentsWithHourEvidence: new Set(),
    studentsWithContractEvidence: new Set(),
  };
  for (const record of records) {
    const source = sourceOf(record);
    const fields = source?.raw?.fields && typeof source.raw.fields === "object" ? source.raw.fields : {};
    const student = text(source?.identity?.name);
    if (record?.kind === "hour_balance") {
      summary.hourRows += 1;
      const remaining = Number(fields["剩余课时"]);
      if (Number.isFinite(remaining) && remaining > 0) summary.positiveRemainingRows += 1;
      if (Number.isFinite(remaining) && remaining < 0) summary.negativeRemainingRows += 1;
      if (text(fields["截止日期"])) summary.hourDeadlineRows += 1;
      if (student) summary.studentsWithHourEvidence.add(student);
    }
    if (record?.kind === "contract_history") {
      summary.contractRows += 1;
      if (text(fields["合约截止日期"])) summary.contractEndRows += 1;
      if (student) summary.studentsWithContractEvidence.add(student);
    }
  }
  return {
    hourRows: summary.hourRows,
    positiveRemainingRows: summary.positiveRemainingRows,
    negativeRemainingRows: summary.negativeRemainingRows,
    hourDeadlineRows: summary.hourDeadlineRows,
    contractRows: summary.contractRows,
    contractEndRows: summary.contractEndRows,
    studentsWithHourEvidence: summary.studentsWithHourEvidence.size,
    studentsWithContractEvidence: summary.studentsWithContractEvidence.size,
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${stableJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function writeReport(input, out) {
  const loaded = await loadChunks(input);
  const asOfDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: SOURCE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const priorityWindowEndDate = addDays(asOfDate, 63);
  const mapping = makeMappingCandidates(loaded.records, asOfDate, priorityWindowEndDate);
  const leaveMakeups = makeLeaveMakeupCandidates(loaded.records);
  const evidence = makeEvidenceSummary(loaded.records);
  const duplicateSourceKeys = [...loaded.seenSourceKeys.values()].filter((count) => count > 1).length;
  const report = {
    format: REPORT_FORMAT,
    generatedAt: new Date().toISOString(),
    sourceRevision: loaded.manifest.revision,
      sourceTimezone: SOURCE_TIMEZONE,
      asOfDate,
      priorityWindowEndDate,
    integrity: {
      verifiedChunks: loaded.verifiedChunks.length,
      sourceChunks: loaded.manifest.chunks.length,
      totalRecords: loaded.records.length,
      manifestTotalRecords: loaded.manifest.chunks.reduce((sum, chunk) => sum + chunk.recordCount, 0),
      duplicateSourceKeys,
      duplicatePairSourceKeys: mapping.duplicatePairSourceKeys,
      allChunkDigestsVerified: true,
    },
    schedule: mapping.schedule,
    mappingCandidates: {
      total: mapping.candidates.length,
      unresolved: mapping.candidates.length,
      nativeBookingCreationAllowed: 0,
      futurePairs: mapping.candidates.filter((candidate) => candidate.futureEventCount > 0).length,
      priorityWindowPairs: mapping.candidates.filter((candidate) => candidate.windowEventCount > 0).length,
    },
    leaveMakeups: {
      total: leaveMakeups.candidates.length,
      pending: leaveMakeups.pending,
      withMakeupDetail: leaveMakeups.withMakeupDetail,
      withoutMakeupDetail: leaveMakeups.candidates.length - leaveMakeups.withMakeupDetail,
    },
    renewalEvidence: evidence,
    safety: {
      sourceMutation: "forbidden",
      studentAttachment: "server-side-authoritative-match-required",
      scheduleToBookingExpansion: "forbidden",
      leaveMakeupToOperation: "explicit-human-confirmation-required",
      automaticTaskCreation: "forbidden",
    },
  };

  const priorityCandidates = mapping.candidates
    .filter((candidate) => candidate.windowEventCount > 0)
    .sort((a, b) => {
      const nextDateOrder = (a.nextSourceDate ?? "9999-99-99").localeCompare(b.nextSourceDate ?? "9999-99-99");
      if (nextDateOrder !== 0) return nextDateOrder;
      if (b.windowEventCount !== a.windowEventCount) return b.windowEventCount - a.windowEventCount;
      return a.mappingKey.localeCompare(b.mappingKey);
    });

  const staging = `${out}.staging-${process.pid}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await chmod(staging, 0o700);
  try {
    await writeJson(join(staging, "report.json"), report);
    await writeJson(join(staging, "mapping-candidates.json"), {
      format: "jiaowubao-static-mapping-candidates-v1",
      sourceRevision: loaded.manifest.revision,
      asOfDate,
      candidates: mapping.candidates,
    });
    await writeJson(join(staging, "priority-review-queue.json"), {
      format: "jiaowubao-static-priority-review-v1",
      sourceRevision: loaded.manifest.revision,
      window: { startDate: asOfDate, endDateExclusive: priorityWindowEndDate, timezone: SOURCE_TIMEZONE },
      reviewPolicy: {
        status: "unresolved_only",
        teacherSelection: "human_confirmation_required",
        courseSelection: "human_confirmation_required",
        studentAttachment: "server_authoritative_match_required",
        nativeBookingCreation: "forbidden_until_explicit_confirmation",
      },
      candidates: priorityCandidates.map((candidate, index) => ({ priorityRank: index + 1, ...candidate })),
    });
    await writeJson(join(staging, "leave-makeup-candidates.json"), {
      format: "jiaowubao-static-leave-makeup-candidates-v1",
      sourceRevision: loaded.manifest.revision,
      candidates: leaveMakeups.candidates,
    });
    await writeJson(join(staging, "verified-chunks.json"), loaded.verifiedChunks);
    await rename(staging, out);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`${stableJson({ status: "prepared", outputDirectory: basename(out), report })}\n`);
}

const options = parseArgs(process.argv.slice(2));
await requireDirectory(options.input, "--input");
await assertNewOutput(options.out, options.input);
await writeReport(options.input, options.out).catch((error) => {
  process.stderr.write(`Jiaowubao candidate report failed: ${error instanceof Error ? error.message : "Unexpected failure."}\n`);
  process.exitCode = 1;
});
