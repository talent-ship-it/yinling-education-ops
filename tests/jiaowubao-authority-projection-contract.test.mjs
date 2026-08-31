import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, timeoutMigration, cronRoute, store, appSnapshot, browserParser] = await Promise.all([
  readFile(new URL("../supabase/migrations/20260831000500_jiaowubao_authoritative_source_projection.sql", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/20260831000600_bound_jiaowubao_authority_projection_timeout.sql", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/jiaowubao-schedule/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/app-snapshot/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/jiaowubao-authority-status.ts", import.meta.url), "utf8"),
]);

function functionBody(sql, name) {
  const match = sql.match(new RegExp(`create or replace function ${name.replaceAll(".", "\\.")}\\([\\s\\S]*?\\n\\$project_jiaowubao_open_api_authority\\$;`, "i"));
  assert.ok(match, `${name} function body missing`);
  return match[0];
}

test("v3 keeps complete business JSON and rejects credential-shaped keys at the database boundary", () => {
  assert.match(migration, /jiaowubao-schedule-export\/v3/);
  assert.match(migration, /octet_length\(\(item_value -> 'record'\)::text\) > 262144/);
  assert.match(migration, /__proto__\|prototype\|constructor\|sk\|secret\|token\|access\[_-\]\?token/);
  assert.doesNotMatch(migration, /\(item_value -> 'record'\) \? 'price_mem'/);
  assert.doesNotMatch(migration, /student_value \? 'price'/);
  assert.match(migration, /where record \? 'price_mem'/);
  assert.match(migration, /where record \? 'price'/);
});

test("the complete authority projection has a bounded function-only timeout", () => {
  assert.match(
    timeoutMigration,
    /alter function public\.project_jiaowubao_open_api_authority\(text,text,text\)\s+set statement_timeout = '110s'/i,
  );
  assert.doesNotMatch(timeoutMigration, /alter\s+(?:database|role|system)\b/i);
  assert.doesNotMatch(timeoutMigration, /statement_timeout\s*=\s*'0'/i);
});

test("projection is immutable, idempotent, multi-authority and never overwrites native records", () => {
  const body = functionBody(migration, "public.project_jiaowubao_open_api_authority");
  assert.match(migration, /create table if not exists internal\.jiaowubao_authority_projection_runs/);
  assert.match(migration, /create table if not exists internal\.jiaowubao_authority_projection_entities/);
  assert.match(migration, /entity_type in \('schedule','student','teacher','course','class','room'\)/);
  assert.match(migration, /projection_run\.summary = '\{\}'::jsonb/);
  assert.match(migration, /jiaowubao_authority_projection_immutable/);
  assert.match(body, /pg_advisory_xact_lock/);
  assert.match(body, /current_row\.revision is distinct from p_revision/);
  assert.match(body, /where projection_run\.snapshot_run_id = current_row\.run_id/);
  assert.match(body, /internal\.student_import_source_key\(student_value\.value -> 'jwbSourceRow'\)/);
  assert.match(body, /historicalJwbSnapshot,currentAggregate,jwbSourceRow/);
  assert.match(body, /historicalJwbSnapshot,retained,jwbSourceRow/);
  assert.match(body, /projection_run\.native_state_sha256 = native_state_sha256_value/);
  assert.match(body, /into native_state_versions_value, native_state_payloads_value/);
  assert.match(body, /jsonb_array_elements\(native_state_payloads_value -> 'students'\)/);
  assert.match(body, /stats\.source_name_count = 1 and stats\.system_name_count = 1/);
  assert.match(body, /'authorityMode', 'one_of_multiple'/);
  assert.match(body, /'nativeRecordsOverwritten', false/);
  assert.match(body, /insert into public\.ops_source_snapshots/);
  assert.doesNotMatch(body, /(?:insert into|update|delete from) public\.ops_state/i);
  assert.match(migration, /revoke all on table internal\.jiaowubao_authority_projection_entities from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.project_jiaowubao_open_api_authority\(text,text,text\) to anon, authenticated/);
});

test("every successful 30-minute path projects authority before narrow trial automation", () => {
  assert.match(store, /JIAOWUBAO_OPEN_API_AUTHORITY_PROJECT_RPC/);
  assert.match(store, /projectJiaowubaoOpenApiAuthority/);
  assert.equal((cronRoute.match(/phase = "project_authority"/g) ?? []).length, 3);
  assert.equal((cronRoute.match(/await projectAuthority\(/g) ?? []).length, 3);
  for (const match of cronRoute.matchAll(/phase = "project_authority"/g)) {
    const trialOffset = cronRoute.indexOf('phase = "project_trials"', match.index);
    assert.ok(trialOffset > match.index, "trial projection must follow authority projection");
  }
  assert.match(cronRoute, /coverage\.matchedEntityRows \+ coverage\.sourceOnlyEntityRows !== coverage\.normalizedEntityRows/);
});

test("the app snapshot reconstructs an aggregate-only browser source DTO", () => {
  assert.match(appSnapshot, /sanitizeJiaowubaoAuthoritySourceForBrowser/);
  assert.match(browserParser, /raw names, IDs and prices are never accepted here/);
  assert.match(browserParser, /rawPrices\.persistedPrivately !== true/);
  assert.match(browserParser, /rawPrices\.browserExposed !== false/);
  assert.doesNotMatch(browserParser, /priceValue|studentName|teacherName|sourceNativeId/);
});
