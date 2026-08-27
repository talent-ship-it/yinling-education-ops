import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/20260819100000_replace_legacy_teacher_subject_taxonomy.sql", import.meta.url),
  "utf8",
);
const commitContractMigration = readFileSync(
  new URL("../supabase/migrations/20260819100100_fix_teacher_import_sheet_contract.sql", import.meta.url),
  "utf8",
);
const referenceBasisMigration = readFileSync(
  new URL("../supabase/migrations/20260819100200_fix_teacher_subject_only_reference_basis.sql", import.meta.url),
  "utf8",
);
const operationalBasisMigration = readFileSync(
  new URL("../supabase/migrations/20260819100300_fix_teacher_subject_only_operational_basis.sql", import.meta.url),
  "utf8",
);

const highExamSubjects = [
  "高考 English EAL", "高考 Humanities", "高考 LOTE", "高考中文", "高考地理", "高考心理学",
  "高考法律", "高考数学", "高考化学", "高考物理", "高考生物", "高考经济", "高考会计",
  "高考商科", "高考计算机", "高考设计", "高考日语", "高考法语",
];

test("teacher taxonomy migration makes all live high-exam tabs authoritative", () => {
  for (const subject of highExamSubjects) assert.match(migration, new RegExp(`'${subject}'`));
  assert.match(migration, /sheet_position between 2 and 29/);
  assert.match(migration, /teacher_import_authoritative_subject_basis/);
  assert.match(migration, /teacher_import_authoritative_detail_basis/);
  assert.match(migration, /assert_teacher_import_authoritative_plan/);
});

test("obsolete curriculum-system tags are absent from the new K12 authority lists", () => {
  for (const obsolete of ["VCE数学科学", "VCE其他", "QCE", "HSC", "WACE", "SACE"]) {
    assert.doesNotMatch(migration, new RegExp(`'${obsolete}'`));
  }
});

test("commit-time sheet contract accepts the same live K12 taxonomy", () => {
  assert.match(commitContractMigration, /commit_teacher_import_plan_atomic/);
  for (const subject of highExamSubjects) assert.match(commitContractMigration, new RegExp(subject));
  for (const obsolete of ["VCE数学科学", "VCE其他", "QCE", "HSC", "WACE", "SACE"]) {
    assert.doesNotMatch(commitContractMigration, new RegExp(`"${obsolete}"`));
  }
  assert.match(commitContractMigration, /security definer/);
  assert.match(commitContractMigration, /revoke all on function public\.commit_teacher_import_plan_atomic/);
});

test("subject-only teachers retain deterministic authority references for every high-exam tab", () => {
  assert.match(referenceBasisMigration, /teacher_import_authoritative_ref_basis/);
  assert.match(referenceBasisMigration, /source_id \|\| '#subjects'/);
  for (const subject of highExamSubjects) assert.match(referenceBasisMigration, new RegExp(`'${subject}'`));
  for (const obsolete of ["VCE数学科学", "VCE其他", "QCE", "HSC", "WACE", "SACE"]) {
    assert.doesNotMatch(referenceBasisMigration, new RegExp(`'${obsolete}'`));
  }
});

test("subject-only operational records use the same high-exam source basis", () => {
  assert.match(operationalBasisMigration, /teacher_import_authoritative_row_basis/);
  for (const subject of highExamSubjects) assert.match(operationalBasisMigration, new RegExp(`'${subject}'`));
});
