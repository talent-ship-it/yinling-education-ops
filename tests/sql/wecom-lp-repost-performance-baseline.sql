\set ON_ERROR_STOP on
\ir assert-disposable-database.sql

insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
  message_type, body, classification, student_name_hint, guardian_wechat_hint,
  operations_owner_hint, course_planner_hint, match_status, ingested_by)
select 'bot:repost-scale:trial:' || n, repeat('a',64), 'repost-scale-room', 'fixture-sales',
  '2101-01-01'::timestamptz + n * interval '1 minute', 'text',
  E'试听LP 信息交接\n【安排教师】：Grace\n【安排科目】：English\n【微信名】：Synthetic Parent ' || n
    || E'\n【学生姓名】：Synthetic Child ' || n
    || E'\n【教务老师】：Abby\n【课程规划】：Tara\n【上课时间】：待定\n【所在时区】：VIC\n【课时】：60分钟\n【课堂要求】：'
    || repeat('Synthetic lesson requirement. ',12),
  'handover', 'Synthetic Child ' || n, 'Synthetic Parent ' || n, 'Abby', 'Tara', 'pending', 'WeCom Bot Receiver'
from generate_series(1,96) n;

insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
  message_type, body, classification, student_name_hint, guardian_wechat_hint,
  operations_owner_hint, course_planner_hint, match_status, ingested_by)
select 'bot:repost-scale:repost:' || n, repeat('b',64), chat_id, sender_id,
  '2101-01-02'::timestamptz + n * interval '1 minute', message_type,
  replace(body,'Grace','Tynan'), classification, student_name_hint, guardian_wechat_hint,
  operations_owner_hint, course_planner_hint, match_status, ingested_by
from internal.wecom_archive_messages cross join lateral (
  select substring(message_id from '[0-9]+$')::integer as n
) number
where message_id in ('bot:repost-scale:trial:1','bot:repost-scale:trial:2');

insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
  message_type, body, classification, student_name_hint, guardian_wechat_hint,
  operations_owner_hint, course_planner_hint, match_status, ingested_by)
select 'bot:repost-scale:other-subject', repeat('c',64), chat_id, sender_id,
  '2101-01-03', message_type, replace(body,'English','Maths'), classification,
  student_name_hint, guardian_wechat_hint, operations_owner_hint, course_planner_hint, match_status, ingested_by
from internal.wecom_archive_messages where message_id='bot:repost-scale:trial:1';

insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
  message_type, body, classification, student_name_hint, operations_owner_hint, match_status, ingested_by)
select 'bot:repost-scale:business:' || n, repeat('d',64), 'repost-scale-room', 'fixture-sales',
  '2101-01-04'::timestamptz + n * interval '1 minute', 'text',
  E'老生LP修改 信息交接\n学生姓名：Draft Student\n涉及科目：English\n变动内容：Synthetic update ' || n,
  'handover','Draft Student','Abby','pending','WeCom Bot Receiver'
from generate_series(1,2) n;

analyze internal.wecom_archive_messages;
create table internal.fixture_wecom_repost_performance_baseline(
  superseded jsonb not null, page_ids text[] not null, total bigint not null,
  helper_ms double precision not null, reader_ms double precision not null,
  helper_owner oid not null, helper_acl aclitem[], helper_security boolean not null
);

do $baseline$
declare started timestamptz; helper_ms double precision; reader_ms double precision;
  expected jsonb; page jsonb; ids text[]; total bigint;
begin
  if (select count(distinct trial_handover_id) from internal.wecom_archive_messages where chat_id='repost-scale-room') <> 96 then
    raise exception 'repost_scale_fixture_did_not_create_distinct_cases';
  end if;
  started := clock_timestamp();
  select jsonb_object_agg(message_id,internal.wecom_lp_superseded_by(message_id)) into expected
  from internal.wecom_archive_messages where chat_id='repost-scale-room';
  helper_ms := extract(epoch from clock_timestamp()-started)*1000;
  started := clock_timestamp();
  page := public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',true,null,30,'2101-01-01','2101-01-05');
  reader_ms := extract(epoch from clock_timestamp()-started)*1000;
  select array_agg(row->>'sourceMessageId' order by row->>'sourceMessageId') into ids from jsonb_array_elements(page->'rows') row;
  total := (page->>'total')::bigint;
  if total <> 98 or expected->>'bot:repost-scale:trial:1' <> 'bot:repost-scale:repost:1'
    or expected->>'bot:repost-scale:trial:2' <> 'bot:repost-scale:repost:2'
    or expected->>'bot:repost-scale:business:1' <> 'bot:repost-scale:business:2' then
    raise exception 'repost_scale_baseline_semantics_failed';
  end if;
  insert into internal.fixture_wecom_repost_performance_baseline
  select expected, ids, total, helper_ms, reader_ms, proowner, proacl, prosecdef
  from pg_catalog.pg_proc where oid='internal.wecom_lp_superseded_by(text)'::regprocedure;
  raise notice 'repost_scale_baseline: rows=101 cases=96 kept=% helper_ms=% reader_ms=%',total,helper_ms,reader_ms;
end;
$baseline$;
