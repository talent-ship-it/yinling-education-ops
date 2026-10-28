import concurrent.futures
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading

ROOT = Path(__file__).resolve().parents[2]
PSQL = [os.environ.get("PSQL", "psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1"]
MIGRATION = ROOT / "supabase/migrations/20261028083500_wecom_lp_latest_repost.sql"


def script(content):
    result = subprocess.run(PSQL, input=content, text=True, capture_output=True, timeout=30, cwd=ROOT)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def batch_pair(prefix, kinds):
    rooms = [prefix + "-A", prefix + "-B"]
    barrier = threading.Barrier(2)

    def ingest(index, kind):
        records = [dict(
            messageId="bot:" + hashlib.sha256((prefix + str(index) + room).encode()).hexdigest(),
            chatId=" " + room + " ", senderId="fixture-sales",
            sentAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            messageType="text", classification="handover",
            text="【安排教师】：Grace\n【安排科目】：English",
            **({"media": []} if kind == "archive" else {}),
        ) for room in (rooms if index == 0 else list(reversed(rooms)))]
        query = (
            "set statement_timeout='8s'; set deadlock_timeout='100ms'; "
            f"select public.ingest_wecom_{kind}_batch('wecom-fixture-secret',"
            f"{literal(json.dumps(records))}::jsonb,'2026-01-01','WeCom Bot Receiver');"
        )
        barrier.wait(timeout=10)
        return subprocess.run(PSQL + ["-c", query], text=True, capture_output=True, timeout=12)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(ingest, index, kind) for index, kind in enumerate(kinds)]
        return [future.result(timeout=15) for future in futures]


subprocess.run(PSQL + ["-f", str(ROOT / "tests/sql/assert-disposable-database.sql")], check=True)
subprocess.run(PSQL + ["-f", str(ROOT / "tests/sql/wecom-quoted-identity-setup.sql")], check=True)
confirmation = (ROOT / "supabase/migrations/20261020091722_wecom_lp_draft_confirmation.sql").read_text()
start = confirmation.index("create function internal.wecom_is_lp_template(p_body text)")
end = confirmation.index("create function internal.wecom_lp_draft_source(", start)
script(confirmation[start:end])
script("""
create function internal.wecom_is_trial_lp_template(p_body text)
returns boolean language sql immutable strict set search_path = '' as $$
  select internal.wecom_is_lp_template(p_body)
$$;
revoke all on function internal.wecom_is_trial_lp_template(text) from public, anon, authenticated, service_role;
""")
script((ROOT / "supabase/migrations/20261025212941_wecom_quoted_handover_identity.sql").read_text().split("do $quoted_draft_sources$")[0])
candidate = MIGRATION.read_text()
start = candidate.index("create function internal.lock_wecom_lp_repost_room()")
end = candidate.index("do $latest_repost_contracts$", start)
script(candidate[start:end])
script("""
create function internal.fixture_lp_batch_pause() returns trigger language plpgsql as $$
begin perform pg_sleep(0.2); return new; end;
$$;
create trigger aab_fixture_lp_batch_pause before insert on internal.wecom_archive_messages
for each row execute function internal.fixture_lp_batch_pause();
""")
results = batch_pair("lp-batch-before", ("bot", "bot"))
assert any("deadlock detected" in result.stderr for result in results), [result.stderr for result in results]
print("original multi-room bot batch: deadlock reproduced")
start = candidate.index("create or replace function internal.lock_wecom_batch_messages(p_records jsonb)")
end = candidate.index("create function internal.lock_wecom_lp_repost_room()", start)
script(candidate[start:end])
for kinds in [("bot", "bot"), ("archive", "archive"), ("bot", "archive")]:
    prefix = "lp-batch-after-" + "-".join(kinds)
    results = batch_pair(prefix, kinds)
    assert all(result.returncode == 0 for result in results), [result.stderr for result in results]
    receipts = [json.loads(result.stdout.strip().splitlines()[-1]) for result in results]
    assert sum(receipt.get("inserted", 0) for receipt in receipts) == 4, receipts
    assert sum(receipt.get("duplicates", 0) for receipt in receipts) == 0, receipts
    count = script("select count(*) from internal.wecom_archive_messages where chat_id in ("
                   + literal(prefix + "-A") + "," + literal(prefix + "-B") + ")")
    assert count == "4", count
    print("/".join(kinds) + ": both opposite-order batches committed all four records")
script("""
do $$ begin
  if has_function_privilege('anon','internal.lock_wecom_batch_messages(jsonb)','execute') then
    raise exception 'private_batch_locker_exposed';
  end if;
end; $$;
""")
print("wecom_lp_latest_repost_batch_runtime_ok")
