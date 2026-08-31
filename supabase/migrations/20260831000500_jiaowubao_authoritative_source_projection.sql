-- Makes the completed Jiaowubao Open API schedule publication a durable,
-- queryable authority source. Jiaowubao is one authority among several: this
-- projection records provenance and safe matches but never overwrites native
-- student, teacher, course, or booking fields.

-- v3 retains every JSON business field returned for a schedule record,
-- including price fields and future supplier fields. Credential-shaped keys
-- remain forbidden at every nesting level.
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
     or (p_envelope ->> 'expectedPageCount')::integer not between 0 and 60
     or jsonb_typeof(p_envelope -> 'expectedRowCount') <> 'number'
     or (p_envelope ->> 'expectedRowCount')::integer not between 0 and 6000
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
     or lower((p_envelope -> 'query')::text) ~ '"(sk|secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|password|authorization|cookie|api[_-]?key|client[_-]?secret|secret[_-]?key)"\s*:'
     or jsonb_typeof(p_envelope -> 'sourceMetadata') <> 'object'
     or octet_length((p_envelope -> 'sourceMetadata')::text) not between 2 and 32768
     or (p_envelope -> 'sourceMetadata') - ARRAY['exportFormat','manifestSha256','recordsSha256']::text[] <> '{}'::jsonb
     or not ((p_envelope -> 'sourceMetadata') ?& ARRAY['exportFormat','manifestSha256','recordsSha256']::text[])
     or p_envelope -> 'sourceMetadata' ->> 'exportFormat' not in (
       'jiaowubao-schedule-export/v1',
       'jiaowubao-schedule-export/v2',
       'jiaowubao-schedule-export/v3'
     )
     or p_envelope -> 'sourceMetadata' ->> 'manifestSha256' <> p_envelope ->> 'externalManifestSha256'
     or p_envelope -> 'sourceMetadata' ->> 'recordsSha256' !~ '^sha256:[a-f0-9]{64}$'
     or lower((p_envelope -> 'sourceMetadata')::text) ~ '"(sk|secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|password|authorization|cookie|api[_-]?key|client[_-]?secret|secret[_-]?key)"\s*:' then
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
       select 1
       from jsonb_array_elements(p_rows) item_value
       where jsonb_typeof(item_value) is distinct from 'object'
          or not (item_value ?& ARRAY['sourceKey','record']::text[])
          or item_value - ARRAY['sourceKey','record']::text[] <> '{}'::jsonb
          or jsonb_typeof(item_value -> 'sourceKey') is distinct from 'string'
          or item_value ->> 'sourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'
          or jsonb_typeof(item_value -> 'record') is distinct from 'object'
          or not ((item_value -> 'record') ?& ARRAY['cal_id']::text[])
          or jsonb_typeof(item_value -> 'record' -> 'cal_id') <> 'string'
          or item_value -> 'record' ->> 'cal_id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
          or (item_value ->> 'sourceKey') <> ('jwb-open-api:schedule:' || (item_value -> 'record' ->> 'cal_id'))
          or octet_length((item_value -> 'record')::text) > 262144
          or lower((item_value -> 'record')::text) ~ '"(__proto__|prototype|constructor|sk|secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|password|authorization|cookie|api[_-]?key|client[_-]?secret|secret[_-]?key)"\s*:'
          or (
            (item_value -> 'record') ? 'stu_list'
            and (
              jsonb_typeof(item_value -> 'record' -> 'stu_list') <> 'array'
              or jsonb_array_length(item_value -> 'record' -> 'stu_list') > 1000
              or exists (
                select 1
                from jsonb_array_elements(item_value -> 'record' -> 'stu_list') student_value
                where jsonb_typeof(student_value) <> 'object'
                   or octet_length(student_value::text) > 131072
              )
            )
          )
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

