create table if not exists internal.jiaowubao_open_api_schedule_snapshot_current(api_source_key text primary key,run_id uuid,revision text,published_at timestamptz);
create table if not exists internal.jiaowubao_open_api_schedule_snapshot_ingest_items(run_id uuid,source_key text);
create or replace function internal.trial_payment_iso(p_value timestamptz)
returns text
language sql
immutable
set search_path = ''
as $function$
  select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$function$;

create or replace function internal.trial_payment_task_status(
  p_due_at timestamptz,
  p_now timestamptz
)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when (p_due_at at time zone 'Australia/Melbourne')::date
       < (p_now at time zone 'Australia/Melbourne')::date then 'overdue'
    when (p_due_at at time zone 'Australia/Melbourne')::date
       = (p_now at time zone 'Australia/Melbourne')::date then 'today'
    else 'upcoming'
  end
$function$;

create function internal.reconcile_trial_payment_tasks_for_booking(jsonb,jsonb,jsonb,jsonb,text,jsonb,timestamptz)
returns jsonb language sql as $$ select $1 $$;
\ir ../../supabase/migrations/20260829000300_trial_payment_paid_lifecycle.sql
