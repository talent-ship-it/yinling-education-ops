\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
begin;
create schema internal;
create function internal.verify_ops_secret(p_secret text) returns boolean language sql immutable as $$ select p_secret = 'case-fixture' $$;
create table internal.wecom_trial_handover_cases (
  id uuid primary key, wechat_name text not null, student_name text,
  operations_owner text, course_planner text, status text not null, created_at timestamptz not null
);
create table internal.wecom_archive_messages(message_id integer primary key, sent_at timestamptz, trial_handover_id uuid);
insert into internal.wecom_trial_handover_cases values
 ('00000000-0000-4000-8000-000000000001','Old unresolved',null,null,null,'awaiting_student_name','2026-01-01');
insert into internal.wecom_archive_messages values (0,'2026-01-01','00000000-0000-4000-8000-000000000001');
insert into internal.wecom_archive_messages select g,'2026-09-01'::timestamptz + g * interval '1 minute',null from generate_series(1,250) g;
insert into internal.wecom_trial_handover_cases
 select gen_random_uuid(), 'Synthetic ' || g, null,null,null,
   case when g <= 60 then 'identity_conflict' else 'identified' end,
   '2026-09-01'::timestamptz + g * interval '1 minute'
 from generate_series(1,80) g;
\ir ../../supabase/migrations/20260922081926_wecom_case_review_pagination.sql
do $$
declare result jsonb; cursor_id uuid; all_ids uuid[] := '{}'; row_value jsonb;
begin
  if exists (select 1 from (select * from internal.wecom_archive_messages order by sent_at desc limit 100) recent where trial_handover_id is not null) then raise exception 'fixture_did_not_reproduce_old_message_window'; end if;
  result := public.read_wecom_handover_cases('case-fixture','pending',null,10);
  if (result->>'total')::integer <> 61 or (result->>'pendingCount')::integer <> 61 then raise exception 'incorrect_case_counts'; end if;
  if result->'rows'->0->>'id' <> '00000000-0000-4000-8000-000000000001' then raise exception 'old_unresolved_case_hidden'; end if;
  loop
    for row_value in select * from jsonb_array_elements(result->'rows') loop
      if (row_value->>'id')::uuid = any(all_ids) then raise exception 'duplicate_across_pages'; end if;
      all_ids := array_append(all_ids,(row_value->>'id')::uuid);
    end loop;
    cursor_id := (result->>'nextCursor')::uuid;
    exit when cursor_id is null;
    result := public.read_wecom_handover_cases('case-fixture','pending',cursor_id,10);
  end loop;
  if cardinality(all_ids) <> 61 then raise exception 'case_pagination_incomplete'; end if;
  if (public.read_wecom_handover_cases('case-fixture','identified',null,30)->>'total')::integer <> 20 then raise exception 'identified_filter_failed'; end if;
  if (public.read_wecom_handover_cases('case-fixture','all',null,30)->>'total')::integer <> 81 then raise exception 'all_filter_failed'; end if;
  begin perform public.read_wecom_handover_cases('wrong','all',null,30); raise exception 'bad_secret_accepted'; exception when insufficient_privilege then null; end;
  begin perform public.read_wecom_handover_cases('case-fixture',null,null,30); raise exception 'null_filter_accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.read_wecom_handover_cases('case-fixture','all',gen_random_uuid(),30); raise exception 'missing_cursor_accepted'; exception when invalid_parameter_value then null; end;
end;
$$;
rollback;
