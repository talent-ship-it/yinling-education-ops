\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
begin;

insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
  message_type,body,classification,student_name_hint,guardian_wechat_hint,
  operations_owner_hint,course_planner_hint,match_status,ingested_by)
select 'bot:prefilter:' || n,repeat('a',64),'prefilter-shared-room','sales',
  '2101-01-01'::timestamptz+n*interval '1 minute','text',
  E'试听LP 信息交接\n安排教师：Grace\n安排科目：English\n学生姓名：Synthetic Child ' || n || E'\n微信名：Synthetic Parent ' || n,
  'handover','Synthetic Child ' || n,'Synthetic Parent ' || n,'Abby','Tara','pending','WeCom Bot Receiver'
from generate_series(1,83) n;
insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
  message_type,body,classification,student_name_hint,guardian_wechat_hint,
  operations_owner_hint,course_planner_hint,match_status,ingested_by)
select 'bot:prefilter:latest',repeat('b',64),chat_id,sender_id,'2101-01-02',message_type,
  replace(body,'Grace','Tynan'),classification,student_name_hint,guardian_wechat_hint,
  operations_owner_hint,course_planner_hint,match_status,ingested_by
from internal.wecom_archive_messages where message_id='bot:prefilter:1';

create temporary table prefilter_key_calls(message_id text);
alter function internal.wecom_lp_repost_key(internal.wecom_archive_messages) rename to fixture_wecom_lp_repost_key;
create function internal.wecom_lp_repost_key(p_message internal.wecom_archive_messages)
returns text[] language plpgsql volatile set search_path='' as $$
begin
  insert into pg_temp.prefilter_key_calls values(p_message.message_id);
  return internal.fixture_wecom_lp_repost_key(p_message);
end;
$$;
revoke all on function internal.wecom_lp_repost_key(internal.wecom_archive_messages) from public, anon, authenticated, service_role;
alter function internal.wecom_lp_superseded_by(text) volatile;

do $identity_prefilter$
declare checked integer; superseded integer; key_calls integer; signature text;
begin
  select count(*),count(*) filter(where internal.wecom_lp_superseded_by(m.message_id) is not null)
  into checked,superseded from internal.wecom_archive_messages m where m.chat_id='prefilter-shared-room';
  select count(*) into key_calls from pg_temp.prefilter_key_calls;
  if checked <> 84 or superseded <> 1 or key_calls > 85 then
    raise exception 'wecom_lp_repost_cross_identity_reparsed: checked=%, superseded=%, key_calls=%',checked,superseded,key_calls;
  end if;
  foreach signature in array array[
    'internal.wecom_lp_superseded_by(text)',
    'internal.wecom_lp_repost_key(internal.wecom_archive_messages)'
  ] loop
    if has_function_privilege('anon',signature,'execute') then
      raise exception 'wecom_lp_repost_helper_permissions_changed';
    end if;
  end loop;
end;
$identity_prefilter$;
select 'wecom_lp_repost_identity_prefilter_runtime_ok' as result;
rollback;
