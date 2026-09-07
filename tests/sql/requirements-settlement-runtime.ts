// Generates synthetic SQL for an isolated local PostgreSQL fixture only.
// Apply the booking-projection fixture, the operational settlement function and this release
// migrations first. Never run the generated fixture against a remote database.
import { prepareLessonOccurrenceSettlement } from '../../lib/lesson-occurrence-service.ts';
const rows=[{entity:'bookings',payload:[{id:'RELEASE-B',date:'2026-09-07',start:'10:00',duration:60,studentId:'RELEASE-S',teacherId:'RELEASE-T',packageId:'RELEASE-P',course:'English'}]},{entity:'students',payload:[{id:'RELEASE-S',name:'Synthetic learner',owner:'Abby',lessonPackages:[{id:'RELEASE-P',name:'Synthetic package',subjectIds:['English'],purchaseRecords:[{id:'BUY',purchasedAt:'2026-09-01T00:00:00Z',hours:4}],consumedHours:0}],lessonLedger:[]}]},{entity:'teachers',payload:[{id:'RELEASE-T',name:'Synthetic teacher'}]},{entity:'payroll',payload:[]}].map(row=>({...row,version:40,updated_at:'2026-09-07T00:00:00Z',updated_by:'Nixon'}));
const prepared=prepareLessonOccurrenceSettlement({rows,request:{occurrenceId:'RELEASE-B:2026-09-07',expectedVersion:40,overrideReason:'Synthetic manual verified adjustment',manualAdjustment:{actualMinutes:40,studentMinutes:40,teacherMinutes:50}},actor:'Nixon',fullAdmin:true,role:'admin',completedAt:new Date().toISOString()});
const quote=(v:unknown)=>"'"+JSON.stringify(v).replaceAll("'","''")+"'::jsonb";
let sql='\\set ON_ERROR_STOP on\nbegin;\n';
for(const row of rows)sql+=`insert into public.ops_state(entity,payload,version,updated_by) values('${row.entity}',${quote(row.payload)},40,'Nixon') on conflict(entity) do update set payload=excluded.payload,version=excluded.version;\n`;
const call=`select * from public.complete_lesson_occurrence_atomic('booking-projection-fixture-secret','RELEASE-B:2026-09-07',40,${quote(prepared.stateVersions)},'${prepared.idempotencyKey}',${quote(prepared.settlement)},null,'${prepared.overrideReason}','Nixon',null);\n`;
sql+=call;
sql+=call.replace(",40,", ",41,").replace(quote(prepared.stateVersions), "(select jsonb_object_agg(entity,version) from public.ops_state where entity in ('bookings','students','teachers','payroll'))");
sql+=`do $$ begin
if (select (payload->0->'lessonPackages'->0->>'consumedHours')::numeric from public.ops_state where entity='students') <> 0.666667 then raise exception 'wrong_student_debit'; end if;
if (select (payload->0->>'payableHours')::numeric from public.ops_state where entity='payroll') <> 0.833333 then raise exception 'wrong_teacher_credit'; end if;
if (select (payload->0->>'duration')::numeric from public.ops_state where entity='bookings') <> 60 then raise exception 'schedule_was_changed'; end if;
end; $$;\nrollback;\n`;
process.stdout.write(sql);
