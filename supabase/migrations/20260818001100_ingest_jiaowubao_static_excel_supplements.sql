-- Offline Jiaowubao Excel exports are immutable supplementary evidence only.
-- Tencent's current `master` source remains the sole authority for student
-- existence.  This migration deliberately does not read or write
-- the operational state store, the formal student-import source contract, packages, or
-- bookings.  It records the static exports in a separate internal ledger so
-- their facts can be reviewed later without turning an unmatched JWB row into
-- a student or a historical schedule cell into a booking.
--
-- The single public RPC accepts deterministic chunks, not one oversized
-- request.  Every chunk must repeat the immutable batch envelope below.  A
-- batch is usable only after every declared chunk arrives and all declared
-- record counts reconcile.  Re-sending the exact same chunk is a safe replay;
-- a changed chunk, source id, revision, or envelope fails closed.
--
-- {
--   format: 'jiaowubao-static-excel-v1',
--   sourceTimezone: 'Australia/Melbourne',
--   sourceTimezoneBasis: string,
--   masterSource: {sourceId:string, revision:string, rowsSha256:sha256},
--   workbooks: [
--     {kind:'quick_list', workbookName:string, workbookSha256:sha256, rowCount:int},
--     {kind:'students', ...}, {kind:'contracts', ...}, {kind:'hours', ...},
--     {kind:'class_members', ...}, {kind:'schedule', ...},
--     {kind:'leave_makeups', ...}
--   ],
--   recordCounts: {facts:int, contracts:int, hours:int, classMembers:int,
--                  schedule:int, leaveMakeups:int},
--   chunk: {index:int /* 0-based */, count:int},
--   facts: Record[], contracts: Record[], hours: Record[],
--   classMembers: Record[], schedule: Record[], leaveMakeups: Record[]
-- }
--
-- Record = {
--   sourceKey: string,
--   sourceRefs: [{workbook: WorkbookKind, row: int /* 1-based */, cell?: A1}],
--   attachments: [
--     {state:'attached', masterSourceRow:string,
--      evidenceName:string, matchMode:'exact_name'} |
--     {state:'quarantined', reason: QuarantineReason}
--   ],
--   payload: object
-- }
--
-- A source cell is represented once even when a group schedule has several
-- safely matched Tencent students: it receives several `attached` child rows.
-- An unresolved member is represented by a `quarantined` child row, never a
-- guessed student link.  The top-level IANA timezone and its basis are stored
-- with the batch; a caller cannot silently substitute a student locale.

create table if not exists internal.jiaowubao_static_excel_batches (
  id uuid primary key default gen_random_uuid(),
  source_id text not null check (length(source_id) between 1 and 160),
  revision text not null check (length(revision) between 1 and 240),
  format text not null check (format = 'jiaowubao-static-excel-v1'),
  source_timezone_assumed text not null check (source_timezone_assumed = 'Australia/Melbourne'),
  source_timezone_basis text not null check (length(source_timezone_basis) between 1 and 240),
  workbooks jsonb not null check (jsonb_typeof(workbooks) = 'array'),
  expected_record_counts jsonb not null check (jsonb_typeof(expected_record_counts) = 'object'),
  master_source_id text not null check (length(master_source_id) between 1 and 160),
  master_revision text not null check (length(master_revision) between 1 and 240),
  master_rows_sha256 text not null check (master_rows_sha256 ~ '^[a-f0-9]{64}$'),
  chunk_count integer not null check (chunk_count between 1 and 512),
  received_chunk_count integer not null default 0 check (received_chunk_count between 0 and chunk_count),
  received_record_counts jsonb not null default '{"facts":0,"contracts":0,"hours":0,"classMembers":0,"schedule":0,"leaveMakeups":0}'::jsonb
    check (jsonb_typeof(received_record_counts) = 'object'),
  -- The seven small XLSX archives expand into a larger, immutable JSON
  -- evidence ledger.  Keep a bounded 128 MiB ceiling, which accommodates the
  -- measured production-shaped export without admitting unbounded storage.
  received_bytes integer not null default 0 check (received_bytes between 0 and 134217728),
  state text not null default 'staging' check (state in ('staging', 'complete')),
  payload_sha256 text check (payload_sha256 is null or payload_sha256 ~ '^[a-f0-9]{64}$'),
  staged_by text not null check (length(staged_by) between 1 and 120),
  staged_at timestamptz not null default now(),
  completed_at timestamptz,
  audit_id uuid references internal.operational_contract_audit(id),
  unique (source_id, revision),
  check (
    (state = 'staging' and payload_sha256 is null and completed_at is null and audit_id is null)
    or (state = 'complete' and payload_sha256 is not null and completed_at is not null and audit_id is not null)
  )
);

alter table internal.jiaowubao_static_excel_batches enable row level security;
revoke all on table internal.jiaowubao_static_excel_batches from public, anon, authenticated;

create table if not exists internal.jiaowubao_static_excel_chunks (
  batch_id uuid not null references internal.jiaowubao_static_excel_batches(id),
  chunk_index integer not null check (chunk_index between 0 and 511),
  chunk_sha256 text not null check (chunk_sha256 ~ '^[a-f0-9]{64}$'),
  content_bytes integer not null check (content_bytes between 1 and 2097152),
  record_counts jsonb not null check (jsonb_typeof(record_counts) = 'object'),
  received_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  primary key (batch_id, chunk_index)
);

alter table internal.jiaowubao_static_excel_chunks enable row level security;
revoke all on table internal.jiaowubao_static_excel_chunks from public, anon, authenticated;

create table if not exists internal.jiaowubao_static_excel_records (
  batch_id uuid not null references internal.jiaowubao_static_excel_batches(id),
  record_kind text not null check (record_kind in (
    'fact', 'contract', 'hour', 'class_member', 'schedule', 'leave_makeup'
  )),
  source_key text not null check (source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'),
  source_refs jsonb not null check (jsonb_typeof(source_refs) = 'array'),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and octet_length(payload::text) between 2 and 32768
  ),
  record_sha256 text not null check (record_sha256 ~ '^[a-f0-9]{64}$'),
  primary key (batch_id, record_kind, source_key)
);