create table if not exists internal.jiaowubao_authority_projection_runs (
  id uuid primary key default gen_random_uuid(),
  api_source_key text not null check (api_source_key = 'jwb-open-api-schedule'),
  snapshot_run_id uuid not null references internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(id) on delete restrict,
  snapshot_revision text not null check (snapshot_revision ~ '^sha256:[a-f0-9]{64}$'),
  native_state_versions jsonb not null check (
    jsonb_typeof(native_state_versions) = 'object'
    and native_state_versions ?& array['students','teachers','courses','bookings']::text[]
    and native_state_versions - array['students','teachers','courses','bookings']::text[] = '{}'::jsonb
  ),
  native_state_sha256 text not null check (native_state_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  source_window jsonb not null check (
    jsonb_typeof(source_window) = 'object'
    and source_window ?& array['start','end']::text[]
    and source_window - array['start','end']::text[] = '{}'::jsonb
  ),
  projected_at timestamptz not null default clock_timestamp(),
  projected_by text not null check (projected_by = 'Ops Admin'),
  summary jsonb not null check (jsonb_typeof(summary) = 'object' and octet_length(summary::text) between 2 and 1048576),
  audit_id uuid not null references internal.operational_contract_audit(id),
  unique (snapshot_run_id, native_state_sha256)
);
alter table internal.jiaowubao_authority_projection_runs enable row level security;
revoke all on table internal.jiaowubao_authority_projection_runs from public, anon, authenticated;

create table if not exists internal.jiaowubao_authority_projection_entities (
  projection_run_id uuid not null references internal.jiaowubao_authority_projection_runs(id) on delete restrict,
  entity_type text not null check (entity_type in ('schedule','student','teacher','course','class','room')),
  source_key text not null check (source_key ~ '^sha256:[a-f0-9]{64}$'),
  source_native_id text check (source_native_id is null or char_length(source_native_id) between 1 and 8192),
  source_id_present boolean not null,
  identity_label text check (identity_label is null or char_length(identity_label) between 1 and 2000),
  identity_key text not null default '' check (char_length(identity_key) <= 2000),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) between 2 and 262144),
  evidence_count integer not null check (evidence_count between 1 and 6000000),
  identity_variant_count integer not null check (identity_variant_count between 0 and 10000),
  match_status text not null default 'unmatched' check (match_status in ('matched','unmatched','conflict','source_only')),
  match_strategy text check (match_strategy is null or match_strategy in ('source_id','unique_name','source_only')),
  matched_entity_id text check (matched_entity_id is null or char_length(matched_entity_id) between 1 and 240),
  conflict_type text check (conflict_type is null or conflict_type in (
    'source_identity_conflict','source_id_matches_multiple','source_id_name_mismatch',
    'ambiguous_source_name','ambiguous_system_name','missing_source_id','missing_identity','not_found'
  )),
  primary key (projection_run_id, entity_type, source_key),
  check ((source_id_present and source_native_id is not null) or (not source_id_present)),
  check (
    (match_status = 'matched' and matched_entity_id is not null and match_strategy is not null and conflict_type is null)
    or (match_status = 'source_only' and matched_entity_id is null and match_strategy = 'source_only')
    or (match_status in ('unmatched','conflict') and matched_entity_id is null and match_strategy is null and conflict_type is not null)
  )
);
alter table internal.jiaowubao_authority_projection_entities enable row level security;
revoke all on table internal.jiaowubao_authority_projection_entities from public, anon, authenticated;
create index if not exists jiaowubao_authority_entities_match_idx
  on internal.jiaowubao_authority_projection_entities (projection_run_id, entity_type, match_status);
create index if not exists jiaowubao_authority_entities_native_id_idx
  on internal.jiaowubao_authority_projection_entities (projection_run_id, entity_type, source_native_id)
  where source_native_id is not null;

create table if not exists internal.jiaowubao_authority_current (
  api_source_key text primary key check (api_source_key = 'jwb-open-api-schedule'),
  projection_run_id uuid not null references internal.jiaowubao_authority_projection_runs(id) on delete restrict,
  snapshot_revision text not null check (snapshot_revision ~ '^sha256:[a-f0-9]{64}$'),
  checked_at timestamptz not null
);
alter table internal.jiaowubao_authority_current enable row level security;
revoke all on table internal.jiaowubao_authority_current from public, anon, authenticated;

create or replace function internal.guard_jiaowubao_authority_projection_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'jiaowubao_authority_projection_runs'
     and tg_op = 'UPDATE'
     and old.summary = '{}'::jsonb
     and new.summary <> '{}'::jsonb
     and (to_jsonb(new) - 'summary') = (to_jsonb(old) - 'summary') then
    return new;
  end if;
  if tg_table_name = 'jiaowubao_authority_projection_entities'
     and tg_op = 'UPDATE'
     and exists (
       select 1
       from internal.jiaowubao_authority_projection_runs projection_run
       where projection_run.id = old.projection_run_id
         and projection_run.summary = '{}'::jsonb
     )
     and (to_jsonb(new) - array['match_status','match_strategy','matched_entity_id','conflict_type']::text[])
       = (to_jsonb(old) - array['match_status','match_strategy','matched_entity_id','conflict_type']::text[]) then
    return new;
  end if;
  raise exception using errcode = '55000', message = 'jiaowubao_authority_projection_immutable';
end;
$$;
revoke all on function internal.guard_jiaowubao_authority_projection_immutable() from public, anon, authenticated;

drop trigger if exists guard_jiaowubao_authority_projection_runs_immutable on internal.jiaowubao_authority_projection_runs;
create trigger guard_jiaowubao_authority_projection_runs_immutable
before update or delete on internal.jiaowubao_authority_projection_runs
for each row execute function internal.guard_jiaowubao_authority_projection_immutable();

drop trigger if exists guard_jiaowubao_authority_projection_entities_immutable on internal.jiaowubao_authority_projection_entities;
create trigger guard_jiaowubao_authority_projection_entities_immutable
before update or delete on internal.jiaowubao_authority_projection_entities
for each row execute function internal.guard_jiaowubao_authority_projection_immutable();

create or replace function internal.jiaowubao_authority_source_key(
  p_entity_type text,
  p_native_id text,
  p_fallback text
)
returns text language sql immutable set search_path = '' as $$
  select 'sha256:' || encode(extensions.digest(
    pg_catalog.convert_to(
      coalesce(p_entity_type, '') || E'\x1f' || coalesce(nullif(btrim(p_native_id), ''), p_fallback, ''),
      'UTF8'
    ),
    'sha256'
  ), 'hex')
$$;
revoke all on function internal.jiaowubao_authority_source_key(text,text,text) from public, anon, authenticated;

