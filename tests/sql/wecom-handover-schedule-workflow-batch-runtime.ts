import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runWecomHandoverScheduleReconciliation } from "../../lib/wecom-handover-schedule-reconciliation";
import type { WecomHandoverScheduleEvidence, WecomHandoverScheduleInput } from "../../lib/wecom-handover-schedule-types";

const database = process.argv[2];
const host = process.env.PGHOST;
if (!database?.match(/^il_fixture_[a-z0-9_]+$/u) || !(host === "127.0.0.1" || host === "localhost" || host === "::1" || host?.startsWith("/"))) {
  throw new Error("Disposable workflow batch database and local PostgreSQL host required");
}
const env = { ...process.env, PGDATABASE: database };
const guard = `do $$ begin if coalesce((select shobj_description(oid,'pg_database') from pg_database where datname=current_database()),'') <> 'insiderleads-disposable-fixture' then raise exception 'disposable marker required'; end if; end $$;`;
function sql(statement: string) {
  const result = spawnSync(process.env.PSQL || "psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], {
    env, input: `${guard}\n${statement}`, encoding: "utf8", maxBuffer: 8_000_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "Workflow batch SQL fixture failed");
  return result.stdout.trim();
}
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const revision = `sha256:${"7".repeat(64)}`;
const ids = ["bot:batch:conflict", "bot:batch:reclassified", "bot:batch:valid"];
sql(`
update public.ops_state set payload=payload||'[{"id":"STU-BATCH","name":"Batch Student","guardianWechat":"Batch Parent","jwbSourceRow":"BATCH-MEMBER","owner":"Abby","planner":"Tara"}]'::jsonb where entity='students';
insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,message_type,body,classification,
  student_name_hint,guardian_wechat_hint,operations_owner_hint,course_planner_hint,match_status,ingested_by)
select id,repeat('7',64),chat,'sales',now()+offset_seconds*interval '1 second','text',body,'handover',
  'Batch Student','Batch Parent','Abby','Tara','pending','WeCom Bot Receiver'
from (values
  ('bot:batch:conflict','batch-conflict',0,E'试听LP 信息交接\\n学生姓名：Batch Student\\n安排教师：Grace\\n安排科目：English'),
  ('bot:batch:conflict-followup','batch-conflict',1,E'业务类型：老师LP修改\\n学生姓名：Batch Student'),
  ('bot:batch:reclassified','batch-reclassified',0,E'学生姓名：Batch Student\\n安排教师：Grace\\n安排科目：English'),
  ('bot:batch:reclassified-followup','batch-reclassified',1,E'业务类型：老师LP修改\\n学生姓名：Batch Student'),
  ('bot:batch:valid','batch-valid',0,E'试听LP 信息交接\\n学生姓名：Batch Student\\n安排教师：Grace\\n安排科目：English')
) m(id,chat,offset_seconds,body);
do $$ declare run uuid; audit uuid; first_day text; last_day text; item jsonb;
begin
  first_day := (date_trunc('month',now() at time zone 'Australia/Melbourne')::date-1)::text;
  last_day := ((date_trunc('month',now() at time zone 'Australia/Melbourne')+interval '1 month')::date+32)::text;
  item := internal.fixture_wecom_schedule_record('workflow-batch',((now() at time zone 'Australia/Melbourne')::date+1)::text,'Batch Student');
  item := jsonb_set(item,'{record,course_title}','"English - Batch Student 试听"');
  item := jsonb_set(item,'{record,stu_list}','[{"mem_id":"BATCH-MEMBER","name":"Batch Student"}]');
  run := internal.fixture_wecom_schedule_run(${literal(revision)},first_day,last_day,now(),jsonb_build_array(item));
  audit := internal.append_operational_contract_audit('fixture.pointer','fixture','fixture','fixture','{}');
  update internal.jiaowubao_open_api_schedule_snapshot_current set run_id=run,revision=${literal(revision)},row_count=1,
    rows_sha256='sha256:'||repeat('d',64),payload_sha256='sha256:'||repeat('e',64),audit_id=audit where api_source_key='jwb-open-api-schedule';
end $$;
`);
const readInput = () => JSON.parse(sql(`select public.read_wecom_handover_schedule_input('wecom-fixture-secret',${literal(revision)},null);`)) as WecomHandoverScheduleInput;
const first = readInput();
assert.deepEqual([...first.targetSourceMessageIds].sort(), [...ids].sort());
for (const id of ids.slice(0, 2)) {
  const source = first.sources.find((source) => source.sourceMessageId === id)!;
  assert.equal(source.messages.length, 2);
}
const before = sql(`select jsonb_build_object(
  'rows',(select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s),
  'messages',(select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m),
  'confirmations',(select jsonb_agg(to_jsonb(c) order by source_message_id) from internal.wecom_lp_confirmations c)
);`);
const batches: (readonly WecomHandoverScheduleEvidence[])[] = [];
const dependencies = {
  readInput: async () => readInput(), now: () => new Date(),
  save: async ({ snapshotRevision, inputRevision, evidence }: { snapshotRevision: string; inputRevision: string; evidence: readonly WecomHandoverScheduleEvidence[] }) => {
    batches.push(evidence);
    return JSON.parse(sql(`select public.save_wecom_handover_schedule_evidence('wecom-fixture-secret',${literal(snapshotRevision)},${literal(inputRevision)},${literal(JSON.stringify(evidence))}::jsonb);`));
  },
};
const receipt = await runWecomHandoverScheduleReconciliation(revision, dependencies);
assert.ok(receipt.checkedCount >= 3);
const batch = batches[0]!;
for (const id of ids.slice(0, 2)) {
  const evidence = batch.find((entry) => entry.sourceMessageId === id)!;
  assert.equal(evidence.status, "ambiguous");
  assert.equal(evidence.matchedStudentId, null);
  assert.deepEqual(evidence.candidates, []);
}
const valid = batch.find((entry) => entry.sourceMessageId === "bot:batch:valid")!;
assert.equal(valid.status, "matched");
assert.equal(valid.matchedStudentId, "STU-BATCH");
assert.equal(valid.candidates[0]!.schedule.eventId, "jwb-open-api:schedule:workflow-batch");
assert.deepEqual(JSON.parse(sql(`select public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array[${ids.map(literal).join(",")}],'Abby',false);`)),
  [...batch].sort((left, right) => left.sourceMessageId.localeCompare(right.sourceMessageId)));
assert.equal(sql(`select jsonb_build_object(
  'rows',(select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s),
  'messages',(select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m),
  'confirmations',(select jsonb_agg(to_jsonb(c) order by source_message_id) from internal.wecom_lp_confirmations c)
);`), before);
assert.deepEqual(readInput().targetSourceMessageIds, []);
assert.deepEqual(await runWecomHandoverScheduleReconciliation(revision, dependencies), { checkedCount: 0, matchedCount: 0, candidateCount: 0 });
process.stdout.write("wecom_handover_schedule_workflow_batch_runtime_ok\n");
