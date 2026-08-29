-- Supabase owns the fifteen-minute production clock. A trigger-only token is
-- resolved from Vault when pg_cron calls the fixed Vercel worker. The tokens
-- that can read the bridge or call Tencent remain only in Vercel's encrypted
-- production environment. No credential or student field is stored here.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

do $$
begin
  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'tencent_trial_ledger_cron_token'
      and nullif(btrim(decrypted_secret), '') is not null
  ) then
    raise exception using errcode = '55000', message = 'tencent_trial_ledger_cron_vault_token_missing';
  end if;

  perform cron.unschedule(jobid)
  from cron.job
  where jobname = 'tencent-trial-ledger-sync-15m';

  perform cron.schedule(
    'tencent-trial-ledger-sync-15m',
    '*/15 * * * *',
    $schedule$
      select net.http_get(
        url := 'https://app.insiderleadsedu.com/api/cron/tencent-trial-ledger',
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'tencent_trial_ledger_cron_token'
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

comment on extension pg_cron is 'Runs fixed production source and outbound mirror synchronization routes.';
