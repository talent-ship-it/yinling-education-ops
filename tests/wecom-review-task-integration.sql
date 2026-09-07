-- Run in a disposable database with the original mirror migration installed.
\set ON_ERROR_STOP on
begin;
create role service_role;
create table public.ops_state(entity text primary key,payload jsonb,version bigint,updated_at timestamptz,updated_by text);
create table public.ops_mutation_log(entity text,version bigint,actor text);
create table internal.operational_contract_audit(id uuid primary key default gen_random_uuid());
create function internal.append_operational_contract_audit(text,text,text,text,jsonb) returns uuid language plpgsql as $$ declare i uuid; begin insert into internal.operational_contract_audit default values returning id into i; return i; end $$;
\ir ../supabase/migrations/20260907111000_wecom_review_batches_and_tasks.sql
insert into public.ops_state values ('students','[{"id":"STU-TEST","name":"Synthetic Student","owner":"Test Owner"}]',1,now(),'test'),('tasks','[]',1,now(),'test');
insert into internal.wecom_mirror_review_batches(batch_id,group_name,source_revision,rows_digest,expected_rows,captured_at,summary)
values('wxm-'||repeat('c',32),'Synthetic published group',repeat('c',64),repeat('0',64),1,now(),'{}'),('wxm-'||repeat('d',32),'Synthetic hidden group',repeat('d',64),repeat('0',64),1,now()+interval '1 hour','{}');
insert into internal.wecom_mirror_review_rows
select 'wxm-'||repeat('c',32),1,'task','synthetic.png',b,encode(extensions.digest('task'||chr(10)||'synthetic.png'||chr(10)||b,'sha256'),'hex') from (select '{"identityVerified":true,"actionKey":"synthetic-review","studentId":"STU-TEST","studentName":"Synthetic Student","owner":"Test Owner","title":"Verify handover","description":"Synthetic source verification","reviewDueAt":"2026-09-08T08:00:00.000Z"}'::text b) x;
update internal.wecom_mirror_review_batches set rows_digest=(select encode(extensions.digest(content_sha256,'sha256'),'hex') from internal.wecom_mirror_review_rows where batch_id='wxm-'||repeat('c',32)) where batch_id='wxm-'||repeat('c',32);
select internal.publish_wecom_mirror_review('wxm-'||repeat('c',32),repeat('c',64));
do $$ declare r jsonb; task_id text; v bigint; begin
 -- Hidden/unpublished sources cannot be promoted.
 begin perform internal.promote_wecom_review_task('wxm-'||repeat('d',32),1); raise exception 'test: hidden promotion accepted'; exception when no_data_found then null; end;
 -- Identity/owner drift fails before any task is written.
 update public.ops_state set payload='[{"id":"STU-TEST","name":"Changed Student","owner":"Test Owner"}]' where entity='students';
 begin perform internal.promote_wecom_review_task('wxm-'||repeat('c',32),1); raise exception 'test: drift accepted'; exception when raise_exception then if sqlerrm<>'review_student_authority_changed' then raise; end if; end;
 update public.ops_state set payload='[{"id":"STU-TEST","name":"Synthetic Student","owner":"Test Owner","importArchived":true}]' where entity='students';
 begin perform internal.promote_wecom_review_task('wxm-'||repeat('c',32),1); raise exception 'test: archived accepted'; exception when raise_exception then if sqlerrm<>'review_student_authority_changed' then raise; end if; end;
 update public.ops_state set payload='[{"id":"STU-TEST","name":"Synthetic Student","owner":"Test Owner"}]' where entity='students';
 r:=internal.promote_wecom_review_task('wxm-'||repeat('c',32),1); task_id:=r->>'taskId';
 if r->>'applied'<>'true' or (select jsonb_array_length(payload) from public.ops_state where entity='tasks')<>1 then raise exception 'test: projection missing'; end if;
 update public.ops_state set payload=jsonb_set(payload,'{0,status}','"done"') where entity='tasks';
 select version into v from public.ops_state where entity='tasks';
 r:=internal.promote_wecom_review_task('wxm-'||repeat('c',32),1);
 if r->>'applied'<>'false' or (select version from public.ops_state where entity='tasks')<>v or (select payload#>>'{0,status}' from public.ops_state where entity='tasks')<>'done' then raise exception 'test: replay reopened or mutated'; end if;
 r:=public.read_wecom_mirror_review_v2('synthetic-test-only','task','',1,'wxm-'||repeat('c',32));
 if r#>>'{batch,id}'<>'wxm-'||repeat('c',32) or r#>>'{rows,0,task,status}'<>'done' or r#>>'{rows,0,task,id}'<>task_id then raise exception 'test: batch or live state wrong'; end if;
 if exists(select 1 from jsonb_array_elements(r->'batches') b where b->>'id'='wxm-'||repeat('d',32)) then raise exception 'test: staging exposed'; end if;
 r:=public.read_wecom_mirror_review_v2('synthetic-test-only','task','',1,'wxm-'||repeat('d',32));
 if r->'batch'<>'null'::jsonb or r->>'total'<>'0' then raise exception 'test: hidden selection leaked or silently replaced'; end if;
 begin perform public.read_wecom_mirror_review_v2('invalid'); raise exception 'test: secret bypass'; exception when insufficient_privilege then null; end;
 if has_function_privilege('anon','internal.promote_wecom_review_task(text,integer)','EXECUTE') or has_function_privilege('authenticated','internal.promote_wecom_review_task(text,integer)','EXECUTE') or has_function_privilege('service_role','internal.promote_wecom_review_task(text,integer)','EXECUTE') then raise exception 'test: public promotion privilege'; end if;
 raise notice 'PASS: hidden source, identity drift, archive, projection, replay/completion, batch selection, staging privacy, secret, owner-only promotion';
end $$;
rollback;
