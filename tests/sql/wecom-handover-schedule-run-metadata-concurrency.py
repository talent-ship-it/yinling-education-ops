import os
import subprocess
import time

BASE = [os.environ.get('PSQL', 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']


def sql(statement):
    return subprocess.run(BASE + ['-c', statement], check=True, text=True, capture_output=True, timeout=15).stdout.strip()


def session(statement):
    process = subprocess.Popen(BASE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    process.stdin.write(statement + '\n')
    process.stdin.flush()
    return process


def finish(process, statement='commit;'):
    process.stdin.write(statement + '\n')
    process.stdin.close()
    process.wait(timeout=8)
    if process.returncode:
        raise AssertionError('metadata concurrent transaction failed: ' + process.stderr.read())


def blocked(application_name, locktype='advisory'):
    until = time.monotonic() + 4
    while time.monotonic() < until:
        if sql("select exists(select 1 from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.application_name='" + application_name + "' and l.locktype='" + locktype + "' and not l.granted)") == 't':
            return
        time.sleep(0.02)
    raise AssertionError('metadata concurrent operation did not wait for the expected ' + locktype + ' lock')


run = sql("select internal.fixture_wecom_schedule_run('metadata-concurrent','2099-01-04','2099-01-04','2100-01-01T00:00:00Z',jsonb_build_array(internal.fixture_wecom_history_record('metadata-concurrent','2099-01-04')))")
sql("delete from internal.wecom_schedule_run_metadata where run_id='" + run + "'")
append = "insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items(run_id,page_index,item_index,source_key,canonical_json,item_sha256,item) select run_id,page_index,POSITION,source_key||'-POSITION',canonical_json,item_sha256,item from internal.jiaowubao_open_api_schedule_snapshot_ingest_items where run_id='" + run + "' and item_index=0;"
backfiller = session("begin; select internal.refresh_wecom_schedule_run_metadata('" + run + "');")
appender = None
try:
    if backfiller.stdout.readline().strip() != '1':
        raise AssertionError('metadata backfill did not acquire lock and build the initial receipt')
    appender = session("set application_name='metadata_append_wait'; begin; " + append.replace('POSITION', '1') + " select 'append_done';")
    blocked('metadata_append_wait')
    finish(backfiller)
    if appender.stdout.readline().strip() != 'append_done':
        raise AssertionError('metadata append did not resume after backfill commit')
    finish(appender)
    if sql("select exists(select 1 from internal.wecom_schedule_run_metadata where run_id='" + run + "')") != 'f':
        raise AssertionError('metadata backfill-then-append race left a stale receipt')
finally:
    for process in [backfiller, appender]:
        if process and process.poll() is None:
            process.kill()
            process.wait(timeout=5)

appender = session("begin; " + append.replace('POSITION', '2') + " select 'append_locked';")
backfiller = None
try:
    if appender.stdout.readline().strip() != 'append_locked':
        raise AssertionError('metadata append did not acquire shared run advisory lock')
    backfiller = session("set application_name='metadata_backfill_wait'; begin; select internal.refresh_wecom_schedule_run_metadata('" + run + "');")
    blocked('metadata_backfill_wait')
    finish(appender)
    if backfiller.stdout.readline().strip() != '3':
        raise AssertionError('metadata backfill did not observe the committed append after waiting')
    finish(backfiller)
    result = subprocess.run(BASE + ['-c', "select public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one'])"], text=True, capture_output=True, timeout=8)
    if result.returncode == 0 or 'wecom_schedule_run_metadata_missing' not in result.stderr:
        raise AssertionError('metadata receipt accepted appended rows against the prior completed row count')
finally:
    for process in [backfiller, appender]:
        if process and process.poll() is None:
            process.kill()
            process.wait(timeout=5)
def complete(run_id):
    return "select public.complete_jiaowubao_open_api_schedule_snapshot_ingest('wecom-fixture-secret','" + run_id + "','Ops Admin')->>'state';"


def owner_append(run_id):
    return "insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items(run_id,page_index,item_index,source_key,canonical_json,item_sha256,item) select run_id,page_index,99,source_key||'-owner-append',canonical_json,item_sha256,item from internal.jiaowubao_open_api_schedule_snapshot_ingest_items where run_id='" + run_id + "' and item_index=0;"


sql("delete from internal.jiaowubao_open_api_schedule_snapshot_current where api_source_key='jwb-open-api-schedule'")
run = sql("select internal.fixture_wecom_metadata_stage('metadata-completion-first',1)")
completer = session("begin; do $$ begin perform 1 from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs where id='" + run + "' for update; end; $$; select 'completion_parent_locked';")
appender = None
try:
    if completer.stdout.readline().strip() != 'completion_parent_locked':
        raise AssertionError('normal completion fixture did not acquire its parent row first')
    appender = session("set application_name='metadata_append_parent_wait'; begin; " + owner_append(run) + " select 'append_after_completion';")
    blocked('metadata_append_parent_wait', 'transactionid')
    completer.stdin.write(complete(run) + '\n')
    completer.stdin.flush()
    if completer.stdout.readline().strip() != 'complete':
        raise AssertionError('normal completion could not finish while an owner append waited for its parent')
    finish(completer)
    if appender.stdout.readline().strip() != 'append_after_completion':
        raise AssertionError('owner append did not resume after normal completion')
    finish(appender)
    if sql("select exists(select 1 from internal.wecom_schedule_run_metadata where run_id='" + run + "')") != 'f':
        raise AssertionError('normal-completion-then-owner-append retained a stale receipt')
finally:
    for process in [completer, appender]:
        if process and process.poll() is None:
            process.kill()
            process.wait(timeout=5)

run = sql("select internal.fixture_wecom_metadata_stage('metadata-owner-first',1)")
appender = session("begin; " + owner_append(run) + " select 'owner_parent_locked';")
completer = None
try:
    if appender.stdout.readline().strip() != 'owner_parent_locked':
        raise AssertionError('owner append fixture did not acquire its parent before its advisory lock')
    completer = session("set application_name='metadata_completion_parent_wait'; begin; " + complete(run))
    blocked('metadata_completion_parent_wait', 'transactionid')
    finish(appender)
    if completer.stdout.readline().strip() != 'complete':
        raise AssertionError('normal completion did not resume after the owner append committed')
    finish(completer)
    if sql("select item_count=2 and expected_row_count=1 from internal.wecom_schedule_run_metadata where run_id='" + run + "'") != 't':
        raise AssertionError('normal completion did not record the actual appended row count')
    revision = sql("select revision from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs where id='" + run + "'")
    result = subprocess.run(BASE + ['-c', "select public.read_wecom_handover_schedule_input('wecom-fixture-secret','" + revision + "',array['bot:title-only:one'])"], text=True, capture_output=True, timeout=8)
    if result.returncode == 0 or 'wecom_schedule_run_metadata_missing' not in result.stderr:
        raise AssertionError('owner-append-then-normal-completion accepted a mismatched receipt')
finally:
    for process in [appender, completer]:
        if process and process.poll() is None:
            process.kill()
            process.wait(timeout=5)
print('wecom_handover_schedule_run_metadata_concurrency_ok')
