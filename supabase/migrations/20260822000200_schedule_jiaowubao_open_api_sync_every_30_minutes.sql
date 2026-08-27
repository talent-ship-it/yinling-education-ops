-- Vercel Hobby only permits daily Cron jobs. Supabase Cron therefore invokes
-- the fixed Vercel route every thirty minutes. The bearer token is resolved
-- inside Vault only when the scheduled query runs; it is not stored in this
-- migration, cron.job command, application source, or browser code.
--
-- The called route retains its own durable lease and immutable source-pointer
-- CAS, so an asynchronous retry or duplicate invocation cannot publish a
-- partial snapshot or create operational records.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

do $$
begin
  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'jiaowubao_schedule_sync_token'
      and nullif(btrim(decrypted_secret), '') is not null
  ) then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_sync_vault_token_missing';
  end if;

  perform cron.unschedule(jobid)
  from cron.job
  where jobname = 'jiaowubao-open-api-schedule-30m';

  perform cron.schedule(
    'jiaowubao-open-api-schedule-30m',
    '*/30 * * * *',
    $schedule$
      select net.http_get(
        url := 'https://app.insiderleadsedu.com/api/cron/jiaowubao-schedule',
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'jiaowubao_schedule_sync_token'
          )
        ),
        timeout_milliseconds := 300000
      );
    $schedule$
  );
end;
$$;

revoke all on schema net from public, anon, authenticated;
revoke all on function net.http_get(text,jsonb,jsonb,integer) from public, anon, authenticated;
revoke all on table net.http_request_queue from public, anon, authenticated;
revoke all on table net._http_response from public, anon, authenticated;

comment on extension pg_cron is 'Runs the fixed JWB Open API source sync every 30 minutes; no operational projection.';
