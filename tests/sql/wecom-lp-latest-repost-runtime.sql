\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
begin;

insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
  message_type, body, classification, student_name_hint, guardian_wechat_hint,
  operations_owner_hint, course_planner_hint, match_status, ingested_by)
select id, repeat('a',64), room, 'fixture-sales', sent::timestamptz, 'text',
  heading || E'\n【安排教师】：' || teacher || E'\n【安排科目】：' || subject || E'\n【微信名】：Draft Parent\n【学生姓名】：Draft Student',
  'handover','Draft Student','Draft Parent','Abby','Tara','pending','WeCom Bot Receiver'
from (values
 ('bot:latest:old','latest-room','2100-01-01 00:00Z','试听LP 信息交接','Grace','English'),
 ('bot:latest:new','latest-room','2100-01-01 01:00Z','试听LP 信息交接','Tynan','English'),
 ('bot:latest:delayed','latest-room','2100-01-01 00:30Z','试听LP 信息交接','Grace','English'),
 ('bot:latest:maths','latest-room','2100-01-01 02:00Z','试听LP 信息交接','Grace','Maths'),
 ('bot:latest:type','latest-room','2100-01-01 02:00Z','老生新LP 信息交接','Grace','English'),
 ('bot:latest:room','latest-other-room','2100-01-01 02:00Z','试听LP 信息交接','Grace','English')
) source(id,room,sent,heading,teacher,subject);

do $latest_repost$
declare page jsonb; next_page jsonb; source jsonb; receipt record; replay record;
  state_before jsonb; archive_before bigint; ids text[]; cursor_value text; scope_role text;
