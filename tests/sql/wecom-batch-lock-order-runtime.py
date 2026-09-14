"""Run with psql on PATH and PG* pointing at a marked, disposable local database.
Rebuilds synthetic fixture schemas; deliberately commits for concurrent sessions.
"""
import concurrent.futures
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading

ROOT = Path(__file__).resolve().parents[2]
PSQL = [os.environ.get("PSQL", "psql"), "-X", "-v", "ON_ERROR_STOP=1", "-At"]


def sql(statement):
    return subprocess.run(PSQL + ["-c", statement], capture_output=True, text=True)


def fixture_file(path):
    result = subprocess.run(PSQL + ["-f", str(path)], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr)


def pair(prefix, bot=False):
    ids = ["bot:" + hashlib.sha256((prefix + suffix).encode()).hexdigest()
           if bot else prefix + suffix for suffix in ["A", "B"]]
    sent_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    records = [dict(messageId=message_id, chatId="fixture-chat", senderId="fixture-sender",
                    sentAt=sent_at, messageType="text", text="Synthetic fixture",
                    classification="handover", studentNameHint="Fixture Student",
                    guardianWechatHint="Fixture Parent", **({} if bot else {"media": []}))
               for message_id in ids]
    barrier = threading.Barrier(2)

    def ingest(items):
        barrier.wait(timeout=10)
        payload = json.dumps(items).replace("'", "''")
        function = "ingest_wecom_bot_batch" if bot else "ingest_wecom_archive_batch"
        return sql("set statement_timeout='10s'; set deadlock_timeout='100ms'; "
                   f"select public.{function}('wecom-fixture-secret','{payload}'::jsonb,"
                   "'2026-01-01T00:00:00Z','fixture');")

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(ingest, records), executor.submit(ingest, list(reversed(records)))]
        results = [future.result(timeout=15) for future in futures]
    return results


# Validate in the same connection as setup, before any destructive statement.
setup = (ROOT / "tests/sql/assert-disposable-database.sql").read_text() + """
drop schema if exists internal cascade;
drop schema if exists extensions cascade;
drop table if exists public.ops_mutation_log cascade;
drop table if exists public.ops_state cascade;
create schema internal;
create schema extensions;
create extension pgcrypto with schema extensions;
do $$ begin
  if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create table public.ops_state(entity text primary key,payload jsonb not null,version bigint not null,updated_at timestamptz default now(),updated_by text);
create table public.ops_mutation_log(entity text,version bigint,actor text);
create table internal.operational_contract_audit(id uuid primary key default extensions.gen_random_uuid(),action text,actor text,target_type text,target_id text,metadata jsonb,created_at timestamptz default now());
create function internal.verify_ops_secret(p_secret text) returns boolean language sql as $$ select p_secret='wecom-fixture-secret' $$;
create function internal.append_operational_contract_audit(p_action text,p_actor text,p_target_type text,p_target_id text,p_metadata jsonb default '{}')
returns uuid language plpgsql as $$ declare receipt uuid; begin
 insert into internal.operational_contract_audit(action,actor,target_type,target_id,metadata) values(p_action,p_actor,p_target_type,p_target_id,p_metadata) returning id into receipt; return receipt;
end $$;
"""
# psql meta-commands must be interpreted as a script, not a -c SQL string.
result = subprocess.run(PSQL, input=setup, capture_output=True, text=True)
if result.returncode:
    raise RuntimeError(result.stderr)
for name in ["20260901000100_wecom_archive_ingestion.sql",
             "20260909000100_wecom_bot_receiver_ingest.sql",
             "20260910000100_wecom_bot_text_classification.sql",
             "20260910093517_wecom_bot_auto_match.sql"]:
    fixture_file(ROOT / "supabase/migrations" / name)
result = sql("""
insert into public.ops_state(entity,payload,version,updated_by) values
 ('students','[{"id":"STU-1","name":"Fixture Student","owner":"Abby","guardianWechat":"Fixture Parent"}]',1,'fixture'),
 ('files','[]',1,'fixture'),('messages','[]',1,'fixture');
create function internal.fixture_pause() returns trigger language plpgsql as $$ begin perform pg_sleep(0.5); return new; end; $$;
create trigger fixture_pause before insert on internal.wecom_archive_messages for each row execute function internal.fixture_pause();
""")
if result.returncode:
    raise RuntimeError(result.stderr)
results = pair("before-")
assert any("deadlock detected" in result.stderr for result in results), "Baseline deadlock was not reproduced"
print("Original archive batch: deadlock reproduced")
fixture_file(ROOT / "supabase/migrations/20260914000300_wecom_batch_lock_order.sql")
for prefix, bot in [("after-archive-", False), ("after-bot-", True)]:
    results = pair(prefix, bot)
    assert all(result.returncode == 0 for result in results), [result.stderr for result in results]
    receipts = [json.loads(result.stdout.strip().splitlines()[-1]) for result in results]
    assert sum(receipt.get("inserted", 0) for receipt in receipts) == 2, receipts
    assert sum(receipt.get("duplicates", 0) for receipt in receipts) == 2, receipts
    print(prefix + "both batches succeeded with exactly two inserts and two duplicates")
# The database remains populated for inspection.
