\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
begin;
create temporary table quote_business_before as select * from public.ops_state;
create function internal.fixture_quote_record(p_key text, p_room text, p_body text, p_at timestamptz default now())
returns jsonb language sql as $$
 select jsonb_build_object('messageId','bot:'||encode(extensions.digest(p_key,'sha256'),'hex'),
  'chatId',p_room,'senderId','synthetic-staff','sentAt',p_at,'messageType','text','text',p_body);
$$;
create function internal.fixture_quote_handover(p_key text, p_room text, p_parent text, p_at timestamptz default now()-interval '1 hour')
returns jsonb language sql as $$
 select internal.fixture_quote_record(p_key,p_room,E'试听LP 信息交接\n【安排教师】：Synthetic Teacher\n【安排科目】：English\n【微信名】：'||p_parent,p_at)
  || jsonb_build_object('classification','handover','guardianWechatHint',p_parent);
$$;
create function internal.fixture_quote_ingest(p_records jsonb, p_cutoff timestamptz default now()-interval '1 day')
returns jsonb language sql as $$ select public.ingest_wecom_bot_batch('wecom-fixture-secret',p_records,p_cutoff,'WeCom Bot Receiver') $$;
create function internal.fixture_quoted_reply(p_key text,p_room text,p_original jsonb,p_name text default 'Alex示例')
returns jsonb language sql as $$
 select internal.fixture_quote_record(p_key,p_room,p_name||'@教务AI助手') || jsonb_build_object('quote',jsonb_build_object(
  'messageId',p_original->>'messageId','text',p_original->>'text'),'quotedStudentName',p_name);
$$;

select internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quote_handover('one','room-one','Parent One')));
select internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quoted_reply('one-reply','room-one',internal.fixture_quote_handover('one','room-one','Parent One'))));
create temporary table quote_first_draft as select internal.wecom_lp_trial_draft_source(internal.fixture_quote_handover('one','room-one','Parent One')->>'messageId') payload;

do $$
declare source jsonb; identity_id uuid;
begin
 select payload into source from quote_first_draft;
 if source->>'studentName' is distinct from 'Alex示例' or source->>'status' <> 'identified'
   or jsonb_array_length(source->'messages') <> 2
   or source#>>'{messages,1,studentNameHint}' <> 'Alex示例' then raise exception 'quoted_name_not_in_original_draft'; end if;
 select trial_handover_id into identity_id from internal.wecom_archive_messages where message_id=source->>'sourceMessageId';
 if (select count(*) from internal.wecom_trial_handover_cases where id=identity_id and student_name='Alex示例') <> 1
   or (select count(*) from internal.wecom_archive_messages where trial_handover_id=identity_id) <> 2
   or (source#>>'{messages,0,sentAt}')::timestamptz <> now()-interval '1 hour'
   or (select count(*) from internal.wecom_bot_quoted_identities where status='matched') <> 1 then raise exception 'quoted_identity_case_or_original_time_changed'; end if;
end;
$$;
create temporary table quote_audit_before as select count(*) n from internal.operational_contract_audit;
select internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quoted_reply('one-reply','room-one',internal.fixture_quote_handover('one','room-one','Parent One'))));
do $$ begin
 if (select n from quote_audit_before) <> (select count(*) from internal.operational_contract_audit)
   or (select payload from quote_first_draft) is distinct from internal.wecom_lp_trial_draft_source(internal.fixture_quote_handover('one','room-one','Parent One')->>'messageId')
 then raise exception 'quoted_replay_changed_evidence'; end if;
 begin
  perform internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quoted_reply('one-reply','room-one',internal.fixture_quote_handover('one','room-one','Parent One'),'Other孩子')));
  raise exception 'changed_quote_replay_accepted';
 exception when unique_violation then null; end;
end $$;

select internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quote_handover('text-only','room-text','Parent Text')));
select internal.fixture_quote_ingest(jsonb_build_array((internal.fixture_quoted_reply('text-reply','room-text',internal.fixture_quote_handover('text-only','room-text','Parent Text')) #- '{quote,messageId}')));

do $$ begin
 if not exists(select 1 from internal.wecom_bot_quoted_identities where message_id=internal.fixture_quote_record('text-reply','','')->>'messageId' and status='matched') then raise exception 'exact_text_quote_failed'; end if;
end $$;

select internal.fixture_quote_ingest(jsonb_build_array(
 internal.fixture_quoted_reply('early-reply','room-early',internal.fixture_quote_handover('early','room-early','Parent Early'))));
select internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quote_handover('early','room-early','Parent Early')));
do $$ begin
 if not exists(select 1 from internal.wecom_bot_quoted_identities where message_id=internal.fixture_quote_record('early-reply','','')->>'messageId' and status='matched') then raise exception 'out_of_order_quote_not_revisited'; end if;
end $$;

select internal.fixture_quote_ingest(jsonb_build_array(
 internal.fixture_quoted_reply('cross-reply','other-room',internal.fixture_quote_handover('one','room-one','Parent One')),
 internal.fixture_quoted_reply('truncated','room-one',internal.fixture_quote_handover('one','room-one','Parent One')) || jsonb_build_object('quote',jsonb_build_object('messageId',internal.fixture_quote_handover('one','room-one','Parent One')->>'messageId','text','试听LP...')),
 internal.fixture_quoted_reply('wrong-id','room-one',internal.fixture_quote_handover('one','room-one','Parent One')) || jsonb_build_object('quote',jsonb_build_object('messageId','bot:'||repeat('f',64),'text',internal.fixture_quote_handover('one','room-one','Parent One')->>'text')),
 internal.fixture_quote_record('unknown-shape','room-one','Alex示例') || jsonb_build_object('quote','{}'::jsonb,'quotedStudentName','Alex示例')
));
do $$ begin
 if (select count(*) from internal.wecom_bot_quoted_identities q where q.message_id in (
  select internal.fixture_quote_record(k,'','')->>'messageId' from unnest(array['cross-reply','truncated','wrong-id','unknown-shape']) k) and q.status='pending' and q.source_message_id is null) <> 4 then raise exception 'untrusted_quote_resolved'; end if;
end $$;

select internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quote_handover('multi-a','room-multi','Parent Multi'),internal.fixture_quote_handover('multi-b','room-multi','Parent Multi')));
select internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quoted_reply('multi-reply','room-multi',internal.fixture_quote_handover('multi-a','room-multi','Parent Multi'))));
select internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quoted_reply('multi-text','room-multi',internal.fixture_quote_handover('multi-a','room-multi','Parent Multi')) #- '{quote,messageId}'));
update public.ops_state set payload='[{"id":"DUP-1","name":"Alex示例"},{"id":"DUP-2","name":"Alex示例"}]' where entity='students';
select internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quote_handover('same-name','room-same-name','Parent Same')));
select internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quoted_reply('same-name-reply','room-same-name',internal.fixture_quote_handover('same-name','room-same-name','Parent Same'))));
update public.ops_state set payload='[]' where entity='students';
select internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quoted_reply('conflict-reply','room-one',internal.fixture_quote_handover('one','room-one','Parent One'),'Other孩子')));

do $$ begin
 if (select count(*) from internal.wecom_bot_quoted_identities q where q.message_id in (
  select internal.fixture_quote_record(k,'','')->>'messageId' from unnest(array['multi-reply','multi-text','same-name-reply']) k) and q.status='ambiguous') <> 3 then raise exception 'ambiguous_identity_not_held'; end if;
 if not exists(select 1 from internal.wecom_bot_quoted_identities where message_id=internal.fixture_quote_record('conflict-reply','','')->>'messageId' and status='conflict')
   or not exists(select 1 from internal.wecom_trial_handover_cases where chat_id='room-one' and student_name='Alex示例' and status='identified')
 then raise exception 'conflicting_name_overwrote_identity'; end if;
 if exists(select 1 from internal.wecom_trial_handover_cases where chat_id in ('room-multi','room-same-name') and student_name is not null)
 then raise exception 'ambiguous_name_changed_case'; end if;
end $$;

