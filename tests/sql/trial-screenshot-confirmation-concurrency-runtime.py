import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = [os.environ.get('PSQL', 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']


def sql(statement):
    return subprocess.run(BASE + ['-c', statement], text=True, capture_output=True, check=True).stdout.strip()


def literal(value):
    return "'" + value.replace("'", "''") + "'"


subprocess.run(BASE + ['-f', str(ROOT / 'tests/sql/assert-disposable-database.sql')], check=True)
subprocess.run(BASE + ['-f', str(ROOT / 'tests/sql/trial-screenshot-confirmation-setup.sql')], check=True)
revision = 'sha256:' + 'a' * 64
source_day = sql("select to_char((now()+interval '2 days') at time zone 'Australia/Melbourne','YYYY-MM-DD')")
started = sql("select to_char((" + literal(source_day + ' 09:00') + "::timestamp at time zone 'Australia/Melbourne') at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
ended = sql("select to_char((" + literal(source_day + ' 10:00') + "::timestamp at time zone 'Australia/Melbourne') at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
student = dict(id='S-1', name='Synthetic Parent', guardianWechat='Synthetic Parent', owner='Ella')
fields = dict(responsibleOperations='Ella', studentNameKnown=False, subject='Keep subject', trialDurationMinutes=45)
lp = dict(id='LP-1', studentId='S-1', workflowType='试听 LP', stage='待跟进', fields=fields, trialPaid=True)
link = dict(source='jiaowubao-open-api', confirmation='screenshot-review', sourceRevision=revision,
            eventId='jwb-open-api:schedule:1', startsAt=started, endsAt=ended, courseName='English - Synthetic Child试听',
            teacherName='Synthetic Teacher', teacherId=None, studentName='Synthetic Child', plannerHint='Tara', matchedAt=started)
next_lp = dict(lp, fields=dict(fields, assignedTeacher='Synthetic Teacher', studentNameKnown=True, studentName='Synthetic Child', trialDurationMinutes=60),
               trialSchedule=link, trialScheduleReview=dict(source='screenshot-review', eventId=link['eventId']))
run_id = '35000000-0000-4000-8000-000000000001'
raw = dict(record=dict(dated=source_day, time_start='09:00', time_end='10:00', teacher_title='Synthetic Teacher', course_title=link['courseName'], stu_list=[dict(mem_id='8001', name='试听学员A')]))
for entity, payload in [('students', [student]), ('lpItems', [lp]), ('tasks', [])]:
    sql('insert into public.ops_state(entity,payload,version,updated_by) values(' + literal(entity) + ',' + literal(json.dumps(payload)) + ",1,'fixture')")
sql('insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs values(' + ','.join([literal(run_id), literal('jwb-open-api-schedule'), literal(revision), literal('complete'), literal(json.dumps(dict(start=source_day, end=source_day)))]) + ')')
sql('insert into internal.jiaowubao_open_api_schedule_snapshot_current values(' + ','.join([literal('jwb-open-api-schedule'), literal(run_id), literal(revision), 'now()']) + ')')
sql('insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items values(' + ','.join([literal(run_id), literal(link['eventId']), literal(json.dumps(raw))]) + ')')
versions = dict(students=1, lpItems=1, tasks=1)
intent = dict(lpItemId='LP-1', eventId=link['eventId'], sourceRevision=revision, sourceDate=source_day, expectedVersions=versions)


def confirm(key):
    return 'select applied,student_id,lp_item_id from public.confirm_trial_screenshot_atomic(' + ','.join([
        literal('local-jwb-fixture'), literal(key), literal(json.dumps(intent)), literal(json.dumps(versions)),
        literal(json.dumps([next_lp])), literal('[]'), literal('Ella'), 'true']) + ')'


first_key = '35000000-0000-4000-8000-000000000002'
first = subprocess.Popen(BASE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
first.stdin.write('begin;\n' + confirm(first_key) + ';\nselect pg_sleep(1);\ncommit;\n')
first.stdin.close()
receipt = first.stdout.readline().strip()
if receipt != 't|S-1|LP-1':
    raise AssertionError('first atomic confirmation did not commit expected LP: ' + receipt)
second = subprocess.run(BASE + ['-c', confirm(first_key)], text=True, capture_output=True, timeout=15, check=True)
first.wait(timeout=15)
if first.returncode:
    raise AssertionError(first.stderr.read())
if second.stdout.strip() != 'f|S-1|LP-1':
    raise AssertionError('same-key concurrent retry did not return original result')
other = subprocess.run(BASE + ['-c', confirm('35000000-0000-4000-8000-000000000003')], text=True, capture_output=True, timeout=10)
if other.returncode == 0 or 'version_conflict' not in other.stderr:
    raise AssertionError('different-key stale confirmation overwrote current state')
counts = sql('select (select count(*) from internal.trial_screenshot_commands),(select count(*) from internal.jiaowubao_trial_sync_commands),(select count(*) from internal.operational_contract_audit),(select version from public.ops_state where entity=\'students\')')
if counts != '1|1|2|1':
    raise AssertionError('concurrent confirmation wrote duplicate receipts or mutated student: ' + counts)
print('trial_screenshot_confirmation_concurrency_runtime_ok')