create or replace function internal.jiaowubao_authority_schedule_time_valid(p_record jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  source_date text := nullif(btrim(p_record ->> 'dated'), '');
  start_text text := nullif(btrim(p_record ->> 'time_start'), '');
  end_text text := nullif(btrim(p_record ->> 'time_end'), '');
  start_minutes integer;
  end_minutes integer;
begin
  if source_date !~ '^\d{4}-\d{2}-\d{2}$'
     or start_text !~ '^\d{2}:\d{2}$'
     or end_text !~ '^\d{2}:\d{2}$' then
    return false;
  end if;
  begin
    if to_char(source_date::date, 'YYYY-MM-DD') <> source_date then return false; end if;
  exception when others then
    return false;
  end;
  if substring(start_text from 1 for 2)::integer not between 0 and 23
     or substring(end_text from 1 for 2)::integer not between 0 and 23
     or substring(start_text from 4 for 2)::integer not between 0 and 59
     or substring(end_text from 4 for 2)::integer not between 0 and 59 then
    return false;
  end if;
  start_minutes := substring(start_text from 1 for 2)::integer * 60
    + substring(start_text from 4 for 2)::integer;
  end_minutes := substring(end_text from 1 for 2)::integer * 60
    + substring(end_text from 4 for 2)::integer;
  return end_minutes > start_minutes;
exception when others then
  return false;
end;
$$;
revoke all on function internal.jiaowubao_authority_schedule_time_valid(jsonb) from public, anon, authenticated;

create or replace function public.project_jiaowubao_open_api_authority(
  p_secret text,
  p_revision text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $project_jiaowubao_open_api_authority$
declare
  current_row internal.jiaowubao_open_api_schedule_snapshot_current%rowtype;
  snapshot_run internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype;
  prior_projection internal.jiaowubao_authority_projection_runs%rowtype;
  projection_id uuid := gen_random_uuid();
  checked_at timestamptz := clock_timestamp();
  audit_id uuid;
  entity_counts jsonb;
  match_counts jsonb;
  anomaly_counts jsonb;
  price_counts jsonb;
  field_coverage jsonb;
  coverage jsonb;
  summary_value jsonb;
  native_state_versions_value jsonb;
  native_state_payloads_value jsonb;
  native_state_sha256_value text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_actor <> 'Ops Admin' or p_revision !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'jiaowubao_authority_projection_forbidden';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('jiaowubao-authority-projection:jwb-open-api-schedule', 0)
  );
  select * into current_row
  from internal.jiaowubao_open_api_schedule_snapshot_current current_snapshot
  where current_snapshot.api_source_key = 'jwb-open-api-schedule'
  for update;
  if not found or current_row.revision is distinct from p_revision then
    raise exception using errcode = '40001', message = 'jiaowubao_authority_snapshot_revision_changed';
  end if;
  select * into snapshot_run
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs source_run
  where source_run.id = current_row.run_id
    and source_run.state = 'complete'
    and source_run.revision = p_revision
    and source_run.api_source_key = current_row.api_source_key;
  if not found then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_snapshot_invalid';
  end if;

  -- Matching depends on four native collections as well as the immutable
  -- supplier snapshot. Capture all four payloads and versions in one statement
  -- snapshot. The projection remains internally consistent without holding
  -- locks that would block normal operational writes.
  with expected_state(entity) as (
    values ('students'::text), ('teachers'::text), ('courses'::text), ('bookings'::text)
  )
  select
    jsonb_object_agg(expected_state.entity, coalesce(native_state.version, 0) order by expected_state.entity),
    jsonb_object_agg(expected_state.entity, case when jsonb_typeof(native_state.payload) = 'array'
      then native_state.payload else '[]'::jsonb end order by expected_state.entity)
  into native_state_versions_value, native_state_payloads_value
  from expected_state
  left join public.ops_state native_state on native_state.entity = expected_state.entity;
  native_state_sha256_value := 'sha256:' || encode(extensions.digest(
    pg_catalog.convert_to(native_state_versions_value::text, 'UTF8'),
    'sha256'
  ), 'hex');

  select * into prior_projection
  from internal.jiaowubao_authority_projection_runs projection_run
  where projection_run.snapshot_run_id = current_row.run_id
    and projection_run.native_state_sha256 = native_state_sha256_value;
  if found then
    summary_value := prior_projection.summary || jsonb_build_object(
      'checkedAt', checked_at,
      'snapshotPublishedAt', current_row.published_at,
      'replayed', true
    );
    insert into internal.jiaowubao_authority_current(api_source_key, projection_run_id, snapshot_revision, checked_at)
    values (current_row.api_source_key, prior_projection.id, p_revision, checked_at)
    on conflict (api_source_key) do update set
      projection_run_id = excluded.projection_run_id,
      snapshot_revision = excluded.snapshot_revision,
      checked_at = excluded.checked_at;
    insert into public.ops_source_snapshots(
      source_id, title, source_type, url, modified_at, synced_at, row_count, status, payload
    ) values (
      'jiaowubao-open-api-schedule', '教务宝 Open API', 'authoritative_api', null,
      snapshot_run.completed_at, checked_at, snapshot_run.expected_row_count, 'synced', summary_value - 'replayed'
    ) on conflict (source_id) do update set
      title = excluded.title,
      source_type = excluded.source_type,
      url = excluded.url,
      modified_at = excluded.modified_at,
      synced_at = excluded.synced_at,
      row_count = excluded.row_count,
      status = excluded.status,
      payload = excluded.payload;
    return summary_value;
  end if;

  -- The run row is inserted first so every normalized entity has an immutable
  -- parent. The transaction rolls back the row if any projection check fails.
  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_authority_projection.completed', p_actor,
    'jiaowubao_authority_projection_run', projection_id::text,
    jsonb_build_object(
      'snapshotRevision', p_revision,
      'snapshotRunId', current_row.run_id,
      'nativeStateRevision', native_state_sha256_value
    )
  );
  insert into internal.jiaowubao_authority_projection_runs(
    id, api_source_key, snapshot_run_id, snapshot_revision,
    native_state_versions, native_state_sha256, source_window,
    projected_at, projected_by, summary, audit_id
  ) values (
    projection_id, current_row.api_source_key, current_row.run_id, p_revision,
    native_state_versions_value, native_state_sha256_value,
    jsonb_build_object('start', snapshot_run.query ->> 'start', 'end', snapshot_run.query ->> 'end'),
    checked_at, p_actor, '{}'::jsonb, audit_id
  );

  insert into internal.jiaowubao_authority_projection_entities(
    projection_run_id, entity_type, source_key, source_native_id, source_id_present,
    identity_label, identity_key, payload, evidence_count, identity_variant_count,
    match_status, conflict_type
  )
  select projection_id, 'schedule',
    internal.jiaowubao_authority_source_key('schedule', item_row.item -> 'record' ->> 'cal_id', item_row.source_key),
    item_row.item -> 'record' ->> 'cal_id', true,
    nullif(btrim(item_row.item -> 'record' ->> 'course_title'), ''),
    internal.student_import_name_key(item_row.item -> 'record' ->> 'course_title'),
    item_row.item -> 'record', 1, 1, 'unmatched', 'not_found'
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_items item_row
  where item_row.run_id = current_row.run_id;

  with observations as materialized (
    select
      internal.jiaowubao_authority_source_key(
        'student',
        nullif(btrim(student_value.value ->> 'mem_id'), ''),
        'missing:' || (item_row.item -> 'record' ->> 'cal_id') || ':' || student_value.ordinality::text
      ) as source_key,
      nullif(btrim(student_value.value ->> 'mem_id'), '') as source_native_id,
      nullif(btrim(student_value.value ->> 'name'), '') as identity_label,
      internal.student_import_name_key(student_value.value ->> 'name') as identity_key,
      student_value.value as payload,
      coalesce(item_row.item -> 'record' ->> 'dated', '') as source_date,
      coalesce(item_row.item -> 'record' ->> 'time_start', '') as source_time,
      item_row.source_key as event_key,
      student_value.ordinality
    from internal.jiaowubao_open_api_schedule_snapshot_ingest_items item_row
    cross join lateral jsonb_array_elements(case
      when jsonb_typeof(item_row.item -> 'record' -> 'stu_list') = 'array'
      then item_row.item -> 'record' -> 'stu_list' else '[]'::jsonb
    end) with ordinality student_value(value, ordinality)
    where item_row.run_id = current_row.run_id
  ), grouped as materialized (
    select source_key, max(source_native_id) as source_native_id,
      (jsonb_agg(payload order by (identity_key <> '') desc, source_date desc, source_time desc, event_key desc, ordinality desc) -> 0) as latest_payload,
      count(*)::integer as evidence_count,
      (count(distinct identity_key) filter (where identity_key <> ''))::integer as identity_variant_count
    from observations
    group by source_key
  )
  insert into internal.jiaowubao_authority_projection_entities(
    projection_run_id, entity_type, source_key, source_native_id, source_id_present,
    identity_label, identity_key, payload, evidence_count, identity_variant_count,
    match_status, conflict_type
  )
  select projection_id, 'student', grouped.source_key, grouped.source_native_id,
    grouped.source_native_id is not null,
    nullif(btrim(grouped.latest_payload ->> 'name'), ''),
    internal.student_import_name_key(grouped.latest_payload ->> 'name'),
    grouped.latest_payload, grouped.evidence_count, grouped.identity_variant_count,
    'unmatched', case when grouped.source_native_id is null then 'missing_source_id' else 'not_found' end
  from grouped;

  with observations as materialized (
    select
      internal.jiaowubao_authority_source_key(
        'teacher', teacher_value.source_native_id,
        'name:' || internal.student_import_name_key(teacher_value.identity_label)
      ) as source_key,
      teacher_value.source_native_id,
      teacher_value.identity_label,
      internal.student_import_name_key(teacher_value.identity_label) as identity_key,
      jsonb_strip_nulls(jsonb_build_object(
        'teacher_id', teacher_value.source_native_id,
        'teacher_title', teacher_value.identity_label,
        'role', teacher_value.teacher_role,
        'teacher_hour', teacher_value.teacher_hour
      )) as payload,
      coalesce(item_row.item -> 'record' ->> 'dated', '') as source_date,
      coalesce(item_row.item -> 'record' ->> 'time_start', '') as source_time,
      item_row.source_key as event_key
    from internal.jiaowubao_open_api_schedule_snapshot_ingest_items item_row
    cross join lateral (
      values
        ('primary'::text, nullif(btrim(item_row.item -> 'record' ->> 'teacher_id'), ''), nullif(btrim(item_row.item -> 'record' ->> 'teacher_title'), ''), item_row.item -> 'record' -> 'teacher_hour'),
        ('assistant_s'::text, nullif(btrim(item_row.item -> 'record' ->> 'teacher_s'), ''), nullif(btrim(item_row.item -> 'record' ->> 'teacher_s_title'), ''), item_row.item -> 'record' -> 'teacher_s_hour'),
        ('assistant_t'::text, nullif(btrim(item_row.item -> 'record' ->> 'teacher_t'), ''), nullif(btrim(item_row.item -> 'record' ->> 'teacher_t_title'), ''), item_row.item -> 'record' -> 'teacher_t_hour')
    ) teacher_value(teacher_role, source_native_id, identity_label, teacher_hour)
    where item_row.run_id = current_row.run_id
      and (teacher_value.source_native_id is not null or teacher_value.identity_label is not null)
  ), grouped as materialized (
    select source_key, max(source_native_id) as source_native_id,
      (jsonb_agg(payload order by (identity_key <> '') desc, source_date desc, source_time desc, event_key desc) -> 0) as latest_payload,
      count(*)::integer as evidence_count,
      (count(distinct identity_key) filter (where identity_key <> ''))::integer as identity_variant_count
    from observations
    group by source_key
  )
  insert into internal.jiaowubao_authority_projection_entities(
    projection_run_id, entity_type, source_key, source_native_id, source_id_present,
    identity_label, identity_key, payload, evidence_count, identity_variant_count,
    match_status, conflict_type
  )
  select projection_id, 'teacher', grouped.source_key, grouped.source_native_id,
    grouped.source_native_id is not null,
    nullif(btrim(grouped.latest_payload ->> 'teacher_title'), ''),
    internal.student_import_name_key(grouped.latest_payload ->> 'teacher_title'),
    grouped.latest_payload, grouped.evidence_count, grouped.identity_variant_count,
    'unmatched', case when internal.student_import_name_key(grouped.latest_payload ->> 'teacher_title') = ''
      then 'missing_identity' else 'not_found' end
  from grouped;

  with observations as materialized (
    select dimension.entity_type,
      internal.jiaowubao_authority_source_key(
        dimension.entity_type, dimension.source_native_id,
        'name:' || internal.student_import_name_key(dimension.identity_label)
      ) as source_key,
      dimension.source_native_id,
      dimension.identity_label,
      internal.student_import_name_key(dimension.identity_label) as identity_key,
      jsonb_strip_nulls(jsonb_build_object(
        'source_id', dimension.source_native_id,
        'title', dimension.identity_label
      )) as payload,
      coalesce(item_row.item -> 'record' ->> 'dated', '') as source_date,
      coalesce(item_row.item -> 'record' ->> 'time_start', '') as source_time,
      item_row.source_key as event_key
    from internal.jiaowubao_open_api_schedule_snapshot_ingest_items item_row
    cross join lateral (
      values
        ('course'::text, nullif(btrim(item_row.item -> 'record' ->> 'course_id'), ''), nullif(btrim(item_row.item -> 'record' ->> 'course_title'), '')),
        ('class'::text, nullif(btrim(item_row.item -> 'record' ->> 'team_id'), ''), nullif(btrim(item_row.item -> 'record' ->> 'team_title'), '')),
        ('room'::text, nullif(btrim(item_row.item -> 'record' ->> 'room_id'), ''), nullif(btrim(item_row.item -> 'record' ->> 'room_title'), ''))
    ) dimension(entity_type, source_native_id, identity_label)
    where item_row.run_id = current_row.run_id
      and (dimension.source_native_id is not null or dimension.identity_label is not null)
  ), grouped as materialized (
    select entity_type, source_key, max(source_native_id) as source_native_id,
      (jsonb_agg(payload order by (identity_key <> '') desc, source_date desc, source_time desc, event_key desc) -> 0) as latest_payload,
      count(*)::integer as evidence_count,
      (count(distinct identity_key) filter (where identity_key <> ''))::integer as identity_variant_count
    from observations
    group by entity_type, source_key
  )
  insert into internal.jiaowubao_authority_projection_entities(
    projection_run_id, entity_type, source_key, source_native_id, source_id_present,
    identity_label, identity_key, payload, evidence_count, identity_variant_count,
    match_status, match_strategy, conflict_type
  )
  select projection_id, grouped.entity_type, grouped.source_key, grouped.source_native_id,
    grouped.source_native_id is not null,
    nullif(btrim(grouped.latest_payload ->> 'title'), ''),
    internal.student_import_name_key(grouped.latest_payload ->> 'title'),
    grouped.latest_payload, grouped.evidence_count, grouped.identity_variant_count,
    case when grouped.entity_type in ('class','room') then 'source_only' else 'unmatched' end,
    case when grouped.entity_type in ('class','room') then 'source_only' else null end,
    case when grouped.entity_type in ('class','room') then null
      when internal.student_import_name_key(grouped.latest_payload ->> 'title') = '' then 'missing_identity'
      else 'not_found' end
  from grouped;

  -- Match students by their stable Jiaowubao member ID first. Exact unique
  -- names are a fallback only when both source and system are unambiguous.
  with system_students as materialized (
    select student_value.value ->> 'id' as entity_id,
      internal.student_import_name_key(student_value.value ->> 'name') as name_key,
      coalesce(
        nullif(internal.student_import_source_key(student_value.value -> 'jwbSourceRow'), ''),
        nullif(internal.student_import_source_key(student_value.value #> '{historicalJwbSnapshot,currentAggregate,jwbSourceRow}'), ''),
        nullif(internal.student_import_source_key(student_value.value #> '{historicalJwbSnapshot,retained,jwbSourceRow}'), '')
      ) as jwb_member_id
    from jsonb_array_elements(native_state_payloads_value -> 'students') student_value(value)
    where nullif(btrim(student_value.value ->> 'id'), '') is not null
  ), stats as materialized (
    select source_entity.source_key,
      (select count(*)::integer from system_students system_student
        where system_student.jwb_member_id = source_entity.source_native_id) as source_id_match_count,
      (select min(system_student.entity_id) from system_students system_student
        where system_student.jwb_member_id = source_entity.source_native_id) as source_id_entity_id,
      (select min(system_student.name_key) from system_students system_student
        where system_student.jwb_member_id = source_entity.source_native_id) as source_id_name_key,
      (select count(*)::integer from internal.jiaowubao_authority_projection_entities peer
        where peer.projection_run_id = projection_id and peer.entity_type = 'student'
          and peer.identity_key <> '' and peer.identity_key = source_entity.identity_key) as source_name_count,
      (select count(*)::integer from system_students system_student
        where system_student.name_key <> '' and system_student.name_key = source_entity.identity_key) as system_name_count,
      (select min(system_student.entity_id) from system_students system_student
        where system_student.name_key <> '' and system_student.name_key = source_entity.identity_key) as name_entity_id
    from internal.jiaowubao_authority_projection_entities source_entity
    where source_entity.projection_run_id = projection_id and source_entity.entity_type = 'student'
  )
  update internal.jiaowubao_authority_projection_entities source_entity
  set match_status = case
      when not source_entity.source_id_present then 'unmatched'
      when source_entity.identity_variant_count > 1 then 'conflict'
      when stats.source_id_match_count > 1 then 'conflict'
      when stats.source_id_match_count = 1 and source_entity.identity_key <> ''
        and stats.source_id_name_key <> '' and stats.source_id_name_key <> source_entity.identity_key then 'conflict'
      when stats.source_id_match_count = 1 then 'matched'
      when source_entity.identity_key = '' then 'unmatched'
      when stats.source_name_count > 1 then 'conflict'
      when stats.system_name_count > 1 then 'conflict'
      when stats.source_name_count = 1 and stats.system_name_count = 1 then 'matched'
      else 'unmatched' end,
    match_strategy = case
      when stats.source_id_match_count = 1
        and not (source_entity.identity_key <> '' and stats.source_id_name_key <> ''
          and stats.source_id_name_key <> source_entity.identity_key)
        and source_entity.identity_variant_count <= 1 then 'source_id'
      when stats.source_id_match_count = 0 and source_entity.source_id_present
        and source_entity.identity_variant_count <= 1 and source_entity.identity_key <> ''
        and stats.source_name_count = 1 and stats.system_name_count = 1 then 'unique_name'
      else null end,
    matched_entity_id = case
      when stats.source_id_match_count = 1
        and not (source_entity.identity_key <> '' and stats.source_id_name_key <> ''
          and stats.source_id_name_key <> source_entity.identity_key)
        and source_entity.identity_variant_count <= 1 then stats.source_id_entity_id
      when stats.source_id_match_count = 0 and source_entity.source_id_present
        and source_entity.identity_variant_count <= 1 and source_entity.identity_key <> ''
        and stats.source_name_count = 1 and stats.system_name_count = 1 then stats.name_entity_id
      else null end,
    conflict_type = case
      when not source_entity.source_id_present then 'missing_source_id'
      when source_entity.identity_variant_count > 1 then 'source_identity_conflict'
      when stats.source_id_match_count > 1 then 'source_id_matches_multiple'
      when stats.source_id_match_count = 1 and source_entity.identity_key <> ''
        and stats.source_id_name_key <> '' and stats.source_id_name_key <> source_entity.identity_key then 'source_id_name_mismatch'
      when stats.source_id_match_count = 1 then null
      when source_entity.identity_key = '' then 'missing_identity'
      when stats.source_name_count > 1 then 'ambiguous_source_name'
      when stats.system_name_count > 1 then 'ambiguous_system_name'
      when stats.source_name_count = 1 and stats.system_name_count = 1 then null
      else 'not_found' end
  from stats
  where source_entity.projection_run_id = projection_id
    and source_entity.entity_type = 'student'
    and source_entity.source_key = stats.source_key;

  -- Teacher and course IDs are not currently present in the native models, so
  -- only exact unique full-name matches are accepted.
  with target_types(entity_type, state_entity) as (
    values ('teacher'::text, 'teachers'::text), ('course'::text, 'courses'::text)
  ), system_entities as materialized (
    select target.entity_type, item_value.value ->> 'id' as entity_id,
      internal.student_import_name_key(item_value.value ->> 'name') as name_key
    from target_types target
    cross join lateral jsonb_array_elements(native_state_payloads_value -> target.state_entity) item_value(value)
    where nullif(btrim(item_value.value ->> 'id'), '') is not null
  ), stats as materialized (
    select source_entity.entity_type, source_entity.source_key,
      (select count(*)::integer from internal.jiaowubao_authority_projection_entities peer
        where peer.projection_run_id = projection_id and peer.entity_type = source_entity.entity_type
          and peer.identity_key <> '' and peer.identity_key = source_entity.identity_key) as source_name_count,
      (select count(*)::integer from system_entities system_entity
        where system_entity.entity_type = source_entity.entity_type
          and system_entity.name_key <> '' and system_entity.name_key = source_entity.identity_key) as system_name_count,
      (select min(system_entity.entity_id) from system_entities system_entity
        where system_entity.entity_type = source_entity.entity_type
          and system_entity.name_key <> '' and system_entity.name_key = source_entity.identity_key) as name_entity_id
    from internal.jiaowubao_authority_projection_entities source_entity
    where source_entity.projection_run_id = projection_id
      and source_entity.entity_type in ('teacher','course')
  )
  update internal.jiaowubao_authority_projection_entities source_entity
  set match_status = case
      when source_entity.identity_variant_count > 1 then 'conflict'
      when source_entity.identity_key = '' then 'unmatched'
      when stats.source_name_count > 1 then 'conflict'
      when stats.system_name_count > 1 then 'conflict'
      when stats.source_name_count = 1 and stats.system_name_count = 1 then 'matched'
      else 'unmatched' end,
    match_strategy = case when source_entity.identity_variant_count <= 1
      and source_entity.identity_key <> '' and stats.source_name_count = 1 and stats.system_name_count = 1
      then 'unique_name' else null end,
    matched_entity_id = case when source_entity.identity_variant_count <= 1
      and source_entity.identity_key <> '' and stats.source_name_count = 1 and stats.system_name_count = 1
      then stats.name_entity_id else null end,
    conflict_type = case
      when source_entity.identity_variant_count > 1 then 'source_identity_conflict'
      when source_entity.identity_key = '' then 'missing_identity'
      when stats.source_name_count > 1 then 'ambiguous_source_name'
      when stats.system_name_count > 1 then 'ambiguous_system_name'
      when stats.source_name_count = 1 and stats.system_name_count = 1 then null
      else 'not_found' end
  from stats
  where source_entity.projection_run_id = projection_id
    and source_entity.entity_type = stats.entity_type
    and source_entity.source_key = stats.source_key;

  with system_bookings as materialized (
    select booking_value.value ->> 'id' as entity_id,
      nullif(btrim(booking_value.value ->> 'sourceLessonId'), '') as source_lesson_id
    from jsonb_array_elements(native_state_payloads_value -> 'bookings') booking_value(value)
    where nullif(btrim(booking_value.value ->> 'id'), '') is not null
  ), stats as materialized (
    select source_entity.source_key,
      (select count(*)::integer from system_bookings system_booking
        where system_booking.source_lesson_id in (
          source_entity.source_native_id,
          'jwb-open-api:schedule:' || source_entity.source_native_id
        )) as match_count,
      (select min(system_booking.entity_id) from system_bookings system_booking
        where system_booking.source_lesson_id in (
          source_entity.source_native_id,
          'jwb-open-api:schedule:' || source_entity.source_native_id
        )) as entity_id
    from internal.jiaowubao_authority_projection_entities source_entity
    where source_entity.projection_run_id = projection_id and source_entity.entity_type = 'schedule'
  )
  update internal.jiaowubao_authority_projection_entities source_entity
  set match_status = case when stats.match_count = 1 then 'matched'
      when stats.match_count > 1 then 'conflict' else 'unmatched' end,
    match_strategy = case when stats.match_count = 1 then 'source_id' else null end,
    matched_entity_id = case when stats.match_count = 1 then stats.entity_id else null end,
    conflict_type = case when stats.match_count > 1 then 'source_id_matches_multiple'
      when stats.match_count = 0 then 'not_found' else null end
  from stats
  where source_entity.projection_run_id = projection_id
    and source_entity.entity_type = 'schedule'
    and source_entity.source_key = stats.source_key;

  with entity_types(entity_type) as (
    values ('schedule'::text), ('student'::text), ('teacher'::text),
      ('course'::text), ('class'::text), ('room'::text)
  ), aggregate_counts as (
    select entity_type.entity_type,
      count(source_entity.source_key)::integer as total,
      (count(*) filter (where source_entity.match_status = 'matched'))::integer as matched,
      (count(*) filter (where source_entity.match_status = 'unmatched'))::integer as unmatched,
      (count(*) filter (where source_entity.match_status = 'conflict'))::integer as conflict,
      (count(*) filter (where source_entity.match_status = 'source_only'))::integer as source_only
    from entity_types entity_type
    left join internal.jiaowubao_authority_projection_entities source_entity
      on source_entity.projection_run_id = projection_id
      and source_entity.entity_type = entity_type.entity_type
    group by entity_type.entity_type
  )
  select jsonb_object_agg(entity_type, total order by entity_type),
    jsonb_object_agg(entity_type, jsonb_build_object(
      'total', total,
      'matched', matched,
      'unmatched', unmatched,
      'conflict', conflict,
      'sourceOnly', source_only,
      'matchRate', case when total = 0 then 0 else round(matched * 100.0 / total, 2) end
    ) order by entity_type)
  into entity_counts, match_counts
  from aggregate_counts;

  -- Missing or duplicate cal_id values are rejected before a snapshot can
  -- become complete, so a successfully published revision proves both are 0.
  select jsonb_build_object(
    'duplicateScheduleIds', 0,
    'missingScheduleIds', 0,
    'invalidTimeRecords', count(*) filter (
      where source_entity.entity_type = 'schedule'
        and not internal.jiaowubao_authority_schedule_time_valid(source_entity.payload)
    ),
    'missingStudentIds', count(*) filter (
      where source_entity.entity_type = 'student' and not source_entity.source_id_present
    ),
    'missingTeacherIds', count(*) filter (
      where source_entity.entity_type = 'teacher' and not source_entity.source_id_present
    ),
    'missingCourseIds', count(*) filter (
      where source_entity.entity_type = 'course' and not source_entity.source_id_present
    ),
    'identityConflicts', count(*) filter (where source_entity.match_status = 'conflict'),
    'identityVariantConflicts', coalesce(sum(greatest(source_entity.identity_variant_count - 1, 0)), 0)
  ) into anomaly_counts
  from internal.jiaowubao_authority_projection_entities source_entity
  where source_entity.projection_run_id = projection_id;

  with schedule_records as materialized (
    select item_row.item -> 'record' as record
    from internal.jiaowubao_open_api_schedule_snapshot_ingest_items item_row
    where item_row.run_id = current_row.run_id
  ), student_records as materialized (
    select student_value.value as record
    from schedule_records schedule_record
    cross join lateral jsonb_array_elements(case when jsonb_typeof(schedule_record.record -> 'stu_list') = 'array'
      then schedule_record.record -> 'stu_list' else '[]'::jsonb end) student_value(value)
  )
  select jsonb_build_object(
      'present', exists(select 1 from schedule_records where record ? 'price_mem')
        or exists(select 1 from student_records where record ? 'price'),
      'schedulePriceRecords', (select count(*)::integer from schedule_records where record ? 'price_mem'),
      'studentPriceRecords', (select count(*)::integer from student_records where record ? 'price'),
      'persistedPrivately', true,
      'browserExposed', false
    ),
    jsonb_build_object(
      'topLevelFields', coalesce((select jsonb_agg(field_name order by field_name) from (
        select distinct field.key as field_name
        from schedule_records schedule_record
        cross join lateral jsonb_object_keys(schedule_record.record) field(key)
      ) top_fields), '[]'::jsonb),
      'studentFields', coalesce((select jsonb_agg(field_name order by field_name) from (
        select distinct field.key as field_name
        from student_records student_record
        cross join lateral jsonb_object_keys(student_record.record) field(key)
      ) student_fields), '[]'::jsonb)
    )
  into price_counts, field_coverage;

  select jsonb_build_object(
    'snapshotRows', snapshot_run.expected_row_count,
    'normalizedEntityRows', count(*),
    'matchedEntityRows', count(*) filter (where match_status = 'matched'),
    'sourceOnlyEntityRows', count(*) filter (where match_status <> 'matched'),
    'sourceSnapshotPersisted', true,
    'normalizedProjectionPersisted', true,
    'nativeRecordsOverwritten', false,
    'connectedTools', jsonb_build_array('query_schedule_list')
  ) into coverage
  from internal.jiaowubao_authority_projection_entities
  where projection_run_id = projection_id;

  summary_value := jsonb_build_object(
    'schemaVersion', 1,
    'authorityMode', 'one_of_multiple',
    'source', 'jiaowubao-open-api',
    'tool', 'query_schedule_list',
    'projectionRunId', projection_id,
    'snapshotRevision', p_revision,
    'snapshotRunId', current_row.run_id,
    'nativeStateRevision', native_state_sha256_value,
    'snapshotPublishedAt', current_row.published_at,
    'snapshotChangedAt', snapshot_run.completed_at,
    'projectedAt', checked_at,
    'checkedAt', checked_at,
    'cadenceMinutes', 30,
    'sourceWindow', jsonb_build_object('start', snapshot_run.query ->> 'start', 'end', snapshot_run.query ->> 'end'),
    'entityCounts', entity_counts,
    'matches', match_counts,
    'anomalies', anomaly_counts,
    'prices', price_counts,
    'fields', field_coverage,
    'coverage', coverage
  );

  update internal.jiaowubao_authority_projection_runs
  set summary = summary_value
  where id = projection_id;

  insert into internal.jiaowubao_authority_current(api_source_key, projection_run_id, snapshot_revision, checked_at)
  values (current_row.api_source_key, projection_id, p_revision, checked_at)
  on conflict (api_source_key) do update set
    projection_run_id = excluded.projection_run_id,
    snapshot_revision = excluded.snapshot_revision,
    checked_at = excluded.checked_at;

  insert into public.ops_source_snapshots(
    source_id, title, source_type, url, modified_at, synced_at, row_count, status, payload
  ) values (
    'jiaowubao-open-api-schedule', '教务宝 Open API', 'authoritative_api', null,
    snapshot_run.completed_at, checked_at, snapshot_run.expected_row_count, 'synced', summary_value
  ) on conflict (source_id) do update set
    title = excluded.title,
    source_type = excluded.source_type,
    url = excluded.url,
    modified_at = excluded.modified_at,
    synced_at = excluded.synced_at,
    row_count = excluded.row_count,
    status = excluded.status,
    payload = excluded.payload;

  return summary_value || jsonb_build_object('replayed', false);
end;
$project_jiaowubao_open_api_authority$;

revoke all on function public.project_jiaowubao_open_api_authority(text,text,text) from public, anon, authenticated;
grant execute on function public.project_jiaowubao_open_api_authority(text,text,text) to anon, authenticated;

comment on table internal.jiaowubao_authority_projection_entities is
  'Immutable normalized Jiaowubao authority entities with provenance-safe matches to native records; raw complete fields remain in the immutable source snapshot.';
comment on function public.project_jiaowubao_open_api_authority(text,text,text) is
  'Secret-gated idempotent projection of the current complete Jiaowubao Open API schedule snapshot; updates aggregate source health without overwriting another authority.';
