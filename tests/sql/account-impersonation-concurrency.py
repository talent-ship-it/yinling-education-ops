"""Replay the live session/account lock inversion in a disposable database."""
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
BASE = [os.environ.get("PSQL", "psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1"]
ACTOR = "11111111-1111-4111-8111-111111111111"
TARGET = "22222222-2222-4222-8222-222222222222"
ACTOR_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TARGET_SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
SECRET = "materials-fixture-secret"


def sql(statement):
    return subprocess.run(BASE + ["-c", statement], capture_output=True, text=True, timeout=5, check=True).stdout.strip()


subprocess.run(BASE + ["-f", str(ROOT / "tests/sql/assert-disposable-database.sql")], timeout=5, check=True)
sql(f"update internal.app_account_sessions set revoked_at=null,access_version=1,idle_expires_at=now()+interval '10 minutes' where session_id='{ACTOR_SESSION}';")
call = (f"select session_id from public.create_account_impersonation_session('{SECRET}','{ACTOR}',"
        f"'{ACTOR_SESSION}','{TARGET}','{TARGET_SESSION}',repeat('c',64),0,1,'concurrency fixture');")

for locked_table, locked_column, locked_id in [
    ("app_account_sessions", "session_id", ACTOR_SESSION),
    ("app_accounts", "account_id", TARGET),
]:
    reader = subprocess.Popen(BASE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        reader.stdin.write(f"begin; set local statement_timeout='2s'; select {locked_column} from internal.{locked_table} where {locked_column}='{locked_id}' for update;\n")
        reader.stdin.flush()
        assert reader.stdout.readline().strip() == locked_id, "Reader did not acquire the intended lock"
        started = time.monotonic()
        attempt = subprocess.run(BASE + ["-v", "VERBOSITY=verbose", "-c", call], capture_output=True, text=True, timeout=3)
        assert attempt.returncode != 0 and "55P03" in attempt.stderr, attempt.stderr
        assert time.monotonic() - started < 2, "Switch waited while holding an account lock"
        assert sql(f"select count(*) from internal.app_account_sessions where session_id='{TARGET_SESSION}';") == "0"
        # The real live reader can now acquire the account and finish; a failed
        # switch must not leave any lock or partial session behind.
        reader.stdin.write(f"select account_id from public.read_account_session('{SECRET}',repeat('a',64)); commit;\n")
        reader.stdin.close()
        assert reader.wait(timeout=4) == 0, reader.stderr.read()
        assert reader.stdout.read().strip() == ACTOR
        assert sql(call) == TARGET_SESSION
        assert sql(f"select count(*) from internal.app_account_sessions where session_id='{TARGET_SESSION}';") == "1"
        sql(f"delete from internal.app_account_sessions where session_id='{TARGET_SESSION}';")
    finally:
        if reader.poll() is None:
            reader.kill()
            reader.wait(timeout=3)

assert sql(f"select account_id from public.read_account_session('{SECRET}',repeat('a',64));") == ACTOR
print("account impersonation concurrent session read and target write: PASS")
