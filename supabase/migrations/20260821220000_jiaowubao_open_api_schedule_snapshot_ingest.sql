-- Immutable, resumable evidence ingest for the Jiaowubao Open API schedule.
--
-- This is intentionally a separate protocol from the Excel/student source
-- imports. It stores the API snapshot only; it never projects students,
-- bookings, tasks, teachers, attendance, or AVA state. A completed snapshot
-- is made visible only by replacing the source-key pointer in the final short
-- transaction.
--
-- The caller supplies no API secret in this envelope or in any table. The
-- server-only caller authenticates each RPC with internal.verify_ops_secret.
-- Tables and RPCs are private by default: no PUBLIC/anon/authenticated grants.

create table if not exists internal.jiaowubao_open_api_schedule_snapshot_ingest_runs (
  id uuid primary key default gen_random_uuid(),
  api_source_key text not null check (
    api_source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'
  ),
  revision text not null check (length(revision) between 1 and 240),
  query jsonb not null check (
    jsonb_typeof(query) = 'object'
    and octet_length(query::text) between 2 and 32768
  ),
  expected_page_count integer not null check (expected_page_count between 0 and 500),
  expected_row_count integer not null check (expected_row_count between 0 and 50000),
  -- The source pointer observed before this run began. Completion must still
  -- see exactly this value (or no pointer) before it is allowed to publish.
  -- This prevents an older local export from silently replacing a newer one.
  expected_current_revision text check (
    expected_current_revision is null
    or expected_current_revision ~ '^sha256:[a-f0-9]{64}$'
  ),
  -- This is the immutable local export-manifest digest. It is evidence of
  -- the file received by the operator, not a claim about PostgreSQL JSONB
  -- canonical bytes. The server computes canonical_rows_sha256 below.
  external_manifest_sha256 text not null check (external_manifest_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  source_metadata jsonb not null check (
    jsonb_typeof(source_metadata) = 'object'
    and octet_length(source_metadata::text) between 2 and 32768
  ),
  state text not null default 'staging' check (state in ('staging', 'complete', 'aborted')),
  canonical_rows_sha256 text check (canonical_rows_sha256 is null or canonical_rows_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  payload_sha256 text check (payload_sha256 is null or payload_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  staged_by text not null check (staged_by = btrim(staged_by) and length(staged_by) between 1 and 120),
  staged_at timestamptz not null default now(),
  staging_audit_id uuid not null references internal.operational_contract_audit(id),
  completed_at timestamptz,
  completion_audit_id uuid references internal.operational_contract_audit(id),
  aborted_at timestamptz,
  abort_audit_id uuid references internal.operational_contract_audit(id),
  check (
    (state = 'staging' and canonical_rows_sha256 is null and payload_sha256 is null and completed_at is null and completion_audit_id is null and aborted_at is null and abort_audit_id is null)
    or (state = 'complete' and canonical_rows_sha256 is not null and payload_sha256 is not null and completed_at is not null and completion_audit_id is not null and aborted_at is null and abort_audit_id is null)
    or (state = 'aborted' and canonical_rows_sha256 is null and payload_sha256 is null and completed_at is null and completion_audit_id is null and aborted_at is not null and abort_audit_id is not null)
  )
);

alter table internal.jiaowubao_open_api_schedule_snapshot_ingest_runs enable row level security;
revoke all on table internal.jiaowubao_open_api_schedule_snapshot_ingest_runs from public, anon, authenticated;

create unique index if not exists jwb_open_api_schedule_snapshot_active_revision_idx
  on internal.jiaowubao_open_api_schedule_snapshot_ingest_runs (api_source_key, revision)
  where state in ('staging', 'complete');

create table if not exists internal.jiaowubao_open_api_schedule_snapshot_ingest_pages (
  run_id uuid not null references internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(id) on delete restrict,
  page_index integer not null check (page_index between 0 and 499),
  page_sha256 text not null check (page_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  rows jsonb not null check (jsonb_typeof(rows) = 'array'),
  row_count integer not null check (row_count between 1 and 100),
  content_bytes integer not null check (content_bytes between 1 and 2097152),
  staged_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  primary key (run_id, page_index),
  check (jsonb_array_length(rows) = row_count)
);

alter table internal.jiaowubao_open_api_schedule_snapshot_ingest_pages enable row level security;
revoke all on table internal.jiaowubao_open_api_schedule_snapshot_ingest_pages from public, anon, authenticated;

create table if not exists internal.jiaowubao_open_api_schedule_snapshot_ingest_items (
  run_id uuid not null references internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(id) on delete restrict,
  page_index integer not null,
  item_index integer not null check (item_index between 0 and 99),
  source_key text not null check (source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'),
  -- canonical_json is PostgreSQL's jsonb::text for the complete
  -- {sourceKey,record} wrapper, not JavaScript JSON.stringify(record).
  canonical_json text not null check (octet_length(canonical_json) between 2 and 262144),
  item_sha256 text not null check (item_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  item jsonb not null check (jsonb_typeof(item) = 'object'),
  staged_at timestamptz not null default now(),
  primary key (run_id, page_index, item_index),
  unique (run_id, source_key),
  foreign key (run_id, page_index) references internal.jiaowubao_open_api_schedule_snapshot_ingest_pages(run_id, page_index) on delete restrict
);

alter table internal.jiaowubao_open_api_schedule_snapshot_ingest_items enable row level security;
revoke all on table internal.jiaowubao_open_api_schedule_snapshot_ingest_items from public, anon, authenticated;

create table if not exists internal.jiaowubao_open_api_schedule_snapshot_current (
  api_source_key text primary key check (api_source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'),
  run_id uuid not null references internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(id),
  revision text not null,
  row_count integer not null check (row_count between 0 and 50000),
  rows_sha256 text not null check (rows_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  payload_sha256 text not null check (payload_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  published_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);

alter table internal.jiaowubao_open_api_schedule_snapshot_current enable row level security;
revoke all on table internal.jiaowubao_open_api_schedule_snapshot_current from public, anon, authenticated;

create or replace function internal.guard_jiaowubao_open_api_schedule_snapshot_run()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' or old.state in ('complete', 'aborted') then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_run_immutable';
  end if;
  if new.id is distinct from old.id
     or new.api_source_key is distinct from old.api_source_key
     or new.revision is distinct from old.revision
     or new.query is distinct from old.query
     or new.expected_page_count is distinct from old.expected_page_count
     or new.expected_row_count is distinct from old.expected_row_count
     or new.expected_current_revision is distinct from old.expected_current_revision
     or new.external_manifest_sha256 is distinct from old.external_manifest_sha256
     or new.source_metadata is distinct from old.source_metadata
     or new.staged_by is distinct from old.staged_by
     or new.staged_at is distinct from old.staged_at
     or new.staging_audit_id is distinct from old.staging_audit_id then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_run_immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_jiaowubao_open_api_schedule_snapshot_run on internal.jiaowubao_open_api_schedule_snapshot_ingest_runs;
create trigger guard_jiaowubao_open_api_schedule_snapshot_run
before update or delete on internal.jiaowubao_open_api_schedule_snapshot_ingest_runs
for each row execute function internal.guard_jiaowubao_open_api_schedule_snapshot_run();
revoke all on function internal.guard_jiaowubao_open_api_schedule_snapshot_run() from public, anon, authenticated;

create or replace function internal.guard_jiaowubao_open_api_schedule_snapshot_page()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_page_immutable';
  end if;
  if tg_op = 'DELETE'
     and current_setting('internal.jiaowubao_open_api_schedule_snapshot_abort_run_id', true) is distinct from old.run_id::text then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_page_delete_forbidden';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists guard_jiaowubao_open_api_schedule_snapshot_page on internal.jiaowubao_open_api_schedule_snapshot_ingest_pages;
create trigger guard_jiaowubao_open_api_schedule_snapshot_page
before update or delete on internal.jiaowubao_open_api_schedule_snapshot_ingest_pages
for each row execute function internal.guard_jiaowubao_open_api_schedule_snapshot_page();
revoke all on function internal.guard_jiaowubao_open_api_schedule_snapshot_page() from public, anon, authenticated;

create or replace function internal.guard_jiaowubao_open_api_schedule_snapshot_item()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_item_immutable';
  end if;
  if tg_op = 'DELETE'
     and current_setting('internal.jiaowubao_open_api_schedule_snapshot_abort_run_id', true) is distinct from old.run_id::text then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_item_delete_forbidden';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists guard_jiaowubao_open_api_schedule_snapshot_item on internal.jiaowubao_open_api_schedule_snapshot_ingest_items;
create trigger guard_jiaowubao_open_api_schedule_snapshot_item
before update or delete on internal.jiaowubao_open_api_schedule_snapshot_ingest_items
for each row execute function internal.guard_jiaowubao_open_api_schedule_snapshot_item();
revoke all on function internal.guard_jiaowubao_open_api_schedule_snapshot_item() from public, anon, authenticated;

create or replace function internal.assert_jiaowubao_open_api_schedule_snapshot_envelope(p_envelope jsonb)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_envelope is null or jsonb_typeof(p_envelope) <> 'object'
     or p_envelope - ARRAY['apiSourceKey','revision','query','expectedPageCount','expectedRowCount','expectedCurrentRevision','externalManifestSha256','sourceMetadata']::text[] <> '{}'::jsonb
     or not (p_envelope ?& ARRAY['apiSourceKey','revision','query','expectedPageCount','expectedRowCount','expectedCurrentRevision','externalManifestSha256','sourceMetadata']::text[])
     or p_envelope ->> 'apiSourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'
     or nullif(btrim(p_envelope ->> 'revision'), '') is null
     or p_envelope ->> 'revision' <> btrim(p_envelope ->> 'revision')
     or length(p_envelope ->> 'revision') > 240
     or p_envelope ->> 'revision' !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'query') <> 'object'
     or octet_length((p_envelope -> 'query')::text) not between 2 and 32768
     or (p_envelope -> 'query') - ARRAY['start','end','limit','order']::text[] <> '{}'::jsonb
     or not ((p_envelope -> 'query') ?& ARRAY['start','end','limit','order']::text[])
     or jsonb_typeof(p_envelope -> 'query' -> 'start') <> 'string'
     or (p_envelope -> 'query' ->> 'start') !~ '^\d{4}-\d{2}-\d{2}$'
     or jsonb_typeof(p_envelope -> 'query' -> 'end') <> 'string'
     or (p_envelope -> 'query' ->> 'end') !~ '^\d{4}-\d{2}-\d{2}$'
     or jsonb_typeof(p_envelope -> 'query' -> 'limit') <> 'number'
     or (p_envelope -> 'query' ->> 'limit')::integer <> 100
     or jsonb_typeof(p_envelope -> 'query' -> 'order') <> 'string'
     or p_envelope -> 'query' ->> 'order' <> 'asc'
     or jsonb_typeof(p_envelope -> 'expectedPageCount') <> 'number'
     or (p_envelope ->> 'expectedPageCount')::integer not between 0 and 500
     or jsonb_typeof(p_envelope -> 'expectedRowCount') <> 'number'
     or (p_envelope ->> 'expectedRowCount')::integer not between 0 and 50000
     or (
       jsonb_typeof(p_envelope -> 'expectedCurrentRevision') <> 'null'
       and (
         jsonb_typeof(p_envelope -> 'expectedCurrentRevision') <> 'string'
         or p_envelope ->> 'expectedCurrentRevision' !~ '^sha256:[a-f0-9]{64}$'
       )
     )
     or jsonb_typeof(p_envelope -> 'externalManifestSha256') <> 'string'
     or p_envelope ->> 'externalManifestSha256' !~ '^sha256:[a-f0-9]{64}$'
     or p_envelope ->> 'revision' <> p_envelope ->> 'externalManifestSha256'
     or lower((p_envelope -> 'query')::text) ~ '"(sk|secret|token|password)"\s*:'
     or jsonb_typeof(p_envelope -> 'sourceMetadata') <> 'object'
     or octet_length((p_envelope -> 'sourceMetadata')::text) not between 2 and 32768
     or (p_envelope -> 'sourceMetadata') - ARRAY['exportFormat','manifestSha256','recordsSha256']::text[] <> '{}'::jsonb
     or not ((p_envelope -> 'sourceMetadata') ?& ARRAY['exportFormat','manifestSha256','recordsSha256']::text[])
     or p_envelope -> 'sourceMetadata' ->> 'exportFormat' <> 'jiaowubao-schedule-export/v1'
     or p_envelope -> 'sourceMetadata' ->> 'manifestSha256' <> p_envelope ->> 'externalManifestSha256'
     or p_envelope -> 'sourceMetadata' ->> 'recordsSha256' !~ '^sha256:[a-f0-9]{64}$'
     or lower((p_envelope -> 'sourceMetadata')::text) ~ '"(sk|secret|token|password)"\s*:' then
    raise exception using errcode = '22023', message = 'jiaowubao_open_api_schedule_snapshot_envelope_invalid';
  end if;
end;
$$;
revoke all on function internal.assert_jiaowubao_open_api_schedule_snapshot_envelope(jsonb) from public, anon, authenticated;

create or replace function internal.assert_jiaowubao_open_api_schedule_snapshot_page(p_rows jsonb)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 100
     or octet_length(p_rows::text) > 2097152
     or exists (
       select 1 from jsonb_array_elements(p_rows) item_value
       where jsonb_typeof(item_value) is distinct from 'object'
          or not (item_value ?& ARRAY['sourceKey','record']::text[])
          or item_value - ARRAY['sourceKey','record']::text[] <> '{}'::jsonb
          or jsonb_typeof(item_value -> 'sourceKey') is distinct from 'string'
          or item_value ->> 'sourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'
          or jsonb_typeof(item_value -> 'record') is distinct from 'object'
          or not ((item_value -> 'record') ?& ARRAY['cal_id']::text[])
          or (item_value -> 'record') - ARRAY[
            'cal_id','type','appoint','team_id','team_title','course_id','course_title',
            'room_id','room_title','teacher_id','teacher_title','teacher_s','teacher_t',
            'dated','time_start','time_end','cal_length','hours','created','live',
            'max_num','mem_max','mem_num','mem_num_sign','mem_num_not_sign','mem_num_leave',
            'mem_leave','mem_arrive','arrive_percent','mem_not_comment','all_leave','over',
            'over_state','over_time'
          ]::text[] <> '{}'::jsonb
          or lower((item_value -> 'record')::text) ~ '"(stu_list|student|name|price|cont|logo|note|remark)"\s*:'
          or jsonb_typeof(item_value -> 'record' -> 'cal_id') <> 'string'
          or item_value -> 'record' ->> 'cal_id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
          or (item_value ->> 'sourceKey') <> ('jwb-open-api:schedule:' || (item_value -> 'record' ->> 'cal_id'))
          or octet_length((item_value -> 'record')::text) > 262144
     )
     or exists (
       select 1 from jsonb_array_elements(p_rows) item_value
       group by item_value ->> 'sourceKey' having count(*) > 1
     ) then
    raise exception using errcode = '22023', message = 'jiaowubao_open_api_schedule_snapshot_page_invalid';
  end if;
end;
$$;
revoke all on function internal.assert_jiaowubao_open_api_schedule_snapshot_page(jsonb) from public, anon, authenticated;

create or replace function public.begin_jiaowubao_open_api_schedule_snapshot_ingest(p_secret text, p_envelope jsonb, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype; audit_id uuid; run_id uuid := gen_random_uuid();
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if nullif(btrim(p_actor), '') is null or p_actor <> btrim(p_actor) or p_actor not in ('Nixon','Ops Admin') then raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_forbidden'; end if;
  perform internal.assert_jiaowubao_open_api_schedule_snapshot_envelope(p_envelope);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-open-api-schedule:' || p_envelope ->> 'apiSourceKey', 0));
  select * into saved from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r where r.api_source_key = p_envelope ->> 'apiSourceKey' and r.revision = p_envelope ->> 'revision' and r.state in ('staging','complete') for update;
  if found then
    if saved.query is distinct from p_envelope -> 'query' or saved.expected_page_count <> (p_envelope ->> 'expectedPageCount')::integer or saved.expected_row_count <> (p_envelope ->> 'expectedRowCount')::integer or saved.expected_current_revision is distinct from p_envelope ->> 'expectedCurrentRevision' or saved.external_manifest_sha256 <> p_envelope ->> 'externalManifestSha256' or saved.source_metadata is distinct from p_envelope -> 'sourceMetadata' or saved.staged_by <> p_actor then raise exception using errcode = '23505', message = 'jiaowubao_open_api_schedule_snapshot_envelope_conflict'; end if;
    return jsonb_build_object('runId',saved.id,'apiSourceKey',saved.api_source_key,'revision',saved.revision,'state',saved.state,'expectedPageCount',saved.expected_page_count,'expectedRowCount',saved.expected_row_count,'expectedCurrentRevision',saved.expected_current_revision,'externalManifestSha256',saved.external_manifest_sha256,'canonicalRowsSha256',saved.canonical_rows_sha256,'replayed',true);
  end if;
  audit_id := internal.append_operational_contract_audit('jiaowubao_open_api_schedule_snapshot_ingest.started',p_actor,'jiaowubao_open_api_schedule_snapshot_ingest_run',run_id::text,jsonb_build_object('apiSourceKey',p_envelope ->> 'apiSourceKey','revision',p_envelope ->> 'revision','expectedPageCount',(p_envelope ->> 'expectedPageCount')::integer,'expectedRowCount',(p_envelope ->> 'expectedRowCount')::integer,'expectedCurrentRevision',p_envelope ->> 'expectedCurrentRevision','externalManifestSha256',p_envelope ->> 'externalManifestSha256'));
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(id,api_source_key,revision,query,expected_page_count,expected_row_count,expected_current_revision,external_manifest_sha256,source_metadata,staged_by,staging_audit_id) values (run_id,p_envelope ->> 'apiSourceKey',p_envelope ->> 'revision',p_envelope -> 'query',(p_envelope ->> 'expectedPageCount')::integer,(p_envelope ->> 'expectedRowCount')::integer,p_envelope ->> 'expectedCurrentRevision',p_envelope ->> 'externalManifestSha256',p_envelope -> 'sourceMetadata',p_actor,audit_id);
  return jsonb_build_object('runId',run_id,'apiSourceKey',p_envelope ->> 'apiSourceKey','revision',p_envelope ->> 'revision','state','staging','expectedPageCount',(p_envelope ->> 'expectedPageCount')::integer,'expectedRowCount',(p_envelope ->> 'expectedRowCount')::integer,'expectedCurrentRevision',p_envelope ->> 'expectedCurrentRevision','externalManifestSha256',p_envelope ->> 'externalManifestSha256','replayed',false);
end;
$$;
revoke all on function public.begin_jiaowubao_open_api_schedule_snapshot_ingest(text,jsonb,text) from public, anon, authenticated;

create or replace function public.stage_jiaowubao_open_api_schedule_snapshot_page(p_secret text,p_run_id uuid,p_page_index integer,p_rows jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_state internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype; existing_page internal.jiaowubao_open_api_schedule_snapshot_ingest_pages%rowtype; page_hash text; bytes integer; rows_count integer; audit_id uuid; item_value jsonb; item_pos integer := 0;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if nullif(btrim(p_actor), '') is null or p_actor <> btrim(p_actor) or p_actor not in ('Nixon','Ops Admin') then raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_forbidden'; end if;
  select * into run_state from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r where r.id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'jiaowubao_open_api_schedule_snapshot_run_not_found'; end if;
  if run_state.staged_by <> p_actor then raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_mismatch'; end if;
  if run_state.state <> 'staging' then raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_run_not_staging'; end if;
  if p_page_index is null or p_page_index < 0 or p_page_index >= run_state.expected_page_count then raise exception using errcode = '22023', message = 'jiaowubao_open_api_schedule_snapshot_page_index_invalid'; end if;
  perform internal.assert_jiaowubao_open_api_schedule_snapshot_page(p_rows);
  rows_count := jsonb_array_length(p_rows); bytes := octet_length(p_rows::text); page_hash := 'sha256:' || encode(extensions.digest(p_rows::text,'sha256'),'hex');
  select * into existing_page from internal.jiaowubao_open_api_schedule_snapshot_ingest_pages p where p.run_id = p_run_id and p.page_index = p_page_index for update;
  if found then
    if existing_page.page_sha256 <> page_hash or existing_page.row_count <> rows_count or existing_page.content_bytes <> bytes then raise exception using errcode = '23505', message = 'jiaowubao_open_api_schedule_snapshot_page_conflict'; end if;
    return jsonb_build_object('runId',p_run_id,'pageIndex',p_page_index,'pageSha256',page_hash,'rowCount',rows_count,'replayed',true);
  end if;
  audit_id := internal.append_operational_contract_audit('jiaowubao_open_api_schedule_snapshot_ingest.page_staged',p_actor,'jiaowubao_open_api_schedule_snapshot_ingest_run',p_run_id::text,jsonb_build_object('pageIndex',p_page_index,'pageSha256',page_hash,'rowCount',rows_count,'contentBytes',bytes));
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_pages(run_id,page_index,page_sha256,rows,row_count,content_bytes,audit_id) values(p_run_id,p_page_index,page_hash,p_rows,rows_count,bytes,audit_id);
  for item_value in select value from jsonb_array_elements(p_rows) loop
    insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items(run_id,page_index,item_index,source_key,canonical_json,item_sha256,item) values(p_run_id,p_page_index,item_pos,item_value ->> 'sourceKey',(item_value)::text,'sha256:' || encode(extensions.digest((item_value)::text,'sha256'),'hex'),item_value);
    item_pos := item_pos + 1;
  end loop;
  return jsonb_build_object('runId',p_run_id,'pageIndex',p_page_index,'pageSha256',page_hash,'rowCount',rows_count,'replayed',false);
end;
$$;
revoke all on function public.stage_jiaowubao_open_api_schedule_snapshot_page(text,uuid,integer,jsonb,text) from public, anon, authenticated;

create or replace function public.get_jiaowubao_open_api_schedule_snapshot_ingest_status(p_secret text,p_run_id uuid,p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_state internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype; pages_count integer; rows_count integer;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  select * into run_state from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r where r.id = p_run_id;
  if not found then raise exception using errcode = 'P0002', message = 'jiaowubao_open_api_schedule_snapshot_run_not_found'; end if;
  if nullif(btrim(p_actor), '') is null or p_actor <> btrim(p_actor) or p_actor not in ('Nixon','Ops Admin') then raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_forbidden'; end if;
  if run_state.staged_by <> p_actor then raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_mismatch'; end if;
  select count(*)::integer, coalesce(sum(p.row_count),0)::integer into pages_count, rows_count from internal.jiaowubao_open_api_schedule_snapshot_ingest_pages p where p.run_id = p_run_id;
  return jsonb_build_object('runId',run_state.id,'apiSourceKey',run_state.api_source_key,'revision',run_state.revision,'state',run_state.state,'expectedPageCount',run_state.expected_page_count,'expectedRowCount',run_state.expected_row_count,'pagesCommitted',pages_count,'rowsCommitted',rows_count,'externalManifestSha256',run_state.external_manifest_sha256,'canonicalRowsSha256',run_state.canonical_rows_sha256,'payloadSha256',run_state.payload_sha256);
end;
$$;
revoke all on function public.get_jiaowubao_open_api_schedule_snapshot_ingest_status(text,uuid,text) from public, anon, authenticated;

create or replace function public.get_jiaowubao_open_api_schedule_snapshot_preflight(p_secret text,p_api_source_key text,p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare current_row internal.jiaowubao_open_api_schedule_snapshot_current%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_api_source_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$' or nullif(btrim(p_actor), '') is null or p_actor <> btrim(p_actor) or p_actor not in ('Nixon','Ops Admin') then raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_preflight_forbidden'; end if;
  select * into current_row from internal.jiaowubao_open_api_schedule_snapshot_current c where c.api_source_key = p_api_source_key;
  if not found then return jsonb_build_object('apiSourceKey',p_api_source_key,'current',null); end if;
  return jsonb_build_object('apiSourceKey',current_row.api_source_key,'current',jsonb_build_object('runId',current_row.run_id,'revision',current_row.revision,'rowCount',current_row.row_count,'rowsSha256',current_row.rows_sha256,'payloadSha256',current_row.payload_sha256,'publishedAt',current_row.published_at));
end;
$$;
revoke all on function public.get_jiaowubao_open_api_schedule_snapshot_preflight(text,text,text) from public, anon, authenticated;

create or replace function public.complete_jiaowubao_open_api_schedule_snapshot_ingest(p_secret text,p_run_id uuid,p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_state internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype; current_row internal.jiaowubao_open_api_schedule_snapshot_current%rowtype; observed_current_revision text; page_count integer; row_count integer; rows_hash text; payload_hash text; audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if nullif(btrim(p_actor), '') is null or p_actor <> btrim(p_actor) or p_actor not in ('Nixon','Ops Admin') then raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_forbidden'; end if;
  select * into run_state from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r where r.id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'jiaowubao_open_api_schedule_snapshot_run_not_found'; end if;
  if run_state.staged_by <> p_actor then raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_mismatch'; end if;
  if run_state.state = 'complete' then return jsonb_build_object('runId',run_state.id,'apiSourceKey',run_state.api_source_key,'revision',run_state.revision,'state','complete','rowCount',run_state.expected_row_count,'rowsSha256',run_state.canonical_rows_sha256,'payloadSha256',run_state.payload_sha256,'replayed',true); end if;
  if run_state.state <> 'staging' then raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_run_not_staging'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-open-api-schedule:' || run_state.api_source_key, 0));
  -- Lock the pointer while comparing it with the value captured in the
  -- immutable run envelope. A concurrent publisher therefore either wins
  -- before this check (and makes us fail) or waits until this publish ends.
  select * into current_row
  from internal.jiaowubao_open_api_schedule_snapshot_current c
  where c.api_source_key = run_state.api_source_key
  for update;
  observed_current_revision := case when found then current_row.revision else null end;
  if observed_current_revision is distinct from run_state.expected_current_revision then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_current_pointer_conflict';
  end if;
  select count(*)::integer, coalesce(sum(p.row_count),0)::integer into page_count,row_count from internal.jiaowubao_open_api_schedule_snapshot_ingest_pages p where p.run_id = p_run_id;
  if page_count <> run_state.expected_page_count or row_count <> run_state.expected_row_count or exists(select 1 from generate_series(0,run_state.expected_page_count-1) n where not exists(select 1 from internal.jiaowubao_open_api_schedule_snapshot_ingest_pages p where p.run_id=p_run_id and p.page_index=n)) then raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_pages_incomplete'; end if;
  -- Hash the exact PostgreSQL-canonical wrapper bytes persisted at stage.
  -- The local CLI never fabricates this value; it is returned by completion.
  select 'sha256:' || encode(extensions.digest(coalesce(string_agg(i.canonical_json, '' order by i.page_index,i.item_index),''),'sha256'),'hex') into rows_hash from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i where i.run_id = p_run_id;
  payload_hash := 'sha256:' || encode(extensions.digest(coalesce(string_agg(p.page_sha256, '' order by p.page_index),''),'sha256'),'hex');
  audit_id := internal.append_operational_contract_audit('jiaowubao_open_api_schedule_snapshot_ingest.completed',p_actor,'jiaowubao_open_api_schedule_snapshot_ingest_run',p_run_id::text,jsonb_build_object('apiSourceKey',run_state.api_source_key,'revision',run_state.revision,'pageCount',page_count,'rowCount',row_count,'rowsSha256',rows_hash,'payloadSha256',payload_hash));
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set state='complete',canonical_rows_sha256=rows_hash,payload_sha256=payload_hash,completed_at=now(),completion_audit_id=audit_id where id=p_run_id;
  insert into internal.jiaowubao_open_api_schedule_snapshot_current(api_source_key,run_id,revision,row_count,rows_sha256,payload_sha256,audit_id) values(run_state.api_source_key,p_run_id,run_state.revision,row_count,rows_hash,payload_hash,audit_id) on conflict(api_source_key) do update set run_id=excluded.run_id,revision=excluded.revision,row_count=excluded.row_count,rows_sha256=excluded.rows_sha256,payload_sha256=excluded.payload_sha256,published_at=now(),audit_id=excluded.audit_id;
  return jsonb_build_object('runId',p_run_id,'apiSourceKey',run_state.api_source_key,'revision',run_state.revision,'state','complete','pageCount',page_count,'rowCount',row_count,'rowsSha256',rows_hash,'payloadSha256',payload_hash,'replayed',false);
end;
$$;
revoke all on function public.complete_jiaowubao_open_api_schedule_snapshot_ingest(text,uuid,text) from public, anon, authenticated;

create or replace function public.abort_jiaowubao_open_api_schedule_snapshot_ingest(p_secret text,p_run_id uuid,p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_state internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype; audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if nullif(btrim(p_actor), '') is null or p_actor <> btrim(p_actor) or p_actor not in ('Nixon','Ops Admin') then raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_forbidden'; end if;
  select * into run_state from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r where r.id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'jiaowubao_open_api_schedule_snapshot_run_not_found'; end if;
  if run_state.staged_by <> p_actor then raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_actor_mismatch'; end if;
  if run_state.state <> 'staging' then raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_run_not_staging'; end if;
  audit_id := internal.append_operational_contract_audit('jiaowubao_open_api_schedule_snapshot_ingest.aborted',p_actor,'jiaowubao_open_api_schedule_snapshot_ingest_run',p_run_id::text,jsonb_build_object('apiSourceKey',run_state.api_source_key,'revision',run_state.revision));
  perform pg_catalog.set_config('internal.jiaowubao_open_api_schedule_snapshot_abort_run_id',p_run_id::text,true);
  delete from internal.jiaowubao_open_api_schedule_snapshot_ingest_items where run_id=p_run_id;
  delete from internal.jiaowubao_open_api_schedule_snapshot_ingest_pages where run_id=p_run_id;
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set state='aborted',aborted_at=now(),abort_audit_id=audit_id where id=p_run_id;
  return jsonb_build_object('runId',p_run_id,'apiSourceKey',run_state.api_source_key,'revision',run_state.revision,'state','aborted');
end;
$$;
revoke all on function public.abort_jiaowubao_open_api_schedule_snapshot_ingest(text,uuid,text) from public, anon, authenticated;

comment on table internal.jiaowubao_open_api_schedule_snapshot_ingest_runs is 'Private immutable JWB Open API schedule snapshot run ledger; evidence only, no native projection.';
comment on table internal.jiaowubao_open_api_schedule_snapshot_current is 'Private current pointer for completed JWB Open API schedule evidence.';
