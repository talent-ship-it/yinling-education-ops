begin isolation level serializable;
set local lock_timeout = '2s';
set local statement_timeout = '10s';

do $preflight$
begin
  if current_setting('transaction_isolation') <> 'serializable' then
    raise exception 'Scheduler activation requires a serializable transaction; no job created';
  end if;
  if exists (select 1 from unnest(array[
    'public.read_jiaowubao_unclosed_snapshot(text)',
    'public.begin_jiaowubao_unclosed_snapshot(text,uuid,text,timestamptz,integer)',
    'public.stage_jiaowubao_unclosed_snapshot(text,uuid,integer,jsonb)',
    'public.complete_jiaowubao_unclosed_snapshot(text,uuid)',
    'public.abort_jiaowubao_unclosed_snapshot(text,uuid)'
  ]) signature where to_regprocedure(signature) is null) then
    raise exception 'Required unclosed snapshot RPCs are missing; no job created';
  end if;
  if (select count(*) from vault.decrypted_secrets
      where name = 'jiaowubao_unclosed_sync_token') <> 1
     or not exists (select 1 from vault.decrypted_secrets
       where name = 'jiaowubao_unclosed_sync_token'
         and length(btrim(decrypted_secret)) >= 32) then
    raise exception 'Expected one configured unclosed sync credential of at least 32 characters; no job created';
  end if;
  if exists (select 1 from cron.job where jobname = 'jiaowubao-unclosed-daily') then
    raise exception 'Unclosed scheduler job already exists; inspect instead of overwriting';
  end if;
end;
$preflight$;

select cron.schedule('jiaowubao-unclosed-daily', '5 * * * *', $job$
  select net.http_get(
    url := 'https://app.insiderleadsedu.com/api/cron/jiaowubao-unclosed-lessons',
    headers := jsonb_build_object('Authorization', 'Bearer ' || s.decrypted_secret),
    timeout_milliseconds := 300000
  )
  from vault.decrypted_secrets s
  where s.name = 'jiaowubao_unclosed_sync_token'
    and length(btrim(s.decrypted_secret)) >= 32
    and (select count(*) from vault.decrypted_secrets
      where name = 'jiaowubao_unclosed_sync_token') = 1
    and extract(hour from current_timestamp at time zone 'Australia/Melbourne') = 8;
$job$);

commit;
