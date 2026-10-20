import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PSQL = os.environ.get('PSQL', 'psql')
BASE = [PSQL, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']


def sql(statement):
    result = subprocess.run(BASE + ['-c', statement], text=True, capture_output=True, check=True)
    return result.stdout.strip()


def literal(value):
    return "'" + value.replace("'", "''") + "'"


subprocess.run(BASE + ['-f', str(ROOT / 'tests/sql/assert-disposable-database.sql')], check=True)
subprocess.run(BASE + ['-f', str(ROOT / 'tests/sql/wecom-lp-draft-setup.sql')], check=True)
source = json.loads(sql("select internal.wecom_lp_draft_source('bot:lp-draft:new')"))
fields = json.loads(sql("select internal.fixture_wecom_lp_fields('New Draft Student') || '{\"planner\":\"Abby\"}'::jsonb"))
versions = sql('select internal.fixture_wecom_lp_versions()')
new_student = dict(name='New Draft Student', course='English', segment='试听', lpNeed='试听LP',
                   owner='Abby', planner='Abby', grade='待确认', location='VIC',
                   timezone='Australia/Melbourne', guardianWechat='New Draft Parent', notes='无特殊备注')


def confirm(command, student_id=None):
    return "select applied,student_id,lp_item_id from public.confirm_wecom_lp_draft_atomic(" + ','.join([
        literal('wecom-fixture-secret'), literal(source['caseId']), literal(source['sourceMessageId']),
        literal(source['sourceRevision']), literal(command), literal(student_id) if student_id else 'null',
        literal(json.dumps(new_student)) if new_student is not None else 'null',
        literal(json.dumps(fields)), literal('{"owner":"Abby","planner":"Abby","mayReassign":false}'),
        literal(versions), literal('Abby'), 'false']) + ')'


first = subprocess.Popen(BASE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
first.stdin.write('begin;\n' + confirm('20000000-0000-4000-8000-000000000001') + ';\nselect pg_sleep(1);\ncommit;\n')
first.stdin.close()
first_receipt = first.stdout.readline().strip()
if not first_receipt.startswith('t|'):
    raise AssertionError('first confirmation did not acquire and create the LP: ' + first_receipt)
second = subprocess.run(BASE + ['-c', confirm('20000000-0000-4000-8000-000000000002')],
                        text=True, capture_output=True, timeout=15, check=True)
first.wait(timeout=15)
if first.returncode:
    raise AssertionError(first.stderr.read())
if second.stdout.strip() != 'f|' + first_receipt[2:]:
    raise AssertionError('concurrent command keys created different LP/student records')
counts = sql("select (select count(*) from internal.wecom_lp_confirmations),"
             "(select count(*) from internal.student_creation_commands),"
             "jsonb_array_length((select payload from public.ops_state where entity='students')),"
             "jsonb_array_length((select payload from public.ops_state where entity='lpItems'))")
if counts != '1|1|3|1':
    raise AssertionError('concurrent duplicate student/LP state: ' + counts)

other_source = json.loads(sql("select internal.wecom_lp_draft_source('bot:lp-draft:one')"))
source = other_source
fields = json.loads(sql('select internal.fixture_wecom_lp_fields()'))
versions = sql('select internal.fixture_wecom_lp_versions()')
new_student = None
busy_confirm = confirm('20000000-0000-4000-8000-000000000003', 'STU-DRAFT-1')
blocker = subprocess.Popen(BASE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
blocker.stdin.write("begin;\nselect entity from public.ops_state where entity='files' for update;\nselect pg_sleep(1);\ncommit;\n")
blocker.stdin.close()
if blocker.stdout.readline().strip() != 'files':
    raise AssertionError('shared-state writer did not acquire fixture lock')
busy = subprocess.run(BASE + ['-c', busy_confirm], text=True, capture_output=True, timeout=10)
if busy.returncode == 0 or 'wecom_lp_confirmation_busy' not in busy.stderr:
    raise AssertionError('confirmation waited on shared state while holding its case lock: ' + busy.stderr)
blocker.wait(timeout=15)
if blocker.returncode:
    raise AssertionError(blocker.stderr.read())
if sql('select count(*) from internal.wecom_lp_confirmations') != '1':
    raise AssertionError('busy confirmation created a receipt')
print('wecom_lp_draft_concurrency_runtime_ok')
