import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("generic ops writes append a server-derived audit in the same transaction", async () => {
  const migration = await read("supabase/migrations/20260827000100_authoritative_generic_ops_audit.sql");
  assert.match(migration, /put_scoped_ops_state_without_authoritative_audit/);
  assert.match(migration, /internal\.append_operational_contract_audit\(/);
  assert.match(migration, /'ops_state\.' \|\| saved\.entity \|\| '\.updated'/);
  assert.match(migration, /'payloadSha256'/);
  assert.match(migration, /read_operational_contract_audit/);
  assert.match(migration, /revoke all on function public\.put_scoped_ops_state_without_authoritative_audit/);
});

test("the public audit route rejects browser-authored prose", async () => {
  const route = await read("app/api/audit/route.ts");
  assert.match(route, /export async function POST\(\)/);
  assert.match(route, /操作审计只能由服务器业务事务生成/);
  assert.doesNotMatch(route, /request\.json|body\?\.(?:action|detail|tone)|putOpsState/);
});
