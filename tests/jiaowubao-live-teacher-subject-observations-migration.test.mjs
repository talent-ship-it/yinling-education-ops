import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = fs.readFileSync(path.join(
  process.cwd(),
  "supabase/migrations/20260821200000_record_pinned_jwb_live_teacher_subject_observations.sql",
), "utf8");

const productionCandidates = [
  ["sha256:07e4cbefb4ed00b40c84c5b4f797e4e788bda93e1830f175fb43e0351c36faef", 179, "433a4a706e218e62048c5765da548b3de4cc91b11139a0177b52b957fcfab470"],
  ["sha256:40722c06d11e2d27b4eea1fa105ed7e83dec99907dfdc4461854bb5ec4be1121", 90, "9a170f46875081380d1e44aeb53ee38dad9af706b238fc611faf8260b883d86c"],
  ["sha256:e75e87290b284d48bf79aae792bfa3d3fadc6e57e8c07dcdfba880b75ba03e55", 197, "e95a7f39610fa5c6bc65a2ec34a484e7070098b9883c76008416a24ab637f386"],
  ["sha256:5cbaeae1a7c5a1469070c3b225f380e65c648b122dbfb256871874f089d90b7f", 119, "c58ae526011fedca777673244af87dfbb83fe0b74c969fd6c56db348fbfd18d4"],
  ["sha256:5cb598cd33497b15edb979cf10525873fdf2440836af918a056c1eb8682acd99", 43, "e9c152ad65df1a16d8c05058e32d33c2043a15ba132f6be214e88579f884f410"],
  ["sha256:549caeed9dcaa20d9bae8f33b92cc1e333ed8504e7a632c9e2357eb0c119ac37", 64, "26a19a70610cbdee0106c561d4481f12114f8b0657e564c2695388444de07d3f"],
  ["sha256:ac79ee4de56b64b9fa93dc29bae44eade46dabae7c919fdeae5d0e2bd34782a3", 38, "834e12d04262645483a1c461a9626f93f37bc0953a778696b625ec304093ec07"],
  ["sha256:02e22160d355a809794e13e7afdb353612c9810b3a57db5136737ae060ab3b2a", 111, "9db9d185d083a5175ca1e2663d41057f96c63138c02db2885be791c486d1312f"],
  ["sha256:07d2e19e2602c3ac3bd14dc1ab658a39f3f8dcf0b23d9fafb611bb8178f45ffc", 77, "0c3d1e1224ae0b58de8543e4c6aa9351e39b2bd3fd38fdf20d11b546cfd5ce88"],
  ["sha256:ad8a183ffeec76542b2b36e8aabbee2e55d09d97b715219c7ff2ce1324e49665", 21, "91d2d31be4d247236fcbd5e56b19a3592ed47792b0f1615c8a130cbc50455cb8"],
];

test("pinned live JWB teacher evidence is observed-only and private", () => {
  assert.match(migration, /jiaowubao_live_teacher_subject_observation_batches/);
  assert.match(migration, /jiaowubao_live_teacher_subject_observations/);
  assert.match(migration, /observation_state = 'observed_only'/);
  assert.match(migration, /enable row level security/g);
  assert.match(migration, /revoke all on table internal\.jiaowubao_live_teacher_subject_observation_batches from public, anon, authenticated/);
  assert.match(migration, /revoke all on table internal\.jiaowubao_live_teacher_subject_observations from public, anon, authenticated/);
  assert.match(migration, /before update or delete on internal\.jiaowubao_live_teacher_subject_observation_batches/);
  assert.match(migration, /before update or delete on internal\.jiaowubao_live_teacher_subject_observations/);
});

test("pinned live JWB evidence verifies exact production candidate proof before persistence", () => {
  assert.match(migration, /internal\.assert_jiaowubao_direct_schedule_mapping_snapshot_integrity\(saved_run\.id\)/);
  assert.match(migration, /complete_run_count <> 1/);
  assert.match(migration, /source_run_id constant uuid := '0c143cc3-5951-4a9a-9b28-cba291e81475'/);
  assert.match(migration, /snapshot\.source_evidence_sha256 = expected\.source_evidence_sha256/);
  assert.match(migration, /snapshot\.source_event_count = expected\.source_event_count/);
  assert.match(migration, /snapshot\.teacher_label = expected\.native_teacher_name/);
  assert.match(migration, /snapshot\.course_label = expected\.course_label/);
  assert.match(migration, /inserted_count <> 10/);
  for (const [mappingKey, count, evidenceHash] of productionCandidates) {
    assert.ok(migration.includes(mappingKey));
    assert.match(migration, new RegExp(`'${mappingKey.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}', '${evidenceHash}', ${count}`));
  }
});

test("pinned live JWB evidence cannot become a scheduling or mapping authority", () => {
  assert.doesNotMatch(migration, /update\s+public\.ops_state/i);
  assert.doesNotMatch(migration, /put_jiaowubao_direct_schedule_label_mapping/i);
  assert.doesNotMatch(migration, /insert\s+into\s+internal\.jiaowubao_direct_schedule_label_mapping_decisions/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.ops_mutation_log/i);
  assert.match(migration, /pinned_jiaowubao_live_observation_teachers_mutated/);
});
