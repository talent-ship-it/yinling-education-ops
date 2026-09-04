-- Pull the prior fully completed Melbourne month once per UTC day. At 18:17
-- UTC this is after midnight in Melbourne in both standard and daylight time;
-- the route's month calculation therefore never asks the upstream source for
-- a partially completed current month. The :17 offset also leaves a bounded
-- gap before the separate every-30-minute schedule sync calls the same vendor
-- tool. The bearer token is resolved only from Supabase Vault when the job
-- executes.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule(jobid)
  from cron.job
  where jobname = 'jiaowubao-completed-lesson-daily';

  perform cron.schedule(
    'jiaowubao-completed-lesson-daily',
    '17 18 * * *',
    $schedule$
      with valid_secret as (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'jiaowubao_completed_lesson_sync_token'
          and nullif(btrim(decrypted_secret), '') is not null
        limit 2
      ), exactly_one_secret as (
        select max(decrypted_secret) as token
        from valid_secret
        having count(*) = 1
      )
      select net.http_get(
        url := 'https://app.insiderleadsedu.com/api/cron/jiaowubao-completed-lessons',
        headers := jsonb_build_object('Authorization', 'Bearer ' || token),
        timeout_milliseconds := 300000
      )
      from exactly_one_secret;
    $schedule$
  );
end;
$$;

revoke all on schema net from public, anon, authenticated;
revoke all on function net.http_get(text,jsonb,jsonb,integer) from public, anon, authenticated;
revoke all on table net.http_request_queue from public, anon, authenticated;
revoke all on table net._http_response from public, anon, authenticated;

comment on extension pg_cron is 'Runs the private JWB over=1 completed-lesson sync daily; no payroll or operations projection. The job starts only after Vault contains exactly one nonblank sync token.';