do $$
declare original jsonb; acknowledgement text; draft jsonb;
begin
 original:=internal.fixture_quote_handover('ack-target','room-ack','Parent Ack');
 perform internal.fixture_quote_ingest(jsonb_build_array(original));
 foreach acknowledgement in array array['收到','谢谢','好的'] loop
  perform internal.fixture_quote_ingest(jsonb_build_array(
   internal.fixture_quote_record('ack-'||acknowledgement,'room-ack',acknowledgement||'@教务AI助手')
    || jsonb_build_object('quote',jsonb_build_object('messageId',original->>'messageId','text',original->>'text'))));
  if exists(select 1 from internal.wecom_trial_handover_cases where chat_id='room-ack' and (student_name is not null or status='identified'))
   or not exists(select 1 from internal.wecom_bot_quoted_identities where message_id=internal.fixture_quote_record('ack-'||acknowledgement,'','')->>'messageId' and student_name is null and status='pending')
   then raise exception 'ordinary_quote_established_identity'; end if;
 end loop;
 perform internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quoted_reply('ack-real-name','room-ack',original)));
 select internal.wecom_lp_trial_draft_source(original->>'messageId') into draft;
 if draft->>'studentName' is distinct from 'Alex示例' or draft->>'status' <> 'identified'
  or jsonb_array_length(draft->'messages')<>2
  or (draft#>>'{messages,0,sentAt}')::timestamptz<>now()-interval '1 hour'
  or not exists(select 1 from internal.wecom_trial_handover_cases where chat_id='room-ack' and student_name='Alex示例'
   and identity_message_id=internal.fixture_quote_record('ack-real-name','','')->>'messageId')
  or exists(select 1 from internal.wecom_bot_quoted_identities where message_id in (
   select internal.fixture_quote_record('ack-'||k,'','')->>'messageId' from unnest(array['收到','谢谢','好的']) k) and (student_name is not null or status<>'pending'))
  then raise exception 'ordinary_quote_blocked_later_real_name'; end if;
end $$;

create extension if not exists dblink with schema extensions;
do $$
declare original jsonb; replies jsonb; page integer;
begin
 original:=internal.fixture_quote_handover('backlog-original','room-backlog','Parent Backlog');
 perform internal.fixture_quote_ingest(jsonb_build_array(original));
 for page in 0..1 loop
  select jsonb_agg(internal.fixture_quote_record('backlog-ack-'||n,'room-backlog','收到@教务AI助手')
   || jsonb_build_object('quote',jsonb_build_object('messageId',original->>'messageId','text',original->>'text')))
  into replies from generate_series(page*50+1,page*50+50) n;
  perform internal.fixture_quote_ingest(replies);
  select jsonb_agg(internal.fixture_quoted_reply('backlog-missing-'||n,'room-backlog',
   internal.fixture_quote_handover('backlog-not-yet-'||n,'room-backlog','Missing Parent '||n)))
  into replies from generate_series(page*50+1,page*50+50) n;
  perform internal.fixture_quote_ingest(replies);
 end loop;
 update internal.wecom_bot_quoted_identities q set created_at=now()-interval '2 hours'
 from internal.wecom_archive_messages m where q.message_id=m.message_id and m.chat_id='room-backlog';
 if (select count(*) from internal.wecom_bot_quoted_identities q join internal.wecom_archive_messages m using(message_id)
  where m.chat_id='room-backlog' and q.student_name is null and q.status='pending')<>100
  or (select count(*) from internal.wecom_bot_quoted_identities q join internal.wecom_archive_messages m using(message_id)
   where m.chat_id='room-backlog' and q.student_name='Alex示例' and q.status='pending')<>100 then raise exception 'missing_old_ineligible_backlog'; end if;
end $$;
create temporary table quote_backlog_clock as select sent_at from internal.wecom_archive_messages
where message_id=internal.fixture_quote_handover('backlog-original','room-backlog','Parent Backlog')->>'messageId';
commit;
begin;
do $$
declare original jsonb; reply_id text; draft jsonb;
begin
 original:=internal.fixture_quote_handover('backlog-original','room-backlog','Parent Backlog');
 reply_id:=internal.fixture_quote_record('backlog-real-name','','')->>'messageId';
 perform extensions.dblink_connect('quote_backlog_lock',format('host=127.0.0.1 port=%s dbname=%s user=%s connect_timeout=3',current_setting('port'),current_database(),current_user));
 perform extensions.dblink_exec('quote_backlog_lock',pg_temp.disposable_database_assertion_sql());
 perform extensions.dblink_exec('quote_backlog_lock',$lock_sql$do $lock$ begin
  perform pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended('room-backlog',0));
 end $lock$;$lock_sql$);
 perform internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quoted_reply('backlog-real-name','room-backlog',original)));
 if not exists(select 1 from internal.wecom_bot_quoted_identities where message_id=reply_id and student_name='Alex示例'
  and status='pending' and source_message_id is null)
  or exists(select 1 from internal.wecom_trial_handover_cases where chat_id='room-backlog' and student_name is not null)
  then raise exception 'quote_was_not_deferred_by_real_contention'; end if;
 perform extensions.dblink_disconnect('quote_backlog_lock');
 perform internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quote_record('backlog-unrelated','room-backlog','Synthetic unrelated update')));
 select internal.wecom_lp_trial_draft_source(original->>'messageId') into draft;
 if not exists(select 1 from internal.wecom_bot_quoted_identities where message_id=reply_id and status='matched'
   and source_message_id=original->>'messageId')
  or draft->>'studentName' is distinct from 'Alex示例' or draft->>'status'<>'identified'
  or jsonb_array_length(draft->'messages')<>2
  or (draft#>>'{messages,0,sentAt}')::timestamptz<>(select sent_at from quote_backlog_clock)
  or (select count(*) from internal.wecom_bot_quoted_identities q join internal.wecom_archive_messages m using(message_id)
   where m.chat_id='room-backlog' and q.student_name is null and q.status='pending' and q.source_message_id is null)<>100
  or (select count(*) from internal.wecom_bot_quoted_identities q join internal.wecom_archive_messages m using(message_id)
   where m.chat_id='room-backlog' and q.student_name='Alex示例' and q.status='pending' and q.source_message_id is null)<>100
  then raise exception 'old_ineligible_quotes_starved_deferred_identity'; end if;
end $$;

select internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quote_handover('old','room-cutoff','Parent Old',now()-interval '3 days')),now()-interval '4 days');
select internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quoted_reply('cutoff-reply','room-cutoff',internal.fixture_quote_handover('old','room-cutoff','Parent Old'))));
do $$ begin
 if not exists(select 1 from internal.wecom_bot_quoted_identities where message_id=internal.fixture_quote_record('cutoff-reply','','')->>'messageId' and status='pending') then raise exception 'quote_bypassed_cutoff'; end if;
 begin
  perform internal.fixture_quote_ingest(jsonb_build_array(internal.fixture_quote_record('precutoff','room-one','Synthetic',now()-interval '2 days')));
  raise exception 'reply_bypassed_cutoff';
 exception when invalid_parameter_value then null; end;
 begin
  perform public.ingest_wecom_bot_batch('wrong',jsonb_build_array(internal.fixture_quote_record('bad-secret','room-one','Synthetic')),now()-interval '1 day','WeCom Bot Receiver');
  raise exception 'quote_bypassed_secret';
 exception when insufficient_privilege then null; end;
 if exists((select * from public.ops_state except select * from quote_business_before) union all (select * from quote_business_before except select * from public.ops_state)) then raise exception 'quote_changed_operational_state'; end if;
 if exists(select 1 from internal.wecom_lp_confirmations) then raise exception 'quote_created_lp_confirmation'; end if;
 if has_table_privilege('anon','internal.wecom_bot_quoted_identities','select') or has_function_privilege('anon','internal.ingest_wecom_bot_batch_without_quotes(text,jsonb,timestamptz,text)','execute') then raise exception 'quote_private_boundary_exposed'; end if;
end $$;
select 'wecom quoted identity: exact ID/text, original request time, replay, out-of-order, ambiguity, conflict, cutoff, secret, private boundary and no business writes passed' receipt;
rollback;
