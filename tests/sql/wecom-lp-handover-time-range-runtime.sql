\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
\ir wecom-lp-draft-setup.sql

create temporary table fixture_wecom_range_contract as
select oid, pg_catalog.pg_get_functiondef(oid) as definition from pg_catalog.pg_proc
where oid in (
  'public.read_wecom_lp_drafts(text,text,boolean,text,integer)'::regprocedure,
  'internal.wecom_lp_draft_source(text)'::regprocedure,
  'public.confirm_wecom_lp_draft_atomic(text,uuid,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,boolean)'::regprocedure
);
\ir ../../supabase/migrations/20261020104800_wecom_lp_handover_time_range.sql

begin;
insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
  ingested_at,message_type,body,classification,student_name_hint,guardian_wechat_hint,
  operations_owner_hint,course_planner_hint,match_status,ingested_by)
select 'bot:range:' || lpad(n::text,2,'0'), repeat('a',64), 'draft-room','fixture-sales',
  '2099-01-10T00:00:00Z'::timestamptz + ((n-1)/2) * interval '1 minute',
  '2099-03-01T00:00:00Z'::timestamptz - n * interval '1 day',
  'text', E'【安排教师】：Grace\n【安排科目】：English\n【微信名】：Draft Parent\n【学生姓名】：Draft Student',
  'handover','Draft Student','Draft Parent','Abby','Tara','pending','WeCom Bot Receiver'
from generate_series(1,35) n;
insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
  message_type,body,classification,student_name_hint,guardian_wechat_hint,
  operations_owner_hint,course_planner_hint,match_status,ingested_by)
values('bot:range:other',repeat('b',64),'draft-other-room','fixture-sales','2099-01-10T00:00:00Z',
  'text',E'【安排教师】：Grace\n【安排科目】：English\n【微信名】：Other Parent',
  'handover','Other Student','Other Parent','Ella','Tara','pending','WeCom Bot Receiver');

do $wecom_handover_range$
declare page jsonb; page_two jsonb; narrow jsonb; source jsonb; receipt record;
  from_at timestamptz := '2099-01-10T00:00:00Z'; before_at timestamptz := '2099-01-11T00:00:00Z';
  state_before jsonb; audit_before bigint; ids text[]; expected_ids text[];
