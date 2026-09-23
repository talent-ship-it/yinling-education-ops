import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { sqlRuntimeFixtures } from "../tests/sql/runtime-fixtures.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const DISPOSABLE_MARKER = "insiderleads-disposable-fixture";
const PSQL = process.env.PSQL || "psql";
const PYTHON = process.env.PYTHON || "python3";
const selectedId = process.argv[2] === "--fixture" ? process.argv[3] : null;
const listOnly = process.argv.includes("--list");

function fail(message) {
  throw new Error(message);
}

function normalizedRuntimeSources() {
  return readdirSync(resolve(ROOT, "tests/sql"))
    .filter((name) => /-runtime\.(?:sql|ts|py)$/u.test(name))
    .map((name) => `tests/sql/${name}`)
    .sort();
}

function assertManifestComplete() {
  const ids = sqlRuntimeFixtures.map((fixture) => fixture.id);
  const sources = sqlRuntimeFixtures.map((fixture) => fixture.source).sort();
  if (new Set(ids).size !== ids.length) fail("SQL runtime manifest contains a duplicate fixture id.");
  if (new Set(sources).size !== sources.length) fail("SQL runtime manifest contains a duplicate fixture source.");
  const discovered = normalizedRuntimeSources();
  if (JSON.stringify(sources) !== JSON.stringify(discovered)) {
    const missing = discovered.filter((source) => !sources.includes(source));
    const stale = sources.filter((source) => !discovered.includes(source));
    fail(`SQL runtime manifest is incomplete. Missing: ${missing.join(", ") || "none"}; stale: ${stale.join(", ") || "none"}.`);
  }
  for (const fixture of sqlRuntimeFixtures) {
    if (!/^[a-z0-9-]+$/u.test(fixture.id) || !Array.isArray(fixture.steps) || fixture.steps.length === 0) {
      fail(`SQL runtime manifest entry is invalid: ${fixture.id}`);
    }
    for (const step of fixture.steps) {
      const absolute = resolve(ROOT, step.file);
      if (relative(ROOT, absolute).startsWith("..") || !step.file.startsWith("tests/") && !step.file.startsWith("supabase/")) {
        fail(`SQL runtime step escapes the repository: ${step.file}`);
      }
      if (step.kind === "sql-fragment" && (typeof step.start !== "string" || step.start.length === 0)) {
        fail(`SQL fragment step requires a start marker: ${step.file}`);
      }
    }
  }
}

function localDatabaseEnvironment(database) {
  const host = process.env.PGHOST || "127.0.0.1";
  if (!(host === "127.0.0.1" || host === "localhost" || host === "::1" || host.startsWith("/"))) {
    fail("SQL runtime fixtures require a local PostgreSQL host or Unix socket.");
  }
  return {
    ...process.env,
    PGHOST: host,
    PGPORT: process.env.PGPORT || "5432",
    PGUSER: process.env.PGUSER || "postgres",
    PGDATABASE: database,
    PGSSLMODE: "disable",
    PSQL,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.capture ? ["pipe", "pipe", "pipe"] : [options.input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture && result.stderr) process.stderr.write(result.stderr);
    fail(`${command} ${args.join(" ")} failed with status ${result.status}.`);
  }
  return options.capture ? result.stdout : "";
}

function psql(database, args, options = {}) {
  return run(PSQL, ["-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], {
    ...options,
    env: localDatabaseEnvironment(database),
  });
}

function adminSql(sql, capture = false) {
  return psql("postgres", ["-qAt", "-c", sql], { capture });
}

function quotedIdentifier(value) {
  if (!/^il_fixture_[a-z0-9_]+$/u.test(value)) fail(`Unsafe disposable database name: ${value}`);
  return `"${value}"`;
}

function createDisposableDatabase(database) {
  const identifier = quotedIdentifier(database);
  adminSql(`create database ${identifier};`);
  adminSql(`comment on database ${identifier} is '${DISPOSABLE_MARKER}';`);
}

function dropDisposableDatabase(database) {
  const identifier = quotedIdentifier(database);
  const marker = adminSql(`select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = '${database}';`, true).trim();
  if (marker !== DISPOSABLE_MARKER) fail(`Refusing to drop unmarked database ${database}.`);
  adminSql(`drop database ${identifier} with (force);`);
}

function uniqueMarkerPosition(source, marker, file, from = 0) {
  const position = source.indexOf(marker, from);
  if (position < 0) fail(`SQL fragment marker was not found: ${file}`);
  if (source.indexOf(marker, position + marker.length) >= 0) {
    fail(`SQL fragment marker must occur exactly once: ${file}`);
  }
  return position;
}

function readSqlFragment(step) {
  const source = readFileSync(resolve(ROOT, step.file), "utf8");
  const start = uniqueMarkerPosition(source, step.start, step.file);
  if (step.end === undefined) return source.slice(start);
  const end = uniqueMarkerPosition(source, step.end, step.file, start + step.start.length);
  return source.slice(start, end);
}

function runSqlFile(step, database) {
  const file = resolve(ROOT, step.file);
  psql(database, ["-f", file]);
}

function runSqlFragment(step, database) {
  psql(database, ["-q"], { input: readSqlFragment(step) });
}

function runTypeScriptSql(step, database) {
  const file = resolve(ROOT, step.file);
  const env = localDatabaseEnvironment(database);
  const generatedSql = run(process.execPath, ["--import", "tsx", file], { env, capture: true });
  psql(database, ["-q"], { input: generatedSql });
}

function runTypeScript(step, database) {
  const file = resolve(ROOT, step.file);
  const args = ["--import", "tsx", file, ...(step.databaseArgument ? [database] : [])];
  run(process.execPath, args, { env: localDatabaseEnvironment(database) });
}

function runPython(step, database) {
  run(PYTHON, [resolve(ROOT, step.file)], { env: localDatabaseEnvironment(database) });
}

const STEP_RUNNERS = Object.freeze({
  sql: runSqlFile,
  "sql-fragment": runSqlFragment,
  "typescript-sql": runTypeScriptSql,
  typescript: runTypeScript,
  python: runPython,
});

function runStep(step, database) {
  const stepRunner = STEP_RUNNERS[step.kind];
  if (!stepRunner) fail(`Unsupported SQL runtime step: ${step.kind}`);
  stepRunner(step, database);
}

assertManifestComplete();
if (listOnly) {
  for (const fixture of sqlRuntimeFixtures) process.stdout.write(`${fixture.id}\t${fixture.source}\n`);
  process.exit(0);
}
if (process.argv.includes("--fixture") && !selectedId) fail("--fixture requires a fixture id.");
const fixtures = selectedId
  ? sqlRuntimeFixtures.filter((fixture) => fixture.id === selectedId)
  : sqlRuntimeFixtures;
if (fixtures.length === 0) fail(`Unknown SQL runtime fixture: ${selectedId}`);

const version = Number(adminSql("show server_version_num;", true).trim());
if (!Number.isSafeInteger(version) || version < 160000 || version >= 170000) {
  fail(`SQL runtime fixtures require PostgreSQL 16; server reported ${version || "an invalid version"}.`);
}

for (const [index, fixture] of fixtures.entries()) {
  const database = `il_fixture_ci_${process.pid}_${index}`;
  process.stdout.write(`\n[sql-runtime] ${fixture.id}\n`);
  createDisposableDatabase(database);
  try {
    for (const step of fixture.steps) runStep(step, database);
  } finally {
    dropDisposableDatabase(database);
  }
}

process.stdout.write(`\n[sql-runtime] PASS (${fixtures.length} fixtures)\n`);
