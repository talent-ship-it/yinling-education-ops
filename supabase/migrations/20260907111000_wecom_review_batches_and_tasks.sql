-- Reviewed mirror sources may create an internal verification task before a
-- complete LP exists. Only the database owner can promote: this is not an OCR
-- auto-execution endpoint and does not modify LPs, bookings or payment state.
create table internal.wecom_review_task_links (
 batch_id text not null,
 row_number integer not null,
 action_key text not null unique,
 task_id text not null unique,
 intent_hash text not null,
 audit_id uuid not null references internal.operational_contract_audit(id),
 created_at timestamptz not null default now(),
 primary key (batch_id,row_number),
 foreign key (batch_id,row_number) references internal.wecom_mirror_review_rows(batch_id,row_number)
);
alter table internal.wecom_review_task_links enable row level security;
revoke all on internal.wecom_review_task_links from public,anon,authenticated,service_role;

create function internal.promote_wecom_review_task(p_batch_id text,p_row_number integer)
returns jsonb language plpgsql set search_path='' as $$
declare r internal.wecom_mirror_review_rows%rowtype; b jsonb; student jsonb;
 students_state public.ops_state%rowtype; tasks_state public.ops_state%rowtype;
 prior internal.wecom_review_task_links%rowtype; task jsonb; task_id_value text;
 deadline timestamptz; audit_value uuid; n integer;
