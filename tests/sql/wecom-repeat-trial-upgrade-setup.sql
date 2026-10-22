\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
insert into internal.wecom_archive_messages(message_id,content_sha256,chat_id,sender_id,sent_at,
  message_type,body,classification,student_name_hint,operations_owner_hint,match_status,ingested_by)
values ('bot:repeat:historical',repeat('6',64),'historical-repeat','sales','2099-02-01','text',
  E'二次试听 信息交接\n学生：Historical Repeat Student\n安排教师：Grace\n二次试听原因+注意事项：想再试一节',
  'handover','Historical Repeat Student','Abby','pending','WeCom Bot Receiver');
create table internal.fixture_repeat_before as
select m.message_id,m.body,b.id from internal.wecom_archive_messages m
join internal.wecom_lp_business_sources b on b.source_message_id=m.message_id
where m.message_id='bot:repeat:historical';