begin
  state_before := internal.fixture_wecom_lp_versions();
  select count(*) into archive_before from internal.wecom_archive_messages;
  if internal.wecom_lp_superseded_by('bot:latest:old') <> 'bot:latest:new'
    or internal.wecom_lp_superseded_by('bot:latest:delayed') <> 'bot:latest:new'
    or internal.wecom_lp_superseded_by('bot:latest:new') is not null
    or internal.wecom_lp_superseded_by('bot:latest:maths') is not null
    or internal.wecom_lp_superseded_by('bot:latest:type') is not null
    or internal.wecom_lp_superseded_by('bot:latest:room') is not null then
    raise exception 'latest_repost_time_or_group_boundaries_failed';
  end if;
  page := public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,2,'2100-01-01','2100-01-02');
  next_page := public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,page->>'nextCursor',2,'2100-01-01','2100-01-02');
  if page->>'total' <> '4' or next_page->>'total' <> '4'
    or jsonb_array_length(page->'rows') <> 2 or jsonb_array_length(next_page->'rows') <> 2
    or next_page->>'nextCursor' is not null then raise exception 'latest_repost_page_count_failed'; end if;
  select array_agg(row->>'sourceMessageId' order by row->>'sourceMessageId') into ids
  from jsonb_array_elements((page->'rows') || (next_page->'rows')) row;
  if ids <> array['bot:latest:maths','bot:latest:new','bot:latest:room','bot:latest:type'] then
    raise exception 'latest_repost_pagination_dropped_or_repeated';
  end if;
  if (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,'2100-01-01','2100-01-01 00:45Z'))->>'total' <> '0' then
    raise exception 'latest_repost_range_resurrected_old_source';
  end if;
  if exists(select 1 from jsonb_array_elements(public.read_wecom_lp_drafts('wecom-fixture-secret','Abby',false,null,50)->'rows') row
      where row->>'sourceMessageId' in ('bot:latest:old','bot:latest:delayed')) then
    raise exception 'latest_repost_rolling_reader_kept_old_source';
  end if;
  if (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Ella',false,null,30,'2100-01-01','2100-01-02'))->>'total' <> '0' then
    raise exception 'latest_repost_owner_scope_changed';
  end if;
  if (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,'bot:latest:old',1,'2100-01-01','2100-01-02'))->'rows'->0->>'sourceMessageId' <> 'bot:latest:new' then
    raise exception 'latest_repost_old_cursor_failed';
  end if;
  begin
    perform public.read_wecom_lp_draft('wecom-fixture-secret','bot:latest:old','Abby',false);
    raise exception 'latest_repost_single_read_allowed_old_source';
  exception when serialization_failure then
    if sqlerrm <> 'wecom_lp_source_superseded' then raise; end if;
  end;
  source := internal.wecom_lp_draft_source('bot:latest:old');
  begin
    perform public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
      source->>'sourceMessageId',source->>'sourceRevision','40000000-0000-4000-8000-000000000001',
      'STU-DRAFT-1',null,internal.fixture_wecom_lp_fields(),
      '{"owner":"Abby","planner":"Tara","mayReassign":false}',internal.fixture_wecom_lp_versions(),'Abby',false,'试听 LP');
    raise exception 'latest_repost_stale_tab_confirmed_old_source';
  exception when serialization_failure then
    if sqlerrm <> 'wecom_lp_source_superseded' then raise; end if;
  end;
  if state_before <> internal.fixture_wecom_lp_versions() or archive_before <> (select count(*) from internal.wecom_archive_messages) then
    raise exception 'latest_repost_read_or_rejection_mutated_state';
  end if;
  source := public.read_wecom_lp_draft('wecom-fixture-secret','bot:latest:new','Abby',false);
  if jsonb_array_length(source->'messages') <> 1 or source->'messages'->0->>'messageId' <> 'bot:latest:new'
    or source->'messages'->0->>'text' not like '%Tynan%' then raise exception 'latest_repost_new_fields_contaminated_by_old_template'; end if;
  select * into receipt from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
    source->>'sourceMessageId',source->>'sourceRevision','40000000-0000-4000-8000-000000000002',
    'STU-DRAFT-1',null,internal.fixture_wecom_lp_fields()||'{"assignedTeacher":"Tynan"}',
    '{"owner":"Abby","planner":"Tara","mayReassign":false}',internal.fixture_wecom_lp_versions(),'Abby',false,'试听 LP');
  if not receipt.applied then raise exception 'latest_repost_latest_confirmation_failed'; end if;
  insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
    message_type,body,classification,student_name_hint,guardian_wechat_hint,operations_owner_hint,course_planner_hint,match_status,ingested_by)
  select 'bot:latest:after-confirmed',repeat('b',64),chat_id,sender_id,'2100-01-01 03:00Z',message_type,body,classification,
    student_name_hint,guardian_wechat_hint,operations_owner_hint,course_planner_hint,match_status,ingested_by
  from internal.wecom_archive_messages where message_id='bot:latest:new';
  if internal.wecom_lp_superseded_by('bot:latest:new') is not null then raise exception 'latest_repost_hid_confirmed_lp'; end if;
  select * into replay from public.confirm_wecom_lp_draft_atomic('wecom-fixture-secret',(source->>'caseId')::uuid,
    source->>'sourceMessageId',source->>'sourceRevision','40000000-0000-4000-8000-000000000002',
    'STU-DRAFT-1',null,internal.fixture_wecom_lp_fields()||'{"assignedTeacher":"Tynan"}',
    '{"owner":"Abby","planner":"Tara","mayReassign":false}',internal.fixture_wecom_lp_versions(),'Abby',false,'试听 LP');
  if replay.applied or replay.lp_item_id <> receipt.lp_item_id or replay.audit_entry_id <> receipt.audit_entry_id then
    raise exception 'latest_repost_broke_confirmed_idempotency';
  end if;
  foreach scope_role in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(scope_role,'internal.wecom_lp_superseded_by(text)','execute')
      or has_function_privilege(scope_role,'internal.wecom_lp_repost_key(internal.wecom_archive_messages)','execute')
      or has_table_privilege(scope_role,'internal.wecom_archive_messages','select') then raise exception 'latest_repost_exposed_private_archive'; end if;
  end loop;
