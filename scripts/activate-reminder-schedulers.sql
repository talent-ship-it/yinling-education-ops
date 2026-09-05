-- Run only after explicit production-change approval and target verification.
-- Target: Insider Leads / orvsgisjjrzgtxuwwsms.
-- Precondition: Production OPS_REMINDER_CRON_SECRET has been saved securely
-- in this project's Vault as yinling_ops_reminder_cron_secret.
-- No credential value belongs in this file or in the cron command text.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '10s';

do $preflight$
begin
  if (select count(*) from vault.decrypted_secrets
      where name = 'yinling_ops_reminder_cron_secret') <> 1
     or not exists (select 1 from vault.decrypted_secrets
       where name = 'yinling_ops_reminder_cron_secret'
         and length(btrim(decrypted_secret)) > 0) then
    raise exception 'Expected one configured reminder secret; no jobs created';
  end if;
  if exists (select 1 from cron.job where jobname in
      ('lp-parent-progress-5m', 'trial-payment-reminders-5m')) then
    raise exception 'A target job already exists; inspect instead of overwriting';
  end if;
end;
$preflight$;

select cron.schedule('lp-parent-progress-5m', '1-59/5 * * * *', $job$
  select net.http_get(
    url := 'https://app.insiderleadsedu.com/api/cron/lp-parent-progress',
    headers := jsonb_build_object('Authorization', 'Bearer ' || s.decrypted_secret),
    timeout_milliseconds := 45000
  )
  from vault.decrypted_secrets s
  where s.name = 'yinling_ops_reminder_cron_secret'
    and length(btrim(s.decrypted_secret)) > 0
    and (select count(*) from vault.decrypted_secrets
      where name = 'yinling_ops_reminder_cron_secret') = 1;
$job$);

select cron.schedule('trial-payment-reminders-5m', '3-59/5 * * * *', $job$
  select net.http_get(
    url := 'https://app.insiderleadsedu.com/api/cron/trial-payment',
    headers := jsonb_build_object('Authorization', 'Bearer ' || s.decrypted_secret),
    timeout_milliseconds := 45000
  )
  from vault.decrypted_secrets s
  where s.name = 'yinling_ops_reminder_cron_secret'
    and length(btrim(s.decrypted_secret)) > 0
    and (select count(*) from vault.decrypted_secrets
      where name = 'yinling_ops_reminder_cron_secret') = 1;
$job$);

commit;

-- Read-only verification after the first scheduled executions:
-- SELECT jobname, schedule, active FROM cron.job
-- WHERE jobname IN ('lp-parent-progress-5m', 'trial-payment-reminders-5m');
-- SELECT count(*), max(started_at)
-- FROM internal.lp_parent_progress_scheduler_runs;
-- SELECT count(*), max(applied_at)
-- FROM internal.trial_payment_reconcile_runs;
-- Also check the associated HTTP and business outcomes, not only cron success.