begin
  if exists (select 1 from fixture_wecom_range_contract c where pg_catalog.pg_get_functiondef(c.oid) <> c.definition) then
    raise exception 'range_reader_changed_released_source_or_confirmation_contract';
  end if;
  source := internal.wecom_lp_draft_source('bot:range:15');
  select * into receipt from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',
    (source->>'caseId')::uuid,source->>'sourceMessageId',source->>'sourceRevision',
    '30000000-0000-4000-8000-000000000001','STU-DRAFT-1',null,internal.fixture_wecom_lp_fields(),
    '{"owner":"Abby","planner":"Tara","mayReassign":false}',internal.fixture_wecom_lp_versions(),'Abby',false);
  if not receipt.applied then raise exception 'range_fixture_confirmation_failed'; end if;
  state_before := internal.fixture_wecom_lp_versions();
  select count(*) into audit_before from internal.operational_contract_audit;
  page := public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,p_from=>from_at,p_before=>before_at);
  if page->>'total' <> '35' or jsonb_array_length(page->'rows') <> 30
     or page->>'nextCursor' <> 'bot:range:30' then
    raise exception 'range_default_page_or_total_failed';
  end if;
  select array_agg(row->>'sourceMessageId' order by position) into ids
  from jsonb_array_elements(page->'rows') with ordinality r(row,position);
  select array_agg('bot:range:' || lpad(n::text,2,'0') order by n) into expected_ids from generate_series(1,30) n;
  if ids is distinct from expected_ids then raise exception 'range_sorted_by_ingestion_or_lost_time_ties'; end if;
  if not exists(select 1 from jsonb_array_elements(page->'rows') row
      where row->>'sourceMessageId'='bot:range:15' and row->'confirmed'->>'lpItemId'=receipt.lp_item_id)
     or not exists(select 1 from jsonb_array_elements(page->'rows') row
      where row->>'sourceMessageId'='bot:range:01' and row->'confirmed'='null'::jsonb) then
    raise exception 'range_omitted_confirmed_or_pending_trial';
  end if;
  if exists(select 1 from jsonb_array_elements(page->'rows') row
    where row - 'handoverAt' <> internal.wecom_lp_draft_source(row->>'sourceMessageId')
      or (row->>'handoverAt')::timestamptz <> (select sent_at from internal.wecom_archive_messages where message_id=row->>'sourceMessageId')) then
    raise exception 'range_changed_source_revision_or_handover_time';
  end if;
  if (select row->>'sourceRevision' from jsonb_array_elements(page->'rows') row where row->>'sourceMessageId'='bot:range:15')
       is distinct from source->>'sourceRevision'
     or (public.read_wecom_lp_drafts('wecom-fixture-secret','Abby',false,null,50))->>'total' <> '37'
     or (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,'bot:range:15',1,from_at,before_at))->'rows'->0->>'sourceMessageId' <> 'bot:range:16' then
    raise exception 'range_confirmation_revision_or_rolling_compatibility_failed';
  end if;
  page_two := public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,page->>'nextCursor',30,from_at,before_at);
  select array_agg(row->>'sourceMessageId' order by position) into ids
  from jsonb_array_elements(page_two->'rows') with ordinality r(row,position);
  if ids is distinct from array['bot:range:31','bot:range:32','bot:range:33','bot:range:34','bot:range:35']
     or page_two->>'total' <> '35' or page_two->>'nextCursor' is not null then
    raise exception 'range_keyset_dropped_or_repeated_sources';
  end if;
  narrow := public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,1,from_at,before_at);
  page_two := public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,narrow->>'nextCursor',1,from_at,before_at);
  if narrow->'rows'->0->>'sourceMessageId' <> 'bot:range:01'
     or page_two->'rows'->0->>'sourceMessageId' <> 'bot:range:02' then
    raise exception 'range_cursor_lost_same_time_source';
  end if;
  narrow := public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,
    from_at+interval '4 minute',from_at+interval '6 minute');
  select array_agg(row->>'sourceMessageId' order by position) into ids
  from jsonb_array_elements(narrow->'rows') with ordinality r(row,position);
  if ids is distinct from array['bot:range:09','bot:range:10','bot:range:11','bot:range:12']
     or narrow->>'total' <> '4' then
    raise exception 'range_inclusive_lower_exclusive_upper_failed';
  end if;
  if (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,'2099-01-10T11:00:00+11',before_at))->'rows'
       is distinct from page->'rows' then
    raise exception 'range_instant_offset_equivalence_failed';
  end if;
  if (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,before_at,null))->>'total' <> '0'
     or (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,null,from_at))->>'total' <> '3'
     or (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false))->>'total' <> '38' then
    raise exception 'range_open_bounds_failed';
  end if;
  if (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Ella',false,null,30,from_at,before_at))->>'total' <> '1'
     or (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Nixon',true,null,50,from_at,before_at))->>'total' <> '36' then
    raise exception 'range_owner_or_full_admin_scope_failed';
  end if;
  begin
    perform public.read_wecom_lp_drafts_in_range('wrong','Abby',true,null,30,from_at,before_at);
    raise exception 'range_wrong_secret_allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,'bot:range:other',30,from_at,before_at);
    raise exception 'range_cross_owner_cursor_allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,'missing',30,from_at,before_at);
    raise exception 'range_missing_cursor_allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,'bot:lp-draft:identity',30,null,null);
    raise exception 'range_non_template_cursor_allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,'bot:range:01',30,from_at+interval '1 minute',before_at);
    raise exception 'range_outside_window_cursor_allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,0,from_at,before_at);
    raise exception 'range_zero_limit_allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,51,from_at,before_at);
    raise exception 'range_oversized_limit_allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,null,from_at,before_at);
    raise exception 'range_null_limit_allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,before_at,from_at);
    raise exception 'range_reversed_bounds_allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,from_at,from_at);
    raise exception 'range_equal_bounds_allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,'-infinity',before_at);
    raise exception 'range_nonfinite_lower_allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,from_at,'infinity');
    raise exception 'range_nonfinite_upper_allowed';
  exception when invalid_parameter_value then null; end;
  begin
    execute $bad$select public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,'not-a-date',null)$bad$;
    raise exception 'range_invalid_timestamp_allowed';
  exception when invalid_datetime_format then null; end;
  if has_function_privilege('service_role','public.read_wecom_lp_drafts_in_range(text,text,boolean,text,integer,timestamptz,timestamptz)','execute')
     or not has_function_privilege('anon','public.read_wecom_lp_drafts_in_range(text,text,boolean,text,integer,timestamptz,timestamptz)','execute')
     or not has_function_privilege('authenticated','public.read_wecom_lp_drafts_in_range(text,text,boolean,text,integer,timestamptz,timestamptz)','execute') then
    raise exception 'range_execution_grants_changed';
  end if;
  if state_before <> internal.fixture_wecom_lp_versions()
     or audit_before <> (select count(*) from internal.operational_contract_audit) then
    raise exception 'range_reader_mutated_operational_state';
  end if;
end;
$wecom_handover_range$;
select 'wecom_lp_handover_time_range_runtime_ok' as result;
rollback;
