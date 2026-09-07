-- Execute after the reviewed GitHub release and explicit production approval.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '10s';
do $$
begin
 if exists(select 1 from cron.job where jobname='classroom-provision-5m') then raise exception 'Job already exists; inspect instead of overwriting'; end if;
 if (select count(*) from vault.decrypted_secrets where name='yinling_ops_reminder_cron_secret' and length(btrim(decrypted_secret))>0) <> 1 then raise exception 'Expected one configured reminder credential'; end if;
end; $$;
select cron.schedule('classroom-provision-5m', '2-59/5 * * * *', $job$
 select net.http_get(url := 'https://app.insiderleadsedu.com/api/cron/classroom-provision', headers := jsonb_build_object('Authorization', 'Bearer ' || s.decrypted_secret), timeout_milliseconds := 60000)
 from vault.decrypted_secrets s where s.name='yinling_ops_reminder_cron_secret' and length(btrim(s.decrypted_secret))>0
 and (select count(*) from vault.decrypted_secrets where name='yinling_ops_reminder_cron_secret')=1;
$job$);
commit;