alter table internal.jiaowubao_static_excel_records enable row level security;
revoke all on table internal.jiaowubao_static_excel_records from public, anon, authenticated;

create table if not exists internal.jiaowubao_static_excel_record_attachments (
  batch_id uuid not null,
  record_kind text not null,
  source_key text not null,
  attachment_index integer not null check (attachment_index between 1 and 250),
  attachment_state text not null check (attachment_state in ('attached', 'quarantined')),
  master_source_row text,
  evidence_name text,
  match_mode text check (match_mode in (
    'exact_name'
  )),
  quarantine_reason text check (quarantine_reason in (
    'unmatched_jwb_identity',
    'ambiguous_jwb_identity',
    'review_required_annotation',
    'excluded_master_status',
    'empty_name',
    'missing_phone',
    'duplicate_identity',
    'class_not_resolved',
    'unassigned_teacher',
    'unmapped_course',
    'invalid_source_value',
    'non_operational_static_schedule'
  )),
  primary key (batch_id, record_kind, source_key, attachment_index),
  foreign key (batch_id, record_kind, source_key)
    references internal.jiaowubao_static_excel_records(batch_id, record_kind, source_key),
  check (
    (attachment_state = 'attached'
      and master_source_row is not null
      and evidence_name is not null
      and match_mode is not null
      and quarantine_reason is null)
    or (attachment_state = 'quarantined'
      and master_source_row is null
      and evidence_name is null
      and match_mode is null
      and quarantine_reason is not null)
  )
);

create unique index if not exists jiaowubao_static_excel_record_attached_master_uidx
  on internal.jiaowubao_static_excel_record_attachments (
    batch_id, record_kind, source_key, master_source_row
  ) where attachment_state = 'attached';

create index if not exists jiaowubao_static_excel_record_attachment_master_idx
  on internal.jiaowubao_static_excel_record_attachments (batch_id, master_source_row)
  where attachment_state = 'attached';

alter table internal.jiaowubao_static_excel_record_attachments enable row level security;
revoke all on table internal.jiaowubao_static_excel_record_attachments from public, anon, authenticated;

