import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { handoverTaskGroups, type HandoverTaskInput } from "../../lib/wecom-handover-tasks";
import { createWecomHandoverTaskHandlers } from "../../lib/wecom-handover-task-service";

const database = process.argv[2];
const host = process.env.PGHOST;
if (!database?.match(/^il_fixture_[a-z0-9_]+$/u) || !(host === "127.0.0.1" || host === "localhost" || host === "::1" || host?.startsWith("/"))) {
  throw new Error("Disposable task database and local PostgreSQL host required");
}
const env = { ...process.env, PGDATABASE: database };
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function sql(statement: string) {
  const guard = `do $$ begin if coalesce((select shobj_description(oid,'pg_database') from pg_database where datname=current_database()),'') <> 'insiderleads-disposable-fixture' then raise exception 'disposable marker required'; end if; end $$;`;
  const result = spawnSync(process.env.PSQL || "psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], {
    env, input: `${guard}\n${statement}`, encoding: "utf8", maxBuffer: 8_000_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "Task SQL fixture failed");
  return result.stdout.trim();
}
sql(`insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,message_type,body,classification,
 student_name_hint,guardian_wechat_hint,operations_owner_hint,course_planner_hint,match_status,ingested_by)
values('bot:generated:tasks',repeat('8',64),'generated-tasks-room','sales',now(),'text',
 E'试听LP 信息交接\\n【安排教师】：Grace\\n【安排科目】：English\\n【是否“要指定内容”】：是\\n【是否“要写作”】：否\\n【是否“发试卷 收试卷”】：否\\n【是否“跟进老师备课内容”】：是\\n【学生姓名】：Generated Child\\n【微信名】：Generated Parent\\n【教务老师】：Abby\\n【课程规划老师】：Tara',
 'handover','Generated Child','Generated Parent','Abby','Tara','pending','WeCom Bot Receiver');`);
const read = async (): Promise<HandoverTaskInput> => JSON.parse(sql("select public.read_wecom_handover_task_input('wecom-fixture-secret');"));
const handlers = createWecomHandoverTaskHandlers({
  identify: async () => ({ session: { user: "Abby", role: "staff", permissions: ["operations.read", "operations.write"], scopeMembers: [{ kind: "all", key: "*" }] }, fullAdmin: false }),
  read, now: () => new Date(),
  save: async (input) => Number(sql(`select public.save_wecom_handover_tasks('wecom-fixture-secret',${literal(input.sourceMessageId)},${literal(input.sourceRevision)},${literal(input.snapshotRevision)},${literal(input.inputRevision)},${input.expectedVersion},${literal(JSON.stringify(input.tasks))}::jsonb,${literal(input.actor)},false);`)),
});
const group = handoverTaskGroups(await read(), new Date()).find((entry) => entry.source.sourceMessageId === "bot:generated:tasks")!;
assert.ok(group.tasks.some((task) => task.ruleKey === "trial.manual-request.parent-progress-24h"));
const action = group.tasks.find((task) => task.ruleKey === "trial.manual-request.specified-content")!;
for (const command of ["complete", "reopen"] as const) {
  const response = await handlers.POST(new Request("https://example.test", { method: "POST", body: JSON.stringify({ taskId: action.id, action: command }) }));
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  const after = handoverTaskGroups(await read(), new Date()).find((entry) => entry.source.sourceMessageId === "bot:generated:tasks")!;
  assert.equal(after.tasks.find((task) => task.id === action.id)?.status === "done", command === "complete");
  assert.equal(after.tasks.find((task) => task.ruleKey === "wecom.handover.identity")?.status, "done");
}
console.log("Generated handover tasks / real PostgreSQL service complete, refresh, reopen: PASS");
