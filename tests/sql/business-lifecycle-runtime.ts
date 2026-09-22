/** Local-only synthetic integration fixture. Never reads app credentials. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { prepareTeacherDepartureCreation, parseTeacherDepartureCreationCommand } from "../../lib/teacher-departure-creation-service";
import { prepareTeacherAbsenceCreation, parseTeacherAbsenceCreationCommand } from "../../lib/teacher-absence-creation-service";
import { preparePermanentTeacherReplacement } from "../../lib/operation-occurrence-service";
import { reconcileRenewalTasks, renewalStatusForPackage, renewalTaskCycleForPackage } from "../../lib/renewal-tasks";
import type { OpsStateRow } from "../../lib/ops-store";

const database = process.argv[2];
const socket = process.env.PGHOST;
if (!database?.match(/^il_fixture_business_[a-z0-9_]+$/) || !socket?.startsWith("/private/tmp/")) throw new Error("Disposable business database and local Unix socket required");
const env = { PATH: process.env.PATH, PGHOST: socket, PGPORT: process.env.PGPORT ?? "65432", PGUSER: process.env.PGUSER ?? "nixon", PGDATABASE: database };
const guard = `do $$ begin if coalesce((select shobj_description(oid,'pg_database') from pg_database where datname=current_database()),'') <> 'insiderleads-disposable-fixture' then raise exception 'disposable marker required'; end if; end $$;`;
function sql(statement: string) {
  const result = spawnSync("/opt/homebrew/opt/postgresql@17/bin/psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], { env, input: `${guard}\n${statement}`, encoding: "utf8", maxBuffer: 8_000_000 });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "SQL fixture failed");
  return result.stdout.trim();
}
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const json = (value: unknown) => `${literal(JSON.stringify(value))}::jsonb`;
const migration = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
sql(`drop schema if exists internal cascade; drop schema if exists extensions cascade; drop table if exists public.ops_state cascade; drop table if exists public.ops_mutation_log cascade;
create schema internal; create schema extensions; create extension pgcrypto with schema extensions;
create table public.ops_state(entity text primary key,payload jsonb not null,version bigint not null,updated_at timestamptz not null default now(),updated_by text not null);
create table public.ops_mutation_log(entity text,version bigint,actor text);
create table internal.operational_contract_audit(id uuid primary key default gen_random_uuid(),action text,actor text,target_type text,target_id text,metadata jsonb,created_at timestamptz default now());
create function internal.verify_ops_secret(text) returns boolean language sql immutable set search_path='' as $$ select $1 = 'business-fixture-secret' $$;
create function internal.append_operational_contract_audit(text,text,text,text,jsonb default '{}'::jsonb) returns uuid language plpgsql set search_path='' as $$ declare saved uuid; begin insert into internal.operational_contract_audit(action,actor,target_type,target_id,metadata) values($1,$2,$3,$4,$5) returning id into saved; return saved; end $$;`);
for (const name of ["20260815033000_teacher_departure_command_ledger", "20260815034000_permanent_teacher_replacement_atomic", "20260815041000_teacher_departure_creation_atomic", "20260819101100_teacher_departure_timeline_tasks", "20260819101200_teacher_absence_creation_atomic"]) sql(migration(name));
// Only recurrence helpers and the current departure projector are needed here;
// unrelated settlement/JWB functions are covered by their own runtime fixtures.
const recurrence = migration("20260819101400_support_booking_recurrence_intervals");
sql(recurrence.slice(0, recurrence.indexOf("-- Replace the deployed JWB")));
sql(recurrence.slice(recurrence.indexOf("create or replace function internal.teacher_departure_creation_tasks_v2")));
sql(migration("20260914000200_retired_staff_assignment_guard").split("-- Only active records")[0]);
sql(migration("20260728042500_add_student_fu_attachments"));
sql(migration("20260824000400_renewal_follow_up_atomic"));
sql(migration("20260824000600_renewal_follow_up_create_if_missing_atomic"));
for (const name of ["20260922081910_departure_allow_pending_match", "20260922082044_multisubject_teacher_replacement", "20260922082236_lp_handover_operations_owner", "20260922082748_renewal_purchase_cycles", "20260922083359_refresh_departure_candidates"]) sql(migration(name));

const secret = literal("business-fixture-secret");
const now = new Date();
const commonBooking = { studentId: "S-1", teacherId: "T-OLD", start: "17:00", duration: 60, timezone: "Australia/Melbourne", kind: "常规课", status: "已确认", teacherSubjectId: "Math" };
const englishBooking = { ...commonBooking, id: "B-EN", teacherId: "T-EN", date: "2026-09-09", teacherSubjectId: "English" };
const englishTeacher = { id: "T-EN", name: "English Teacher", subjects: ["English"], newStudentCapacity: 3, capacityAssignments: ["S-1"] };
const fixtures: Record<string, unknown[]> = {
  bookings: [{ ...commonBooking, id: "B-HIST", date: "2026-08-18", recurring: true, repeatCount: 2 }, { ...commonBooking, id: "B-MATH", date: "2026-09-01", recurring: true, repeatCount: 2 }, englishBooking],
  students: [{ id: "S-1", status: "在读", owner: "Abby", teacher: "English Teacher", files: 0 }],
  teachers: [{ id: "T-OLD", name: "Old Teacher", subjects: ["Math"], newStudentCapacity: 0, capacityAssignments: ["S-1"] }, { id: "T-NEW", name: "New Teacher", subjects: ["Math"], acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: [], availabilityWindows: [] }, englishTeacher],
  operations: [], tasks: [], renewals: [], files: [],
};
for (const [entity, payload] of Object.entries(fixtures)) sql(`insert into public.ops_state(entity,payload,version,updated_by) values(${literal(entity)},${json(payload)},1,'fixture');`);
function rows(): OpsStateRow[] { return JSON.parse(sql("select jsonb_agg(to_jsonb(s)) from public.ops_state s;")); }
function versions(current: OpsStateRow[]) { return Object.fromEntries(current.map((row) => [row.entity, row.version])); }
function expectSqlError(statement: string, expected: RegExp) {
  assert.throws(() => sql(statement), expected);
}

// F05+F07: no candidate still records a departure and owner-visible LP tasks.
const initial = rows();
const departure = prepareTeacherDepartureCreation({ rows: initial, actor: "Nixon", role: "admin", fullAdmin: true, now,
  command: parseTeacherDepartureCreationCommand({ commandKey: "teacher-departure-create:123e4567-e89b-42d3-a456-426614174000", sourceTeacherId: "T-OLD", effectiveDate: "2026-09-01", detail: "fixture departure", expectedVersions: { bookings: 1, operations: 1, students: 1, tasks: 1, teachers: 1 } }) });
assert.deepEqual(departure.affectedGroups[0].candidateTeacherIds, []);
const groups = departure.affectedGroups.map(({ studentId, operationId, affectedOccurrenceIds, candidateTeacherIds }) => ({ studentId, operationId, affectedOccurrenceIds, candidateTeacherIds }));
const departureCall = `select applied from public.create_teacher_departure_atomic(${secret},${literal(departure.commandKey)},${json(departure.commandIntent)},'T-OLD','2026-09-01','fixture departure',${json(departure.expectedVersions)},${json(departure.operations)},${json(departure.tasks)},${json(groups)},${literal(departure.submittedAt)},'Nixon');`;
assert.equal(sql(departureCall), "t");
assert.equal(sql(departureCall), "f", "exact replay is idempotent");
let current = rows();
assert.deepEqual(current.find((row) => row.entity === "bookings")?.payload, fixtures.bookings);
const departureLp = (current.find((row) => row.entity === "tasks")?.payload as Record<string, unknown>[]).find((task) => String(task.ruleKey).endsWith(":lp-to-new-teacher"));
assert.equal(departureLp?.owner, "Abby");
assert.deepEqual(departureLp?.assignees, ["Abby"]);

// No-match cannot be confirmed; later AVA correction must first pass refresh.
const replacementCommand = () => ({ operationId: departure.operationIds[0], chosenTeacherId: "T-NEW", expectedVersions: { bookings: 1, operations: current.find((row) => row.entity === "operations")!.version, students: 1, teachers: current.find((row) => row.entity === "teachers")!.version } });
assert.throws(() => preparePermanentTeacherReplacement({ command: replacementCommand(), rows: current, actor: "Nixon", fullAdmin: true }), /候选|AVA/);
const availableTeachers = (fixtures.teachers as Record<string, unknown>[]).map((teacher) => teacher.id === "T-NEW" ? { ...teacher, availabilityWindows: [{ id: "AVA-NEW", teacherId: "T-NEW", day: 2, start: "16:00", end: "20:00", timezone: "Australia/Melbourne", validFrom: "2026-09-01", validTo: "2026-09-30", excludedDates: [], overrides: [], source: "submission" }] } : teacher);
sql(`update public.ops_state set payload=${json(availableTeachers)},version=2 where entity='teachers';`);
current = rows();
const refresh = (expected: Record<string, number>) => `select to_jsonb(r) from public.refresh_teacher_departure_candidates_atomic(${secret},${literal(departure.operationIds[0])},${json(expected)},'Nixon') r;`;
const refreshVersions = { bookings: 1, operations: 2, students: 1, teachers: 2 };
expectSqlError(refresh({ ...refreshVersions, teachers: 1 }), /version_conflict/);
assert.throws(() => preparePermanentTeacherReplacement({ command: replacementCommand(), rows: current, actor: "Nixon", fullAdmin: true }), /候选/);
sql(refresh(refreshVersions));
current = rows();
assert.deepEqual((current.find((row) => row.entity === "operations")!.payload as Record<string, unknown>[])[0].recommendedTeacherIds, ["T-NEW"]);
// F06: independently derived SQL payload agrees with TypeScript and preserves English.
const replacement = preparePermanentTeacherReplacement({ command: replacementCommand(), rows: current, actor: "Nixon", fullAdmin: true, now });
assert.equal(replacement.students[0].teacher, "English Teacher");
const replacementCall = `select applied from public.confirm_permanent_teacher_replacement_atomic(${secret},${literal(replacement.commandKey)},${json(replacement.commandIntent)},${literal(replacement.operationId)},'S-1','T-OLD','T-NEW','2026-09-01',${json(replacement.expectedVersions)},${json(replacement.bookings)},${json(replacement.operations)},${json(replacement.teachers)},${json(replacement.students)},${json(replacement.affectedOccurrenceIds)},${json(replacement.changedTeacherIds)},'Nixon');`;
assert.equal(sql(replacementCall), "t");
assert.equal(sql(replacementCall), "f");
current = rows();
assert.deepEqual((current.find((row) => row.entity === "bookings")!.payload as Record<string, unknown>[]).find((entry) => entry.id === "B-EN"), englishBooking);
assert.deepEqual((current.find((row) => row.entity === "teachers")!.payload as Record<string, unknown>[]).find((entry) => entry.id === "T-EN"), englishTeacher);
expectSqlError(refresh({ ...refreshVersions, operations: 3 }), /version_conflict|operation_mismatch/);

// F07: absence creation also agrees with SQL for the owner and real historical due date.
const v = versions(current);
const absence = prepareTeacherAbsenceCreation({ rows: current, actor: "Nixon", role: "admin", fullAdmin: true, now,
  command: parseTeacherAbsenceCreationCommand({ commandKey: "teacher-absence-create:123e4567-e89b-42d3-a456-426614174000", sourceTeacherId: "T-NEW", eventStart: "2026-09-08", eventEnd: "2026-09-08", type: "老师请假", detail: "fixture absence", expectedVersions: { bookings: v.bookings, operations: v.operations, students: v.students, tasks: v.tasks, teachers: v.teachers } }) });
assert.equal(absence.tasks.find((task) => task.ruleKey?.endsWith(":lp-handover"))?.owner, "Abby");
assert.equal(sql(`select applied from public.create_teacher_absence_atomic(${secret},${literal(absence.commandKey)},${json(absence.commandIntent)},'T-NEW','2026-09-08','2026-09-08','老师请假','fixture absence',${json(absence.expectedVersions)},${json(absence.operations)},${json(absence.tasks)},${json(absence.affectedGroups)},${literal(absence.submittedAt)},'Nixon');`), "t");

// F04: two purchase cycles coexist; saving renewal closes only the current one.
const oldCycle = "2026-07-01T00:00:00.000Z", newCycle = "2026-09-01T00:00:00.000Z";
const projections = [oldCycle, newCycle].map((cycleStartedAt) => ({ studentId: "S-1", packageId: "PKG-1", owner: "Abby", cycleStartedAt, depletionAt: "2026-09-25T07:00:00.000Z" }));
const oldTasks = reconcileRenewalTasks([], [projections[0]], { now });
const tasks = reconcileRenewalTasks(oldTasks, [projections[1]], { now });
sql(`update public.ops_state set payload=${json(tasks)},version=100 where entity='tasks';
update public.ops_state set payload=${json([{ ...(fixtures.students[0] as object), lessonPackages: [{ id: "PKG-1", name: "Math", subjectIds: ["Math"], consumedHours: 0, purchaseRecords: [{ id: "P-1", purchasedAt: oldCycle, hours: 10 }, { id: "P-2", purchasedAt: newCycle, hours: 10 }] }] }])},version=100 where entity='students';
update public.ops_state set payload=${json([{ id: "REN-1", studentId: "S-1", packageId: "PKG-1", businessStatus: "not_renewed_active", status: "待跟进", owner: "Abby" }])},version=100 where entity='renewals';`);
const intent = { renewalId: "REN-1", studentId: "S-1", packageId: "PKG-1", businessStatus: "renewed", result: "已跟进", attemptedAt: "2026-09-22T00:00:00.000Z", note: "fixture renewal", renewalDateNote: "", hasAttachment: false };
assert.equal(sql(`select applied from public.put_renewal_follow_up_atomic(${secret},'renewal-follow-up:123e4567-e89b-42d3-a456-426614174000',${json(intent)},'REN-1','S-1','PKG-1','renewed','已跟进','2026-09-22T00:00:00.000Z','fixture renewal','',null,null,null,null,null,'{"files":1,"renewals":100,"students":100,"tasks":100}','Nixon');`), "t");
const savedTasks = rows().find((row) => row.entity === "tasks")!.payload as Record<string, unknown>[];
assert.notEqual(savedTasks.find((task) => task.id === oldTasks[0].id)?.status, "done");
assert.equal(savedTasks.find((task) => task.id !== oldTasks[0].id)?.status, "done");
const savedRenewal = (rows().find((row) => row.entity === "renewals")!.payload as Record<string, unknown>[])[0];
assert.equal(savedRenewal.remainingHoursAtRenewal, 20, "SQL captures the paid balance even when renewal is recorded after purchase");
sql(`update public.ops_state set payload=jsonb_set(payload,'{0,lessonPackages,0,consumedHours}','16'),version=version+1 where entity='students';`);
const cycleInput = { studentId: "S-1", packageId: "PKG-1", packageCount: 1, cycleStartedAt: newCycle, remainingHours: 4 };
const renewalRecords = [{ studentId: "S-1", packageId: "PKG-1", status: "renewed" as const, lastAttemptAt: intent.attemptedAt, remainingHoursAtRenewal: 20 }];
const afterPayment = { ...projections[1], cycleStartedAt: renewalTaskCycleForPackage(renewalRecords, cycleInput), status: renewalStatusForPackage(renewalRecords, cycleInput) };
assert.equal(afterPayment.status, "not_renewed_active");
const laterTasks = reconcileRenewalTasks(savedTasks as never, [afterPayment], { now });
assert.equal(laterTasks.length, 3);
assert.equal(sql("select internal.renewal_cycle_task_anchor((select payload -> 0 from public.ops_state where entity='students'),'PKG-1','renewal:S-1:PKG-1',(select payload -> 0 from public.ops_state where entity='renewals'));"), laterTasks.find((task) => !savedTasks.some((saved) => saved.id === task.id))?.anchorBookingId);
console.log("Business SQL runtime passed: departure registration/replay, candidate refresh/OCC, permanent multi-subject replacement/replay, absence LP ownership, renewal cycle closure.");