begin
 select r0.* into strict r from internal.wecom_mirror_review_rows r0
 join internal.wecom_mirror_review_batches b0 on b0.batch_id=r0.batch_id
 where r0.batch_id=p_batch_id and r0.row_number=p_row_number and b0.published_at is not null;
 b:=r.body_text::jsonb;
 if r.kind<>'task' or b->'identityVerified' is distinct from 'true'::jsonb
   or coalesce(b->>'actionKey','') !~ '^[a-z0-9][a-z0-9._:-]{1,119}$'
   or coalesce(b->>'studentId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
   or coalesce(length(btrim(b->>'title')),0) not between 1 and 200
   or coalesce(length(btrim(b->>'description')),0) not between 1 and 4000
   or coalesce(length(btrim(b->>'studentName')),0) not between 1 and 200
   or coalesce(length(btrim(b->>'owner')),0) not between 1 and 120
   or coalesce(b->>'owner','') in ('待分配','未分配')
   or coalesce(b->>'reviewDueAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
  raise exception 'unverified_or_incomplete_review_task';
 end if;
 deadline:=(b->>'reviewDueAt')::timestamptz;
 if not isfinite(deadline) or to_char(deadline at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>b->>'reviewDueAt' then raise exception 'invalid_review_deadline'; end if;
 -- Same exclusive lock order as the existing student/task atomic workflows.
 select * into strict students_state from public.ops_state where entity='students' for update;
 select * into strict tasks_state from public.ops_state where entity='tasks' for update;
 select * into prior from internal.wecom_review_task_links where action_key=b->>'actionKey' or (batch_id=p_batch_id and row_number=p_row_number);
 if found then
  if prior.intent_hash<>r.content_sha256 or prior.batch_id<>p_batch_id or prior.row_number<>p_row_number then raise exception 'review_task_intent_conflict'; end if;
  -- Never recreate a deleted task or reopen a task completed after import.
  return jsonb_build_object('applied',false,'taskId',prior.task_id);
 end if;
 if jsonb_typeof(students_state.payload) is distinct from 'array' or jsonb_typeof(tasks_state.payload) is distinct from 'array' then raise exception 'review_task_state_invalid'; end if;
 select count(*) into n from jsonb_array_elements(students_state.payload) s where s->>'id'=b->>'studentId';
 if n<>1 then raise exception 'review_student_identity_ambiguous'; end if;
 select s into student from jsonb_array_elements(students_state.payload) s where s->>'id'=b->>'studentId';
 if student->>'name' is distinct from b->>'studentName' or student->>'owner' is distinct from b->>'owner'
   or coalesce(student->>'importArchived','false')<>'false' then raise exception 'review_student_authority_changed'; end if;
 task_id_value:='TSK-WXM-'||left(encode(extensions.digest(b->>'actionKey','sha256'),'hex'),24);
 if exists(select 1 from jsonb_array_elements(tasks_state.payload) t where t->>'id'=task_id_value) then raise exception 'review_task_id_conflict'; end if;
 task:=jsonb_build_object('id',task_id_value,'title',btrim(b->>'title'),'owner',student->>'owner',
  'assignees',jsonb_build_array(student->>'owner'),'watchers',jsonb_build_array('Ops Admin'),
  'studentId',student->>'id','due',to_char(deadline at time zone 'Australia/Melbourne','YYYY-MM-DD HH24:MI'),
  'dueAt',b->>'reviewDueAt','status',case when deadline<now() then 'overdue' when (deadline at time zone 'Australia/Melbourne')::date=(now() at time zone 'Australia/Melbourne')::date then 'today' else 'upcoming' end,
  'tone','amber','category','LP','trigger',btrim(b->>'description')||chr(10)||'核对截止时间由本次检查安排，不是群内原始承诺。来源：'||p_batch_id||' #'||p_row_number);
 update public.ops_state set payload=jsonb_build_array(task)||payload,version=version+1,updated_at=now(),updated_by='Nixon' where entity='tasks' returning * into tasks_state;
 insert into public.ops_mutation_log(entity,version,actor) values('tasks',tasks_state.version,'Nixon');
 audit_value:=internal.append_operational_contract_audit('wecom.review_task_import','Nixon','student',student->>'id',jsonb_build_object('batchId',p_batch_id,'rowNumber',p_row_number,'sourceSha256',r.content_sha256,'taskId',task_id_value));
 insert into internal.wecom_review_task_links(batch_id,row_number,action_key,task_id,intent_hash,audit_id) values(p_batch_id,p_row_number,b->>'actionKey',task_id_value,r.content_sha256,audit_value);
 return jsonb_build_object('applied',true,'taskId',task_id_value);
end;
$$;
revoke all on function internal.promote_wecom_review_task(text,integer) from public,anon,authenticated,service_role;

-- Explicit batch selection keeps previously imported groups accessible.
-- Preserve the v1 RPC until old deployments have drained.
create function public.read_wecom_mirror_review_v2(p_secret text,p_kind text default 'task',p_query text default '',p_page integer default 1,p_batch_id text default '')
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare b internal.wecom_mirror_review_batches%rowtype; total bigint; rows jsonb; counts jsonb; batches jsonb;
begin
 if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501',message='invalid_ops_secret'; end if;
 if p_kind is null or p_kind not in ('capture','schedule','task','finding') or p_query is null or length(p_query)>100 or p_page is null or p_page<1 or p_page>100 or p_batch_id is null or (p_batch_id<>'' and p_batch_id !~ '^wxm-[a-f0-9]{32}$') then raise exception using errcode='22023',message='invalid_review_filter'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',batch_id,'groupName',group_name,'capturedAt',captured_at) order by captured_at desc,batch_id desc),'[]'::jsonb) into batches from internal.wecom_mirror_review_batches where published_at is not null;
 select * into b from internal.wecom_mirror_review_batches where published_at is not null and (p_batch_id='' or batch_id=p_batch_id) order by captured_at desc,batch_id desc limit 1;
 if not found then return jsonb_build_object('batch',null,'batches',batches,'rows','[]'::jsonb,'total',0,'counts','{}'::jsonb,'page',p_page); end if;
 select jsonb_object_agg(k,n) into counts from (select kind k,count(*) n from internal.wecom_mirror_review_rows where batch_id=b.batch_id group by kind) c;
 select count(*) into total from internal.wecom_mirror_review_rows r where r.batch_id=b.batch_id and r.kind=p_kind and (p_query='' or position(lower(p_query) in lower(r.body_text))>0);
 select coalesce(jsonb_agg(jsonb_build_object('rowNumber',r.row_number,'kind',r.kind,'sourceCapture',r.source_capture,'body',r.body_text::jsonb,
  'task',case when l.task_id is null then null else jsonb_build_object('id',l.task_id,'status',t.item->>'status','owner',t.item->>'owner','dueAt',t.item->>'dueAt') end) order by r.row_number),'[]'::jsonb) into rows from (
  select * from internal.wecom_mirror_review_rows r0 where r0.batch_id=b.batch_id and r0.kind=p_kind and (p_query='' or position(lower(p_query) in lower(r0.body_text))>0)
  order by row_number limit 30 offset ((p_page-1)*30)
 ) r left join internal.wecom_review_task_links l on l.batch_id=r.batch_id and l.row_number=r.row_number
 left join lateral (select item from public.ops_state s cross join lateral jsonb_array_elements(s.payload) item where s.entity='tasks' and item->>'id'=l.task_id limit 1) t on true;
 return jsonb_build_object('batch',jsonb_build_object('id',b.batch_id,'groupName',b.group_name,'capturedAt',b.captured_at,'publishedAt',b.published_at,'sourceRevision',b.source_revision,'summary',b.summary),'batches',batches,'rows',rows,'total',total,'counts',counts,'page',p_page);
end;
$$;
revoke all on function public.read_wecom_mirror_review_v2(text,text,text,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.read_wecom_mirror_review_v2(text,text,text,integer,text) to anon,authenticated;
