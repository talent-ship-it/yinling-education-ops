import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationNames = {
  ledger: "20260815033000_teacher_departure_command_ledger.sql",
  permanent: "20260815034000_permanent_teacher_replacement_atomic.sql",
  departure: "20260815041000_teacher_departure_creation_atomic.sql",
};

const migrationUrl = (name) => new URL(`../supabase/migrations/${name}`, import.meta.url);

function sqlFunction(source, qualifiedName) {
  const start = source.indexOf(`create or replace function ${qualifiedName}(`);
  const end = source.indexOf("\n$$;", start);
  assert.ok(start >= 0 && end > start, `${qualifiedName} function body is missing`);
  return source.slice(start, end + 4);
}

function ledgerDdl(source) {
  const start = source.indexOf("create table if not exists internal.teacher_departure_creation_commands (");
  const revoke = "revoke all on table internal.teacher_departure_creation_commands from public, anon, authenticated, service_role;";
  const end = source.indexOf(revoke, start);
  assert.ok(start >= 0 && end > start, "teacher departure command ledger DDL is missing");
  return source.slice(start, end + revoke.length).replace(/\s+/g, " ").trim();
}

test("the shared departure ledger is installed before permanent confirmation and departure creation", async () => {
  for (const name of Object.values(migrationNames)) {
    await readFile(migrationUrl(name), "utf8");
  }
  assert.ok(migrationNames.ledger < migrationNames.permanent);
  assert.ok(migrationNames.permanent < migrationNames.departure);
});

test("330 ledger DDL exactly matches both 410 and canonical definitions after whitespace normalization", async () => {
  const [ledger, departure, canonical] = await Promise.all([
    readFile(migrationUrl(migrationNames.ledger), "utf8"),
    readFile(migrationUrl(migrationNames.departure), "utf8"),
    readFile(migrationUrl("20260813013935_operational_atomic_contracts.sql"), "utf8"),
  ]);
  assert.equal(ledgerDdl(ledger), ledgerDdl(departure));
  assert.equal(ledgerDdl(ledger), ledgerDdl(canonical));
});

test("330 is a table-boundary prelude only and cannot mutate operational state", async () => {
  const ledger = await readFile(migrationUrl(migrationNames.ledger), "utf8");
  assert.doesNotMatch(ledger, /\b(?:insert\s+into|update|delete\s+from)\b/i);
  assert.doesNotMatch(ledger, /public\.ops_state|public\.ops_mutation_log|append_operational_contract_audit/i);
  assert.doesNotMatch(ledger, /create\s+(?:or\s+replace\s+)?function\s+public\./i);
  assert.doesNotMatch(ledger, /\bgrant\b/i);
  assert.match(ledger, /alter table internal\.teacher_departure_creation_commands enable row level security/i);
  assert.match(ledger, /revoke all on table internal\.teacher_departure_creation_commands from public, anon, authenticated, service_role/i);
});

test("340 references the future ledger only inside confirm RPC and its executable fixture never calls confirm", async () => {
  const permanent = await readFile(migrationUrl(migrationNames.permanent), "utf8");
  const confirm = sqlFunction(permanent, "public.confirm_permanent_teacher_replacement_atomic");
  const references = [...permanent.matchAll(/internal\.teacher_departure_creation_commands/g)];
  assert.equal(references.length, 1);
  assert.ok(references[0].index >= permanent.indexOf(confirm));
  assert.ok(references[0].index < permanent.indexOf(confirm) + confirm.length);
  const fixtureStart = permanent.indexOf("\ndo $$", permanent.indexOf(confirm) + confirm.length);
  assert.ok(fixtureStart > 0, "permanent replacement executable fixture is missing");
  assert.doesNotMatch(
    permanent.slice(fixtureStart),
    /\bconfirm_permanent_teacher_replacement_atomic\s*\(/i,
  );
});
