\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
\ir wecom-trial-handover-safe-identity-setup.sql
create schema internal;
create table public.ops_state(entity text primary key,payload jsonb not null,version bigint not null,updated_at timestamptz default now(),updated_by text);
create table public.ops_mutation_log(entity text,version bigint,actor text);
create table internal.operational_contract_audit(id uuid primary key default extensions.gen_random_uuid(),action text,actor text,target_type text,target_id text,metadata jsonb,created_at timestamptz default now());
create function internal.verify_ops_secret(p_secret text) returns boolean language sql as $$ select p_secret='wecom-fixture-secret' $$;
create function internal.append_operational_contract_audit(p_action text,p_actor text,p_target_type text,p_target_id text,p_metadata jsonb default '{}')
returns uuid language plpgsql as $$ declare receipt uuid; begin
 insert into internal.operational_contract_audit(action,actor,target_type,target_id,metadata) values(p_action,p_actor,p_target_type,p_target_id,p_metadata) returning id into receipt; return receipt;
end $$;
\ir ../../supabase/migrations/20260901000100_wecom_archive_ingestion.sql
\ir ../../supabase/migrations/20260910093517_wecom_bot_auto_match.sql
\ir ../../supabase/migrations/20260914000300_wecom_batch_lock_order.sql
\ir ../../supabase/migrations/20260915000200_wecom_name_format_matching.sql
\ir ../../supabase/migrations/20260915000300_wecom_trial_handover_identity.sql
\ir ../../supabase/migrations/20260915000400_wecom_trial_handover_tolerant_identity.sql
\ir ../../supabase/migrations/20261019000100_wecom_safe_guardian_identity.sql
insert into public.ops_state(entity,payload,version,updated_by) values
 ('students','[]',1,'fixture'),('files','[]',1,'fixture'),('messages','[]',1,'fixture');
