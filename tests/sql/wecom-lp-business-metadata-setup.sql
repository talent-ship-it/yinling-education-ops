\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
\ir ../../supabase/migrations/20261021122214_cache_wecom_schedule_run_metadata.sql

do $business_metadata_backfill$
declare result jsonb; batches integer := 0;
begin
  loop
    result := internal.backfill_wecom_schedule_run_metadata(4);
    batches := batches + 1;
    if batches > 100 then raise exception 'business_metadata_backfill_not_bounded'; end if;
    exit when result->>'remainingRuns' = '0';
  end loop;
end;
$business_metadata_backfill$;
