import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = [os.environ.get('PSQL', 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']
SCRIPT = (ROOT / 'scripts/activate-unclosed-lesson-scheduler.sql').read_text()
RPCS = [
    'read_jiaowubao_unclosed_snapshot(text)',
    'begin_jiaowubao_unclosed_snapshot(text,uuid,text,timestamptz,integer)',
    'stage_jiaowubao_unclosed_snapshot(text,uuid,integer,jsonb)',
    'complete_jiaowubao_unclosed_snapshot(text,uuid)',
    'abort_jiaowubao_unclosed_snapshot(text,uuid)',
]


def sql(statement, expected_error=None):
    result = subprocess.run(BASE, input=statement, text=True, capture_output=True, timeout=20)
    if expected_error is None:
        if result.returncode != 0:
            raise AssertionError('Synthetic scheduler SQL failed without exposing its private parameters')
    elif result.returncode == 0 or expected_error not in result.stderr:
        raise AssertionError('Synthetic scheduler preflight did not reject the expected condition')
    return result.stdout.strip()


def assert_sql(expression, label):
    if sql('select (' + expression + ') is true') != 't':
        raise AssertionError(label)


def create_rpc(signature):
    sql('create function public.' + signature + " returns jsonb language sql as $$ select '{}'::jsonb $$;")


subprocess.run(BASE + ['-f', str(ROOT / 'tests/sql/assert-disposable-database.sql')], check=True)
sql('''
create schema cron;
create schema net;
create schema vault;
create table cron.job(jobid bigint generated always as identity primary key,jobname text unique not null,schedule text not null,command text not null,active boolean not null default true);
create table vault.decrypted_secrets(name text,decrypted_secret text);
create table public.fixture_http_calls(url text,timeout_milliseconds integer,authorization_valid boolean,header_keys text[],tick timestamptz);
create function cron.schedule(p_name text,p_schedule text,p_command text) returns bigint language plpgsql as $$
declare result bigint;
begin
 insert into cron.job(jobname,schedule,command) values(p_name,p_schedule,p_command)
 on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid into result;
 return result;
end $$;
create function net.http_get(url text,params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 2000) returns bigint language plpgsql as $$
begin
 insert into public.fixture_http_calls values(url,timeout_milliseconds,
  headers->>'Authorization' = 'Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='jiaowubao_unclosed_sync_token'),
  array(select jsonb_object_keys(headers)),current_setting('fixture.tick')::timestamptz);
 return 1;
end $$;
insert into cron.job(jobname,schedule,command,active) values('unrelated-fixture-job','17 * * * *','select 42',false);
create table public.fixture_jobs_before as select * from cron.job;
insert into vault.decrypted_secrets values('jiaowubao_unclosed_sync_token',md5(random()::text));
''')

for signature in RPCS:
    create_rpc(signature)
for signature in RPCS:
    sql('drop function public.' + signature + ';')
    sql(SCRIPT, 'Required unclosed snapshot RPCs are missing')
    assert_sql('not exists(select 1 from cron.job where jobname=\'jiaowubao-unclosed-daily\')', 'Missing RPC installed a job')
    create_rpc(signature)

for secret_sql in [
    "delete from vault.decrypted_secrets; insert into vault.decrypted_secrets values('yinling_ops_reminder_cron_secret',md5(random()::text));",
    "insert into vault.decrypted_secrets values('jiaowubao_unclosed_sync_token',null);",
    "update vault.decrypted_secrets set decrypted_secret=repeat('x',31);",
    "update vault.decrypted_secrets set decrypted_secret=repeat(' ',40);",
    "update vault.decrypted_secrets set decrypted_secret=md5(random()::text); insert into vault.decrypted_secrets select name,decrypted_secret from vault.decrypted_secrets;",
]:
    sql(secret_sql)
    sql(SCRIPT, 'Expected one configured unclosed sync credential')
    assert_sql("(select count(*) from cron.job)=1", 'Invalid credential installed a job')

sql("delete from vault.decrypted_secrets; insert into vault.decrypted_secrets values('jiaowubao_unclosed_sync_token',md5(random()::text));")
sql("insert into cron.job(jobname,schedule,command,active) values('jiaowubao-unclosed-daily','0 0 * * *','select 73',false);")
sql(SCRIPT, 'Unclosed scheduler job already exists')
assert_sql("(select count(*) from cron.job)=2 and (select schedule='0 0 * * *' and command='select 73' and not active from cron.job where jobname='jiaowubao-unclosed-daily')", 'Activation overwrote an existing target job')
sql("delete from cron.job where jobname='jiaowubao-unclosed-daily';")
sql(SCRIPT)
assert_sql("(select count(*) from cron.job)=2 and (select count(*) from cron.job where jobname='jiaowubao-unclosed-daily')=1", 'Activation did not install exactly one job')
assert_sql("not exists((select * from cron.job where jobname<>'jiaowubao-unclosed-daily' except select * from public.fixture_jobs_before) union all (select * from public.fixture_jobs_before except select * from cron.job where jobname<>'jiaowubao-unclosed-daily'))", 'Activation changed another job')
assert_sql("(select schedule='5 * * * *' and active from cron.job where jobname='jiaowubao-unclosed-daily')", 'Activation schedule was incorrect')
assert_sql("not exists(select 1 from cron.job j cross join vault.decrypted_secrets s where position(s.decrypted_secret in j.command)>0)", 'Cron command embedded a credential value')
assert_sql('not exists(select 1 from public.fixture_http_calls)', 'Registration executed an HTTP request')
sql(SCRIPT, 'Unclosed scheduler job already exists')
assert_sql("(select count(*) from cron.job)=2", 'Repeated activation changed the jobs')

for day in ['2026-01-15', '2026-07-15', '2026-04-05', '2026-10-04']:
    sql("""
truncate public.fixture_http_calls;
do $$ declare tick timestamptz; command text;
begin
 select j.command into command from cron.job j where jobname='jiaowubao-unclosed-daily';
 for tick in select generate_series('""" + day + """'::date::timestamp at time zone 'Australia/Melbourne',
  ('""" + day + """'::date+1)::timestamp at time zone 'Australia/Melbourne'-interval '1 hour',interval '1 hour')+interval '5 minutes' loop
  perform set_config('fixture.tick',tick::text,true);
  execute replace(command,'current_timestamp',quote_literal(tick)||'::timestamptz');
 end loop;
end $$;
""")
    assert_sql("(select count(*) from public.fixture_http_calls)=1 and not exists(select 1 from public.fixture_http_calls where (tick at time zone 'Australia/Melbourne')::time<>'08:05'::time or url<>'https://app.insiderleadsedu.com/api/cron/jiaowubao-unclosed-lessons' or timeout_milliseconds<>300000 or authorization_valid is distinct from true or header_keys<>array['Authorization'])", 'Summer/winter/DST scheduling or request contract failed')

for mutation in [
    'delete from vault.decrypted_secrets;',
    "insert into vault.decrypted_secrets values('jiaowubao_unclosed_sync_token',repeat('x',31));",
    "update vault.decrypted_secrets set decrypted_secret=md5(random()::text); insert into vault.decrypted_secrets select name,decrypted_secret from vault.decrypted_secrets;",
]:
    sql(mutation)
    sql("""
truncate public.fixture_http_calls;
do $$ declare command text;
begin
 select j.command into command from cron.job j where jobname='jiaowubao-unclosed-daily';
 perform set_config('fixture.tick','2026-07-14T22:05:00Z',true);
 execute replace(command,'current_timestamp',quote_literal('2026-07-14T22:05:00Z'::timestamptz)||'::timestamptz');
end $$;
""")
    assert_sql('not exists(select 1 from public.fixture_http_calls)', 'Runtime invalid credential sent a request')

print('unclosed scheduler activation: dependency/token/job guards, one isolated job, no embedded credential, runtime fail-closed and summer/winter/DST 08:05 passed')
