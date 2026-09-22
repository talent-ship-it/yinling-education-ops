// Generate guarded, rollback-only SQL for a local disposable database that has
// the operational settlement contract, manual-settlement migration and the
// joint-attendance migration applied. No connection or credentials are loaded.
import { readFileSync } from "node:fs";
import { prepareLessonOccurrenceSettlement } from "../../lib/lesson-occurrence-service.ts";
import type { LessonAttendanceEvidence } from "../../lib/lesson-occurrences.ts";

const quote = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const start = "2026-09-07T10:00:00.000Z";
const finish = "2026-09-07T11:00:00.000Z";
const party = (userId: string, joinedAt: string, leftAt: string) => ({
  userId, accumulatedSeconds: (Date.parse(leftAt) - Date.parse(joinedAt)) / 1000, joinLeave: [{ joinedAt, leftAt }],
});
const normal: LessonAttendanceEvidence = { student: party("S1", start, finish), teacher: party("T1", start, finish) };
const cases: Array<{ name: string; evidence: LessonAttendanceEvidence; normal: boolean; timezone?: string; date?: string }> = [
  { name: "early departure", evidence: { ...normal, teacher: party("T1", "2026-09-07T09:45:00Z", "2026-09-07T10:45:00Z") }, normal: false },
  { name: "full lesson", evidence: normal, normal: true },
  { name: "duration only", evidence: { student: { userId: "S1", accumulatedSeconds: 3600 }, teacher: { userId: "T1", accumulatedSeconds: 3600 } }, normal: false },
  { name: "overlap and reconnect", evidence: {
    student: { userId: "S1", accumulatedSeconds: 3600, joinLeave: [{ joinedAt: start, leftAt: "2026-09-07T10:40:00Z" }, { joinedAt: "2026-09-07T10:30:00Z", leftAt: finish }] },
    teacher: { userId: "T1", accumulatedSeconds: 3300, joinLeave: [{ joinedAt: start, leftAt: "2026-09-07T10:20:00Z" }, { joinedAt: "2026-09-07T10:25:00Z", leftAt: finish }] },
  }, normal: true },
  { name: "after-lesson time", evidence: { student: party("S1", "2026-09-07T10:15:00Z", "2026-09-07T11:15:00Z"), teacher: party("T1", "2026-09-07T10:15:00Z", "2026-09-07T11:15:00Z") }, normal: false },
  { name: "Melbourne DST", date: "2026-01-07", timezone: "Australia/Melbourne", evidence: {
    student: party("S1", "2026-01-06T23:00:00Z", "2026-01-07T00:00:00Z"), teacher: party("T1", "2026-01-06T23:00:00Z", "2026-01-07T00:00:00Z"),
  }, normal: true },
];
let sql = readFileSync(new URL("assert-disposable-database.sql", import.meta.url), "utf8") + "\nbegin;\n";
sql += "insert into internal.ops_secrets(key,sha256_hex) values('workspace_api',encode(extensions.digest('attendance-fixture-secret','sha256'),'hex')) on conflict(key) do update set sha256_hex=excluded.sha256_hex;\n";
for (const [index, fixture] of cases.entries()) {
  const id = `ATTENDANCE-${index}`;
  const date = fixture.date ?? "2026-09-07";
  const occurrenceId = `${id}:${date}`;
  const reference = `fixture:attendance-${index}`;
  const capturedAt = fixture.date ? "2026-01-07T00:00:00.000Z" : finish;
  const rows = [
    { entity: "bookings", payload: [{ id, date, start: "10:00", timezone: fixture.timezone ?? "UTC", duration: 60, studentId: "S1", teacherId: "T1", packageId: "P1", course: "English" }] },
    { entity: "students", payload: [{ id: "S1", owner: "Abby", lessonPackages: [{ id: "P1", name: "English", subjectIds: ["English"], consumedHours: 0, purchaseRecords: [{ id: "BUY", purchasedAt: "2026-09-01T00:00:00Z", hours: 10 }] }], lessonLedger: [] }] },
    { entity: "teachers", payload: [{ id: "T1", name: "Synthetic" }] }, { entity: "payroll", payload: [] },
  ].map((row) => ({ ...row, version: 1, updated_at: "2026-09-01T00:00:00Z", updated_by: "fixture" }));
  const request = { occurrenceId, expectedVersion: 1, attendanceEvidenceReference: reference };
  const prepared = prepareLessonOccurrenceSettlement({ rows, request, actor: "BigBlueButton", fullAdmin: false, trustedProvider: "bbb", attendance: fixture.evidence, completedAt: capturedAt });
  for (const row of rows) sql += `insert into public.ops_state(entity,payload,version,updated_by) values('${row.entity}',${quote(row.payload)},1,'fixture') on conflict(entity) do update set payload=excluded.payload,version=1;\n`;
  sql += `do $$ begin perform public.put_lesson_attendance_evidence('attendance-fixture-secret','${reference}','${occurrenceId}','${capturedAt}',${quote(fixture.evidence)},'bbb','BigBlueButton'); end $$;\n`;
  const call = (settlement: unknown, replay = false) => `public.complete_lesson_occurrence_atomic('attendance-fixture-secret','${occurrenceId}',${replay ? "(select version from public.ops_state where entity='bookings')" : "1"},${replay ? "(select jsonb_object_agg(entity,version) from public.ops_state where entity in ('bookings','students','teachers','payroll'))" : quote(prepared.stateVersions)},'${prepared.idempotencyKey}',${quote(settlement)},'${reference}',null,'BigBlueButton','${String(index + 1).padStart(64, "0")}')`;
  if (index === 0) {
    const forged = prepareLessonOccurrenceSettlement({ rows, request, actor: "BigBlueButton", fullAdmin: false, trustedProvider: "bbb", attendance: normal, completedAt: finish });
    sql += `do $$ begin begin perform * from ${call(forged.settlement)}; raise exception 'forged_normal_accepted'; exception when invalid_parameter_value then if sqlerrm <> 'attendance_evidence_classification_mismatch' then raise; end if; end; end $$;\n`;
  }
  sql += `do $$ declare result record; begin select * into result from ${call(prepared.settlement)}; if result.disposition <> '${fixture.normal ? "completed" : "abnormal"}' or not result.applied then raise exception 'wrong_result_${index}'; end if; end $$;\n`;
  sql += `do $$ declare result record; begin select * into result from ${call(prepared.settlement, true)}; if result.applied then raise exception 'replay_applied_${index}'; end if; end $$;\n`;
  sql += `do $$ begin if (select (payload->0->'lessonPackages'->0->>'consumedHours')::numeric from public.ops_state where entity='students') <> ${fixture.normal ? 1 : 0} or (select jsonb_array_length(payload) from public.ops_state where entity='payroll') <> ${fixture.normal ? 1 : 0} then raise exception 'wrong_financial_effect_${index}'; end if; end $$;\n`;
}
sql += `do $$ begin if has_function_privilege('anon','internal.lesson_joint_attendance_seconds(jsonb,text,text,text,numeric)','execute') or has_function_privilege('authenticated','internal.lesson_joint_attendance_seconds(jsonb,text,text,text,numeric)','execute') then raise exception 'helper_exposed'; end if; end $$;\n`;
sql += "rollback;\nselect 'PASS: six attendance scenarios, forged classification, exact replay and financial invariants';\n";
process.stdout.write(sql);
