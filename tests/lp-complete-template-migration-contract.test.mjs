import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260827000200_enforce_complete_lp_submission.sql", import.meta.url);

test("the database rejects legacy-minimal LP submissions while retaining legacy readers", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /mutate_lp_atomic_without_complete_template_guard/);
  assert.match(migration, /direct_enrollment_required/);
  assert.match(migration, /additionalNotes.*basicInfo.*studentFoundation.*learningGoal.*recommendedResources.*teachingLanguage.*firstLessonContent.*lessonSchedule/s);
  assert.match(migration, /handoverFromTeacher.*materialsAndContentTaught.*recommendedNextContent.*studentStrengthsAndLearningProfile.*lastHomework.*lastLessonRecordingUrl/s);
  assert.match(migration, /allocatedLessonContentAndResources/);
  assert.match(migration, /purchasedHours.*bonusHours.*lessonFrequency.*preferredTime.*coursesAndTeachers/s);
  assert.match(migration, /revoke all on function public\.mutate_lp_atomic_without_complete_template_guard/);
});
