-- Resume the private member-page cursor often enough to finish a closed month
-- automatically. The seven-minute gaps around :00 and :30 avoid the
-- separate current-schedule job that uses query_schedule_list. Once a month
-- is published, the route performs a fast database no-change check and makes
-- no supplier request.

do $$
begin
  perform cron.unschedule(jobid)
  from cron.job
  where jobname = 'jiaowubao-completed-lesson-daily';

  perform cron.schedule(
    'jiaowubao-completed-lesson-daily',
    '7,12,17,22,37,42,47,52 * * * *',
    $schedule$
      with valid_secret as (
        select btrim(decrypted_secret) as decrypted_secret
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

comment on extension pg_cron is
  'Resumes the private completed-month JWB member-page cursor outside current-schedule sync start windows; published months no-op.';
