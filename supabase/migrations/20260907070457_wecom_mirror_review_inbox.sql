-- Mirror evidence is a review source, not a native archive message or completed LP.
create table internal.wecom_mirror_review_batches (
 batch_id text primary key check (batch_id ~ '^wxm-[a-f0-9]{32}$'),
 group_name text not null check (length(group_name) between 1 and 200),
 source_revision text not null check (source_revision ~ '^[a-f0-9]{64}$'),
 rows_digest text not null check (rows_digest ~ '^[a-f0-9]{64}$'),
 expected_rows integer not null check (expected_rows between 1 and 3000),
 captured_at timestamptz not null,
 summary jsonb not null check (jsonb_typeof(summary)='object' and octet_length(summary::text)<=16384),
 published_at timestamptz,
 created_at timestamptz not null default now()
);
create table internal.wecom_mirror_review_rows (
 batch_id text not null references internal.wecom_mirror_review_batches(batch_id),
 row_number integer not null check(row_number between 1 and 3000),
 kind text not null check(kind in ('capture','schedule','task','finding')),
 source_capture text not null check(source_capture ~ '^[a-z0-9_-]+[.]png$'),
 body_text text not null check(octet_length(body_text)<=20000 and jsonb_typeof(body_text::jsonb)='object'),
 content_sha256 text not null check(content_sha256 = encode(extensions.digest(kind || chr(10) || source_capture || chr(10) || body_text, 'sha256'), 'hex')),
 primary key(batch_id,row_number)
);
alter table internal.wecom_mirror_review_batches enable row level security;
alter table internal.wecom_mirror_review_rows enable row level security;
revoke all on internal.wecom_mirror_review_batches,internal.wecom_mirror_review_rows from public,anon,authenticated;

-- Only the existing server-held Ops capability can read published evidence.
-- Session/full-admin authorization is additionally enforced in the HTTP route.
create function public.read_wecom_mirror_review(p_secret text,p_kind text default 'task',p_query text default '',p_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare b internal.wecom_mirror_review_batches%rowtype; total bigint; rows jsonb; counts jsonb;
begin
 if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501',message='invalid_ops_secret'; end if;
 if p_kind is null or p_kind not in ('capture','schedule','task','finding') or p_query is null or length(p_query)>100 or p_page is null or p_page<1 or p_page>100 then
  raise exception using errcode='22023',message='invalid_review_filter';
 end if;
 select * into b from internal.wecom_mirror_review_batches where published_at is not null order by captured_at desc,batch_id desc limit 1;
 if not found then return jsonb_build_object('batch',null,'rows','[]'::jsonb,'total',0,'counts','{}'::jsonb,'page',p_page); end if;
 select jsonb_object_agg(k,n) into counts from (select kind k,count(*) n from internal.wecom_mirror_review_rows where batch_id=b.batch_id group by kind) c;
 select count(*) into total from internal.wecom_mirror_review_rows r where r.batch_id=b.batch_id and r.kind=p_kind and (p_query='' or position(lower(p_query) in lower(r.body_text))>0);
 select coalesce(jsonb_agg(jsonb_build_object('rowNumber',row_number,'kind',kind,'sourceCapture',source_capture,'body',body_text::jsonb) order by row_number),'[]'::jsonb) into rows from (
  select * from internal.wecom_mirror_review_rows r where r.batch_id=b.batch_id and r.kind=p_kind and (p_query='' or position(lower(p_query) in lower(r.body_text))>0)
  order by row_number limit 30 offset ((p_page-1)*30)
 ) filtered;
 return jsonb_build_object('batch',jsonb_build_object('id',b.batch_id,'groupName',b.group_name,'capturedAt',b.captured_at,'publishedAt',b.published_at,'sourceRevision',b.source_revision,'summary',b.summary),'rows',rows,'total',total,'counts',counts,'page',p_page);
end;
$$;
revoke all on function public.read_wecom_mirror_review(text,text,text,integer) from public;
grant execute on function public.read_wecom_mirror_review(text,text,text,integer) to anon,authenticated;

-- Publishing is an owner-only completion step after independently committed chunks.
create function internal.publish_wecom_mirror_review(p_batch_id text, p_revision text)
returns void language plpgsql set search_path='' as $$
declare b internal.wecom_mirror_review_batches%rowtype; n integer; last_row integer; actual_digest text;
begin
 select * into strict b from internal.wecom_mirror_review_batches where batch_id=p_batch_id for update;
 if b.source_revision <> p_revision then raise exception 'source_revision_conflict'; end if;
 select count(*),max(row_number),encode(extensions.digest(string_agg(content_sha256,'' order by row_number),'sha256'),'hex')
 into n,last_row,actual_digest from internal.wecom_mirror_review_rows where batch_id=p_batch_id;
 if n<>b.expected_rows or last_row<>b.expected_rows or actual_digest is distinct from b.rows_digest then raise exception 'incomplete_or_conflicting_batch'; end if;
 update internal.wecom_mirror_review_batches set published_at=coalesce(published_at,now()) where batch_id=p_batch_id;
end;
$$;
revoke all on function internal.publish_wecom_mirror_review(text,text) from public,anon,authenticated;

create function internal.guard_wecom_mirror_review_rows()
returns trigger language plpgsql set search_path='' as $$
declare parent_id text;
begin
 parent_id := case when TG_OP='DELETE' then OLD.batch_id else NEW.batch_id end;
 -- Same parent lock as publication: a racing chunk cannot change a published batch.
 perform 1 from internal.wecom_mirror_review_batches where batch_id=parent_id for update;
 if exists(select 1 from internal.wecom_mirror_review_batches where batch_id=parent_id and published_at is not null) then raise exception 'published_batch_is_immutable'; end if;
 if TG_OP='UPDATE' and NEW.batch_id<>OLD.batch_id then raise exception 'batch_move_forbidden'; end if;
 if TG_OP='DELETE' then return OLD; end if;
 return NEW;
end;
$$;
revoke all on function internal.guard_wecom_mirror_review_rows() from public,anon,authenticated;
create trigger wecom_mirror_review_rows_guard before insert or update or delete on internal.wecom_mirror_review_rows for each row execute function internal.guard_wecom_mirror_review_rows();