-- Static Excel supplements deliberately do not depend on the legacy JWB/API
-- source being configured.  This server-only reader exposes the Tencent
-- master snapshot behind the same operations secret, so an upload can attach
-- evidence only to the current authoritative master rows.  Its output is
-- consumed inside the API route and is never returned to the browser.
create or replace function public.get_current_student_import_master_source(
  p_secret text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $jiaowubao_static_excel_master_source$
declare
  master_source internal.student_import_source_rows%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  select * into master_source
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'master';
  if master_source.source_kind is null then
    raise exception using errcode = 'P0002', message = 'static_excel_master_source_unavailable';
  end if;

  return jsonb_build_object(
    'master', jsonb_build_object(
      'sourceId', master_source.source_id,
      'revision', master_source.revision,
      'rowsSha256', master_source.rows_sha256,
      'rows', master_source.rows
    )
  );
end;
$jiaowubao_static_excel_master_source$;

revoke all on function public.get_current_student_import_master_source(text)
  from public, anon, authenticated;
grant execute on function public.get_current_student_import_master_source(text)
  to anon, authenticated;

create or replace function public.put_jiaowubao_static_excel_supplement(
  p_secret text,
  p_source_id text,
  p_revision text,
  p_batch jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $jiaowubao_static_excel_supplement$
declare
  master_source internal.student_import_source_rows%rowtype;
  saved_batch internal.jiaowubao_static_excel_batches%rowtype;
  saved_chunk internal.jiaowubao_static_excel_chunks%rowtype;
  record_item record;
  chunk_audit_id uuid;
  completion_audit_id uuid;
  chunk_hash text;
  chunk_bytes integer;
  declared_chunk_index integer;
  declared_chunk_count integer;
  computed_counts jsonb;
  received_counts jsonb;
  canonical_batch jsonb;
  final_payload_hash text;
  newly_completed boolean := false;
  has_saved_batch boolean := false;
  total_records integer;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  if p_actor is null
     or p_actor not in ('Nixon', 'Ops Admin')
     or nullif(trim(p_source_id), '') is null
     or p_source_id <> trim(p_source_id)
     or length(trim(p_source_id)) > 160
     or nullif(trim(p_revision), '') is null
     or p_revision <> trim(p_revision)
     or length(trim(p_revision)) > 240 then
    raise exception using errcode = '22023', message = 'invalid_static_excel_import_request';
  end if;

  if jsonb_typeof(p_batch) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'invalid_static_excel_batch';
  end if;
  if p_batch - ARRAY[
    'format', 'sourceTimezone', 'sourceTimezoneBasis', 'masterSource', 'workbooks',
    'recordCounts', 'chunk', 'facts', 'contracts', 'hours',
    'classMembers', 'schedule', 'leaveMakeups'
  ]::text[] <> '{}'::jsonb
     or not (p_batch ?& ARRAY[
       'format', 'sourceTimezone', 'sourceTimezoneBasis', 'masterSource', 'workbooks',
       'recordCounts', 'chunk', 'facts', 'contracts', 'hours',
       'classMembers', 'schedule', 'leaveMakeups'
     ]::text[]) then
    raise exception using errcode = '22023', message = 'invalid_static_excel_batch_shape';
  end if;
  if jsonb_typeof(p_batch -> 'format') is distinct from 'string'
     or p_batch ->> 'format' <> 'jiaowubao-static-excel-v1'
     or jsonb_typeof(p_batch -> 'sourceTimezone') is distinct from 'string'
     or p_batch ->> 'sourceTimezone' <> 'Australia/Melbourne'
     or jsonb_typeof(p_batch -> 'sourceTimezoneBasis') is distinct from 'string'
     or nullif(trim(p_batch ->> 'sourceTimezoneBasis'), '') is null
     or p_batch ->> 'sourceTimezoneBasis' <> trim(p_batch ->> 'sourceTimezoneBasis')
     or length(trim(p_batch ->> 'sourceTimezoneBasis')) > 240 then
    raise exception using errcode = '22023', message = 'invalid_static_excel_timezone_provenance';
  end if;
  if jsonb_typeof(p_batch -> 'masterSource') is distinct from 'object'
     or (p_batch -> 'masterSource') - ARRAY['sourceId', 'revision', 'rowsSha256']::text[] <> '{}'::jsonb
     or not (p_batch -> 'masterSource' ?& ARRAY['sourceId', 'revision', 'rowsSha256']::text[])
     or jsonb_typeof(p_batch -> 'masterSource' -> 'sourceId') is distinct from 'string'
     or nullif(trim(p_batch -> 'masterSource' ->> 'sourceId'), '') is null
     or p_batch -> 'masterSource' ->> 'sourceId' <> trim(p_batch -> 'masterSource' ->> 'sourceId')
     or length(p_batch -> 'masterSource' ->> 'sourceId') > 160
     or jsonb_typeof(p_batch -> 'masterSource' -> 'revision') is distinct from 'string'
     or nullif(trim(p_batch -> 'masterSource' ->> 'revision'), '') is null
     or p_batch -> 'masterSource' ->> 'revision' <> trim(p_batch -> 'masterSource' ->> 'revision')
     or length(p_batch -> 'masterSource' ->> 'revision') > 240
     or jsonb_typeof(p_batch -> 'masterSource' -> 'rowsSha256') is distinct from 'string'
     or p_batch -> 'masterSource' ->> 'rowsSha256' !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_static_excel_master_source';
  end if;
  if jsonb_typeof(p_batch -> 'workbooks') is distinct from 'array'
     or jsonb_typeof(p_batch -> 'recordCounts') is distinct from 'object'
     or jsonb_typeof(p_batch -> 'chunk') is distinct from 'object'
     or jsonb_typeof(p_batch -> 'facts') is distinct from 'array'
     or jsonb_typeof(p_batch -> 'contracts') is distinct from 'array'
     or jsonb_typeof(p_batch -> 'hours') is distinct from 'array'
     or jsonb_typeof(p_batch -> 'classMembers') is distinct from 'array'
     or jsonb_typeof(p_batch -> 'schedule') is distinct from 'array'
     or jsonb_typeof(p_batch -> 'leaveMakeups') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'invalid_static_excel_batch_types';
  end if;

  if jsonb_array_length(p_batch -> 'workbooks') <> 7
     or (
       select coalesce(jsonb_agg(item.value ->> 'kind' order by item.ordinal), '[]'::jsonb)
       from jsonb_array_elements(p_batch -> 'workbooks') with ordinality as item(value, ordinal)
     ) is distinct from '["quick_list","students","contracts","hours","class_members","schedule","leave_makeups"]'::jsonb
     or exists (
       select 1
       from jsonb_array_elements(p_batch -> 'workbooks') item(value)
       where jsonb_typeof(item.value) is distinct from 'object'
          or item.value - ARRAY['kind', 'workbookName', 'workbookSha256', 'rowCount']::text[] <> '{}'::jsonb
          or jsonb_typeof(item.value -> 'kind') is distinct from 'string'
          or jsonb_typeof(item.value -> 'workbookName') is distinct from 'string'
          or nullif(trim(item.value ->> 'workbookName'), '') is null
          or item.value ->> 'workbookName' <> trim(item.value ->> 'workbookName')
          or length(trim(item.value ->> 'workbookName')) > 240
          or jsonb_typeof(item.value -> 'workbookSha256') is distinct from 'string'
          or item.value ->> 'workbookSha256' !~ '^[a-f0-9]{64}$'
          or case when jsonb_typeof(item.value -> 'rowCount') = 'number' then
            (item.value ->> 'rowCount')::numeric < 0
            or (item.value ->> 'rowCount')::numeric > 1000000
            or (item.value ->> 'rowCount')::numeric <> trunc((item.value ->> 'rowCount')::numeric)
          else true end
     ) then
    raise exception using errcode = '22023', message = 'invalid_static_excel_workbook_manifest';
  end if;

  if (p_batch -> 'recordCounts') - ARRAY[
    'facts', 'contracts', 'hours', 'classMembers', 'schedule', 'leaveMakeups'
  ]::text[] <> '{}'::jsonb
     or not (p_batch -> 'recordCounts' ?& ARRAY[
       'facts', 'contracts', 'hours', 'classMembers', 'schedule', 'leaveMakeups'
     ]::text[])
     or exists (
       select 1
       from jsonb_each(p_batch -> 'recordCounts') item(key, value)
       where case when jsonb_typeof(item.value) = 'number' then
         (item.value #>> '{}')::numeric < 0
         or (item.value #>> '{}')::numeric <> trunc((item.value #>> '{}')::numeric)
         or (item.value #>> '{}')::numeric > case item.key
           when 'facts' then 2000
           when 'contracts' then 10000
           when 'hours' then 10000
           when 'classMembers' then 10000
           when 'schedule' then 60000
           when 'leaveMakeups' then 5000
           else 0
         end
       else true end
     ) then
    raise exception using errcode = '22023', message = 'invalid_static_excel_record_counts';
  end if;

  total_records := (p_batch -> 'recordCounts' ->> 'facts')::integer
    + (p_batch -> 'recordCounts' ->> 'contracts')::integer
    + (p_batch -> 'recordCounts' ->> 'hours')::integer
    + (p_batch -> 'recordCounts' ->> 'classMembers')::integer
    + (p_batch -> 'recordCounts' ->> 'schedule')::integer
    + (p_batch -> 'recordCounts' ->> 'leaveMakeups')::integer;
  if total_records > 97000 then
    raise exception using errcode = '22023', message = 'static_excel_record_count_limit_exceeded';
  end if;

  if (p_batch -> 'chunk') - ARRAY['index', 'count']::text[] <> '{}'::jsonb
     or not (p_batch -> 'chunk' ?& ARRAY['index', 'count']::text[]) then
    raise exception using errcode = '22023', message = 'invalid_static_excel_chunk';
  end if;
  if jsonb_typeof(p_batch -> 'chunk' -> 'index') is distinct from 'number'
     or jsonb_typeof(p_batch -> 'chunk' -> 'count') is distinct from 'number' then
    raise exception using errcode = '22023', message = 'invalid_static_excel_chunk';
  end if;
  if (p_batch -> 'chunk' ->> 'index')::numeric <> trunc((p_batch -> 'chunk' ->> 'index')::numeric)
     or (p_batch -> 'chunk' ->> 'count')::numeric <> trunc((p_batch -> 'chunk' ->> 'count')::numeric)
     or (p_batch -> 'chunk' ->> 'index')::numeric < 0
     or (p_batch -> 'chunk' ->> 'count')::numeric < 1
     or (p_batch -> 'chunk' ->> 'count')::numeric > 512
     or (p_batch -> 'chunk' ->> 'index')::numeric >= (p_batch -> 'chunk' ->> 'count')::numeric then
    raise exception using errcode = '22023', message = 'invalid_static_excel_chunk';
  end if;
  declared_chunk_index := (p_batch -> 'chunk' ->> 'index')::integer;
  declared_chunk_count := (p_batch -> 'chunk' ->> 'count')::integer;

  computed_counts := jsonb_build_object(
    'facts', jsonb_array_length(p_batch -> 'facts'),
    'contracts', jsonb_array_length(p_batch -> 'contracts'),
    'hours', jsonb_array_length(p_batch -> 'hours'),
    'classMembers', jsonb_array_length(p_batch -> 'classMembers'),
    'schedule', jsonb_array_length(p_batch -> 'schedule'),
    'leaveMakeups', jsonb_array_length(p_batch -> 'leaveMakeups')
  );
  if (
    (computed_counts ->> 'facts')::integer
    + (computed_counts ->> 'contracts')::integer
    + (computed_counts ->> 'hours')::integer
    + (computed_counts ->> 'classMembers')::integer
    + (computed_counts ->> 'schedule')::integer
    + (computed_counts ->> 'leaveMakeups')::integer
  ) not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'invalid_static_excel_chunk_record_count';
  end if;

  chunk_bytes := octet_length(p_batch::text);
  if chunk_bytes > 2097152 then
    raise exception using errcode = '22023', message = 'static_excel_chunk_size_limit_exceeded';
  end if;

  -- Validate every normalized record before creating a staging batch.  The
  -- outer schema is intentionally exact; raw source fields remain in the
  -- bounded payload object so the importer cannot mint arbitrary columns.
  for record_item in
    select 'fact'::text as record_kind, item.value
    from jsonb_array_elements(p_batch -> 'facts') item(value)
    union all
    select 'contract'::text, item.value from jsonb_array_elements(p_batch -> 'contracts') item(value)
    union all
    select 'hour'::text, item.value from jsonb_array_elements(p_batch -> 'hours') item(value)
    union all
    select 'class_member'::text, item.value from jsonb_array_elements(p_batch -> 'classMembers') item(value)
    union all
    select 'schedule'::text, item.value from jsonb_array_elements(p_batch -> 'schedule') item(value)
    union all
    select 'leave_makeup'::text, item.value from jsonb_array_elements(p_batch -> 'leaveMakeups') item(value)
  loop
    if jsonb_typeof(record_item.value) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'invalid_static_excel_record';
    end if;
    if record_item.value - ARRAY['sourceKey', 'sourceRefs', 'attachments', 'payload']::text[] <> '{}'::jsonb
       or not (record_item.value ?& ARRAY['sourceKey', 'sourceRefs', 'attachments', 'payload']::text[])
       or jsonb_typeof(record_item.value -> 'sourceKey') is distinct from 'string'
       or record_item.value ->> 'sourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'
       or jsonb_typeof(record_item.value -> 'sourceRefs') is distinct from 'array'
       or jsonb_typeof(record_item.value -> 'attachments') is distinct from 'array'
       or jsonb_typeof(record_item.value -> 'payload') is distinct from 'object' then
      raise exception using errcode = '22023', message = 'invalid_static_excel_record';
    end if;
    if jsonb_array_length(record_item.value -> 'sourceRefs') not between 1 and 100
       or jsonb_array_length(record_item.value -> 'attachments') not between 1 and 250
       or (select count(*) from jsonb_object_keys(record_item.value -> 'payload')) not between 1 and 128
       or octet_length((record_item.value -> 'payload')::text) > 32768 then
      raise exception using errcode = '22023', message = 'invalid_static_excel_record';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(record_item.value -> 'sourceRefs') source_ref(value)
      where jsonb_typeof(source_ref.value) is distinct from 'object'
    ) then
      raise exception using errcode = '22023', message = 'invalid_static_excel_record_source_refs';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(record_item.value -> 'sourceRefs') source_ref(value)
      where source_ref.value - ARRAY['workbook', 'row', 'cell']::text[] <> '{}'::jsonb
         or jsonb_typeof(source_ref.value -> 'workbook') is distinct from 'string'
         or source_ref.value ->> 'workbook' not in (
           'quick_list', 'students', 'contracts', 'hours',
           'class_members', 'schedule', 'leave_makeups'
         )
         or case when jsonb_typeof(source_ref.value -> 'row') = 'number' then
           (source_ref.value ->> 'row')::numeric < 1
           or (source_ref.value ->> 'row')::numeric > 1000000
           or (source_ref.value ->> 'row')::numeric <> trunc((source_ref.value ->> 'row')::numeric)
         else true end
         or (source_ref.value ? 'cell' and (
           jsonb_typeof(source_ref.value -> 'cell') is distinct from 'string'
           or source_ref.value ->> 'cell' !~ '^[A-Z]{1,3}[1-9][0-9]{0,5}$'
         ))
    ) or (
      select count(*)
      from jsonb_array_elements(record_item.value -> 'sourceRefs') source_ref(value)
    ) <> (
      select count(distinct (source_ref.value ->> 'workbook') || ':' || (source_ref.value ->> 'row') || ':' || coalesce(source_ref.value ->> 'cell', ''))
      from jsonb_array_elements(record_item.value -> 'sourceRefs') source_ref(value)
    ) then
      raise exception using errcode = '22023', message = 'invalid_static_excel_record_source_refs';
    end if;

    if record_item.record_kind = 'schedule' and not exists (
      select 1
      from jsonb_array_elements(record_item.value -> 'sourceRefs') source_ref(value)
      where source_ref.value ->> 'workbook' = 'schedule'
        and source_ref.value ? 'cell'
    ) then
      raise exception using errcode = '22023', message = 'static_excel_schedule_source_cell_required';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(record_item.value -> 'attachments') attachment(value)
      where jsonb_typeof(attachment.value) is distinct from 'object'
    ) then
      raise exception using errcode = '22023', message = 'invalid_static_excel_record_attachments';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(record_item.value -> 'attachments') attachment(value)
      where attachment.value - ARRAY['state', 'masterSourceRow', 'evidenceName', 'matchMode', 'reason']::text[] <> '{}'::jsonb
         or jsonb_typeof(attachment.value -> 'state') is distinct from 'string'
         or case attachment.value ->> 'state'
           when 'attached' then
             not (attachment.value ?& ARRAY['state', 'masterSourceRow', 'evidenceName', 'matchMode']::text[])
             or attachment.value ? 'reason'
             or jsonb_typeof(attachment.value -> 'masterSourceRow') is distinct from 'string'
             or nullif(trim(attachment.value ->> 'masterSourceRow'), '') is null
             or attachment.value ->> 'masterSourceRow' <> trim(attachment.value ->> 'masterSourceRow')
             or length(attachment.value ->> 'masterSourceRow') > 240
             or jsonb_typeof(attachment.value -> 'evidenceName') is distinct from 'string'
             or nullif(trim(attachment.value ->> 'evidenceName'), '') is null
             or attachment.value ->> 'evidenceName' <> trim(attachment.value ->> 'evidenceName')
             or length(attachment.value ->> 'evidenceName') > 240
             or jsonb_typeof(attachment.value -> 'matchMode') is distinct from 'string'
             or attachment.value ->> 'matchMode' <> 'exact_name'
           when 'quarantined' then
             not (attachment.value ?& ARRAY['state', 'reason']::text[])
             or attachment.value ? 'masterSourceRow'
             or attachment.value ? 'evidenceName'
             or attachment.value ? 'matchMode'
             or jsonb_typeof(attachment.value -> 'reason') is distinct from 'string'
             or attachment.value ->> 'reason' not in (
               'unmatched_jwb_identity',
               'ambiguous_jwb_identity',
               'review_required_annotation',
               'excluded_master_status',
               'empty_name',
               'missing_phone',
               'duplicate_identity',
               'class_not_resolved',
               'unassigned_teacher',
               'unmapped_course',
               'invalid_source_value',
               'non_operational_static_schedule'
             )
           else true
         end
    ) or (
      select count(*)
      from jsonb_array_elements(record_item.value -> 'attachments') attachment(value)
      where attachment.value ->> 'state' = 'attached'
    ) <> (
      select count(distinct attachment.value ->> 'masterSourceRow')
      from jsonb_array_elements(record_item.value -> 'attachments') attachment(value)
      where attachment.value ->> 'state' = 'attached'
    ) then
      raise exception using errcode = '22023', message = 'invalid_static_excel_record_attachments';
    end if;
  end loop;

  if exists (
    select 1
    from (
      select 'fact'::text as record_kind, item.value ->> 'sourceKey' as source_key
      from jsonb_array_elements(p_batch -> 'facts') item(value)
      union all select 'contract'::text, item.value ->> 'sourceKey' from jsonb_array_elements(p_batch -> 'contracts') item(value)
      union all select 'hour'::text, item.value ->> 'sourceKey' from jsonb_array_elements(p_batch -> 'hours') item(value)
      union all select 'class_member'::text, item.value ->> 'sourceKey' from jsonb_array_elements(p_batch -> 'classMembers') item(value)
      union all select 'schedule'::text, item.value ->> 'sourceKey' from jsonb_array_elements(p_batch -> 'schedule') item(value)
      union all select 'leave_makeup'::text, item.value ->> 'sourceKey' from jsonb_array_elements(p_batch -> 'leaveMakeups') item(value)
    ) incoming
    group by incoming.record_kind, incoming.source_key
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'static_excel_chunk_duplicate_record_source_key';
  end if;

  chunk_hash := encode(extensions.digest(p_batch::text, 'sha256'), 'hex');

  -- One advisory key serializes a logical source/revision across chunk retries
  -- without taking a lock on student state or the Tencent source writer.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('jiaowubao-static-excel:' || trim(p_source_id) || ':' || trim(p_revision))
  );

  select * into saved_batch
  from internal.jiaowubao_static_excel_batches batch
  where batch.source_id = trim(p_source_id)
    and batch.revision = trim(p_revision)
  for update;

  has_saved_batch := found;
  if has_saved_batch then
    if saved_batch.format <> p_batch ->> 'format'
       or saved_batch.source_timezone_assumed <> p_batch ->> 'sourceTimezone'
       or saved_batch.source_timezone_basis <> p_batch ->> 'sourceTimezoneBasis'
       or saved_batch.master_source_id <> p_batch -> 'masterSource' ->> 'sourceId'
       or saved_batch.master_revision <> p_batch -> 'masterSource' ->> 'revision'
       or saved_batch.master_rows_sha256 <> p_batch -> 'masterSource' ->> 'rowsSha256'
       or saved_batch.workbooks is distinct from p_batch -> 'workbooks'
       or saved_batch.expected_record_counts is distinct from p_batch -> 'recordCounts'
       or saved_batch.chunk_count <> declared_chunk_count then
      raise exception using errcode = '23505', message = 'static_excel_batch_envelope_conflict';
    end if;
    select * into saved_chunk
    from internal.jiaowubao_static_excel_chunks chunk
    where chunk.batch_id = saved_batch.id
      and chunk.chunk_index = declared_chunk_index
    for update;
    if found then
      if saved_chunk.chunk_sha256 <> chunk_hash then
        raise exception using errcode = '23505', message = 'static_excel_chunk_conflict';
      end if;
      -- A lost client response must replay even if Tencent refreshes after the
      -- original chunk was safely stored.  New chunks below still fail closed
      -- against the batch's original Tencent source snapshot.
      return jsonb_build_object(
        'batchId', saved_batch.id,
        'sourceId', saved_batch.source_id,
        'revision', saved_batch.revision,
        'state', saved_batch.state,
        'chunkIndex', declared_chunk_index,
        'chunkCount', saved_batch.chunk_count,
        'receivedChunkCount', saved_batch.received_chunk_count,
        'recordCounts', saved_batch.received_record_counts,
        'payloadSha256', saved_batch.payload_sha256,
        'completedNow', false,
        'replayed', true
      );
    end if;
  end if;

  select * into master_source
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'master'
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'static_excel_master_source_unavailable';
  end if;

  -- The service binds every chunk to the exact Tencent source it read before
  -- deriving attachments.  Do not let an intervening master refresh turn an
  -- old exact-name proof into a new cross-student evidence association.
  if master_source.source_id <> p_batch -> 'masterSource' ->> 'sourceId'
     or master_source.revision <> p_batch -> 'masterSource' ->> 'revision'
     or master_source.rows_sha256 <> p_batch -> 'masterSource' ->> 'rowsSha256' then
    raise exception using errcode = '40900', message = 'static_excel_master_source_changed';
  end if;

  if has_saved_batch then
    if saved_batch.master_source_id <> master_source.source_id
       or saved_batch.master_revision <> master_source.revision
       or saved_batch.master_rows_sha256 <> master_source.rows_sha256 then
      raise exception using errcode = '40900', message = 'static_excel_master_source_changed';
    end if;
  else
    insert into internal.jiaowubao_static_excel_batches (
      source_id, revision, format, source_timezone_assumed, source_timezone_basis,
      workbooks, expected_record_counts, master_source_id, master_revision,
      master_rows_sha256, chunk_count, staged_by
    ) values (
      trim(p_source_id), trim(p_revision), p_batch ->> 'format',
      p_batch ->> 'sourceTimezone', p_batch ->> 'sourceTimezoneBasis',
      p_batch -> 'workbooks', p_batch -> 'recordCounts', master_source.source_id,
      master_source.revision, master_source.rows_sha256, declared_chunk_count,
      trim(p_actor)
    ) returning * into saved_batch;
  end if;

  -- Chunks are deliberately sequential.  The browser resumes only from the
  -- last acknowledged cursor; rejecting a gap here keeps an accidental or
  -- handcrafted middle-of-batch call from leaving an unusable staging batch.
  if declared_chunk_index > 0
     and (
       select count(*)
       from internal.jiaowubao_static_excel_chunks prior_chunk
       where prior_chunk.batch_id = saved_batch.id
         and prior_chunk.chunk_index between 0 and declared_chunk_index - 1
     ) <> declared_chunk_index then
    raise exception using errcode = '22023', message = 'static_excel_chunk_sequence_gap';
  end if;

  -- `masterSourceRow` is only an evidence link.  It must be a unique named
  -- Tencent master row, and the explicit rejected inactive/no-hours category
  -- is forbidden even if a stale client tried to attach it.
  if exists (
    select 1
    from jsonb_array_elements(
      (p_batch -> 'facts') || (p_batch -> 'contracts') || (p_batch -> 'hours')
      || (p_batch -> 'classMembers') || (p_batch -> 'schedule') || (p_batch -> 'leaveMakeups')
    ) record_value(value)
    cross join lateral jsonb_array_elements(record_value.value -> 'attachments') attachment(value)
    where attachment.value ->> 'state' = 'attached'
      and (
        select count(*)
        from jsonb_array_elements(master_source.rows) master_row(value)
        where internal.student_import_source_key(master_row.value -> 'sourceRow') =
              attachment.value ->> 'masterSourceRow'
          and nullif(trim(master_row.value ->> 'name'), '') is not null
      ) <> 1
  ) then
    raise exception using errcode = '22023', message = 'static_excel_attachment_master_row_unknown';
  end if;
  -- The only automatic attachment is an exact, canonical name match.  The
  -- evidence name is retained with the child row and checked here again so a
  -- server-side caller cannot accidentally bind a JWB fact to an unrelated
  -- active Tencent master row merely by supplying its source-row key.
  if exists (
    select 1
    from jsonb_array_elements(
      (p_batch -> 'facts') || (p_batch -> 'contracts') || (p_batch -> 'hours')
      || (p_batch -> 'classMembers') || (p_batch -> 'schedule') || (p_batch -> 'leaveMakeups')
    ) record_value(value)
    cross join lateral jsonb_array_elements(record_value.value -> 'attachments') attachment(value)
    join lateral jsonb_array_elements(master_source.rows) master_row(value)
      on internal.student_import_source_key(master_row.value -> 'sourceRow') =
         attachment.value ->> 'masterSourceRow'
    where attachment.value ->> 'state' = 'attached'
      and internal.student_import_name_key(master_row.value ->> 'name') <>
          internal.student_import_name_key(attachment.value ->> 'evidenceName')
  ) then
    raise exception using errcode = '22023', message = 'static_excel_attachment_name_mismatch';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(
      (p_batch -> 'facts') || (p_batch -> 'contracts') || (p_batch -> 'hours')
      || (p_batch -> 'classMembers') || (p_batch -> 'schedule') || (p_batch -> 'leaveMakeups')
    ) record_value(value)
    cross join lateral jsonb_array_elements(record_value.value -> 'attachments') attachment(value)
    join lateral jsonb_array_elements(master_source.rows) master_row(value)
      on internal.student_import_source_key(master_row.value -> 'sourceRow') =
         attachment.value ->> 'masterSourceRow'
    where attachment.value ->> 'state' = 'attached'
      and trim(coalesce(master_row.value ->> 'status', '')) = '不活跃 + 无课时'
  ) then
    raise exception using errcode = '22023', message = 'static_excel_attachment_excluded_master_forbidden';
  end if;

  if saved_batch.state = 'complete' then
    raise exception using errcode = '23505', message = 'static_excel_complete_batch_new_chunk_forbidden';
  end if;

  if exists (
    select 1
    from (
      select 'fact'::text as record_kind, item.value
      from jsonb_array_elements(p_batch -> 'facts') item(value)
      union all select 'contract'::text, item.value from jsonb_array_elements(p_batch -> 'contracts') item(value)
      union all select 'hour'::text, item.value from jsonb_array_elements(p_batch -> 'hours') item(value)
      union all select 'class_member'::text, item.value from jsonb_array_elements(p_batch -> 'classMembers') item(value)
      union all select 'schedule'::text, item.value from jsonb_array_elements(p_batch -> 'schedule') item(value)
      union all select 'leave_makeup'::text, item.value from jsonb_array_elements(p_batch -> 'leaveMakeups') item(value)
    ) incoming
    join internal.jiaowubao_static_excel_records existing
      on existing.batch_id = saved_batch.id
     and existing.record_kind = incoming.record_kind
     and existing.source_key = incoming.value ->> 'sourceKey'
  ) then
    raise exception using errcode = '23505', message = 'static_excel_record_source_key_conflict';
  end if;

  if saved_batch.received_bytes + chunk_bytes > 134217728 then
    raise exception using errcode = '22023', message = 'static_excel_batch_size_limit_exceeded';
  end if;

  chunk_audit_id := internal.append_operational_contract_audit(
    'jiaowubao_static_excel.chunk_staged', trim(p_actor),
    'jiaowubao_static_excel_batch', saved_batch.id::text,
    jsonb_build_object(
      'sourceId', saved_batch.source_id,
      'revision', saved_batch.revision,
      'chunkIndex', declared_chunk_index,
      'chunkCount', declared_chunk_count,
      'chunkSha256', chunk_hash,
      'contentBytes', chunk_bytes,
      'recordCounts', computed_counts,
      'masterSourceId', master_source.source_id,
      'masterRevision', master_source.revision,
      'masterRowsSha256', master_source.rows_sha256
    )
  );

  for record_item in
    select 'fact'::text as record_kind, item.value
    from jsonb_array_elements(p_batch -> 'facts') item(value)
    union all select 'contract'::text, item.value from jsonb_array_elements(p_batch -> 'contracts') item(value)
    union all select 'hour'::text, item.value from jsonb_array_elements(p_batch -> 'hours') item(value)
    union all select 'class_member'::text, item.value from jsonb_array_elements(p_batch -> 'classMembers') item(value)
    union all select 'schedule'::text, item.value from jsonb_array_elements(p_batch -> 'schedule') item(value)
    union all select 'leave_makeup'::text, item.value from jsonb_array_elements(p_batch -> 'leaveMakeups') item(value)
  loop
    insert into internal.jiaowubao_static_excel_records (
      batch_id, record_kind, source_key, source_refs, payload, record_sha256
    ) values (
      saved_batch.id, record_item.record_kind, record_item.value ->> 'sourceKey',
      record_item.value -> 'sourceRefs', record_item.value -> 'payload',
      encode(extensions.digest(record_item.value::text, 'sha256'), 'hex')
    );

    insert into internal.jiaowubao_static_excel_record_attachments (
      batch_id, record_kind, source_key, attachment_index, attachment_state,
      master_source_row, evidence_name, match_mode, quarantine_reason
    )
    select
      saved_batch.id,
      record_item.record_kind,
      record_item.value ->> 'sourceKey',
      attachment.ordinal::integer,
      attachment.value ->> 'state',
      case when attachment.value ->> 'state' = 'attached'
        then attachment.value ->> 'masterSourceRow' else null end,
      case when attachment.value ->> 'state' = 'attached'
        then attachment.value ->> 'evidenceName' else null end,
      case when attachment.value ->> 'state' = 'attached'
        then attachment.value ->> 'matchMode' else null end,
      case when attachment.value ->> 'state' = 'quarantined'
        then attachment.value ->> 'reason' else null end
    from jsonb_array_elements(record_item.value -> 'attachments') with ordinality
      as attachment(value, ordinal);
  end loop;

  insert into internal.jiaowubao_static_excel_chunks (
    batch_id, chunk_index, chunk_sha256, content_bytes, record_counts, audit_id
  ) values (
    saved_batch.id, declared_chunk_index, chunk_hash, chunk_bytes,
    computed_counts, chunk_audit_id
  );

  received_counts := jsonb_build_object(
    'facts', (saved_batch.received_record_counts ->> 'facts')::integer + (computed_counts ->> 'facts')::integer,
    'contracts', (saved_batch.received_record_counts ->> 'contracts')::integer + (computed_counts ->> 'contracts')::integer,
    'hours', (saved_batch.received_record_counts ->> 'hours')::integer + (computed_counts ->> 'hours')::integer,
    'classMembers', (saved_batch.received_record_counts ->> 'classMembers')::integer + (computed_counts ->> 'classMembers')::integer,
    'schedule', (saved_batch.received_record_counts ->> 'schedule')::integer + (computed_counts ->> 'schedule')::integer,
    'leaveMakeups', (saved_batch.received_record_counts ->> 'leaveMakeups')::integer + (computed_counts ->> 'leaveMakeups')::integer
  );

  if received_counts ->> 'facts' <> saved_batch.expected_record_counts ->> 'facts'
     and (received_counts ->> 'facts')::integer > (saved_batch.expected_record_counts ->> 'facts')::integer
     or received_counts ->> 'contracts' <> saved_batch.expected_record_counts ->> 'contracts'
     and (received_counts ->> 'contracts')::integer > (saved_batch.expected_record_counts ->> 'contracts')::integer
     or received_counts ->> 'hours' <> saved_batch.expected_record_counts ->> 'hours'
     and (received_counts ->> 'hours')::integer > (saved_batch.expected_record_counts ->> 'hours')::integer
     or received_counts ->> 'classMembers' <> saved_batch.expected_record_counts ->> 'classMembers'
     and (received_counts ->> 'classMembers')::integer > (saved_batch.expected_record_counts ->> 'classMembers')::integer
     or received_counts ->> 'schedule' <> saved_batch.expected_record_counts ->> 'schedule'
     and (received_counts ->> 'schedule')::integer > (saved_batch.expected_record_counts ->> 'schedule')::integer
     or received_counts ->> 'leaveMakeups' <> saved_batch.expected_record_counts ->> 'leaveMakeups'
     and (received_counts ->> 'leaveMakeups')::integer > (saved_batch.expected_record_counts ->> 'leaveMakeups')::integer then
    raise exception using errcode = '22023', message = 'static_excel_record_counts_exceeded';
  end if;

  update internal.jiaowubao_static_excel_batches batch
  set received_chunk_count = batch.received_chunk_count + 1,
      received_record_counts = received_counts,
      received_bytes = batch.received_bytes + chunk_bytes
  where batch.id = saved_batch.id
  returning * into saved_batch;

  if saved_batch.received_chunk_count = saved_batch.chunk_count then
    if saved_batch.received_record_counts is distinct from saved_batch.expected_record_counts then
      raise exception using errcode = '22023', message = 'static_excel_final_record_counts_mismatch';
    end if;

    -- Hash compact, ordered per-record hashes instead of re-aggregating every
    -- static payload into one large in-memory JSON value.  Each record hash
    -- already covers its source refs, attachment array, and bounded payload.
    select jsonb_build_object(
      'format', saved_batch.format,
      'sourceTimezone', saved_batch.source_timezone_assumed,
      'sourceTimezoneBasis', saved_batch.source_timezone_basis,
      'workbooks', saved_batch.workbooks,
      'recordCounts', saved_batch.expected_record_counts,
      'masterSource', jsonb_build_object(
        'sourceId', saved_batch.master_source_id,
        'revision', saved_batch.master_revision,
        'rowsSha256', saved_batch.master_rows_sha256
      ),
      'facts', coalesce((select jsonb_agg(record.record_sha256 order by record.source_key)
        from internal.jiaowubao_static_excel_records record
        where record.batch_id = saved_batch.id and record.record_kind = 'fact'), '[]'::jsonb),
      'contracts', coalesce((select jsonb_agg(record.record_sha256 order by record.source_key)
        from internal.jiaowubao_static_excel_records record
        where record.batch_id = saved_batch.id and record.record_kind = 'contract'), '[]'::jsonb),
      'hours', coalesce((select jsonb_agg(record.record_sha256 order by record.source_key)
        from internal.jiaowubao_static_excel_records record
        where record.batch_id = saved_batch.id and record.record_kind = 'hour'), '[]'::jsonb),
      'classMembers', coalesce((select jsonb_agg(record.record_sha256 order by record.source_key)
        from internal.jiaowubao_static_excel_records record
        where record.batch_id = saved_batch.id and record.record_kind = 'class_member'), '[]'::jsonb),
      'schedule', coalesce((select jsonb_agg(record.record_sha256 order by record.source_key)
        from internal.jiaowubao_static_excel_records record
        where record.batch_id = saved_batch.id and record.record_kind = 'schedule'), '[]'::jsonb),
      'leaveMakeups', coalesce((select jsonb_agg(record.record_sha256 order by record.source_key)
        from internal.jiaowubao_static_excel_records record
        where record.batch_id = saved_batch.id and record.record_kind = 'leave_makeup'), '[]'::jsonb)
    ) into canonical_batch;

    final_payload_hash := encode(extensions.digest(canonical_batch::text, 'sha256'), 'hex');
    completion_audit_id := internal.append_operational_contract_audit(
      'jiaowubao_static_excel.batch_completed', trim(p_actor),
      'jiaowubao_static_excel_batch', saved_batch.id::text,
      jsonb_build_object(
        'sourceId', saved_batch.source_id,
        'revision', saved_batch.revision,
        'payloadSha256', final_payload_hash,
        'recordCounts', saved_batch.received_record_counts,
        'chunkCount', saved_batch.chunk_count,
        'receivedBytes', saved_batch.received_bytes,
        'masterSourceId', saved_batch.master_source_id,
        'masterRevision', saved_batch.master_revision,
        'masterRowsSha256', saved_batch.master_rows_sha256
      )
    );

    update internal.jiaowubao_static_excel_batches batch
    set state = 'complete', payload_sha256 = final_payload_hash,
        completed_at = now(), audit_id = completion_audit_id
    where batch.id = saved_batch.id
    returning * into saved_batch;
    newly_completed := true;
  end if;

  return jsonb_build_object(
    'batchId', saved_batch.id,
    'sourceId', saved_batch.source_id,
    'revision', saved_batch.revision,
    'state', saved_batch.state,
    'chunkIndex', declared_chunk_index,
    'chunkCount', saved_batch.chunk_count,
    'receivedChunkCount', saved_batch.received_chunk_count,
    'recordCounts', saved_batch.received_record_counts,
    'payloadSha256', saved_batch.payload_sha256,
    'completedNow', newly_completed,
    'replayed', false
  );
end;
$jiaowubao_static_excel_supplement$;

revoke all on function public.put_jiaowubao_static_excel_supplement(text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.put_jiaowubao_static_excel_supplement(text, text, text, jsonb, text)
  to anon, authenticated;
