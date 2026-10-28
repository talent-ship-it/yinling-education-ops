import json
import os
import subprocess
from pathlib import Path

PSQL = os.environ.get("PSQL", "psql")
BASE = [PSQL, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"]
ROOT = Path(__file__).resolve().parents[2]


def sql(statement):
    return subprocess.run(BASE + ["-c", statement], check=True, text=True, capture_output=True).stdout.strip()


def literal(value):
    return "'" + value.replace("'", "''") + "'"


subprocess.run(BASE + ["-f", str(ROOT / "tests/sql/assert-disposable-database.sql")], check=True)
sql("""
insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
 message_type,body,classification,student_name_hint,guardian_wechat_hint,
 operations_owner_hint,course_planner_hint,match_status,ingested_by)
values('bot:latest:concurrent:old',repeat('a',64),'latest-concurrent-room','sales','2100-03-01',
 'text',E'【安排教师】：Grace\\n【安排科目】：English\\n【微信名】：Draft Parent\\n【学生姓名】：Draft Student',
 'handover','Draft Student','Draft Parent','Abby','Tara','pending','WeCom Bot Receiver');
""")
source = json.loads(sql("select internal.wecom_lp_draft_source('bot:latest:concurrent:old')"))
fields = sql("select internal.fixture_wecom_lp_fields()")
versions = sql("select internal.fixture_wecom_lp_versions()")
confirm = "select applied,lp_item_id from public.confirm_wecom_lp_draft_atomic(" + ",".join([
    literal("wecom-fixture-secret"), literal(source["caseId"]), literal(source["sourceMessageId"]),
    literal(source["sourceRevision"]), literal("50000000-0000-4000-8000-000000000001"),
    literal("STU-DRAFT-1"), "null", literal(fields),
    literal('{"owner":"Abby","planner":"Tara","mayReassign":false}'),
    literal(versions), literal("Abby"), "false", literal("试听 LP"),
]) + ")"

writer = subprocess.Popen(BASE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    writer.stdin.write("""
begin;
insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
 message_type,body,classification,student_name_hint,guardian_wechat_hint,
 operations_owner_hint,course_planner_hint,match_status,ingested_by)
select 'bot:latest:concurrent:new',repeat('b',64),chat_id,sender_id,'2100-03-01 01:00Z',
 message_type,replace(body,'Grace','Tynan'),classification,student_name_hint,guardian_wechat_hint,
 operations_owner_hint,course_planner_hint,match_status,ingested_by
from internal.wecom_archive_messages where message_id='bot:latest:concurrent:old';
select 'newer_arrival_locked';
""")
    writer.stdin.flush()
    if writer.stdout.readline().strip() != "newer_arrival_locked":
        raise AssertionError("newer arrival did not acquire the room lock")
    busy = subprocess.run(BASE + ["-c", confirm], text=True, capture_output=True, timeout=10)
    if busy.returncode == 0 or "wecom_lp_confirmation_busy" not in busy.stderr:
        raise AssertionError("confirmation did not reject concurrent arrival: " + busy.stderr)
    writer.stdin.write("commit;\n")
    writer.stdin.close()
    writer.wait(timeout=10)
    if writer.returncode:
        raise AssertionError(writer.stderr.read())
    stale = subprocess.run(BASE + ["-c", confirm], text=True, capture_output=True, timeout=10)
    if stale.returncode == 0 or "wecom_lp_source_superseded" not in stale.stderr:
        raise AssertionError("committed arrival did not reject the stale confirmation: " + stale.stderr)
    if sql("select internal.fixture_wecom_lp_versions()") != versions:
        raise AssertionError("rejected confirmation changed business state")
    if sql("select count(*) from internal.wecom_lp_confirmations where source_message_id like 'bot:latest:concurrent:%'") != "0":
        raise AssertionError("rejected confirmation created a receipt")
finally:
    if writer.poll() is None:
        writer.terminate()
        writer.wait(timeout=10)

print("wecom_lp_latest_repost_concurrency_ok")
