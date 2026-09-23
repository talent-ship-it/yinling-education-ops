import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL(
  "../supabase/migrations/20260922122825_add_wecom_receiver_health.sql",
  import.meta.url,
), "utf8");
const route = readFileSync(new URL(
  "../app/api/integrations/wecom/receiver-health/route.ts",
  import.meta.url,
), "utf8");
const privateHttp = readFileSync(new URL(
  "../lib/wecom-private-http.ts",
  import.meta.url,
), "utf8");

test("stores receiver health in a private singleton and exposes only secret-gated RPCs", () => {
  assert.match(migration, /create table if not exists internal\.wecom_receiver_health/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table internal\.wecom_receiver_health from public, anon, authenticated, service_role/i);
  for (const name of ["record_wecom_receiver_health", "get_wecom_archive_status"]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${name}\\(`, "i"));
  }
  assert.match(migration, /internal\.verify_ops_secret\(p_secret\)/i);
  assert.match(migration, /revoke all on function public\.record_wecom_receiver_health\(text, jsonb\)[\s\S]*from public, anon, authenticated/i);
});

test("health route reuses the private bridge token and bounded aggregate parser", () => {
  assert.match(route, /readTrustedWecomJsonRequest/);
  assert.match(privateHttp, /hasWecomArchiveBridgeToken/);
  assert.match(privateHttp, /readBoundedWecomArchiveJson/);
  assert.match(route, /normalizeWecomReceiverHealth/);
  assert.match(route, /recordWecomReceiverHealth/);
  assert.doesNotMatch(route, /putOpsState|service_role/i);
});
