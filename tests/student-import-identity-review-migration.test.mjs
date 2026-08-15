import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260815030000_student_import_identity_review.sql",
    import.meta.url,
  ),
  "utf8",
);

function section(start, end) {
  const startAt = migration.indexOf(start);
  const endAt = migration.indexOf(end, startAt + start.length);
  assert.ok(startAt >= 0 && endAt > startAt, `missing SQL section: ${start}`);
  return migration.slice(startAt, endAt);
}

function fnv1a(value, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(7, "0");
}

function derivedStudentId(sourceId, sourceRow) {
  const identity = JSON.stringify([sourceId, String(sourceRow).trim()]);
  const reversedIdentity = [...identity].reverse().join("");
  const masterKey = `MSK-N-${fnv1a(identity, 0x811c9dc5)}${fnv1a(reversedIdentity, 0x9e3779b9)}`;
  return `STU-M-${fnv1a(masterKey, 0x811c9dc5)}${fnv1a([...masterKey].reverse().join(""), 0x9e3779b9)}`;
}

function stableValue(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
    .join(",")}}`;
}

function opaqueKey(value) {
  return `sha256:${createHash("sha256").update(stableValue(value)).digest("hex")}`;
}

function opaqueHmac(value, secret) {
  return `sha256:${createHmac("sha256", secret).update(stableValue(value)).digest("hex")}`;
}

const reviewEvidence = {
  contract: "student-import-identity-review-v1",
  master: { sourceId: "master-source", revision: "master-rev", sourceRow: "M-1" },
  jwb: { sourceId: "jwb-source", revision: "jwb-rev", sourceRow: "J-1" },
  studentsVersion: 7,
  reviewEpoch: 0,
  decision: "create",
  studentId: derivedStudentId("master-source", "M-1"),
};

test("identity review golden keys exactly match the SQL executable fixtures", () => {
  assert.equal(reviewEvidence.studentId, "STU-M-17JDNBJ054M4GR");
  assert.equal(
    opaqueKey(reviewEvidence),
    "sha256:9c56038e54a68c9fa0cce5e225c46f5904fbc1d295aff320bcb03b742134e968",
  );
  assert.equal(
    opaqueKey({
      contract: "student-import-identity-review-candidate-v1",
      master: reviewEvidence.master,
      jwb: reviewEvidence.jwb,
      studentsVersion: 7,
      reviewEpoch: 0,
    }),
    "sha256:f9c42a080e0148d0aaa207989729d86d106fa61e4a80717f3e2634f305524503",
  );
  assert.equal(opaqueKey({
    contract: "student-import-identity-review-clear-v1",
    master: { sourceId: "master-source", revision: "master-rev" },
    jwb: { sourceId: "jwb-source", revision: "jwb-rev" },
    studentsVersion: 7,
    reviewEpoch: 0,
    identityLinkFingerprint: `sha256:${"0".repeat(64)}`,
  }), "sha256:96dffec9502997b03c0e3f4f60c86b176222d79b28386e26f936036e640375a0");
  assert.equal(opaqueHmac({
    contract: "student-import-identity-review-manual-token-v2-hmac",
    kind: "master",
    master: { sourceId: "master-source", revision: "master-rev" },
    jwb: { sourceId: "jwb-source", revision: "jwb-rev" },
    studentsVersion: 7,
    reviewEpoch: 0,
    sourceRow: "M-1",
  }, "a".repeat(64)), "sha256:90af7adb260955bebf707c5206d6cb0f489f8ccbe488b386ccc51bc3dfb8f151");
  const numericEvidence = {
    contract: "student-import-identity-review-v1",
    master: { sourceId: "master-source", revision: "master-rev", sourceRow: 42 },
    jwb: { sourceId: "jwb-source", revision: "jwb-rev", sourceRow: 7 },
    studentsVersion: 7,
    reviewEpoch: 0,
    decision: "create",
    studentId: derivedStudentId("master-source", 42),
  };
  assert.equal(numericEvidence.studentId, "STU-M-1DP0LNI04WMC8C");
  assert.equal(
    opaqueKey(numericEvidence),
    "sha256:8b4ed81781e0b8b878b76c487f7f53cc3dae4eecee960d1742cea00fb9b4a4d7",
  );
  assert.equal(
    opaqueKey({
      contract: "student-import-identity-review-candidate-v1",
      master: numericEvidence.master,
      jwb: numericEvidence.jwb,
      studentsVersion: 7,
      reviewEpoch: 0,
    }),
    "sha256:4a6f16107902a56e738fe4fb1562154fe6c8bdbcb6a6e95fa79d7d24483ad23d",
  );
  assert.match(migration, /student_import_identity_review_hash_fixture_mismatch/);
  assert.match(migration, /student_import_identity_review_numeric_hash_fixture_mismatch/);
  assert.match(migration, /student_import_identity_review_create_candidate_fixture_mismatch/);
  assert.match(migration, /student_import_identity_review_uniqueness_fixture_mismatch/);
  assert.match(
    migration,
    /"status":"不活跃 \+ 无课时"[\s\S]*student_import_identity_review_uniqueness_fixture_mismatch/,
  );
  assert.match(migration, /student_import_identity_review_duplicate_resolved_fixture_mismatch/);
  assert.match(migration, /student_import_duplicate_selected_identity_fixture_mismatch/);
  assert.match(migration, /student_import_identity_coverage_fixture_mismatch/);
  assert.match(migration, /student_import_identity_review_create_projection_fixture_mismatch/);
  assert.match(migration, /student_import_identity_review_manual_trial_merge_fixture_mismatch/);
  assert.match(migration, /student_import_identity_review_archive_merge_fixture_mismatch/);
  assert.match(migration, /student_import_identity_review_non_derived_fixture_missing/);
});

test("source revisions remain permanently bound to exact source evidence", () => {
  const evidence = section(
    "create table if not exists internal.student_import_source_revision_evidence",
    "create or replace function internal.student_import_master_review_name_key",
  );
  assert.match(evidence, /primary key \(source_kind, revision\)/);
  assert.match(evidence, /source_id text not null/);
  assert.match(evidence, /rows_sha256 text not null/);
  assert.match(evidence, /alter table internal\.student_import_source_revision_evidence enable row level security/);
  assert.match(evidence, /revoke all on table internal\.student_import_source_revision_evidence[\s\S]*from public, anon, authenticated/);

  const jwbMutex = evidence.indexOf("student_import_source:jwb");
  const masterMutex = evidence.indexOf("student_import_source:master");
  const historyScan = evidence.indexOf("student_import.source_ingested");
  assert.ok(jwbMutex >= 0 && masterMutex > jwbMutex && historyScan > masterMutex);

  assert.match(evidence, /audit_entry\.action = 'student_import\.source_ingested'/);
  assert.match(evidence, /from internal\.student_import_source_rows current_source/);
  assert.match(evidence, /from internal\.student_import_source_revision_evidence saved_evidence/);
  assert.match(evidence, /count\(distinct \(evidence\.source_id, evidence\.rows_sha256\)\) > 1/);
  assert.match(evidence, /message = 'student_import_revision_history_invalid'/);
  assert.match(evidence, /message = 'student_import_revision_history_conflict'/);

  const trigger = section(
    "create or replace function internal.enforce_student_import_source_revision_evidence",
    "create or replace function internal.student_import_master_review_name_key",
  );
  const mutex = trigger.indexOf("student_import_source_revision:' || new.source_kind || ':' || new.revision");
  const historyLock = trigger.indexOf("from internal.student_import_source_revision_evidence evidence");
  assert.ok(mutex >= 0 && historyLock > mutex);
  assert.match(trigger, /historical\.source_id <> new\.source_id[\s\S]*historical\.rows_sha256 <> new\.rows_sha256/);
  assert.match(trigger, /errcode = '23505'[\s\S]*message = 'student_import_revision_conflict'/);
  assert.match(trigger, /before insert or update of source_id, revision, rows_sha256/);
  assert.match(trigger, /for each row execute function internal\.enforce_student_import_source_revision_evidence\(\)/);
  assert.match(trigger, /revoke all on function internal\.enforce_student_import_source_revision_evidence\(\)[\s\S]*from public, anon, authenticated/);
});

test("review candidates use the closed Han evidence and exact opaque-key contracts", () => {
  const nameKey = section(
    "create or replace function internal.student_import_master_review_name_key",
    "create or replace function internal.student_import_identity_review_key",
  );
  const key = section(
    "create or replace function internal.student_import_identity_review_key",
    "create or replace function internal.student_import_identity_review_candidates",
  );
  const candidates = section(
    "create or replace function internal.student_import_identity_review_candidates",
    "create or replace function public.put_student_import_identity_review_decision",
  );

  assert.match(nameKey, /internal\.student_import_display_name\(p_name\)/);
  assert.match(nameKey, /code_point between 13312 and 19903/);
  assert.match(nameKey, /code_point between 196608 and 201551/);
  assert.match(nameKey, /char_length\(current_run\) >= 2/);
  assert.match(nameKey, /cardinality\(qualifying_runs\) = 1/);

  assert.match(key, /internal\.student_import_stable_value\(evidence\)/);
  assert.match(key, /'contract', p_contract/);
  assert.match(key, /'master',[\s\S]*'sourceId',[\s\S]*'revision',[\s\S]*'sourceRow'/);
  assert.match(key, /'jwb',[\s\S]*'sourceId',[\s\S]*'revision',[\s\S]*'sourceRow'/);
  assert.match(key, /'studentsVersion', p_students_version/);
  assert.match(key, /'reviewEpoch', p_review_epoch/);
  assert.match(key, /'decision', p_decision[\s\S]*'studentId', p_student_id/);
  assert.match(key, /student-import-identity-review-manual-token-v2-hmac/);
  assert.match(key, /extensions\.hmac\([\s\S]*p_token_secret[\s\S]*'sha256'/);

  assert.match(
    candidates,
    /internal\.student_import_master_review_name_key\(jwb_row\.value ->> 'name'\)/,
  );
  assert.doesNotMatch(candidates, /internal\.student_import_cjk_name_key/);
  assert.match(candidates, /select count\(\*\) from master_keys sibling/);
  assert.match(candidates, /select count\(\*\) from jwb_keys sibling/);
  assert.match(candidates, /select 'merge'::text as decision[\s\S]*resolved\.match_count = 1/);
  assert.match(candidates, /union all[\s\S]*select 'create'::text, resolved\.derived_student_id/);
  assert.match(candidates, /resolved\.derived_identity_available/);
  assert.match(candidates, /student_import_student_id\([\s\S]*owner_row -> 'sourceRow'[\s\S]*resolved\.existing_student_id/);
  assert.match(candidates, /internal\.student_import_student_id\(p_master_source_id, master\.source_row\)/);
  assert.match(candidates, /student-import-identity-review-candidate-v1/);
  assert.match(candidates, /student-import-identity-review-v1/);
  assert.ok(
    candidates.indexOf("from jsonb_array_elements(p_master_rows)")
      < candidates.indexOf("candidate.status in ("),
    "all master rows must participate in global review-key uniqueness before eligibility",
  );
});

test("the public review RPC accepts only an opaque decision and recomputes under all locks", () => {
  const rpc = section(
    "create or replace function public.put_student_import_identity_review_decision",
    "-- Covers the identities outside the narrow name-evidence suggestion set.",
  );
  const signature = rpc.slice(0, rpc.indexOf("returns jsonb"));
  assert.match(signature, /p_secret text,[\s\S]*p_resolution_key text,[\s\S]*p_decision text,[\s\S]*p_actor text/);
  assert.doesNotMatch(signature, /p_(?:master|jwb|student|source|revision|name|link)/i);
  assert.match(rpc, /internal\.verify_ops_secret\(p_secret\)/);
  assert.match(rpc, /p_decision not in \('merge', 'create'\)/);
  assert.match(rpc, /p_actor not in \('Nixon', 'Ops Admin'\)/);

  const jwbLock = rpc.indexOf("source_state.source_kind = 'jwb'");
  const singletonMutex = rpc.indexOf("student_import_identity_link_set:singleton");
  const masterLock = rpc.indexOf("source_state.source_kind = 'master'");
  const linkLock = rpc.indexOf("identity_state.singleton");
  const studentsLock = rpc.indexOf("state_row.entity = 'students'");
  const recompute = rpc.indexOf("candidates := internal.student_import_identity_review_candidates");
  assert.ok(singletonMutex >= 0 && jwbLock > singletonMutex);
  assert.ok(masterLock > jwbLock && linkLock > masterLock);
  assert.ok(studentsLock > linkLock && recompute > studentsLock);
  assert.ok(rpc.indexOf("duplicate_snapshot := internal.student_import_master_duplicate_snapshot") < recompute);
  assert.match(rpc, /into resolved_master_rows[\s\S]*duplicate_snapshot -> 'decisions'/);
  assert.equal([...rpc.matchAll(/for update;/gi)].length, 4);
  assert.match(rpc, /option_value\.value ->> 'resolutionKey' = p_resolution_key/);
  assert.match(rpc, /option_value\.value ->> 'decision' = p_decision/);
  assert.match(rpc, /student_import_identity_review_unavailable/);

  const exactReplay = rpc.indexOf("if exists (\n    select 1 from jsonb_array_elements(active_links)");
  const audit = rpc.indexOf("student_import.identity_review_confirmed");
  assert.ok(exactReplay >= 0 && audit > exactReplay);
  assert.match(rpc, /active_links \|\| jsonb_build_array\(next_link\)/);
  assert.match(rpc, /count\(distinct internal\.student_import_source_key\(link -> 'masterSourceRow'\)\)/);
  assert.match(rpc, /count\(distinct internal\.student_import_source_key\(link -> 'jwbSourceRow'\)\)/);
  assert.match(rpc, /count\(distinct trim\(link ->> 'studentId'\)\)/);
  assert.match(rpc, /student_import_identity_review_conflict/);
  assert.match(rpc, /student_import\.identity_review_confirmed/);

  for (const returned of rpc.matchAll(/return jsonb_build_object\(([\s\S]*?)\n\s*\);/gi)) {
    assert.doesNotMatch(returned[1], /'studentId'|'reviewKey'/i);
  }
  assert.match(migration, /revoke all on function public\.put_student_import_identity_review_decision\(text, text, text, text\)[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.put_student_import_identity_review_decision\(text, text, text, text\)[\s\S]*to anon, authenticated/);

  const legacyClear = section(
    "-- Keep the clear-only compatibility RPC in the same singleton mutex.",
    "create or replace function public.clear_student_import_identity_links",
  );
  assert.match(legacyClear, /jsonb_array_length\(p_links\) <> 0/);
  assert.match(legacyClear, /pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\([\s\S]*student_import_identity_link_set:singleton/);
  assert.ok(
    legacyClear.indexOf("student_import_identity_link_set:singleton")
      < legacyClear.indexOf("s.source_kind = 'jwb'"),
  );
  assert.match(migration, /revoke all on function public\.put_student_import_identity_links\(text, jsonb, jsonb, text\)[\s\S]*from public, anon, authenticated/);
  assert.doesNotMatch(legacyClear, /grant execute on function public\.put_student_import_identity_links/);

  const clear = section(
    "create or replace function public.clear_student_import_identity_links",
    "revoke all on function public.put_student_import_identity_review_decision",
  );
  const clearSignature = clear.slice(0, clear.indexOf("returns jsonb"));
  assert.match(clearSignature, /p_secret text,[\s\S]*p_resolution_key text,[\s\S]*p_actor text/);
  assert.doesNotMatch(clearSignature, /jsonb|p_(?:links?|source|revision|student)/i);
  assert.match(clear, /expected_key := internal\.student_import_identity_clear_key/);
  assert.match(clear, /expected_key <> p_resolution_key[\s\S]*student_import_identity_review_unavailable/);
  assert.match(clear, /next_epoch := current_epoch \+ 1/);
  assert.match(clear, /review_epoch = excluded\.review_epoch/);
  assert.match(clear, /saved\.last_clear_key = p_resolution_key/);
  assert.match(clear, /saved\.link_count = 0[\s\S]*'unchanged', true/);
  assert.match(clear, /update internal\.student_import_master_duplicate_resolutions resolution set[\s\S]*selected_student_id = null/);
  assert.match(clear, /'unboundDuplicateDecisionCount', unbound_duplicate_count/);
  assert.match(clear, /student_import\.identity_links_cleared/);
  assert.match(clear, /'reviewEpoch', next_epoch/);
  assert.match(migration, /revoke all on function public\.clear_student_import_identity_links\(text, text, text\)[\s\S]*grant execute on function public\.clear_student_import_identity_links\(text, text, text\)/);
});

test("manual pairing accepts only opaque row tokens and recomputes a globally unique link under locks", () => {
  const rpc = section(
    "create or replace function public.put_student_import_identity_review_pair",
    "create or replace function internal.student_import_selected_duplicate_identity_matches",
  );
  const signature = rpc.slice(0, rpc.indexOf("returns jsonb"));
  assert.match(signature, /p_secret text,[\s\S]*p_token_secret text,[\s\S]*p_master_token text,[\s\S]*p_jwb_token text,[\s\S]*p_decision text,[\s\S]*p_existing_token text,[\s\S]*p_actor text/);
  assert.doesNotMatch(signature, /p_(?:master_source|jwb_source|source_row|student_id|links?)/i);
  assert.match(rpc, /internal\.verify_ops_secret\(p_secret\)/);
  assert.match(rpc, /p_decision not in \('merge', 'create'\)/);
  assert.match(rpc, /p_token_secret[\s\S]*!~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(rpc, /student_import_identity_link_set:singleton/);
  assert.equal([...rpc.matchAll(/for update;/gi)].length, 4);
  assert.match(rpc, /duplicate_snapshot := internal\.student_import_master_duplicate_snapshot/);
  assert.match(rpc, /pending_candidate[\s\S]*duplicate_snapshot -> 'decisions'/);
  assert.match(rpc, /student_import_identity_manual_token\([\s\S]*'master'/);
  assert.match(rpc, /student_import_identity_manual_token\([\s\S]*'jwb'/);
  assert.match(rpc, /student_import_identity_manual_token\([\s\S]*'existing'/);
  assert.match(rpc, /selected_master -> 'sourceRow'/);
  assert.match(rpc, /selected_jwb -> 'sourceRow'/);
  assert.match(rpc, /target_student_id := internal\.student_import_student_id/);
  assert.match(rpc, /owner_row[\s\S]*student_import_identity_review_conflict/);
  assert.match(rpc, /active_links \|\| jsonb_build_array\(next_link\)/);
  assert.match(rpc, /student_import\.identity_manual_pair_confirmed/);
  const audit = rpc.slice(rpc.indexOf("student_import.identity_manual_pair_confirmed"));
  assert.doesNotMatch(audit, /p_token_secret/);
  for (const returned of rpc.matchAll(/return jsonb_build_object\(([\s\S]*?)\n\s*\);/gi)) {
    assert.doesNotMatch(returned[1], /'studentId'|'masterSourceRow'|'jwbSourceRow'/i);
  }
  assert.match(migration, /revoke all on function public\.put_student_import_identity_review_pair\([\s\S]*grant execute on function public\.put_student_import_identity_review_pair\(/);
});

test("read, duplicate resolution, projection and commit all consume nonempty reviewed links", () => {
  const getLatest = section(
    "create or replace function public.get_latest_student_import_source_rows",
    "-- Duplicate-row decisions",
  );
  const duplicate = section(
    "create or replace function public.put_student_import_master_duplicate_resolution",
    "revoke all on function public.put_student_import_identity_review_decision",
  );
  const projection = section(
    "create or replace function internal.student_import_canonical_projection",
    "revoke all on function internal.student_import_canonical_projection",
  );
  const commit = section(
    "create or replace function public.commit_student_import_plan_atomic",
    "revoke all on function public.commit_student_import_plan_atomic",
  );
  const coverage = section(
    "create or replace function internal.student_import_identity_coverage_ready",
    "-- The final write boundary consumes",
  );

  assert.doesNotMatch(getLatest, /link_set\.link_count\s*=\s*0/);
  assert.doesNotMatch(duplicate, /link_set\.link_count\s*=\s*0/);
  assert.doesNotMatch(commit, /link_set\.link_count\s*=\s*0/);
  assert.match(getLatest, /link_set\.students_version = students_state\.version[\s\S]*then link_set\.links/);
  assert.match(duplicate, /link_set\.students_version = students_state\.version[\s\S]*active_links := link_set\.links/);
  assert.match(duplicate, /group_link_count > 1[\s\S]*student_master_duplicate_identity_unavailable/);
  assert.match(duplicate, /group_link_count = 1[\s\S]*p_decision <> 'select'[\s\S]*selected_source_row[\s\S]*group_link -> 'masterSourceRow'/);
  assert.match(duplicate, /selected_student_id := group_link ->> 'studentId'/);

  assert.match(projection, /if linked and existing_student is null[\s\S]*student_id <> internal\.student_import_student_id/);
  assert.match(projection, /message = 'invalid_student_import_linked_identity'/);
  assert.match(
    commit,
    /link_set\.students_version = current_state\.version[\s\S]*replaying_prior[\s\S]*link_set\.students_version = p_expected_student_version[\s\S]*then link_set\.links/,
  );
  assert.match(commit, /link ->> 'studentId' <> internal\.student_import_student_id\([\s\S]*master\.source_id, link -> 'masterSourceRow'/);
  assert.match(commit, /reviewed_link ->> 'studentId' = old_student ->> 'id'/);
  assert.match(commit, /reviewed_link ->> 'masterSourceRow' =[\s\S]*imported_student ->> 'sourceRow'/);
  assert.match(commit, /internal\.student_import_identity_coverage_ready\(expected_students\)/);
  assert.match(commit, /message = 'student_import_identity_coverage_required'/);
  assert.match(
    coverage,
    /'在读', '活跃 \+ 有课时', '不活跃 \+ 有课时', '在读 \+ 加课待排'/,
  );
  assert.match(coverage, /coalesce\(imported_student ->> 'importArchived', 'false'\) <> 'true'/);
  assert.match(commit, /student_import_commit:' \|\| p_plan_fingerprint/);
  assert.match(commit, /locked_state_count <> cardinality\(reference_entities\)[\s\S]*student_reference_state_unavailable/);
  assert.ok(
    commit.indexOf("student_import_commit:' || p_plan_fingerprint")
      < commit.indexOf("from internal.student_import_commits c"),
  );
  assert.match(commit, /update internal\.student_import_identity_link_sets identity_state set[\s\S]*students_version = current_state\.version/);
  assert.match(
    commit,
    /insert into internal\.student_import_commits \([\s\S]*master_source_id, master_revision, jwb_source_id, jwb_revision,[\s\S]*master_rows_sha256, jwb_rows_sha256[\s\S]*p_plan_fingerprint, master\.source_id, master\.revision, jwb\.source_id, jwb\.revision,[\s\S]*master\.rows_sha256, jwb\.rows_sha256/,
  );
  assert.match(
    commit,
    /replaying_prior[\s\S]*prior\.master_source_id is null[\s\S]*prior\.master_rows_sha256 is null[\s\S]*prior\.master_source_id <> master\.source_id[\s\S]*prior\.master_rows_sha256 <> master\.rows_sha256[\s\S]*prior\.jwb_rows_sha256 <> jwb\.rows_sha256/,
  );
  assert.match(commit, /insert into internal\.student_import_master_duplicate_resolutions[\s\S]*current_state\.version/);
  assert.match(commit, /student_import_duplicate_carry_mismatch/);
  assert.match(commit, /replaying_prior[\s\S]*link_set\.students_version = p_expected_student_version/);
  assert.match(commit, /duplicate_decision_state\.version := p_expected_student_version/);
  assert.match(
    commit,
    /carried_duplicate_snapshot := internal\.student_import_master_duplicate_snapshot[\s\S]*'studentsVersion', p_expected_student_version/,
  );
  assert.match(
    commit,
    /jsonb_agg\(carried_decision_item\.value[\s\S]*order by old_candidate\.value ->> 'resolutionGroupKey'/,
  );
  assert.match(commit, /message = 'student_import_duplicate_replay_mapping_mismatch'/);

  const carryStart = commit.indexOf("-- Carry current, locked review evidence");
  const commitInsert = commit.indexOf("insert into internal.student_import_commits", carryStart);
  assert.ok(carryStart >= 0 && commitInsert > carryStart);
  const carry = commit.slice(carryStart, commitInsert);
  assert.match(carry, /link_set\.students_version = p_expected_student_version/);
  assert.match(carry, /students_version = current_state\.version/);
  assert.match(carry, /resolution\.students_version = p_expected_student_version/);
  assert.match(carry, /master\.source_id, master\.revision, current_state\.version/);
  assert.match(
    carry,
    /\(carried_duplicate_snapshot -> 'decisions'\) @>[\s\S]*\(duplicate_snapshot -> 'decisions'\)[\s\S]*and \(duplicate_snapshot -> 'decisions'\) @>[\s\S]*\(carried_duplicate_snapshot -> 'decisions'\)/,
  );
  assert.doesNotMatch(carry, /delete\s+from\s+internal\.student_import_master_duplicate_resolutions/i);

  const oldMigrationPromise = readFile(
    new URL("../supabase/migrations/20260813013935_operational_atomic_contracts.sql", import.meta.url),
    "utf8",
  );
  return oldMigrationPromise.then((oldMigration) => {
    const clearStart = oldMigration.indexOf(
      "create or replace function public.put_student_import_identity_links",
    );
    const clearEnd = oldMigration.indexOf(
      "revoke all on function public.put_student_import_source_rows",
      clearStart,
    );
    assert.match(oldMigration.slice(clearStart, clearEnd), /jsonb_array_length\(p_links\) <> 0/);
  });
});

test("lost-response replay returns only a fully revalidated prior commit result", () => {
  const replay = section(
    "create or replace function public.get_student_import_commit_replay_result",
    "revoke all on function public.get_student_import_commit_replay_result",
  );
  const signature = replay.slice(0, replay.indexOf("returns table"));
  assert.match(
    signature,
    /p_secret text,[\s\S]*p_plan_fingerprint text,[\s\S]*p_expected_student_version bigint,[\s\S]*p_actor text/,
  );
  assert.doesNotMatch(signature, /jsonb|p_(?:students|sources?|rows?|links?|revisions?)/i);
  assert.match(
    replay,
    /returns table \([\s\S]*entity text,[\s\S]*version bigint,[\s\S]*updated_at timestamptz,[\s\S]*updated_by text/,
  );
  assert.match(replay, /internal\.verify_ops_secret\(p_secret\)/);
  assert.match(replay, /message = 'student_import_commit_replay_unavailable'/);
  assert.match(replay, /errcode = '40001'[\s\S]*message = 'student_import_commit_replay_source_changed'/);
  assert.match(replay, /message = 'student_import_commit_replay_state_changed'/);
  assert.match(replay, /message = 'student_import_commit_replay_evidence_changed'/);

  const fuLock = replay.indexOf("lock table internal.student_fu_attachments in share mode");
  const commitMutex = replay.indexOf("student_import_commit:' || p_plan_fingerprint");
  const priorLock = replay.indexOf("from internal.student_import_commits committed");
  const jwbLock = replay.indexOf("source_state.source_kind = 'jwb'");
  const masterLock = replay.indexOf("source_state.source_kind = 'master'");
  const linkLock = replay.indexOf("identity_state.singleton");
  const stateLocks = replay.indexOf("where state_row.entity = any(reference_entities)");
  assert.ok(fuLock >= 0 && commitMutex > fuLock && priorLock > commitMutex);
  assert.ok(jwbLock > priorLock && masterLock > jwbLock && linkLock > masterLock && stateLocks > linkLock);
  assert.equal([...replay.matchAll(/\n\s*for update;/gi)].length, 4);
  assert.match(replay, /'bookings', 'files', 'lpItems', 'messages', 'operations',[\s\S]*'payroll', 'renewals', 'students', 'tasks'/);
  assert.match(replay, /array_position\(reference_entities, state_row\.entity\)[\s\S]*for update[\s\S]*loop/);

  assert.match(replay, /p_expected_student_version \+ 1 <> prior\.students_version/);
  assert.match(replay, /prior\.master_source_id is null[\s\S]*prior\.jwb_source_id is null/);
  assert.match(replay, /prior\.master_rows_sha256 is null[\s\S]*prior\.jwb_rows_sha256 is null/);
  assert.match(
    replay,
    /master\.source_id <> prior\.master_source_id[\s\S]*jwb\.source_id <> prior\.jwb_source_id[\s\S]*master\.rows_sha256 <> prior\.master_rows_sha256[\s\S]*jwb\.rows_sha256 <> prior\.jwb_rows_sha256[\s\S]*master\.revision <> prior\.master_revision[\s\S]*jwb\.revision <> prior\.jwb_revision/,
  );
  assert.match(replay, /students_state\.version <> prior\.students_version/);
  assert.match(replay, /prior\.students_sha256[\s\S]*booking_state\.version <> prior\.bookings_version[\s\S]*prior\.bookings_sha256/);
  assert.match(replay, /fu_attachment_snapshot ->> 'fingerprint' <> prior\.fu_attachment_fingerprint/);
  assert.match(replay, /link_set\.students_version = students_state\.version[\s\S]*prior\.identity_link_fingerprint/);
  assert.match(replay, /duplicate_decision_state\.version := p_expected_student_version/);
  assert.match(
    replay,
    /jsonb_agg\(carried_decision_item\.value[\s\S]*order by old_candidate\.value ->> 'resolutionGroupKey'/,
  );
  assert.match(replay, /prior\.master_duplicate_resolution_fingerprint/);
  assert.match(replay, /reference_state\.entity = any\(reference_entities\)/);
  assert.match(replay, /locked_state_count <> cardinality\(reference_entities\)[\s\S]*student_import_commit_replay_state_changed/);
  assert.match(replay, /jsonb_array_elements\(booking_state\.payload\) booking/);
  assert.match(replay, /from internal\.student_fu_attachments attachment/);
  assert.match(replay, /expected_students := internal\.student_import_canonical_projection/);
  assert.match(replay, /expected_students is distinct from students_state\.payload/);
  assert.match(
    replay,
    /return query select[\s\S]*'students'::text,[\s\S]*prior\.students_version,[\s\S]*prior\.committed_at,[\s\S]*prior\.committed_by/,
  );
  assert.match(
    migration,
    /revoke all on function public\.get_student_import_commit_replay_result\(text, text, bigint, text\)[\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /grant execute on function public\.get_student_import_commit_replay_result\(text, text, bigint, text\)[\s\S]*to anon, authenticated/,
  );
  assert.match(
    migration,
    /alter table internal\.student_import_commits[\s\S]*add column if not exists master_source_id text[\s\S]*add column if not exists jwb_source_id text[\s\S]*add column if not exists master_rows_sha256 text[\s\S]*add column if not exists jwb_rows_sha256 text/,
  );
});

test("duplicate snapshots validate selected identities and carry evidence across commits", () => {
  const selectedIdentity = section(
    "create or replace function internal.student_import_selected_duplicate_identity_matches",
    "create or replace function internal.student_import_master_duplicate_snapshot",
  );
  const snapshot = section(
    "create or replace function internal.student_import_master_duplicate_snapshot",
    "-- Current-revision nonempty reviewed links",
  );

  assert.match(selectedIdentity, /internal\.student_import_source_key\(reviewed_link -> 'masterSourceRow'\)/);
  assert.match(selectedIdentity, /trim\(reviewed_link ->> 'studentId'\) = trim\(p_selected_student_id\)/);
  assert.match(selectedIdentity, /internal\.student_import_source_key\(jwb_row -> 'sourceRow'\)/);
  assert.match(snapshot, /link_set\.master_source_id = p_master\.source_id/);
  assert.match(snapshot, /link_set\.students_version = p_students\.version/);
  assert.match(snapshot, /resolution\.selected_student_id is null[\s\S]*student_import_selected_duplicate_identity_matches/);
  assert.doesNotMatch(snapshot, /r\.selected_student_id is null/);
  assert.match(snapshot, /'selectedStudentId', resolution\.selected_student_id/);

  assert.match(migration, /revoke all on function internal\.student_import_selected_duplicate_identity_matches\([\s\S]*from public, anon, authenticated/);
  assert.match(migration, /revoke all on function internal\.student_import_master_duplicate_snapshot\([\s\S]*from public, anon, authenticated/);
  assert.match(migration, /revoke all on function internal\.student_import_identity_coverage_ready\(jsonb\)[\s\S]*from public, anon, authenticated/);
});
