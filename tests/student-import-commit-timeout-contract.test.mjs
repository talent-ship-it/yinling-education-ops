import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, route] = await Promise.all([
  readFile(new URL(
    "../supabase/migrations/20260819000500_bound_student_import_commit_timeout.sql",
    import.meta.url,
  ), "utf8"),
  readFile(new URL("../app/api/student-import/route.ts", import.meta.url), "utf8"),
]);

const rpcSignature = String.raw`public\.commit_student_import_plan_atomic\(\s*text,\s*text,\s*bigint,\s*jsonb,\s*jsonb,\s*text\s*\)`;

test("the student import timeout exception is bounded and scoped to one RPC", () => {
  assert.match(
    migration,
    new RegExp(String.raw`alter function\s+${rpcSignature}\s+set statement_timeout\s*=\s*'30s'`, "i"),
  );
  assert.equal(
    [...migration.matchAll(/set\s+statement_timeout/gi)].length,
    1,
    "the migration must configure exactly one statement timeout",
  );
  assert.doesNotMatch(migration, /\balter\s+(?:role|database|system)\b/i);
  assert.doesNotMatch(migration, /\bset\s+local\s+statement_timeout\b/i);
});

test("the timeout migration preserves the RPC security boundary", () => {
  assert.match(
    migration,
    new RegExp(String.raw`alter function\s+${rpcSignature}\s+security definer`, "i"),
  );
  assert.match(
    migration,
    new RegExp(String.raw`alter function\s+${rpcSignature}\s+set search_path\s*=\s*''`, "i"),
  );
  assert.match(
    migration,
    new RegExp(String.raw`revoke all on function\s+${rpcSignature}[\s\S]*from public, anon, authenticated`, "i"),
  );
  assert.match(
    migration,
    new RegExp(String.raw`grant execute on function\s+${rpcSignature}[\s\S]*to anon, authenticated`, "i"),
  );
});

test("the API route gives the bounded database commit enough runtime", () => {
  assert.match(route, /export const maxDuration\s*=\s*60\s*;/);
});
