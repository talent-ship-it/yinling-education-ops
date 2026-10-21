\set ON_ERROR_STOP on
\ir wecom-lp-draft-setup.sql
create table internal.fixture_legacy_wecom_confirmation as
select * from public.confirm_wecom_lp_draft_atomic(
  'wecom-fixture-secret',
  (internal.wecom_lp_draft_source('bot:lp-draft:one')->>'caseId')::uuid,
  'bot:lp-draft:one', internal.wecom_lp_draft_source('bot:lp-draft:one')->>'sourceRevision',
  '10000000-0000-4000-8000-000000000001','STU-DRAFT-1',null,
  internal.fixture_wecom_lp_fields(),
  '{"owner":"Abby","planner":"Tara","mayReassign":false}',
  internal.fixture_wecom_lp_versions(),'Abby',false
);

insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
  message_type, body, classification, student_name_hint, match_status, ingested_by)
values('bot:business:historical',repeat('a',64),'business-historical','sales','2099-01-02','text',
  E'老生LP修改 信息交接\n学生姓名：Draft Student\n涉及科目：English\n变动内容：更改重点',
  'handover','Draft Student','pending','WeCom Bot Receiver');