end;
$latest_repost$;

insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
  message_type,body,classification,student_name_hint,match_status,ingested_by)
select 'bot:latest:business:'||n,repeat('c',64),'latest-business','sales','2100-02-01'::timestamptz+n*interval '1 hour',
  'text',E'老生LP修改 信息交接\n学生姓名：Draft Student\n涉及科目：English\n变动内容：' || n,
  'handover','Draft Student','pending','WeCom Bot Receiver' from generate_series(1,2) n;
do $business_repost$
begin
  if internal.wecom_lp_superseded_by('bot:latest:business:1') <> 'bot:latest:business:2'
    or (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,'2100-02-01','2100-02-02'))->>'total' <> '1' then
    raise exception 'latest_repost_name_only_business_failed';
  end if;
end;
$business_repost$;

insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
  message_type,body,classification,student_name_hint,guardian_wechat_hint,
  operations_owner_hint,course_planner_hint,match_status,ingested_by)
select 'bot:latest:family:'||n,repeat('d',64),'latest-family-room','sales','2100-04-01'::timestamptz+n*interval '1 hour',
  'text',E'安排教师：Grace\n安排科目：English\n微信名：Family Parent\n学生姓名：Child '||n,
  'handover','Child '||n,'Family Parent','Abby','Tara','pending','WeCom Bot Receiver' from generate_series(1,2) n;
insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
  message_type,body,classification,student_name_hint,guardian_wechat_hint,
  operations_owner_hint,course_planner_hint,match_status,ingested_by)
select 'bot:latest:tie:'||suffix,repeat('e',64),'latest-tie-room','sales','2100-05-01',
  'text',E'安排教师：Grace\n安排科目：English\n微信名：Tie Parent\n学生姓名：Tie Student',
  'handover','Tie Student','Tie Parent','Abby','Tara','pending','WeCom Bot Receiver' from (values ('z'),('a')) t(suffix);
insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
  message_type,body,classification,student_name_hint,guardian_wechat_hint,
  operations_owner_hint,course_planner_hint,match_status,ingested_by)
select 'bot:latest:owner:'||n,repeat('f',64),'latest-owner-room','sales','2100-06-01'::timestamptz+n*interval '1 hour',
  'text',E'安排教师：Grace\n安排科目：English\n微信名：Owner Parent\n学生姓名：Owner Student\n教务老师：'||owner,
  'handover','Owner Student','Owner Parent',owner,'Tara','pending','WeCom Bot Receiver'
from (values (1,'Abby'),(2,'Ella')) t(n,owner);
do $uncertain_subject$
begin
  if internal.wecom_lp_repost_subject(E'安排科目：English\n科目：Maths') is not null
    or internal.wecom_lp_repost_subject(E'安排科目：待确认') is not null
    or internal.wecom_lp_repost_subject(E'[安排科目]: Ｙ８ English\n科目：Y8 English') <> 'y8english' then
    raise exception 'latest_repost_subject_identity_failed';
  end if;
  if internal.wecom_lp_superseded_by('bot:latest:family:1') is not null
    or (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,'2100-04-01','2100-04-02'))->>'total' <> '2' then
    raise exception 'latest_repost_collapsed_family_children';
  end if;
  if internal.wecom_lp_superseded_by('bot:latest:tie:a') <> 'bot:latest:tie:z'
    or internal.wecom_lp_superseded_by('bot:latest:tie:z') is not null then raise exception 'latest_repost_unstable_timestamp_tie'; end if;
  if (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',false,null,30,'2100-06-01','2100-06-02'))->>'total' <> '0'
    or (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Ella',false,null,30,'2100-06-01','2100-06-02'))->>'total' <> '1' then
    raise exception 'latest_repost_owner_reassignment_left_old_action';
  end if;
end;
$uncertain_subject$;
select 'wecom_lp_latest_repost_runtime_ok' as result;
rollback;
