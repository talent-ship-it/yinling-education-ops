import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260821220001_jiaowubao_open_api_schedule_management_bridge.sql",
  import.meta.url,
);
const cliUrl = new URL(
  "../scripts/jiaowubao-open-api-schedule-management-staging.ts",
  import.meta.url,
);
const precedenceFixUrl = new URL(
  "../supabase/migrations/20260821220002_fix_jiaowubao_open_api_schedule_management_begin_precedence.sql",
  import.meta.url,
);
const publicPrecedenceFixUrl = new URL(
  "../supabase/migrations/20260821220003_fix_jiaowubao_open_api_schedule_public_begin_precedence.sql",
  import.meta.url,
);
const { parseManagementArguments } = await import(
  "../scripts/jiaowubao-open-api-schedule-management-staging.ts"
);

test("management bridge is postgres-only and keeps private grants revoked", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /session_user <> 'postgres'/i);
  assert.match(migration, /current_user <> 'postgres'/i);
  assert.match(migration, /security invoker/i);
  for (const name of [
    "begin", "stage", "status", "preflight", "complete", "abort",
  ]) {
    assert.match(migration, new RegExp(`jiaowubao_open_api_schedule_management_${name}`));
    assert.match(
      migration,
      new RegExp(`revoke all on function internal\\.jiaowubao_open_api_schedule_management_${name}`),
    );
  }
  assert.match(migration, /assert_jiaowubao_open_api_schedule_snapshot_envelope/);
  assert.match(migration, /assert_jiaowubao_open_api_schedule_snapshot_page/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /state = 'complete'/);
  assert.match(migration, /current_pointer_conflict/);
  assert.match(migration, /delete from internal\.jiaowubao_open_api_schedule_snapshot_ingest_items/);
  assert.match(migration, /delete from internal\.jiaowubao_open_api_schedule_snapshot_ingest_pages/);
  assert.doesNotMatch(migration, /create or replace function internal\.verify_ops_secret/);
});

test("management CLI uses Supabase db query and never reads operational secrets", async () => {
  const cli = await readFile(cliUrl, "utf8");
  assert.match(cli, /supabase@2\.115\.0/);
  assert.match(cli, /db.*query/s);
  assert.match(cli, /--project-ref.*PROJECT_REF/s);
  assert.match(cli, /JIAOWUBAO_OPS_SECRET/);
  assert.match(cli, /OPS_API_SECRET/);
  assert.match(cli, /delete childEnv\[key\]/);
  assert.doesNotMatch(cli, /database-url-env|ops-secret-env/);
  assert.match(cli, /management_(begin|stage|status|preflight|complete|abort)/);
  assert.match(cli, /statement_timeout = '30s'/);
  assert.match(cli, /--replace-current/);
});

test("management begin hashes the extracted source key, not a JSON concatenation", async () => {
  const migration = await readFile(precedenceFixUrl, "utf8");
  assert.match(
    migration,
    /'jiaowubao-open-api-schedule:'\s*\|\|\s*\(p_envelope\s*->>\s*'apiSourceKey'\)/,
  );
  assert.match(migration, /owner to postgres/i);
  assert.match(migration, /revoke all on function internal\.jiaowubao_open_api_schedule_management_begin/i);
});

test("the original server-only begin RPC has the same precedence repair", async () => {
  const migration = await readFile(publicPrecedenceFixUrl, "utf8");
  assert.match(
    migration,
    /'jiaowubao-open-api-schedule:'\s*\|\|\s*\(p_envelope\s*->>\s*'apiSourceKey'\)/,
  );
  assert.match(migration, /security definer/i);
  assert.match(migration, /revoke all on function public\.begin_jiaowubao_open_api_schedule_snapshot_ingest/i);
});

test("management CLI can safely continue a bounded page range", () => {
  const common = [
    "--input", "/private/tmp/export",
    "--profile", "/private/tmp/profile.yaml",
    "--actor", "Nixon",
  ];
  const parsed = parseManagementArguments([...common, "--page-start", "7", "--page-count", "3"]);
  assert.equal(parsed.pageStart, 7);
  assert.equal(parsed.pageCount, 3);
  assert.throws(
    () => parseManagementArguments([...common, "--page-start", "7"]),
    /参数必须合法/u,
  );
  assert.throws(
    () => parseManagementArguments([...common, "--page-start", "18", "--page-count", "0"]),
    /参数必须合法/u,
  );
});
