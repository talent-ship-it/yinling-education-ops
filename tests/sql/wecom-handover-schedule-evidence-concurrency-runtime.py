import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = [os.environ.get('PSQL', 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']


def sql(statement):
    return subprocess.run(BASE + ['-c', statement], check=True, text=True, capture_output=True, timeout=15).stdout.strip()


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def session(statement):
    process = subprocess.Popen(BASE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    process.stdin.write(statement + '\n')
    process.stdin.flush()
    return process


subprocess.run(BASE + ['-f', str(ROOT / 'tests/sql/wecom-handover-schedule-evidence-runtime.sql')], check=True, timeout=30)
revision = 'sha256:' + '5' * 64
sql("""do $$ declare run uuid; audit uuid; begin
  run := internal.fixture_wecom_schedule_run('""" + revision + """','2099-01-01','2099-01-31','2099-01-04T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_schedule_record('live','2099-01-02')));
  audit := internal.append_operational_contract_audit('fixture.pointer','fixture','fixture','fixture','{}');
  insert into internal.jiaowubao_open_api_schedule_snapshot_current(api_source_key,run_id,revision,row_count,rows_sha256,payload_sha256,audit_id)
    values('jwb-open-api-schedule',run,'""" + revision + """',1,'sha256:'||repeat('d',64),'sha256:'||repeat('e',64),audit);
end; $$;""")
input_value = json.loads(sql("select public.read_wecom_handover_schedule_input('wecom-fixture-secret'," + literal(revision) + ",array['bot:lp-draft:one'])"))
entry = json.loads(sql('select internal.fixture_wecom_schedule_entry(' + literal(json.dumps(input_value)) + '::jsonb)'))
save = "select public.save_wecom_handover_schedule_evidence('wecom-fixture-secret'," + ','.join([
    literal(revision), literal(input_value['inputRevision']), literal(json.dumps([entry]))]) + ')'
writer = session("begin; select entity from public.ops_state where entity='students' for update;")
try:
    if writer.stdout.readline().strip() != 'students':
        raise AssertionError('native writer did not acquire ops state row')
    saver = session('begin; set local statement_timeout=\'3s\'; ' + save + ';')
    try:
        receipt = json.loads(saver.stdout.readline().strip())
        if receipt != dict(checkedCount=1, matchedCount=0, candidateCount=1):
            raise AssertionError('save did not complete while native ops state row was locked')
        writer.stdin.write("set local statement_timeout='5s'; update public.ops_state set payload=payload||'[{}]'::jsonb where entity='students'; commit;\n")
        writer.stdin.flush()
        saver.stdin.write('commit;\n')
        saver.stdin.close()
        saver.wait(timeout=8)
        writer.stdin.close()
        writer.wait(timeout=8)
        if saver.returncode or writer.returncode:
            raise AssertionError('epoch/native lock order failed: ' + saver.stderr.read() + writer.stderr.read())
    finally:
        if saver.poll() is None:
            saver.kill()
            saver.wait(timeout=5)
finally:
    if writer.poll() is None:
        writer.kill()
        writer.wait(timeout=5)
if sql("select public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:lp-draft:one'],'Ops Admin',true)") != '[]':
    raise AssertionError('committed native writer did not invalidate saved cache')
replay = subprocess.run(BASE + ['-c', save], text=True, capture_output=True, timeout=8)
if replay.returncode == 0 or 'wecom_schedule_input_changed' not in replay.stderr:
    raise AssertionError('stale evidence committed after competing native writer')
print('wecom_handover_schedule_evidence_concurrency_runtime_ok')
