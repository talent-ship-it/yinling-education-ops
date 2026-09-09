import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL(
  "../supabase/migrations/20260910000100_wecom_bot_text_classification.sql",
  import.meta.url,
), "utf8");
const route = readFileSync(new URL(
  "../app/api/integrations/wecom/bot-inbox/route.ts",
  import.meta.url,
), "utf8");

test("bot RPC accepts classifier metadata and promotes untouched legacy text rows", () => {
  assert.match(migration, /- 'classification' - 'studentNameHint' - 'guardianWechatHint'/i);
  assert.match(migration, /canonical_classification := coalesce/i);
  assert.match(migration, /'handover', 'renewal_follow_up', 'trial_scheduling', 'other'/i);
  assert.match(migration, /promoted_count integer := 0/i);
  assert.match(migration, /existing\.classification = 'other'/i);
  assert.match(migration, /existing\.body is not distinct from canonical_body/i);
  assert.match(migration, /'promoted', promoted_count/i);
});

test("classifier metadata remains review-only", () => {
  assert.doesNotMatch(migration, /project_wecom_archive_message/i);
  assert.doesNotMatch(migration, /insert\s+into\s+internal\.wecom_archive_media/i);
  assert.match(migration, /student_id, match_status, ingested_by/i);
  assert.match(migration, /null, 'pending', canonical_actor/i);
});

test("bot route enriches normalized callbacks before the private RPC", () => {
  assert.match(route, /enrichWecomBotRecords\(records\)/i);
  assert.match(route, /ingestWecomBotBatch\(\{ records: enrichedRecords/i);
  assert.match(route, /WecomArchiveParseError/i);
});
