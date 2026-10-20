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
subprocess.run(BASE + ['-f', str(ROOT / 'tests/sql/trial-handover-enrichment-setup.sql')], check=True)
seed = json.loads(sql('select internal.fixture_trial_handover_seed()'))
next_lp = dict(seed['lp'], fields=dict(seed['lp']['fields'], assignedTeacher='Synthetic Teacher',
              studentNameKnown=True, studentName='Synthetic Child', trialDurationMinutes=60),
              trialIntake=dict(seed['lp']['trialIntake'], studentName='Synthetic Child', trialDurationMinutes=60),
              trialSchedule=seed['link'])


def command(key):
    return sql('select internal.fixture_trial_handover_call(' + ','.join([
        literal(key), literal(json.dumps([next_lp])) + '::jsonb', literal(json.dumps(seed['tasks'])) + '::jsonb']) + ')')


first_key = '36000000-0000-4000-8000-000000000002'
statement = command(first_key)
first = subprocess.Popen(BASE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
first.stdin.write('begin;\nselect applied from (' + statement + ') result;\nselect pg_sleep(1);\ncommit;\n')
first.stdin.close()
if first.stdout.readline().strip() != 't':
    raise AssertionError('first enrichment did not reach an applied result')
second = subprocess.run(BASE + ['-c', 'select applied from (' + statement + ') result'], text=True, capture_output=True, timeout=15, check=True)
first.wait(timeout=15)
if first.returncode:
    raise AssertionError(first.stderr.read())
if second.stdout.strip() != 'f':
    raise AssertionError('concurrent same-key retry did not return the original result')
other = subprocess.run(BASE + ['-c', command('36000000-0000-4000-8000-000000000003')], text=True, capture_output=True, timeout=10)
if other.returncode == 0 or 'version_conflict' not in other.stderr:
    raise AssertionError('different-key stale enrichment overwrote current state')
counts = sql("select (select count(*) from internal.jiaowubao_trial_sync_commands),(select count(*) from internal.operational_contract_audit),(select version from public.ops_state where entity='students'),(select version from public.ops_state where entity='lpItems'),(select count(*) from public.ops_mutation_log where entity='lpItems')")
if counts != '1|2|1|2|1':
    raise AssertionError('concurrent enrichment wrote duplicate receipts or changed unrelated state: ' + counts)
print('trial_handover_enrichment_concurrency_runtime_ok')
