import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260821210000_fix_jiaowubao_student_source_envelope_precedence.sql",
    import.meta.url,
  ),
  "utf8",
);

test("JWB student source envelope precedence fix validates the nested publication object", () => {
  assert.match(
    migration,
    /create or replace function internal\.assert_jiaowubao_student_source_envelope\(\s*p_envelope jsonb\s*\)/i,
  );
  assert.match(
    migration,
    /\(p_envelope -> 'expectedPublishedJwb'\) - ARRAY\[/i,
  );
  assert.doesNotMatch(
    migration,
    /(?<!\()p_envelope -> 'expectedPublishedJwb'\s*-\s*ARRAY\[/i,
  );
  assert.match(
    migration,
    /jsonb_typeof\(p_envelope -> 'expectedPublishedJwb'\) <> 'object'/i,
  );
  assert.match(
    migration,
    /revoke all on function internal\.assert_jiaowubao_student_source_envelope\(jsonb\)[\s\S]*?from public, anon, authenticated;/i,
  );
  assert.doesNotMatch(migration, /\b(?:grant|security definer)\b/i);
});
