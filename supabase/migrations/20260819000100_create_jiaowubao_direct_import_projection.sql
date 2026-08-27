-- Server-only, one-off projection for the seven Jiaowubao Excel exports.
--
-- This is intentionally separate from the browser uploader retired in 013:
-- a local importer writes these internal tables in one transaction, then
-- completes an immutable run.  Tencent remains the authority for formal
-- student existence.  A Jiaowubao row can therefore only retain an evidence
-- link to a current, non-excluded Tencent source row; it never creates or
-- replaces a formal student.  Schedule rows are class events, not per-student
-- operational bookings, and leave/makeup rows are display-only evidence.
--
-- The source files contain no timezone column.  Their source wall-clock
-- timezone is the approved IANA zone Australia/Melbourne.  The local importer
-- must reject nonexistent and ambiguous DST wall clocks before it inserts a
-- parsed interval, and preserve both the wall-clock fields and the instant.
-- There is deliberately no public writer or browser upload RPC in this
-- migration.  Future server reads can expose a reviewed, secret-gated reader
-- over the internal current-block view below without broadening write access.
--
-- Trust boundary: PostgreSQL preserves and reconciles the manifest/chunk/raw
-- evidence it receives, but it cannot itself reopen a local XLSX file to
-- attest that a supplied sourceDigest or workbook hash came from that file.
-- Only the reviewed local preflight/CLI may construct this internal contract;
-- the schema is not a browser or untrusted-client provenance verifier.

set local lock_timeout = '1s';

create table if not exists internal.jiaowubao_direct_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_id text not null default 'jiaowubao-static-excel'
    check (source_id = 'jiaowubao-static-excel'),
  revision text not null check (revision = btrim(revision) and char_length(revision) between 1 and 240),
  format text not null default 'jiaowubao-direct-import-v1'
    check (format = 'jiaowubao-direct-import-v1'),
  source_timezone text not null default 'Australia/Melbourne'
    check (source_timezone = 'Australia/Melbourne'),
  source_timezone_basis text not null
    check (source_timezone_basis = btrim(source_timezone_basis) and char_length(source_timezone_basis) between 1 and 1000),
  master_source_id text not null
    check (master_source_id = btrim(master_source_id) and char_length(master_source_id) between 1 and 160),
  master_revision text not null
    check (master_revision = btrim(master_revision) and char_length(master_revision) between 1 and 240),
  master_rows_sha256 text not null check (master_rows_sha256 ~ '^[a-f0-9]{64}$'),
  expected_chunk_count integer not null check (expected_chunk_count between 1 and 512),
  -- The immutable seven-kind record totals emitted by the local preflight.
  -- Every staged chunk repeats these totals, so the database can reject a
  -- chunk from a different artifact even when its revision text looks valid.
  source_record_counts jsonb not null check (
    jsonb_typeof(source_record_counts) = 'object'
    and source_record_counts ?& ARRAY[
      'student_snapshot', 'quick_list', 'contract_history', 'hour_balance',
      'class_membership', 'schedule_event', 'leave_makeup'
    ]
    and source_record_counts - ARRAY[
      'student_snapshot', 'quick_list', 'contract_history', 'hour_balance',
      'class_membership', 'schedule_event', 'leave_makeup'
    ]::text[] = '{}'::jsonb
    and jsonb_typeof(source_record_counts -> 'student_snapshot') = 'number'
    and jsonb_typeof(source_record_counts -> 'quick_list') = 'number'
    and jsonb_typeof(source_record_counts -> 'contract_history') = 'number'
    and jsonb_typeof(source_record_counts -> 'hour_balance') = 'number'
    and jsonb_typeof(source_record_counts -> 'class_membership') = 'number'
    and jsonb_typeof(source_record_counts -> 'schedule_event') = 'number'
    and jsonb_typeof(source_record_counts -> 'leave_makeup') = 'number'
    and (source_record_counts ->> 'student_snapshot')::numeric between 0 and 200000
    and (source_record_counts ->> 'quick_list')::numeric between 0 and 200000
    and (source_record_counts ->> 'contract_history')::numeric between 0 and 200000
    and (source_record_counts ->> 'hour_balance')::numeric between 0 and 200000
    and (source_record_counts ->> 'class_membership')::numeric between 0 and 200000
    and (source_record_counts ->> 'schedule_event')::numeric between 0 and 200000
    and (source_record_counts ->> 'leave_makeup')::numeric between 0 and 200000
    and (source_record_counts ->> 'student_snapshot')::numeric = trunc((source_record_counts ->> 'student_snapshot')::numeric)
    and (source_record_counts ->> 'quick_list')::numeric = trunc((source_record_counts ->> 'quick_list')::numeric)
    and (source_record_counts ->> 'contract_history')::numeric = trunc((source_record_counts ->> 'contract_history')::numeric)
    and (source_record_counts ->> 'hour_balance')::numeric = trunc((source_record_counts ->> 'hour_balance')::numeric)
    and (source_record_counts ->> 'class_membership')::numeric = trunc((source_record_counts ->> 'class_membership')::numeric)
    and (source_record_counts ->> 'schedule_event')::numeric = trunc((source_record_counts ->> 'schedule_event')::numeric)
    and (source_record_counts ->> 'leave_makeup')::numeric = trunc((source_record_counts ->> 'leave_makeup')::numeric)
  ),
  -- Exact reconciliation contract for a local one-off transaction.  A run
  -- cannot complete until all four persisted projections match these counts.
  expected_counts jsonb not null check (
    jsonb_typeof(expected_counts) = 'object'
    and expected_counts ?& ARRAY['supplementalRecords', 'scheduleEvents', 'scheduleParticipants', 'leaveMakeups']
    and expected_counts - ARRAY['supplementalRecords', 'scheduleEvents', 'scheduleParticipants', 'leaveMakeups']::text[] = '{}'::jsonb
    and jsonb_typeof(expected_counts -> 'supplementalRecords') = 'number'
    and jsonb_typeof(expected_counts -> 'scheduleEvents') = 'number'
    and jsonb_typeof(expected_counts -> 'scheduleParticipants') = 'number'
    and jsonb_typeof(expected_counts -> 'leaveMakeups') = 'number'
    and (expected_counts ->> 'supplementalRecords')::numeric between 0 and 200000
    and (expected_counts ->> 'scheduleEvents')::numeric between 0 and 200000
    and (expected_counts ->> 'scheduleParticipants')::numeric between 0 and 500000
    and (expected_counts ->> 'leaveMakeups')::numeric between 0 and 200000
    and (expected_counts ->> 'supplementalRecords')::numeric = trunc((expected_counts ->> 'supplementalRecords')::numeric)
    and (expected_counts ->> 'scheduleEvents')::numeric = trunc((expected_counts ->> 'scheduleEvents')::numeric)
    and (expected_counts ->> 'scheduleParticipants')::numeric = trunc((expected_counts ->> 'scheduleParticipants')::numeric)
    and (expected_counts ->> 'leaveMakeups')::numeric = trunc((expected_counts ->> 'leaveMakeups')::numeric)
  ),
  state text not null default 'staging' check (state in ('staging', 'complete')),
  -- SHA-256 over the local importer's canonical manifest plus sorted persisted
  -- record hashes.  It is an immutable audit fingerprint, not a source of
  -- authority for student identity.
  payload_sha256 text check (payload_sha256 is null or payload_sha256 ~ '^[a-f0-9]{64}$'),
  staged_by text not null check (staged_by = btrim(staged_by) and char_length(staged_by) between 1 and 120),
  staged_at timestamptz not null default now(),
  -- The initial internal command is audited too.  This prevents a completed
  -- projection from appearing without a traceable immutable staging boundary.
  staging_audit_id uuid not null references internal.operational_contract_audit(id),
  completed_at timestamptz,
  completion_audit_id uuid references internal.operational_contract_audit(id),
  unique (source_id, revision),
  check (
    (state = 'staging' and payload_sha256 is null and completed_at is null and completion_audit_id is null)
    or (state = 'complete' and payload_sha256 is not null and completed_at is not null and completion_audit_id is not null)
  )
);

alter table internal.jiaowubao_direct_import_runs enable row level security;
revoke all on table internal.jiaowubao_direct_import_runs from public, anon, authenticated;

create table if not exists internal.jiaowubao_direct_import_workbooks (
  run_id uuid not null references internal.jiaowubao_direct_import_runs(id) on delete restrict,
  workbook_kind text not null check (workbook_kind in (
    'quick_list', 'students', 'contracts', 'hours',
    'class_members', 'schedule', 'leave_makeups'
  )),
  workbook_name text not null
    check (workbook_name = btrim(workbook_name) and char_length(workbook_name) between 1 and 500),
  workbook_sha256 text not null check (workbook_sha256 ~ '^[a-f0-9]{64}$'),
  sheet_name text not null
    check (sheet_name = btrim(sheet_name) and char_length(sheet_name) between 1 and 500),
  row_count integer not null check (row_count between 0 and 1000000),
  primary key (run_id, workbook_kind)
);

alter table internal.jiaowubao_direct_import_workbooks enable row level security;
revoke all on table internal.jiaowubao_direct_import_workbooks from public, anon, authenticated;

-- A deterministic preflight chunk is stored once.  This makes the local
-- importer's staged evidence replay-safe while keeping raw rows in the
-- relational projections below rather than a browser-facing blob ledger.
create table if not exists internal.jiaowubao_direct_import_chunks (
  run_id uuid not null references internal.jiaowubao_direct_import_runs(id) on delete restrict,
  chunk_index integer not null check (chunk_index between 0 and 511),
  chunk_sha256 text not null check (chunk_sha256 ~ '^[a-f0-9]{64}$'),
  source_record_counts jsonb not null check (jsonb_typeof(source_record_counts) = 'object'),
  source_record_count integer not null check (source_record_count between 1 and 200000),
  content_bytes integer not null check (content_bytes between 1 and 2097152),
  -- These are PostgreSQL-canonical hashes over the exact staged raw chunk and
  -- its server-side projection instruction.  They make a lost CLI response
  -- replay-safe and let completion prove each stored row came from a ledgered
  -- chunk rather than only trusting aggregate run totals.
  projection_sha256 text not null check (projection_sha256 ~ '^[a-f0-9]{64}$'),
  projected_record_counts jsonb not null check (
    jsonb_typeof(projected_record_counts) = 'object'
    and projected_record_counts ?& ARRAY['supplementalRecords', 'scheduleEvents', 'scheduleParticipants', 'leaveMakeups']
    and projected_record_counts - ARRAY['supplementalRecords', 'scheduleEvents', 'scheduleParticipants', 'leaveMakeups']::text[] = '{}'::jsonb
  ),
  staged_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  primary key (run_id, chunk_index)
);

alter table internal.jiaowubao_direct_import_chunks enable row level security;
revoke all on table internal.jiaowubao_direct_import_chunks from public, anon, authenticated;

-- Student snapshot, quick-list, contract, hour-balance, and class-membership
-- rows share the same source/provenance contract.  Their payloads remain raw
-- history: none is allowed to alter the Tencent formal roster or lesson ledger.
create table if not exists internal.jiaowubao_direct_supplemental_records (
  id bigint generated always as identity primary key,
  run_id uuid not null references internal.jiaowubao_direct_import_runs(id) on delete restrict,
  chunk_index integer not null check (chunk_index between 0 and 511),
  record_kind text not null check (record_kind in (
    'student_snapshot', 'quick_list', 'contract', 'hour_balance', 'class_membership'
  )),
  source_key text not null check (source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'),
  source_workbook text not null check (source_workbook in (
    'quick_list', 'students', 'contracts', 'hours', 'class_members'
  )),
  source_row integer not null check (source_row between 1 and 1000000),
  source_cell text check (source_cell is null or source_cell ~ '^[A-Z]{1,3}[1-9][0-9]{0,5}$'),
  resolution_state text not null check (resolution_state in ('attached', 'quarantined')),
  -- A cached formal ID is allowed only after the trigger proves it belongs to
  -- the exact Tencent-derived current student represented by master_source_row.
  student_id text,
  -- Retained from the JWB identity row. Tencent has no guaranteed phone
  -- column, so this is evidence rather than a Tencent comparison key; it is
  -- nevertheless required before a name-only schedule attendee may inherit
  -- this attached identity record.
  evidence_phone text,
  -- Exactly one attached, phone-proven row may be promoted to the canonical
  -- identity proof for a Tencent student/name within a run.  Other source
  -- facts remain raw supplemental history, but schedule attendees cannot
  -- select between multiple same-name JWB rows.
  identity_proof boolean not null default false,
  master_source_row text,
  evidence_name text,
  match_mode text,
  quarantine_reason text,
  source_payload jsonb not null check (
    jsonb_typeof(source_payload) = 'object'
    and octet_length(source_payload::text) between 2 and 131072
  ),
  record_sha256 text not null check (record_sha256 ~ '^[a-f0-9]{64}$'),
  unique (run_id, record_kind, source_key),
  foreign key (run_id, chunk_index)
    references internal.jiaowubao_direct_import_chunks(run_id, chunk_index) on delete restrict,
  check (
    (record_kind = 'student_snapshot' and source_workbook = 'students')
    or (record_kind = 'quick_list' and source_workbook = 'quick_list')
    or (record_kind = 'contract' and source_workbook = 'contracts')
    or (record_kind = 'hour_balance' and source_workbook = 'hours')
    or (record_kind = 'class_membership' and source_workbook = 'class_members')
  ),
  check (
    (resolution_state = 'attached'
      and student_id is not null and student_id = btrim(student_id) and char_length(student_id) between 1 and 240
      and evidence_phone is not null and evidence_phone = btrim(evidence_phone) and char_length(evidence_phone) between 1 and 64
      and master_source_row is not null and master_source_row = btrim(master_source_row)
      and char_length(master_source_row) between 1 and 240
      and evidence_name is not null and evidence_name = btrim(evidence_name)
      and char_length(evidence_name) between 1 and 240
      and match_mode = 'exact_name'
      and quarantine_reason is null)
    or (resolution_state = 'quarantined'
      and student_id is null and evidence_phone is null and identity_proof = false
      and master_source_row is null and evidence_name is null and match_mode is null
      and quarantine_reason in (
        'unmatched_tencent_student', 'ambiguous_tencent_student',
        'excluded_tencent_student', 'empty_name', 'missing_phone',
        'duplicate_identity', 'review_required', 'invalid_source_value'
      ))
  )
);

alter table internal.jiaowubao_direct_supplemental_records enable row level security;
revoke all on table internal.jiaowubao_direct_supplemental_records from public, anon, authenticated;

create index if not exists jiaowubao_direct_supplemental_master_idx
  on internal.jiaowubao_direct_supplemental_records (run_id, master_source_row)
  where resolution_state = 'attached';

create index if not exists jiaowubao_direct_supplemental_phone_identity_idx
  on internal.jiaowubao_direct_supplemental_records (run_id, student_id, evidence_phone)
  where resolution_state = 'attached';

-- Source keys are an integrity handle, not the only provenance proof.  One
-- exported worksheet coordinate can enter an immutable run only once, so a
-- self-consistent artifact cannot duplicate a row under a second source key.
create unique index if not exists jiaowubao_direct_supplemental_source_coordinate_idx
  on internal.jiaowubao_direct_supplemental_records (run_id, source_workbook, source_row);

create unique index if not exists jiaowubao_direct_supplemental_canonical_identity_idx
  on internal.jiaowubao_direct_supplemental_records (
    run_id,
    master_source_row,
    student_id,
    internal.student_import_name_key(evidence_name)
  )
  where resolution_state = 'attached' and identity_proof;

-- Imported schedule cells stay as class-level events.  They are never normal
-- bookings.  A block is deliberately opt-in and can exist only for a valid
-- Melbourne interval whose teacher has an exact resolved identity.
create table if not exists internal.jiaowubao_direct_schedule_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references internal.jiaowubao_direct_import_runs(id) on delete restrict,
  chunk_index integer not null check (chunk_index between 0 and 511),
  source_key text not null check (source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'),
  source_workbook text not null default 'schedule' check (source_workbook = 'schedule'),
  source_row integer not null check (source_row between 1 and 1000000),
  source_cell text not null check (source_cell ~ '^[A-Z]{1,3}[1-9][0-9]{0,5}$'),
  source_date date not null,
  source_timezone text not null default 'Australia/Melbourne'
    check (source_timezone = 'Australia/Melbourne'),
  source_timezone_basis text not null
    check (source_timezone_basis = btrim(source_timezone_basis) and char_length(source_timezone_basis) between 1 and 1000),
  time_parse_status text not null check (time_parse_status in ('parsed', 'invalid_time')),
  time_parse_reason text,
  dst_resolution text,
  source_local_start time(0),
  source_local_end time(0),
  starts_at timestamptz,
  ends_at timestamptz,
  class_name text check (class_name is null or char_length(class_name) between 1 and 500),
  course_name text check (course_name is null or char_length(course_name) between 1 and 500),
  teacher_display_name text check (teacher_display_name is null or char_length(teacher_display_name) between 1 and 240),
  teacher_resolution text not null default 'unresolved'
    check (teacher_resolution in ('exact_name', 'unresolved', 'ambiguous', 'not_found')),
  teacher_id text check (teacher_id is null or (teacher_id = btrim(teacher_id) and char_length(teacher_id) between 1 and 240)),
  subject_resolution text not null default 'unresolved'
    check (subject_resolution in ('exact_name', 'unresolved', 'ambiguous', 'not_found')),
  subject_id text check (subject_id is null or (subject_id = btrim(subject_id) and char_length(subject_id) between 1 and 240)),
  availability_effect text not null default 'display_only'
    check (availability_effect in ('display_only', 'blocks_teacher_ava')),
  declared_participant_count integer check (declared_participant_count is null or declared_participant_count between 0 and 10000),
  source_payload jsonb not null check (
    jsonb_typeof(source_payload) = 'object'
    and octet_length(source_payload::text) between 2 and 131072
  ),
  record_sha256 text not null check (record_sha256 ~ '^[a-f0-9]{64}$'),
  unique (run_id, source_key),
  foreign key (run_id, chunk_index)
    references internal.jiaowubao_direct_import_chunks(run_id, chunk_index) on delete restrict,
  check (
    (time_parse_status = 'parsed'
      and time_parse_reason is null
      and dst_resolution = 'unambiguous'
      and source_local_start is not null and source_local_end is not null
      and source_local_start < source_local_end
      and starts_at is not null and ends_at is not null and starts_at < ends_at
      and (starts_at at time zone source_timezone) = (source_date + source_local_start)
      and (ends_at at time zone source_timezone) = (source_date + source_local_end))
    or (time_parse_status = 'invalid_time'
      and time_parse_reason in ('missing_time_interval', 'invalid_time_interval', 'non_positive_time_interval', 'invalid_wall_clock', 'ambiguous_wall_clock')
      and dst_resolution is null
      and source_local_start is null and source_local_end is null
      and starts_at is null and ends_at is null)
  ),
  check (
    (teacher_resolution = 'exact_name' and teacher_id is not null and teacher_display_name is not null)
    or (teacher_resolution <> 'exact_name' and teacher_id is null)
  ),
  check (
    (subject_resolution = 'exact_name' and subject_id is not null)
    or (subject_resolution <> 'exact_name' and subject_id is null)
  ),
  check (
    availability_effect = 'display_only'
    or (availability_effect = 'blocks_teacher_ava'
      and time_parse_status = 'parsed'
      and teacher_resolution = 'exact_name'
      and teacher_id is not null)
  )
);

alter table internal.jiaowubao_direct_schedule_events enable row level security;
revoke all on table internal.jiaowubao_direct_schedule_events from public, anon, authenticated;

create index if not exists jiaowubao_direct_schedule_events_block_idx
  on internal.jiaowubao_direct_schedule_events (teacher_id, starts_at, ends_at)
  where availability_effect = 'blocks_teacher_ava';

create unique index if not exists jiaowubao_direct_schedule_source_coordinate_idx
  on internal.jiaowubao_direct_schedule_events (run_id, source_workbook, source_row, source_cell);

-- A source schedule cell may hold a class, so its safe Tencent relationships
-- are kept as many participant rows instead of incorrectly materialising one
-- operational booking per learner.
create table if not exists internal.jiaowubao_direct_schedule_event_participants (
  event_id uuid not null references internal.jiaowubao_direct_schedule_events(id) on delete restrict,
  participant_key text not null check (participant_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'),
  source_display_name text check (source_display_name is null or char_length(source_display_name) between 1 and 240),
  resolution_state text not null check (resolution_state in ('attached', 'quarantined')),
  student_id text,
  -- Name-only attendees must cite a prior phone-bearing supplemental record
  -- from the same immutable run.  The guard verifies it is the same exact
  -- Tencent-attached identity before this participant is accepted.
  identity_supplemental_record_id bigint
    references internal.jiaowubao_direct_supplemental_records(id) on delete restrict,
  master_source_row text,
  evidence_name text,
  match_mode text,
  quarantine_reason text,
  source_payload jsonb not null check (
    jsonb_typeof(source_payload) = 'object'
    and octet_length(source_payload::text) between 2 and 131072
  ),
  record_sha256 text not null check (record_sha256 ~ '^[a-f0-9]{64}$'),
  primary key (event_id, participant_key),
  check (
    (resolution_state = 'attached'
      and student_id is not null and student_id = btrim(student_id) and char_length(student_id) between 1 and 240
      and source_display_name is not null and source_display_name = btrim(source_display_name)
      and char_length(source_display_name) between 1 and 240
      and identity_supplemental_record_id is not null
      and master_source_row is not null and master_source_row = btrim(master_source_row)
      and char_length(master_source_row) between 1 and 240
      and evidence_name is not null and evidence_name = btrim(evidence_name)
      and char_length(evidence_name) between 1 and 240
      and match_mode = 'exact_name'
      and quarantine_reason is null)
    or (resolution_state = 'quarantined'
      and student_id is null and identity_supplemental_record_id is null
      and master_source_row is null and evidence_name is null and match_mode is null
      and quarantine_reason in (
        'unmatched_tencent_student', 'ambiguous_tencent_student',
        'excluded_tencent_student', 'empty_name', 'missing_phone',
        'duplicate_identity', 'review_required', 'class_not_resolved',
        'invalid_source_value'
      ))
  )
);

alter table internal.jiaowubao_direct_schedule_event_participants enable row level security;
revoke all on table internal.jiaowubao_direct_schedule_event_participants from public, anon, authenticated;

create index if not exists jiaowubao_direct_schedule_participants_master_idx
  on internal.jiaowubao_direct_schedule_event_participants (master_source_row)
  where resolution_state = 'attached';

create index if not exists jiaowubao_direct_schedule_participants_identity_idx
  on internal.jiaowubao_direct_schedule_event_participants (identity_supplemental_record_id)
  where resolution_state = 'attached';

-- Leave and makeup exports are retained as imported incidents.  They do not
-- invoke the normal exception workflow and cannot cancel, settle, or create a
-- live operation.
create table if not exists internal.jiaowubao_direct_leave_makeup_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references internal.jiaowubao_direct_import_runs(id) on delete restrict,
  chunk_index integer not null check (chunk_index between 0 and 511),
  source_key text not null check (source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'),
  source_workbook text not null default 'leave_makeups' check (source_workbook = 'leave_makeups'),
  source_row integer not null check (source_row between 1 and 1000000),
  source_cell text check (source_cell is null or source_cell ~ '^[A-Z]{1,3}[1-9][0-9]{0,5}$'),
  incident_kind text not null default 'unknown' check (incident_kind in ('leave', 'makeup', 'unknown')),
  source_date date,
  source_time_text text check (source_time_text is null or char_length(source_time_text) between 1 and 100),
  class_name text check (class_name is null or char_length(class_name) between 1 and 500),
  course_name text check (course_name is null or char_length(course_name) between 1 and 500),
  teacher_display_name text check (teacher_display_name is null or char_length(teacher_display_name) between 1 and 240),
  resolution_state text not null check (resolution_state in ('attached', 'quarantined')),
  student_id text,
  master_source_row text,
  evidence_name text,
  match_mode text,
  quarantine_reason text,
  source_payload jsonb not null check (
    jsonb_typeof(source_payload) = 'object'
    and octet_length(source_payload::text) between 2 and 131072
  ),
  record_sha256 text not null check (record_sha256 ~ '^[a-f0-9]{64}$'),
  unique (run_id, source_key),
  foreign key (run_id, chunk_index)
    references internal.jiaowubao_direct_import_chunks(run_id, chunk_index) on delete restrict,
  check (
    (resolution_state = 'attached'
      and student_id is not null and student_id = btrim(student_id) and char_length(student_id) between 1 and 240
      and master_source_row is not null and master_source_row = btrim(master_source_row)
      and char_length(master_source_row) between 1 and 240
      and evidence_name is not null and evidence_name = btrim(evidence_name)
      and char_length(evidence_name) between 1 and 240
      and match_mode = 'exact_name'
      and quarantine_reason is null)
    or (resolution_state = 'quarantined'
      and student_id is null and master_source_row is null and evidence_name is null and match_mode is null
      and quarantine_reason in (
        'unmatched_tencent_student', 'ambiguous_tencent_student',
        'excluded_tencent_student', 'empty_name', 'missing_phone',
        'duplicate_identity', 'review_required', 'invalid_source_value'
      ))
  )
);

alter table internal.jiaowubao_direct_leave_makeup_events enable row level security;
revoke all on table internal.jiaowubao_direct_leave_makeup_events from public, anon, authenticated;

create index if not exists jiaowubao_direct_leave_makeup_master_idx
  on internal.jiaowubao_direct_leave_makeup_events (run_id, master_source_row, source_date)
  where resolution_state = 'attached';

create unique index if not exists jiaowubao_direct_leave_makeup_source_coordinate_idx
  on internal.jiaowubao_direct_leave_makeup_events (run_id, source_workbook, source_row);

-- These helpers are intentionally internal only.  A local importer has to
-- stage each batch while the Tencent master source it read is still current;
-- completed runs remain valid historical evidence even after a later Tencent
-- refresh.
create or replace function internal.jiaowubao_direct_import_assert_staging(p_run_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_staging$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
begin
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_run_not_found';
  end if;
  if saved_run.state <> 'staging' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_run_not_staging';
  end if;
end;
$jiaowubao_direct_import_assert_staging$;

revoke all on function internal.jiaowubao_direct_import_assert_staging(uuid)
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_assert_attached_master(
  p_run_id uuid,
  p_resolution_state text,
  p_student_id text,
  p_master_source_row text,
  p_evidence_name text,
  p_match_mode text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_attached_master$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  current_master internal.student_import_source_rows%rowtype;
  students_payload jsonb;
  matching_count integer;
  matching_active_name_count integer;
  current_student_count integer;
  matching_name text;
  matching_status text;
begin
  if p_resolution_state <> 'attached' then
    return;
  end if;
  if p_match_mode <> 'exact_name'
     or p_student_id is null
     or p_master_source_row is null
     or p_evidence_name is null then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_attachment_shape_invalid';
  end if;

  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_run_not_found';
  end if;

  select * into current_master
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'master'
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_master_source_unavailable';
  end if;
  if current_master.source_id <> saved_run.master_source_id
     or current_master.revision <> saved_run.master_revision
     or current_master.rows_sha256 <> saved_run.master_rows_sha256 then
    raise exception using errcode = '40900', message = 'jiaowubao_direct_import_master_source_changed';
  end if;

  select count(*) into matching_count
  from jsonb_array_elements(current_master.rows) master_row(value)
  where internal.student_import_source_key(master_row.value -> 'sourceRow') = p_master_source_row
    and nullif(btrim(master_row.value ->> 'name'), '') is not null;
  if matching_count <> 1 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_master_row_unknown';
  end if;

  select master_row.value ->> 'name', master_row.value ->> 'status'
  into matching_name, matching_status
  from jsonb_array_elements(current_master.rows) master_row(value)
  where internal.student_import_source_key(master_row.value -> 'sourceRow') = p_master_source_row;

  if btrim(coalesce(matching_status, '')) = '不活跃 + 无课时' then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_excluded_master_forbidden';
  end if;
  if internal.student_import_name_key(matching_name) <> internal.student_import_name_key(p_evidence_name) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_attachment_name_mismatch';
  end if;
  -- Tencent does not guarantee a phone field, so name uniqueness is the
  -- minimum server-side proof.  Do not let a local writer select one of two
  -- active same-name Tencent rows merely by supplying its source-row key.
  select count(*) into matching_active_name_count
  from jsonb_array_elements(current_master.rows) master_row(value)
  where internal.student_import_name_key(master_row.value ->> 'name') =
        internal.student_import_name_key(p_evidence_name)
    and btrim(coalesce(master_row.value ->> 'status', '')) <> '不活跃 + 无课时';
  if matching_active_name_count <> 1 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_attachment_name_ambiguous';
  end if;

  -- Preserve a concrete current student ID for conflict guards and display,
  -- but only when it is the current Tencent-derived formal record for the
  -- already validated source row.  This is a read-only identity check; no
  -- Jiaowubao record can add, edit, or revive a student here.
  select state_row.payload into students_payload
  from public.ops_state state_row
  where state_row.entity = 'students'
  for share;
  if not found or jsonb_typeof(students_payload) <> 'array' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_students_state_unavailable';
  end if;
  select count(*) into current_student_count
  from jsonb_array_elements(students_payload) student_row(value)
  where student_row.value ->> 'id' = p_student_id
    and student_row.value ->> 'importSource' = 'master'
    and internal.student_import_source_key(student_row.value -> 'sourceRow') = p_master_source_row
    and coalesce(student_row.value ->> 'importArchived', 'false') <> 'true'
    and btrim(coalesce(student_row.value ->> 'status', '')) <> '不活跃 + 无课时'
    and internal.student_import_name_key(student_row.value ->> 'name') =
      internal.student_import_name_key(p_evidence_name);
  if current_student_count <> 1 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_student_id_not_current_tencent_record';
  end if;
end;
$jiaowubao_direct_import_assert_attached_master$;

revoke all on function internal.jiaowubao_direct_import_assert_attached_master(uuid, text, text, text, text, text)
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_assert_supplemental_phone_evidence(
  p_resolution_state text,
  p_evidence_phone text,
  p_source_payload jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_supplemental_phone_evidence$
declare
  source_phone text;
  normalized_source_phone text;
  normalized_evidence_phone text;
begin
  if p_resolution_state <> 'attached' then
    return;
  end if;
  source_phone := coalesce(
    p_source_payload #>> '{source,identity,phone}',
    p_source_payload #>> '{source,raw,fields,手机号}'
  );
  normalized_source_phone := regexp_replace(coalesce(source_phone, ''), '[[:space:]()-]', '', 'g');
  normalized_evidence_phone := regexp_replace(coalesce(p_evidence_phone, ''), '[[:space:]()-]', '', 'g');
  if normalized_source_phone = ''
     or normalized_evidence_phone = ''
     or normalized_source_phone <> normalized_evidence_phone then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_supplemental_phone_evidence_invalid';
  end if;
end;
$jiaowubao_direct_import_assert_supplemental_phone_evidence$;

revoke all on function internal.jiaowubao_direct_import_assert_supplemental_phone_evidence(text, text, jsonb)
  from public, anon, authenticated;

-- An evidence name is not a free-form attachment hint.  It must be the name
-- carried by the exact raw JWB payload kept with this row.  The helper is
-- deliberately called from table guards as well as from the staging command
-- so a future internal writer cannot accidentally substitute a same-name
-- Tencent row for unrelated source evidence.
create or replace function internal.jiaowubao_direct_import_assert_payload_identity_name(
  p_resolution_state text,
  p_evidence_name text,
  p_source_payload jsonb,
  p_context text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_payload_identity_name$
declare
  source_name text;
begin
  if p_resolution_state <> 'attached' then
    return;
  end if;
  source_name := p_source_payload #>> '{source,identity,name}';
  if nullif(btrim(source_name), '') is null
     or internal.student_import_name_key(source_name) <> internal.student_import_name_key(p_evidence_name) then
    if p_context = 'supplemental' then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_supplemental_name_evidence_invalid';
    elsif p_context = 'leave_makeup' then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_leave_makeup_name_evidence_invalid';
    else
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_payload_name_evidence_invalid';
    end if;
  end if;
end;
$jiaowubao_direct_import_assert_payload_identity_name$;

revoke all on function internal.jiaowubao_direct_import_assert_payload_identity_name(text, text, jsonb, text)
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_assert_schedule_participant_name_evidence(
  p_resolution_state text,
  p_evidence_name text,
  p_source_display_name text,
  p_source_payload jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_schedule_participant_name_evidence$
begin
  if p_resolution_state <> 'attached' then
    return;
  end if;
  if nullif(btrim(p_source_display_name), '') is null
     or internal.student_import_name_key(p_source_display_name) <> internal.student_import_name_key(p_evidence_name)
     or not exists (
       select 1
       from jsonb_array_elements_text(
         coalesce(p_source_payload #> '{source,studentDisplayNames}', '[]'::jsonb)
       ) source_name(value)
       where internal.student_import_name_key(source_name.value) =
             internal.student_import_name_key(p_source_display_name)
     ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_participant_name_evidence_invalid';
  end if;
end;
$jiaowubao_direct_import_assert_schedule_participant_name_evidence$;

revoke all on function internal.jiaowubao_direct_import_assert_schedule_participant_name_evidence(text, text, text, jsonb)
  from public, anon, authenticated;

-- PostgreSQL's ordinary AT TIME ZONE conversion picks one side of a repeated
-- wall clock.  Instead, enumerate the bounded offset lattice and require
-- exactly one UTC instant that maps back to each Melbourne source clock.
-- This rejects nonexistent and repeated DST wall clocks before any row may
-- subtract AVA.
create or replace function internal.jiaowubao_direct_import_assert_unambiguous_schedule_time(
  p_time_parse_status text,
  p_source_date date,
  p_source_timezone text,
  p_source_local_start time,
  p_source_local_end time,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_dst_resolution text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_unambiguous_schedule_time$
declare
  local_start timestamp;
  local_end timestamp;
  resolved_start timestamptz;
  resolved_end timestamptz;
  start_candidate_count integer;
  end_candidate_count integer;
begin
  if p_time_parse_status <> 'parsed' then
    return;
  end if;
  if p_source_timezone <> 'Australia/Melbourne'
     or p_source_date is null
     or p_source_local_start is null
     or p_source_local_end is null
     or p_starts_at is null
     or p_ends_at is null
     or p_dst_resolution <> 'unambiguous' then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_time_proof_invalid';
  end if;
  local_start := p_source_date + p_source_local_start;
  local_end := p_source_date + p_source_local_end;

  select count(*), min(candidate.instant)
  into start_candidate_count, resolved_start
  from (
    select ((local_start - make_interval(mins => offset_minutes)) at time zone 'UTC') as instant
    from generate_series(-720, 840, 15) offset_minutes
  ) candidate
  where candidate.instant at time zone p_source_timezone = local_start;

  select count(*), min(candidate.instant)
  into end_candidate_count, resolved_end
  from (
    select ((local_end - make_interval(mins => offset_minutes)) at time zone 'UTC') as instant
    from generate_series(-720, 840, 15) offset_minutes
  ) candidate
  where candidate.instant at time zone p_source_timezone = local_end;

  if start_candidate_count <> 1
     or end_candidate_count <> 1
     or resolved_start is distinct from p_starts_at
     or resolved_end is distinct from p_ends_at
     or p_starts_at >= p_ends_at then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_time_proof_invalid';
  end if;
end;
$jiaowubao_direct_import_assert_unambiguous_schedule_time$;

revoke all on function internal.jiaowubao_direct_import_assert_unambiguous_schedule_time(text, date, text, time, time, timestamptz, timestamptz, text)
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_assert_exact_teacher(
  p_teacher_resolution text,
  p_teacher_id text,
  p_teacher_display_name text,
  p_source_payload jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_exact_teacher$
declare
  teachers_payload jsonb;
  teacher_count integer;
  matching_name_count integer;
  source_teacher_name text;
begin
  if p_teacher_resolution <> 'exact_name' then
    return;
  end if;
  if p_teacher_id is null or p_teacher_display_name is null then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_teacher_attachment_shape_invalid';
  end if;
  source_teacher_name := p_source_payload #>> '{source,teacher}';
  if nullif(btrim(source_teacher_name), '') is null
     or internal.student_import_name_key(source_teacher_name) <>
        internal.student_import_name_key(p_teacher_display_name) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_teacher_name_evidence_invalid';
  end if;
  select state_row.payload into teachers_payload
  from public.ops_state state_row
  where state_row.entity = 'teachers'
  for share;
  if not found or jsonb_typeof(teachers_payload) <> 'array' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_teachers_state_unavailable';
  end if;
  select count(*) into teacher_count
  from jsonb_array_elements(teachers_payload) teacher_row(value)
  where teacher_row.value ->> 'id' = p_teacher_id
    and internal.student_import_name_key(teacher_row.value ->> 'name') =
      internal.student_import_name_key(p_teacher_display_name);
  if teacher_count <> 1 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_teacher_id_not_exact_current_record';
  end if;
  select count(*) into matching_name_count
  from jsonb_array_elements(teachers_payload) teacher_row(value)
  where internal.student_import_name_key(teacher_row.value ->> 'name') =
    internal.student_import_name_key(p_teacher_display_name);
  if matching_name_count <> 1 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_teacher_name_ambiguous';
  end if;
end;
$jiaowubao_direct_import_assert_exact_teacher$;

revoke all on function internal.jiaowubao_direct_import_assert_exact_teacher(text, text, text, jsonb)
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_assert_schedule_participant_identity(
  p_run_id uuid,
  p_student_id text,
  p_identity_supplemental_record_id bigint,
  p_master_source_row text,
  p_evidence_name text,
  p_source_display_name text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_schedule_participant_identity$
declare
  identity_record internal.jiaowubao_direct_supplemental_records%rowtype;
begin
  if p_identity_supplemental_record_id is null then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_participant_identity_required';
  end if;
  select * into identity_record
  from internal.jiaowubao_direct_supplemental_records record
  where record.id = p_identity_supplemental_record_id
    and record.run_id = p_run_id
  for update;
  if not found
     or identity_record.resolution_state <> 'attached'
     or identity_record.identity_proof is not true
     or nullif(btrim(identity_record.evidence_phone), '') is null
     or identity_record.student_id is distinct from p_student_id
     or identity_record.master_source_row is distinct from p_master_source_row
     or internal.student_import_name_key(identity_record.evidence_name) <>
        internal.student_import_name_key(p_evidence_name)
     or internal.student_import_name_key(identity_record.evidence_name) <>
        internal.student_import_name_key(p_source_display_name) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_participant_identity_invalid';
  end if;
end;
$jiaowubao_direct_import_assert_schedule_participant_identity$;

revoke all on function internal.jiaowubao_direct_import_assert_schedule_participant_identity(uuid, text, bigint, text, text, text)
  from public, anon, authenticated;

-- Expensive authority checks intentionally happen once, at completion, while
-- the parent run is FOR UPDATE.  Child insert triggers only perform cheap
-- payload/provenance shape checks; they must not unnest the Tencent master or
-- ops_state JSON arrays for every one of tens of thousands of source rows.
create or replace function internal.jiaowubao_direct_import_validate_projection(
  p_run_id uuid,
  p_master_rows jsonb,
  p_students_payload jsonb,
  p_teachers_payload jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_validate_projection$
declare
  violation text;
begin
  if jsonb_typeof(p_master_rows) <> 'array'
     or jsonb_typeof(p_students_payload) <> 'array'
     or jsonb_typeof(p_teachers_payload) <> 'array' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_authority_state_unavailable';
  end if;

  with
  master_rows as materialized (
    select
      internal.student_import_source_key(master_row.value -> 'sourceRow') as source_row,
      internal.student_import_name_key(master_row.value ->> 'name') as name_key,
      btrim(coalesce(master_row.value ->> 'status', '')) as status
    from jsonb_array_elements(p_master_rows) master_row(value)
  ),
  master_by_source as materialized (
    select source_row, count(*)::integer as row_count, min(name_key) as name_key, min(status) as status
    from master_rows
    where nullif(source_row, '') is not null
    group by source_row
  ),
  active_master_names as materialized (
    select name_key, count(*)::integer as row_count
    from master_rows
    where name_key <> '' and status <> '不活跃 + 无课时'
    group by name_key
  ),
  current_students as materialized (
    select
      student_row.value ->> 'id' as student_id,
      internal.student_import_source_key(student_row.value -> 'sourceRow') as source_row,
      internal.student_import_name_key(student_row.value ->> 'name') as name_key,
      count(*)::integer as row_count
    from jsonb_array_elements(p_students_payload) student_row(value)
    where student_row.value ->> 'importSource' = 'master'
      and coalesce(student_row.value ->> 'importArchived', 'false') <> 'true'
      and btrim(coalesce(student_row.value ->> 'status', '')) <> '不活跃 + 无课时'
    group by
      student_row.value ->> 'id',
      internal.student_import_source_key(student_row.value -> 'sourceRow'),
      internal.student_import_name_key(student_row.value ->> 'name')
  ),
  current_teachers as materialized (
    select
      teacher_row.value ->> 'id' as teacher_id,
      internal.student_import_name_key(teacher_row.value ->> 'name') as name_key,
      count(*)::integer as row_count
    from jsonb_array_elements(p_teachers_payload) teacher_row(value)
    group by teacher_row.value ->> 'id', internal.student_import_name_key(teacher_row.value ->> 'name')
  ),
  current_teacher_names as materialized (
    select name_key, sum(row_count)::integer as row_count
    from current_teachers
    where name_key <> ''
    group by name_key
  ),
  attached_records as materialized (
    select
      'supplemental'::text as record_type,
      record.source_key,
      record.student_id,
      record.master_source_row,
      record.evidence_name,
      internal.student_import_name_key(record.evidence_name) as evidence_name_key
    from internal.jiaowubao_direct_supplemental_records record
    where record.run_id = p_run_id and record.resolution_state = 'attached'
    union all
    select
      'schedule_participant'::text,
      schedule_event.source_key || ':' || participant.participant_key,
      participant.student_id,
      participant.master_source_row,
      participant.evidence_name,
      internal.student_import_name_key(participant.evidence_name)
    from internal.jiaowubao_direct_schedule_event_participants participant
    join internal.jiaowubao_direct_schedule_events schedule_event on schedule_event.id = participant.event_id
    where schedule_event.run_id = p_run_id and participant.resolution_state = 'attached'
    union all
    select
      'leave_makeup'::text,
      leave_makeup_event.source_key,
      leave_makeup_event.student_id,
      leave_makeup_event.master_source_row,
      leave_makeup_event.evidence_name,
      internal.student_import_name_key(leave_makeup_event.evidence_name)
    from internal.jiaowubao_direct_leave_makeup_events leave_makeup_event
    where leave_makeup_event.run_id = p_run_id and leave_makeup_event.resolution_state = 'attached'
  ),
  attached_checked as materialized (
    select
      attachment.*,
      coalesce(master_source.row_count, 0) as master_source_count,
      master_source.name_key as master_name_key,
      master_source.status as master_status,
      coalesce(active_name.row_count, 0) as active_name_count,
      coalesce(current_student.row_count, 0) as current_student_count
    from attached_records attachment
    left join master_by_source master_source on master_source.source_row = attachment.master_source_row
    left join active_master_names active_name on active_name.name_key = attachment.evidence_name_key
    left join current_students current_student
      on current_student.student_id = attachment.student_id
     and current_student.source_row = attachment.master_source_row
     and current_student.name_key = attachment.evidence_name_key
  ),
  participant_identity as materialized (
    select
      participant.event_id,
      participant.participant_key,
      participant.student_id,
      participant.master_source_row,
      participant.evidence_name,
      participant.source_display_name,
      participant.source_payload,
      identity_record.id as identity_id,
      identity_record.run_id as identity_run_id,
      identity_record.resolution_state as identity_state,
      identity_record.identity_proof,
      identity_record.evidence_phone,
      identity_record.student_id as identity_student_id,
      identity_record.master_source_row as identity_master_source_row,
      identity_record.evidence_name as identity_evidence_name
    from internal.jiaowubao_direct_schedule_event_participants participant
    join internal.jiaowubao_direct_schedule_events schedule_event on schedule_event.id = participant.event_id
    left join internal.jiaowubao_direct_supplemental_records identity_record
      on identity_record.id = participant.identity_supplemental_record_id
    where schedule_event.run_id = p_run_id and participant.resolution_state = 'attached'
  ),
  schedule_time_proofs as materialized (
    select
      schedule_event.id,
      schedule_event.source_date,
      schedule_event.source_timezone,
      schedule_event.source_local_start,
      schedule_event.source_local_end,
      schedule_event.starts_at,
      schedule_event.ends_at,
      schedule_event.dst_resolution,
      schedule_event.time_parse_status,
      start_proof.candidate_count as start_candidate_count,
      start_proof.resolved_instant as resolved_start,
      end_proof.candidate_count as end_candidate_count,
      end_proof.resolved_instant as resolved_end
    from internal.jiaowubao_direct_schedule_events schedule_event
    left join lateral (
      select count(*)::integer as candidate_count, min(candidate.instant) as resolved_instant
      from (
        select ((schedule_event.source_date + schedule_event.source_local_start
          - pg_catalog.make_interval(mins => offset_grid.offset_minutes)) at time zone 'UTC') as instant
        from pg_catalog.generate_series(-720, 840, 15) as offset_grid(offset_minutes)
      ) candidate
      where candidate.instant at time zone schedule_event.source_timezone =
        schedule_event.source_date + schedule_event.source_local_start
    ) start_proof on schedule_event.time_parse_status = 'parsed'
    left join lateral (
      select count(*)::integer as candidate_count, min(candidate.instant) as resolved_instant
      from (
        select ((schedule_event.source_date + schedule_event.source_local_end
          - pg_catalog.make_interval(mins => offset_grid.offset_minutes)) at time zone 'UTC') as instant
        from pg_catalog.generate_series(-720, 840, 15) as offset_grid(offset_minutes)
      ) candidate
      where candidate.instant at time zone schedule_event.source_timezone =
        schedule_event.source_date + schedule_event.source_local_end
    ) end_proof on schedule_event.time_parse_status = 'parsed'
    where schedule_event.run_id = p_run_id
  ),
  violation_rows as (
    select 'jiaowubao_direct_import_master_row_unknown'::text as code
    from attached_checked where master_source_count <> 1
    union all
    select 'jiaowubao_direct_import_excluded_master_forbidden'
    from attached_checked where master_status = '不活跃 + 无课时'
    union all
    select 'jiaowubao_direct_import_attachment_name_mismatch'
    from attached_checked where master_name_key is distinct from evidence_name_key
    union all
    select 'jiaowubao_direct_import_attachment_name_ambiguous'
    from attached_checked where active_name_count <> 1
    union all
    select 'jiaowubao_direct_import_student_id_not_current_tencent_record'
    from attached_checked where current_student_count <> 1
    union all
    select 'jiaowubao_direct_import_schedule_participant_identity_invalid'
    from participant_identity identity_link
    where identity_id is null
       or identity_run_id <> p_run_id
       or identity_state <> 'attached'
       or identity_proof is not true
       or nullif(btrim(evidence_phone), '') is null
       or identity_student_id is distinct from student_id
       or identity_master_source_row is distinct from master_source_row
       or internal.student_import_name_key(identity_evidence_name) <>
          internal.student_import_name_key(evidence_name)
       or internal.student_import_name_key(identity_evidence_name) <>
          internal.student_import_name_key(source_display_name)
       or not exists (
         select 1
         from jsonb_array_elements_text(coalesce(source_payload #> '{source,studentDisplayNames}', '[]'::jsonb)) source_name(value)
         where internal.student_import_name_key(source_name.value) =
               internal.student_import_name_key(source_display_name)
       )
    union all
    select 'jiaowubao_direct_import_schedule_time_proof_invalid'
    from schedule_time_proofs
    where time_parse_status = 'parsed'
      and (
        source_timezone <> 'Australia/Melbourne'
        or dst_resolution <> 'unambiguous'
        or start_candidate_count <> 1
        or end_candidate_count <> 1
        or resolved_start is distinct from starts_at
        or resolved_end is distinct from ends_at
        or starts_at >= ends_at
      )
    union all
    select 'jiaowubao_direct_import_teacher_name_evidence_invalid'
    from internal.jiaowubao_direct_schedule_events schedule_event
    where schedule_event.run_id = p_run_id
      and schedule_event.teacher_resolution = 'exact_name'
      and (
        nullif(btrim(schedule_event.source_payload #>> '{source,teacher}'), '') is null
        or internal.student_import_name_key(schedule_event.source_payload #>> '{source,teacher}') <>
           internal.student_import_name_key(schedule_event.teacher_display_name)
      )
    union all
    select 'jiaowubao_direct_import_teacher_id_not_exact_current_record'
    from internal.jiaowubao_direct_schedule_events schedule_event
    left join current_teachers current_teacher
      on current_teacher.teacher_id = schedule_event.teacher_id
     and current_teacher.name_key = internal.student_import_name_key(schedule_event.teacher_display_name)
    where schedule_event.run_id = p_run_id
      and schedule_event.teacher_resolution = 'exact_name'
      and coalesce(current_teacher.row_count, 0) <> 1
    union all
    select 'jiaowubao_direct_import_teacher_name_ambiguous'
    from internal.jiaowubao_direct_schedule_events schedule_event
    left join current_teacher_names current_teacher_name
      on current_teacher_name.name_key = internal.student_import_name_key(schedule_event.teacher_display_name)
    where schedule_event.run_id = p_run_id
      and schedule_event.teacher_resolution = 'exact_name'
      and coalesce(current_teacher_name.row_count, 0) <> 1
    union all
    select 'jiaowubao_direct_import_subject_resolution_not_yet_authoritative'
    from internal.jiaowubao_direct_schedule_events schedule_event
    where schedule_event.run_id = p_run_id
      and (schedule_event.subject_resolution <> 'unresolved' or schedule_event.subject_id is not null)
  )
  select code into violation
  from violation_rows
  limit 1;

  if violation is not null then
    raise exception using errcode = '22023', message = violation;
  end if;
end;
$jiaowubao_direct_import_validate_projection$;

revoke all on function internal.jiaowubao_direct_import_validate_projection(uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_assert_complete(p_run_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_complete$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  current_master internal.student_import_source_rows%rowtype;
  students_payload jsonb;
  teachers_payload jsonb;
  workbook_count integer;
  chunk_count integer;
  minimum_chunk_index integer;
  maximum_chunk_index integer;
  supplemental_count integer;
  schedule_count integer;
  participant_count integer;
  leave_makeup_count integer;
begin
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_run_not_found';
  end if;
  if saved_run.state <> 'staging' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_run_not_staging';
  end if;

  select * into current_master
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'master'
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_master_source_unavailable';
  end if;
  if current_master.source_id <> saved_run.master_source_id
     or current_master.revision <> saved_run.master_revision
     or current_master.rows_sha256 <> saved_run.master_rows_sha256 then
    raise exception using errcode = '40900', message = 'jiaowubao_direct_import_master_source_changed';
  end if;

  select state_row.payload into students_payload
  from public.ops_state state_row
  where state_row.entity = 'students'
  for share;
  select state_row.payload into teachers_payload
  from public.ops_state state_row
  where state_row.entity = 'teachers'
  for share;
  perform internal.jiaowubao_direct_import_validate_projection(
    p_run_id, current_master.rows, students_payload, teachers_payload
  );

  select count(*) into workbook_count
  from internal.jiaowubao_direct_import_workbooks workbook
  where workbook.run_id = p_run_id;
  if workbook_count <> 7 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_workbook_manifest_incomplete';
  end if;

  select count(*), min(chunk.chunk_index), max(chunk.chunk_index)
  into chunk_count, minimum_chunk_index, maximum_chunk_index
  from internal.jiaowubao_direct_import_chunks chunk
  where chunk.run_id = p_run_id;
  if chunk_count <> saved_run.expected_chunk_count
     or minimum_chunk_index <> 0
     or maximum_chunk_index <> saved_run.expected_chunk_count - 1 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_manifest_incomplete';
  end if;
  if exists (
    select 1
    from internal.jiaowubao_direct_import_chunks chunk
    where chunk.run_id = p_run_id
      and chunk.source_record_counts is distinct from saved_run.source_record_counts
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_record_counts_mismatch';
  end if;
  if not exists (
    select 1
    from internal.operational_contract_audit audit_entry
    where audit_entry.id = saved_run.staging_audit_id
      and audit_entry.action = 'jiaowubao_direct_import.started'
      and audit_entry.actor = saved_run.staged_by
      and audit_entry.target_type = 'jiaowubao_direct_import_run'
      and audit_entry.target_id = saved_run.id::text
      and audit_entry.metadata ->> 'sourceId' = saved_run.source_id
      and audit_entry.metadata ->> 'revision' = saved_run.revision
      and audit_entry.metadata ->> 'masterSourceId' = saved_run.master_source_id
      and audit_entry.metadata ->> 'masterRevision' = saved_run.master_revision
      and audit_entry.metadata ->> 'masterRowsSha256' = saved_run.master_rows_sha256
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_staging_audit_invalid';
  end if;
  if exists (
    select 1
    from internal.jiaowubao_direct_import_chunks chunk
    left join internal.operational_contract_audit audit_entry on audit_entry.id = chunk.audit_id
    where chunk.run_id = p_run_id
      and (
        audit_entry.id is null
        or audit_entry.action <> 'jiaowubao_direct_import.chunk_staged'
        or audit_entry.actor <> saved_run.staged_by
        or audit_entry.target_type <> 'jiaowubao_direct_import_run'
        or audit_entry.target_id <> saved_run.id::text
        or audit_entry.metadata ->> 'sourceId' <> saved_run.source_id
        or audit_entry.metadata ->> 'revision' <> saved_run.revision
        or audit_entry.metadata ->> 'chunkIndex' <> chunk.chunk_index::text
        or audit_entry.metadata ->> 'chunkSha256' <> chunk.chunk_sha256
        or audit_entry.metadata ->> 'projectionSha256' <> chunk.projection_sha256
      )
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_audit_invalid';
  end if;
  if exists (
    with chunk_rows as (
      select
        chunk.chunk_index,
        chunk.source_record_count,
        chunk.projected_record_counts,
        coalesce(supplemental.row_count, 0)::integer as supplemental_count,
        coalesce(schedule_event.row_count, 0)::integer as schedule_count,
        coalesce(participant.row_count, 0)::integer as participant_count,
        coalesce(leave_makeup.row_count, 0)::integer as leave_makeup_count
      from internal.jiaowubao_direct_import_chunks chunk
      left join (
        select chunk_index, count(*)::integer as row_count
        from internal.jiaowubao_direct_supplemental_records
        where run_id = p_run_id group by chunk_index
      ) supplemental on supplemental.chunk_index = chunk.chunk_index
      left join (
        select chunk_index, count(*)::integer as row_count
        from internal.jiaowubao_direct_schedule_events
        where run_id = p_run_id group by chunk_index
      ) schedule_event on schedule_event.chunk_index = chunk.chunk_index
      left join (
        select schedule_event.chunk_index, count(*)::integer as row_count
        from internal.jiaowubao_direct_schedule_event_participants participant
        join internal.jiaowubao_direct_schedule_events schedule_event on schedule_event.id = participant.event_id
        where schedule_event.run_id = p_run_id group by schedule_event.chunk_index
      ) participant on participant.chunk_index = chunk.chunk_index
      left join (
        select chunk_index, count(*)::integer as row_count
        from internal.jiaowubao_direct_leave_makeup_events
        where run_id = p_run_id group by chunk_index
      ) leave_makeup on leave_makeup.chunk_index = chunk.chunk_index
      where chunk.run_id = p_run_id
    )
    select 1
    from chunk_rows
    where source_record_count <> supplemental_count + schedule_count + leave_makeup_count
       or projected_record_counts is distinct from jsonb_build_object(
         'supplementalRecords', supplemental_count,
         'scheduleEvents', schedule_count,
         'scheduleParticipants', participant_count,
         'leaveMakeups', leave_makeup_count
       )
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_projection_proof_invalid';
  end if;
  if exists (
    select 1
    from (
      select source_key from internal.jiaowubao_direct_supplemental_records where run_id = p_run_id
      union all select source_key from internal.jiaowubao_direct_schedule_events where run_id = p_run_id
      union all select source_key from internal.jiaowubao_direct_leave_makeup_events where run_id = p_run_id
    ) source_keys
    group by source_key
    having count(*) <> 1
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_source_key_proof_invalid';
  end if;
  -- Aggregate every source kind back from the persisted relational rows.  A
  -- supplemental total alone is not sufficient: it would allow a quick-list
  -- row to stand in for a student snapshot (or any other same-total swap).
  -- The per-workbook proof independently binds the raw source reference to
  -- the immutable seven-file manifest.
  if exists (
    with persisted_source_counts as (
      select persisted_row.source_kind, count(*)::integer as row_count
      from (
        select case record.record_kind
          when 'contract' then 'contract_history'
          else record.record_kind
        end as source_kind
        from internal.jiaowubao_direct_supplemental_records record
        where record.run_id = p_run_id
        union all
        select 'schedule_event'::text
        from internal.jiaowubao_direct_schedule_events schedule_event
        where schedule_event.run_id = p_run_id
        union all
        select 'leave_makeup'::text
        from internal.jiaowubao_direct_leave_makeup_events leave_makeup_event
        where leave_makeup_event.run_id = p_run_id
      ) persisted_row
      group by persisted_row.source_kind
    )
    select 1
    from jsonb_each_text(saved_run.source_record_counts) expected(source_kind, row_count)
    left join persisted_source_counts persisted using (source_kind)
    where coalesce(persisted.row_count, 0) <> expected.row_count::integer
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_source_kind_counts_mismatch';
  end if;
  if exists (
    with persisted_workbook_counts as (
      select persisted_row.workbook_kind, count(*)::integer as row_count
      from (
        select record.source_workbook as workbook_kind
        from internal.jiaowubao_direct_supplemental_records record
        where record.run_id = p_run_id
        union all
        select schedule_event.source_workbook
        from internal.jiaowubao_direct_schedule_events schedule_event
        where schedule_event.run_id = p_run_id
        union all
        select leave_makeup_event.source_workbook
        from internal.jiaowubao_direct_leave_makeup_events leave_makeup_event
        where leave_makeup_event.run_id = p_run_id
      ) persisted_row
      group by persisted_row.workbook_kind
    )
    select 1
    from internal.jiaowubao_direct_import_workbooks workbook
    left join persisted_workbook_counts persisted
      on persisted.workbook_kind = workbook.workbook_kind
    where workbook.run_id = p_run_id
      and coalesce(persisted.row_count, 0) <> workbook.row_count
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_workbook_row_counts_mismatch';
  end if;
  -- Every persisted raw row must still reconstruct to the canonical
  -- PostgreSQL digest accepted from its staged preflight record. This binds
  -- the run ledger to the relational history rather than relying on counts
  -- alone. Participant hashes are separately derived from their one source
  -- schedule cell plus the explicitly retained display name.
  if exists (
    select 1
    from internal.jiaowubao_direct_supplemental_records record
    where record.run_id = p_run_id
      and record.record_sha256 <> encode(extensions.digest(jsonb_build_object(
        'kind', case record.record_kind when 'contract' then 'contract_history' else record.record_kind end,
        'sourceKey', record.source_key,
        'sourceRefs', record.source_payload #> '{_directImport,sourceRefs}',
        'sourceDigest', record.source_payload #>> '{_directImport,sourceDigest}',
        'studentRelationship', record.source_payload #> '{_directImport,studentRelationship}',
        'payload', record.source_payload - '_directImport'
      )::text, 'sha256'), 'hex')
  ) or exists (
    select 1
    from internal.jiaowubao_direct_schedule_events schedule_event
    where schedule_event.run_id = p_run_id
      and schedule_event.record_sha256 <> encode(extensions.digest(jsonb_build_object(
        'kind', 'schedule_event',
        'sourceKey', schedule_event.source_key,
        'sourceRefs', schedule_event.source_payload #> '{_directImport,sourceRefs}',
        'sourceDigest', schedule_event.source_payload #>> '{_directImport,sourceDigest}',
        'studentRelationship', schedule_event.source_payload #> '{_directImport,studentRelationship}',
        'payload', schedule_event.source_payload - '_directImport'
      )::text, 'sha256'), 'hex')
  ) or exists (
    select 1
    from internal.jiaowubao_direct_leave_makeup_events leave_makeup_event
    where leave_makeup_event.run_id = p_run_id
      and leave_makeup_event.record_sha256 <> encode(extensions.digest(jsonb_build_object(
        'kind', 'leave_makeup',
        'sourceKey', leave_makeup_event.source_key,
        'sourceRefs', leave_makeup_event.source_payload #> '{_directImport,sourceRefs}',
        'sourceDigest', leave_makeup_event.source_payload #>> '{_directImport,sourceDigest}',
        'studentRelationship', leave_makeup_event.source_payload #> '{_directImport,studentRelationship}',
        'payload', leave_makeup_event.source_payload - '_directImport'
      )::text, 'sha256'), 'hex')
  ) or exists (
    select 1
    from internal.jiaowubao_direct_schedule_event_participants participant
    join internal.jiaowubao_direct_schedule_events schedule_event on schedule_event.id = participant.event_id
    where schedule_event.run_id = p_run_id
      and participant.record_sha256 <> encode(extensions.digest(jsonb_build_object(
        'sourceKey', schedule_event.source_key,
        'participantKey', participant.participant_key,
        'sourceDisplayName', participant.source_display_name,
        'sourceDigest', schedule_event.source_payload #>> '{_directImport,sourceDigest}'
      )::text, 'sha256'), 'hex')
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_raw_record_digest_proof_invalid';
  end if;

  select count(*) into supplemental_count
  from internal.jiaowubao_direct_supplemental_records record
  where record.run_id = p_run_id;
  select count(*) into schedule_count
  from internal.jiaowubao_direct_schedule_events schedule_event
  where schedule_event.run_id = p_run_id;
  select count(*) into participant_count
  from internal.jiaowubao_direct_schedule_event_participants participant
  join internal.jiaowubao_direct_schedule_events schedule_event on schedule_event.id = participant.event_id
  where schedule_event.run_id = p_run_id;
  select count(*) into leave_makeup_count
  from internal.jiaowubao_direct_leave_makeup_events leave_makeup_event
  where leave_makeup_event.run_id = p_run_id;

  if supplemental_count <> (saved_run.expected_counts ->> 'supplementalRecords')::integer
     or schedule_count <> (saved_run.expected_counts ->> 'scheduleEvents')::integer
     or participant_count <> (saved_run.expected_counts ->> 'scheduleParticipants')::integer
     or leave_makeup_count <> (saved_run.expected_counts ->> 'leaveMakeups')::integer then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_record_counts_mismatch';
  end if;

  -- A partially parsed class cell may remain display-only, but it cannot
  -- subtract teacher availability until at least one exact, current Tencent
  -- student participant proves the event's classroom relationship.
  if exists (
    select 1
    from internal.jiaowubao_direct_schedule_events schedule_event
    where schedule_event.run_id = p_run_id
      and schedule_event.availability_effect = 'blocks_teacher_ava'
      and not exists (
        select 1
        from internal.jiaowubao_direct_schedule_event_participants participant
        where participant.event_id = schedule_event.id
          and participant.resolution_state = 'attached'
      )
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_block_participants_unresolved';
  end if;
end;
$jiaowubao_direct_import_assert_complete$;

revoke all on function internal.jiaowubao_direct_import_assert_complete(uuid)
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_run_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_run_guard$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_run_read_only';
  end if;

  if tg_op = 'INSERT' then
    if new.state <> 'staging'
       or new.payload_sha256 is not null
       or new.staging_audit_id is null
       or new.completed_at is not null
       or new.completion_audit_id is not null then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_run_must_start_staging';
    end if;
    return new;
  end if;

  if old.state = 'complete' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_run_read_only';
  end if;
  if new.id is distinct from old.id
     or new.source_id is distinct from old.source_id
     or new.revision is distinct from old.revision
     or new.format is distinct from old.format
     or new.source_timezone is distinct from old.source_timezone
     or new.source_timezone_basis is distinct from old.source_timezone_basis
     or new.master_source_id is distinct from old.master_source_id
     or new.master_revision is distinct from old.master_revision
     or new.master_rows_sha256 is distinct from old.master_rows_sha256
     or new.expected_chunk_count is distinct from old.expected_chunk_count
     or new.source_record_counts is distinct from old.source_record_counts
     or new.expected_counts is distinct from old.expected_counts
     or new.staged_by is distinct from old.staged_by
     or new.staged_at is distinct from old.staged_at
     or new.staging_audit_id is distinct from old.staging_audit_id
     or new.state <> 'complete'
     or new.payload_sha256 is null
     or new.completed_at is null
     or new.completion_audit_id is null then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_run_invalid_transition';
  end if;

  perform internal.jiaowubao_direct_import_assert_complete(old.id);
  if not exists (
    select 1
    from internal.operational_contract_audit audit_entry
    where audit_entry.id = new.completion_audit_id
      and audit_entry.action = 'jiaowubao_direct_import.completed'
      and audit_entry.actor = old.staged_by
      and audit_entry.target_type = 'jiaowubao_direct_import_run'
      and audit_entry.target_id = old.id::text
      and audit_entry.metadata ->> 'sourceId' = old.source_id
      and audit_entry.metadata ->> 'revision' = old.revision
      and audit_entry.metadata ->> 'payloadSha256' = new.payload_sha256
      and audit_entry.metadata ->> 'masterSourceId' = old.master_source_id
      and audit_entry.metadata ->> 'masterRevision' = old.master_revision
      and audit_entry.metadata ->> 'masterRowsSha256' = old.master_rows_sha256
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_completion_audit_invalid';
  end if;
  return new;
end;
$jiaowubao_direct_import_run_guard$;

revoke all on function internal.jiaowubao_direct_import_run_guard()
  from public, anon, authenticated;

create trigger jiaowubao_direct_import_runs_guard
before insert or update or delete on internal.jiaowubao_direct_import_runs
for each row execute function internal.jiaowubao_direct_import_run_guard();

create or replace function internal.jiaowubao_direct_import_workbook_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_workbook_guard$
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_workbook_read_only';
  end if;
  perform internal.jiaowubao_direct_import_assert_staging(new.run_id);
  return new;
end;
$jiaowubao_direct_import_workbook_guard$;

revoke all on function internal.jiaowubao_direct_import_workbook_guard()
  from public, anon, authenticated;

create trigger jiaowubao_direct_import_workbooks_guard
before insert or update or delete on internal.jiaowubao_direct_import_workbooks
for each row execute function internal.jiaowubao_direct_import_workbook_guard();

create or replace function internal.jiaowubao_direct_import_chunk_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_chunk_guard$
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_chunk_read_only';
  end if;
  perform internal.jiaowubao_direct_import_assert_staging(new.run_id);
  return new;
end;
$jiaowubao_direct_import_chunk_guard$;

revoke all on function internal.jiaowubao_direct_import_chunk_guard()
  from public, anon, authenticated;

create trigger jiaowubao_direct_import_chunks_guard
before insert or update or delete on internal.jiaowubao_direct_import_chunks
for each row execute function internal.jiaowubao_direct_import_chunk_guard();

create or replace function internal.jiaowubao_direct_import_supplemental_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_supplemental_guard$
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_supplemental_read_only';
  end if;
  perform internal.jiaowubao_direct_import_assert_staging(new.run_id);
  perform internal.jiaowubao_direct_import_assert_supplemental_phone_evidence(
    new.resolution_state, new.evidence_phone, new.source_payload
  );
  perform internal.jiaowubao_direct_import_assert_payload_identity_name(
    new.resolution_state, new.evidence_name, new.source_payload, 'supplemental'
  );
  return new;
end;
$jiaowubao_direct_import_supplemental_guard$;

revoke all on function internal.jiaowubao_direct_import_supplemental_guard()
  from public, anon, authenticated;

create trigger jiaowubao_direct_import_supplemental_guard
before insert or update or delete on internal.jiaowubao_direct_supplemental_records
for each row execute function internal.jiaowubao_direct_import_supplemental_guard();

create or replace function internal.jiaowubao_direct_import_schedule_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_schedule_guard$
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_schedule_read_only';
  end if;
  perform internal.jiaowubao_direct_import_assert_staging(new.run_id);
  return new;
end;
$jiaowubao_direct_import_schedule_guard$;

revoke all on function internal.jiaowubao_direct_import_schedule_guard()
  from public, anon, authenticated;

create trigger jiaowubao_direct_import_schedule_guard
before insert or update or delete on internal.jiaowubao_direct_schedule_events
for each row execute function internal.jiaowubao_direct_import_schedule_guard();

create or replace function internal.jiaowubao_direct_import_participant_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_participant_guard$
declare
  parent_run_id uuid;
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_participant_read_only';
  end if;
  select schedule_event.run_id into parent_run_id
  from internal.jiaowubao_direct_schedule_events schedule_event
  where schedule_event.id = new.event_id
  for key share;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_schedule_event_not_found';
  end if;
  perform internal.jiaowubao_direct_import_assert_staging(parent_run_id);
  perform internal.jiaowubao_direct_import_assert_schedule_participant_name_evidence(
    new.resolution_state, new.evidence_name, new.source_display_name, new.source_payload
  );
  -- This is an indexed, single-row proof rather than a Tencent JSON scan.  It
  -- prevents a staging writer from pointing an attached attendee at a
  -- different supplemental identity while retaining the set-based Tencent
  -- authority check for completion.
  if new.resolution_state = 'attached' then
    perform internal.jiaowubao_direct_import_assert_schedule_participant_identity(
      parent_run_id,
      new.student_id,
      new.identity_supplemental_record_id,
      new.master_source_row,
      new.evidence_name,
      new.source_display_name
    );
  end if;
  return new;
end;
$jiaowubao_direct_import_participant_guard$;

revoke all on function internal.jiaowubao_direct_import_participant_guard()
  from public, anon, authenticated;

create trigger jiaowubao_direct_import_participant_guard
before insert or update or delete on internal.jiaowubao_direct_schedule_event_participants
for each row execute function internal.jiaowubao_direct_import_participant_guard();

create or replace function internal.jiaowubao_direct_import_leave_makeup_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_leave_makeup_guard$
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_leave_makeup_read_only';
  end if;
  perform internal.jiaowubao_direct_import_assert_staging(new.run_id);
  perform internal.jiaowubao_direct_import_assert_payload_identity_name(
    new.resolution_state, new.evidence_name, new.source_payload, 'leave_makeup'
  );
  return new;
end;
$jiaowubao_direct_import_leave_makeup_guard$;

revoke all on function internal.jiaowubao_direct_import_leave_makeup_guard()
  from public, anon, authenticated;

create trigger jiaowubao_direct_import_leave_makeup_guard
before insert or update or delete on internal.jiaowubao_direct_leave_makeup_events
for each row execute function internal.jiaowubao_direct_import_leave_makeup_guard();

-- The only schedule rows the future AVA reader may subtract are from the
-- latest complete run and meet the exact time + exact teacher guard above.
-- It has no write path and remains in the internal schema.
create or replace view internal.jiaowubao_direct_current_schedule_blocks
with (security_invoker = true)
as
with latest_complete_run as (
  select run_state.id
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.state = 'complete'
  order by run_state.completed_at desc, run_state.id desc
  limit 1
)
select
  schedule_event.id as event_id,
  schedule_event.run_id,
  schedule_event.source_key,
  schedule_event.source_date,
  schedule_event.source_timezone,
  schedule_event.starts_at,
  schedule_event.ends_at,
  tstzrange(schedule_event.starts_at, schedule_event.ends_at, '[)') as occupied_range,
  schedule_event.teacher_id,
  schedule_event.subject_id,
  schedule_event.class_name,
  schedule_event.course_name,
  coalesce(
    array_agg(participant.student_id order by participant.student_id)
      filter (where participant.resolution_state = 'attached'),
    ARRAY[]::text[]
  ) as student_ids
from internal.jiaowubao_direct_schedule_events schedule_event
join latest_complete_run latest on latest.id = schedule_event.run_id
left join internal.jiaowubao_direct_schedule_event_participants participant
  on participant.event_id = schedule_event.id
where schedule_event.availability_effect = 'blocks_teacher_ava'
group by
  schedule_event.id,
  schedule_event.run_id,
  schedule_event.source_key,
  schedule_event.source_date,
  schedule_event.source_timezone,
  schedule_event.starts_at,
  schedule_event.ends_at,
  schedule_event.teacher_id,
  schedule_event.subject_id,
  schedule_event.class_name,
  schedule_event.course_name;

revoke all on table internal.jiaowubao_direct_current_schedule_blocks from public, anon, authenticated;

-- -------------------------------------------------------------------------
-- Local CLI-only staging contract
-- -------------------------------------------------------------------------
-- These functions are intentionally in `internal`, SECURITY INVOKER, and have
-- no PUBLIC/anon/authenticated execute grants. They are for a reviewed local
-- Supabase CLI session only; they are not Data API or browser RPC endpoints.

create or replace function internal.jiaowubao_direct_import_assert_object_shape(
  p_value jsonb,
  p_fields text[],
  p_error text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_object_shape$
begin
  if jsonb_typeof(p_value) <> 'object'
     or not (p_value ?& p_fields)
     or p_value - p_fields <> '{}'::jsonb then
    raise exception using errcode = '22023', message = p_error;
  end if;
end;
$jiaowubao_direct_import_assert_object_shape$;

revoke all on function internal.jiaowubao_direct_import_assert_object_shape(jsonb, text[], text)
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_assert_resolution(
  p_resolution jsonb,
  p_error_prefix text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_resolution$
declare
  state_value text;
begin
  perform internal.jiaowubao_direct_import_assert_object_shape(
    p_resolution,
    ARRAY['state', 'studentId', 'masterSourceRow', 'reason'],
    p_error_prefix || '_shape_invalid'
  );
  state_value := p_resolution ->> 'state';
  if state_value = 'attached' then
    if jsonb_typeof(p_resolution -> 'studentId') <> 'string'
       or nullif(btrim(p_resolution ->> 'studentId'), '') is null
       or p_resolution ->> 'studentId' <> btrim(p_resolution ->> 'studentId')
       or char_length(p_resolution ->> 'studentId') > 240
       or jsonb_typeof(p_resolution -> 'masterSourceRow') <> 'string'
       or nullif(btrim(p_resolution ->> 'masterSourceRow'), '') is null
       or p_resolution ->> 'masterSourceRow' <> btrim(p_resolution ->> 'masterSourceRow')
       or char_length(p_resolution ->> 'masterSourceRow') > 240
       or p_resolution -> 'reason' <> 'null'::jsonb then
      raise exception using errcode = '22023', message = p_error_prefix || '_shape_invalid';
    end if;
  elsif state_value = 'quarantined' then
    if p_resolution -> 'studentId' <> 'null'::jsonb
       or p_resolution -> 'masterSourceRow' <> 'null'::jsonb
       or jsonb_typeof(p_resolution -> 'reason') <> 'string'
       or p_resolution ->> 'reason' not in (
         'unmatched_tencent_student', 'ambiguous_tencent_student',
         'excluded_tencent_student', 'empty_name', 'missing_phone',
         'duplicate_identity', 'review_required', 'class_not_resolved',
         'invalid_source_value'
       ) then
      raise exception using errcode = '22023', message = p_error_prefix || '_shape_invalid';
    end if;
  else
    raise exception using errcode = '22023', message = p_error_prefix || '_shape_invalid';
  end if;
end;
$jiaowubao_direct_import_assert_resolution$;

revoke all on function internal.jiaowubao_direct_import_assert_resolution(jsonb, text)
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_assert_participant_resolution(
  p_resolution jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_participant_resolution$
begin
  perform internal.jiaowubao_direct_import_assert_object_shape(
    p_resolution,
    ARRAY['state', 'reason'],
    'jiaowubao_direct_import_participant_resolution_shape_invalid'
  );
  if p_resolution ->> 'state' = 'attached' then
    if p_resolution -> 'reason' <> 'null'::jsonb then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_participant_resolution_shape_invalid';
    end if;
  elsif p_resolution ->> 'state' = 'quarantined' then
    if jsonb_typeof(p_resolution -> 'reason') <> 'string'
       or p_resolution ->> 'reason' not in (
         'unmatched_tencent_student', 'ambiguous_tencent_student',
         'excluded_tencent_student', 'empty_name', 'missing_phone',
         'duplicate_identity', 'review_required', 'class_not_resolved',
         'invalid_source_value'
       ) then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_participant_resolution_shape_invalid';
    end if;
  else
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_participant_resolution_shape_invalid';
  end if;
end;
$jiaowubao_direct_import_assert_participant_resolution$;

revoke all on function internal.jiaowubao_direct_import_assert_participant_resolution(jsonb)
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_assert_envelope(p_envelope jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_envelope$
declare
  expected_workbook_kinds text[] := ARRAY[
    'quick_list', 'students', 'contracts', 'hours',
    'class_members', 'schedule', 'leave_makeups'
  ];
begin
  perform internal.jiaowubao_direct_import_assert_object_shape(
    p_envelope,
    ARRAY[
      'format', 'sourceId', 'revision', 'sourceTimezone', 'sourceTimezoneBasis',
      'masterSource', 'workbooks', 'recordCounts', 'expectedCounts', 'chunkCount'
    ],
    'jiaowubao_direct_import_envelope_shape_invalid'
  );
  if jsonb_typeof(p_envelope -> 'format') <> 'string'
     or p_envelope ->> 'format' <> 'jiaowubao-direct-import-v1'
     or jsonb_typeof(p_envelope -> 'sourceId') <> 'string'
     or p_envelope ->> 'sourceId' <> 'jiaowubao-static-excel'
     or jsonb_typeof(p_envelope -> 'revision') <> 'string'
     or nullif(btrim(p_envelope ->> 'revision'), '') is null
     or p_envelope ->> 'revision' <> btrim(p_envelope ->> 'revision')
     or char_length(p_envelope ->> 'revision') > 240
     or jsonb_typeof(p_envelope -> 'sourceTimezone') <> 'string'
     or p_envelope ->> 'sourceTimezone' <> 'Australia/Melbourne'
     or jsonb_typeof(p_envelope -> 'sourceTimezoneBasis') <> 'string'
     or nullif(btrim(p_envelope ->> 'sourceTimezoneBasis'), '') is null
     or p_envelope ->> 'sourceTimezoneBasis' <> btrim(p_envelope ->> 'sourceTimezoneBasis')
     or char_length(p_envelope ->> 'sourceTimezoneBasis') > 1000
     or jsonb_typeof(p_envelope -> 'chunkCount') <> 'number'
     or (p_envelope ->> 'chunkCount')::numeric <> trunc((p_envelope ->> 'chunkCount')::numeric)
     or (p_envelope ->> 'chunkCount')::numeric not between 1 and 512 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_envelope_shape_invalid';
  end if;
  perform internal.jiaowubao_direct_import_assert_object_shape(
    p_envelope -> 'masterSource',
    ARRAY['sourceId', 'revision', 'rowsSha256'],
    'jiaowubao_direct_import_master_source_shape_invalid'
  );
  if jsonb_typeof(p_envelope -> 'masterSource' -> 'sourceId') <> 'string'
     or nullif(btrim(p_envelope -> 'masterSource' ->> 'sourceId'), '') is null
     or jsonb_typeof(p_envelope -> 'masterSource' -> 'revision') <> 'string'
     or nullif(btrim(p_envelope -> 'masterSource' ->> 'revision'), '') is null
     or jsonb_typeof(p_envelope -> 'masterSource' -> 'rowsSha256') <> 'string'
     or p_envelope -> 'masterSource' ->> 'rowsSha256' !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_master_source_shape_invalid';
  end if;
  if jsonb_typeof(p_envelope -> 'recordCounts') <> 'object'
     or not (p_envelope -> 'recordCounts' ?& ARRAY[
       'student_snapshot', 'quick_list', 'contract_history', 'hour_balance',
       'class_membership', 'schedule_event', 'leave_makeup'
     ])
     or p_envelope -> 'recordCounts' - ARRAY[
       'student_snapshot', 'quick_list', 'contract_history', 'hour_balance',
       'class_membership', 'schedule_event', 'leave_makeup'
     ]::text[] <> '{}'::jsonb
     or exists (
       select 1 from jsonb_each(p_envelope -> 'recordCounts') record_count(key, value)
       where jsonb_typeof(record_count.value) <> 'number'
          or (record_count.value #>> '{}')::numeric < 0
          or (record_count.value #>> '{}')::numeric > 200000
          or (record_count.value #>> '{}')::numeric <> trunc((record_count.value #>> '{}')::numeric)
     ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_record_counts_shape_invalid';
  end if;
  if jsonb_typeof(p_envelope -> 'expectedCounts') <> 'object'
     or not (p_envelope -> 'expectedCounts' ?& ARRAY[
       'supplementalRecords', 'scheduleEvents', 'scheduleParticipants', 'leaveMakeups'
     ])
     or p_envelope -> 'expectedCounts' - ARRAY[
       'supplementalRecords', 'scheduleEvents', 'scheduleParticipants', 'leaveMakeups'
     ]::text[] <> '{}'::jsonb
     or exists (
       select 1 from jsonb_each(p_envelope -> 'expectedCounts') expected_count(key, value)
       where jsonb_typeof(expected_count.value) <> 'number'
          or (expected_count.value #>> '{}')::numeric < 0
          or (expected_count.value #>> '{}')::numeric > 500000
          or (expected_count.value #>> '{}')::numeric <> trunc((expected_count.value #>> '{}')::numeric)
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_expected_counts_shape_invalid';
  end if;
  -- Every raw source row is retained exactly once: the five supplemental
  -- kinds, class-level schedule rows, and leave/makeup evidence rows. Only
  -- participant count is derived from the explicit source-display-name map.
  if (p_envelope -> 'expectedCounts' ->> 'supplementalRecords')::integer <>
       (p_envelope -> 'recordCounts' ->> 'student_snapshot')::integer
       + (p_envelope -> 'recordCounts' ->> 'quick_list')::integer
       + (p_envelope -> 'recordCounts' ->> 'contract_history')::integer
       + (p_envelope -> 'recordCounts' ->> 'hour_balance')::integer
       + (p_envelope -> 'recordCounts' ->> 'class_membership')::integer
     or (p_envelope -> 'expectedCounts' ->> 'scheduleEvents')::integer <>
       (p_envelope -> 'recordCounts' ->> 'schedule_event')::integer
     or (p_envelope -> 'expectedCounts' ->> 'leaveMakeups')::integer <>
       (p_envelope -> 'recordCounts' ->> 'leave_makeup')::integer then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_expected_counts_source_mismatch';
  end if;
  if jsonb_typeof(p_envelope -> 'workbooks') <> 'array'
     or jsonb_array_length(p_envelope -> 'workbooks') <> 7
     or exists (
       select 1
       from jsonb_array_elements(p_envelope -> 'workbooks') with ordinality workbook(value, ordinal)
       where jsonb_typeof(workbook.value) <> 'object'
          or workbook.value - ARRAY['kind', 'workbookName', 'workbookSha256', 'sheetName', 'sourceRecordCount']::text[] <> '{}'::jsonb
          or not (workbook.value ?& ARRAY['kind', 'workbookName', 'workbookSha256', 'sheetName', 'sourceRecordCount'])
          or jsonb_typeof(workbook.value -> 'kind') <> 'string'
          or workbook.value ->> 'kind' <> expected_workbook_kinds[workbook.ordinal]
          or jsonb_typeof(workbook.value -> 'workbookName') <> 'string'
          or nullif(btrim(workbook.value ->> 'workbookName'), '') is null
          or jsonb_typeof(workbook.value -> 'workbookSha256') <> 'string'
          or workbook.value ->> 'workbookSha256' !~ '^[a-f0-9]{64}$'
          or jsonb_typeof(workbook.value -> 'sheetName') <> 'string'
          or nullif(btrim(workbook.value ->> 'sheetName'), '') is null
          or jsonb_typeof(workbook.value -> 'sourceRecordCount') <> 'number'
          or (workbook.value ->> 'sourceRecordCount')::numeric < 0
          or (workbook.value ->> 'sourceRecordCount')::numeric > 200000
          or (workbook.value ->> 'sourceRecordCount')::numeric <> trunc((workbook.value ->> 'sourceRecordCount')::numeric)
     )
     or exists (
       select 1
       from jsonb_array_elements(p_envelope -> 'workbooks') workbook(value)
       where (workbook.value ->> 'kind' = 'students' and (workbook.value ->> 'sourceRecordCount')::integer <> (p_envelope -> 'recordCounts' ->> 'student_snapshot')::integer)
          or (workbook.value ->> 'kind' = 'quick_list' and (workbook.value ->> 'sourceRecordCount')::integer <> (p_envelope -> 'recordCounts' ->> 'quick_list')::integer)
          or (workbook.value ->> 'kind' = 'contracts' and (workbook.value ->> 'sourceRecordCount')::integer <> (p_envelope -> 'recordCounts' ->> 'contract_history')::integer)
          or (workbook.value ->> 'kind' = 'hours' and (workbook.value ->> 'sourceRecordCount')::integer <> (p_envelope -> 'recordCounts' ->> 'hour_balance')::integer)
          or (workbook.value ->> 'kind' = 'class_members' and (workbook.value ->> 'sourceRecordCount')::integer <> (p_envelope -> 'recordCounts' ->> 'class_membership')::integer)
          or (workbook.value ->> 'kind' = 'schedule' and (workbook.value ->> 'sourceRecordCount')::integer <> (p_envelope -> 'recordCounts' ->> 'schedule_event')::integer)
          or (workbook.value ->> 'kind' = 'leave_makeups' and (workbook.value ->> 'sourceRecordCount')::integer <> (p_envelope -> 'recordCounts' ->> 'leave_makeup')::integer)
     ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_workbook_manifest_invalid';
  end if;
end;
$jiaowubao_direct_import_assert_envelope$;

revoke all on function internal.jiaowubao_direct_import_assert_envelope(jsonb)
  from public, anon, authenticated;

-- Production import transaction contract (trusted local database session):
--   BEGIN;
--   SELECT internal.begin_jiaowubao_direct_import(...);
--   SELECT internal.stage_jiaowubao_direct_import_chunk(...) -- once per chunk
--   SELECT internal.complete_jiaowubao_direct_import(...);
--   COMMIT;
--
-- The current artifact has many (currently 86) bounded chunks, so its actual
-- importer must retain one client-owned transaction across the individual
-- calls. It must never commit a partial sequence or use a browser/Data API
-- endpoint. The run-row `FOR UPDATE` guards below serialize every helper
-- against completion; a transaction failure rolls back run, audit, chunks and
-- all relational evidence together.
--
-- Begin is idempotent only for the same immutable envelope and local actor.
-- It creates the run audit before the run row, so an aborted transaction also
-- rolls back the audit rather than leaving a misleading history entry.
create or replace function internal.begin_jiaowubao_direct_import(
  p_envelope jsonb,
  p_actor text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $begin_jiaowubao_direct_import$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  current_master internal.student_import_source_rows%rowtype;
  audit_id uuid;
  created_run_id uuid := gen_random_uuid();
begin
  perform internal.jiaowubao_direct_import_assert_envelope(p_envelope);
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or char_length(p_actor) > 120 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_actor_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('jiaowubao-direct-import:' || (p_envelope ->> 'sourceId') || ':' || (p_envelope ->> 'revision'))
  );
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.source_id = p_envelope ->> 'sourceId'
    and run_state.revision = p_envelope ->> 'revision'
  for update;
  if found then
    if saved_run.format <> p_envelope ->> 'format'
       or saved_run.source_timezone <> p_envelope ->> 'sourceTimezone'
       or saved_run.source_timezone_basis <> p_envelope ->> 'sourceTimezoneBasis'
       or saved_run.master_source_id <> p_envelope -> 'masterSource' ->> 'sourceId'
       or saved_run.master_revision <> p_envelope -> 'masterSource' ->> 'revision'
       or saved_run.master_rows_sha256 <> p_envelope -> 'masterSource' ->> 'rowsSha256'
       or saved_run.expected_chunk_count <> (p_envelope ->> 'chunkCount')::integer
       or saved_run.source_record_counts is distinct from p_envelope -> 'recordCounts'
       or saved_run.expected_counts is distinct from p_envelope -> 'expectedCounts'
       or saved_run.staged_by <> p_actor
       or exists (
         select 1
         from jsonb_array_elements(p_envelope -> 'workbooks') workbook(value)
         full join internal.jiaowubao_direct_import_workbooks stored
           on stored.run_id = saved_run.id
          and stored.workbook_kind = workbook.value ->> 'kind'
         where workbook.value is null
            or stored.run_id is null
            or stored.workbook_name <> workbook.value ->> 'workbookName'
            or stored.workbook_sha256 <> workbook.value ->> 'workbookSha256'
            or stored.sheet_name <> workbook.value ->> 'sheetName'
            or stored.row_count <> (workbook.value ->> 'sourceRecordCount')::integer
       ) then
      raise exception using errcode = '23505', message = 'jiaowubao_direct_import_envelope_conflict';
    end if;
    return saved_run.id;
  end if;

  -- This is deliberately a nonlocking snapshot check.  The production import
  -- may stage many bounded chunks in one transaction; holding `FOR SHARE` on
  -- Tencent's source row for that whole period would stall a normal Tencent
  -- refresh. `assert_complete` takes the short definitive lock and compares
  -- the exact source/revision/hash again immediately before completion, so a
  -- refresh during staging safely rejects and rolls back this import instead.
  select * into current_master
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'master';
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_master_source_unavailable';
  end if;
  if current_master.source_id <> p_envelope -> 'masterSource' ->> 'sourceId'
     or current_master.revision <> p_envelope -> 'masterSource' ->> 'revision'
     or current_master.rows_sha256 <> p_envelope -> 'masterSource' ->> 'rowsSha256' then
    raise exception using errcode = '40900', message = 'jiaowubao_direct_import_master_source_changed';
  end if;

  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_direct_import.started', p_actor,
    'jiaowubao_direct_import_run', created_run_id::text,
    jsonb_build_object(
      'sourceId', p_envelope ->> 'sourceId',
      'revision', p_envelope ->> 'revision',
      'chunkCount', (p_envelope ->> 'chunkCount')::integer,
      'recordCounts', p_envelope -> 'recordCounts',
      'expectedCounts', p_envelope -> 'expectedCounts',
      'masterSourceId', p_envelope -> 'masterSource' ->> 'sourceId',
      'masterRevision', p_envelope -> 'masterSource' ->> 'revision',
      'masterRowsSha256', p_envelope -> 'masterSource' ->> 'rowsSha256'
    )
  );
  insert into internal.jiaowubao_direct_import_runs (
    id, source_id, revision, format, source_timezone, source_timezone_basis,
    master_source_id, master_revision, master_rows_sha256, expected_chunk_count,
    source_record_counts, expected_counts, staged_by, staging_audit_id
  ) values (
    created_run_id,
    p_envelope ->> 'sourceId', p_envelope ->> 'revision', p_envelope ->> 'format',
    p_envelope ->> 'sourceTimezone', p_envelope ->> 'sourceTimezoneBasis',
    p_envelope -> 'masterSource' ->> 'sourceId',
    p_envelope -> 'masterSource' ->> 'revision',
    p_envelope -> 'masterSource' ->> 'rowsSha256',
    (p_envelope ->> 'chunkCount')::integer,
    p_envelope -> 'recordCounts', p_envelope -> 'expectedCounts', p_actor, audit_id
  );
  insert into internal.jiaowubao_direct_import_workbooks (
    run_id, workbook_kind, workbook_name, workbook_sha256, sheet_name, row_count
  )
  select
    created_run_id,
    workbook.value ->> 'kind',
    workbook.value ->> 'workbookName',
    workbook.value ->> 'workbookSha256',
    workbook.value ->> 'sheetName',
    (workbook.value ->> 'sourceRecordCount')::integer
  from jsonb_array_elements(p_envelope -> 'workbooks') workbook(value);
  return created_run_id;
end;
$begin_jiaowubao_direct_import$;

revoke all on function internal.begin_jiaowubao_direct_import(jsonb, text)
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_assert_staging_chunk(
  p_run_id uuid,
  p_chunk jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_staging_chunk$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  expected_contract jsonb := jsonb_build_object(
    'storage', 'server_only_relational_staging',
    'studentAuthority', 'tencent_master',
    'studentCreation', 'forbidden',
    'studentMatching', 'server_side_current_tencent_only',
    'scheduleProjection', 'read_only_imported_schedule_event',
    'scheduleBookingExpansion', 'forbidden',
    'sourceMutation', 'forbidden'
  );
begin
  perform internal.jiaowubao_direct_import_assert_staging(p_run_id);
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id
  for update;

  perform internal.jiaowubao_direct_import_assert_object_shape(
    p_chunk,
    ARRAY['format', 'revision', 'contract', 'sourceTimezone', 'sourceTimezoneBasis', 'workbooks', 'recordCounts', 'chunk', 'records'],
    'jiaowubao_direct_import_chunk_shape_invalid'
  );
  if jsonb_typeof(p_chunk -> 'format') <> 'string'
     or p_chunk ->> 'format' <> 'jiaowubao-direct-staging-v1'
     or jsonb_typeof(p_chunk -> 'revision') <> 'string'
     or p_chunk ->> 'revision' <> saved_run.revision
     or p_chunk -> 'contract' is distinct from expected_contract
     or jsonb_typeof(p_chunk -> 'sourceTimezone') <> 'string'
     or p_chunk ->> 'sourceTimezone' <> saved_run.source_timezone
     or jsonb_typeof(p_chunk -> 'sourceTimezoneBasis') <> 'string'
     or p_chunk ->> 'sourceTimezoneBasis' <> saved_run.source_timezone_basis
     or p_chunk -> 'recordCounts' is distinct from saved_run.source_record_counts
     or jsonb_typeof(p_chunk -> 'chunk') <> 'object'
     or p_chunk -> 'chunk' - ARRAY['index', 'count']::text[] <> '{}'::jsonb
     or not (p_chunk -> 'chunk' ?& ARRAY['index', 'count'])
     or jsonb_typeof(p_chunk -> 'chunk' -> 'index') <> 'number'
     or jsonb_typeof(p_chunk -> 'chunk' -> 'count') <> 'number'
     or (p_chunk -> 'chunk' ->> 'index')::numeric <> trunc((p_chunk -> 'chunk' ->> 'index')::numeric)
     or (p_chunk -> 'chunk' ->> 'count')::numeric <> trunc((p_chunk -> 'chunk' ->> 'count')::numeric)
     or (p_chunk -> 'chunk' ->> 'index')::integer not between 0 and 511
     or (p_chunk -> 'chunk' ->> 'count')::integer <> saved_run.expected_chunk_count
     or jsonb_typeof(p_chunk -> 'records') <> 'array'
     or jsonb_array_length(p_chunk -> 'records') not between 1 and 1500
     or octet_length(p_chunk::text) > 2097152 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_shape_invalid';
  end if;
  if jsonb_typeof(p_chunk -> 'workbooks') <> 'array'
     or jsonb_array_length(p_chunk -> 'workbooks') <> 7
     or exists (
       select 1
       from jsonb_array_elements(p_chunk -> 'workbooks') workbook(value)
       full join internal.jiaowubao_direct_import_workbooks stored
         on stored.run_id = p_run_id and stored.workbook_kind = workbook.value ->> 'kind'
       where jsonb_typeof(workbook.value) <> 'object'
          or workbook.value - ARRAY['kind', 'workbookName', 'workbookSha256', 'sheetName', 'sourceRecordCount']::text[] <> '{}'::jsonb
          or not (workbook.value ?& ARRAY['kind', 'workbookName', 'workbookSha256', 'sheetName', 'sourceRecordCount'])
          or stored.run_id is null
          or stored.workbook_name <> workbook.value ->> 'workbookName'
          or stored.workbook_sha256 <> workbook.value ->> 'workbookSha256'
          or stored.sheet_name <> workbook.value ->> 'sheetName'
          or stored.row_count <> (workbook.value ->> 'sourceRecordCount')::integer
     ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_workbook_manifest_mismatch';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_chunk -> 'records') record(value)
    where jsonb_typeof(record.value) <> 'object'
       or record.value - ARRAY['kind', 'sourceKey', 'sourceRefs', 'sourceDigest', 'studentRelationship', 'payload']::text[] <> '{}'::jsonb
       or not (record.value ?& ARRAY['kind', 'sourceKey', 'sourceRefs', 'sourceDigest', 'studentRelationship', 'payload'])
       or jsonb_typeof(record.value -> 'kind') <> 'string'
       or record.value ->> 'kind' not in (
         'student_snapshot', 'quick_list', 'contract_history', 'hour_balance',
         'class_membership', 'schedule_event', 'leave_makeup'
       )
       or jsonb_typeof(record.value -> 'sourceKey') <> 'string'
       or record.value ->> 'sourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'
       or jsonb_typeof(record.value -> 'sourceDigest') <> 'string'
       or record.value ->> 'sourceDigest' !~ '^[a-f0-9]{64}$'
       or jsonb_typeof(record.value -> 'sourceRefs') <> 'array'
       or jsonb_array_length(record.value -> 'sourceRefs') <> 1
       or jsonb_typeof(record.value -> 'payload') <> 'object'
       or octet_length((record.value -> 'payload')::text) > 131072
       or jsonb_typeof(record.value -> 'payload' -> 'source') <> 'object'
       or jsonb_typeof(record.value -> 'payload' -> 'staging') <> 'object'
       or jsonb_typeof(record.value -> 'studentRelationship') <> 'object'
       or record.value -> 'studentRelationship' - ARRAY['state', 'automaticAttachment', 'sourceIdentity']::text[] <> '{}'::jsonb
       or not (record.value -> 'studentRelationship' ?& ARRAY['state', 'automaticAttachment', 'sourceIdentity'])
       or record.value -> 'studentRelationship' ->> 'automaticAttachment' <> 'forbidden'
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_record_shape_invalid';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_chunk -> 'records') record(value)
    cross join lateral jsonb_array_elements(record.value -> 'sourceRefs') source_ref(value)
    where jsonb_typeof(source_ref.value) <> 'object'
       or source_ref.value - ARRAY['workbook', 'row', 'cell']::text[] <> '{}'::jsonb
       or not (source_ref.value ?& ARRAY['workbook', 'row'])
       or jsonb_typeof(source_ref.value -> 'workbook') <> 'string'
       or source_ref.value ->> 'workbook' not in (
         'quick_list', 'students', 'contracts', 'hours', 'class_members', 'schedule', 'leave_makeups'
       )
       or jsonb_typeof(source_ref.value -> 'row') <> 'number'
       or (source_ref.value ->> 'row')::numeric <> trunc((source_ref.value ->> 'row')::numeric)
       or (source_ref.value ->> 'row')::integer not between 1 and 1000000
       or (source_ref.value ? 'cell' and (
         jsonb_typeof(source_ref.value -> 'cell') <> 'string'
         or source_ref.value ->> 'cell' !~ '^[A-Z]{1,3}[1-9][0-9]{0,5}$'
       ))
       or (record.value ->> 'kind' = 'student_snapshot' and source_ref.value ->> 'workbook' <> 'students')
       or (record.value ->> 'kind' = 'quick_list' and source_ref.value ->> 'workbook' <> 'quick_list')
       or (record.value ->> 'kind' = 'contract_history' and source_ref.value ->> 'workbook' <> 'contracts')
       or (record.value ->> 'kind' = 'hour_balance' and source_ref.value ->> 'workbook' <> 'hours')
       or (record.value ->> 'kind' = 'class_membership' and source_ref.value ->> 'workbook' <> 'class_members')
       or (record.value ->> 'kind' = 'schedule_event' and (source_ref.value ->> 'workbook' <> 'schedule' or not (source_ref.value ? 'cell')))
       or (record.value ->> 'kind' = 'leave_makeup' and source_ref.value ->> 'workbook' <> 'leave_makeups')
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_source_ref_invalid';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_chunk -> 'records') record(value)
    group by record.value ->> 'sourceKey'
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_duplicate_source_key';
  end if;
end;
$jiaowubao_direct_import_assert_staging_chunk$;

revoke all on function internal.jiaowubao_direct_import_assert_staging_chunk(uuid, jsonb)
  from public, anon, authenticated;

-- Projection instruction shape (all identity names/phones/times are derived
-- from `p_chunk.records`, never supplied here):
-- {
--   supplemental: [{sourceKey,resolution:{state,studentId,masterSourceRow,reason},identityProof}],
--   scheduleEvents: [{sourceKey,teacherResolution,teacherId,availabilityEffect,
--     participants:[{participantKey,sourceDisplayName,identitySupplementalSourceKey,resolution:{state,reason}}]}],
--   leaveMakeups: [{sourceKey,incidentKind,resolution:{state,studentId,masterSourceRow,reason}}]
-- }
create or replace function internal.stage_jiaowubao_direct_import_chunk(
  p_run_id uuid,
  p_chunk jsonb,
  p_projection jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $stage_jiaowubao_direct_import_chunk$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  saved_chunk internal.jiaowubao_direct_import_chunks%rowtype;
  identity_record internal.jiaowubao_direct_supplemental_records%rowtype;
  item record;
  participant_item record;
  entry jsonb;
  participant jsonb;
  raw_record jsonb;
  source_ref jsonb;
  resolution jsonb;
  temporal jsonb;
  source_payload jsonb;
  records_by_key jsonb;
  source_name text;
  source_phone text;
  source_date_value date;
  time_parse_reason_value text;
  event_id uuid;
  chunk_index_value integer;
  chunk_hash text;
  projection_hash text;
  record_hash text;
  chunk_audit_id uuid;
  supplemental_count integer;
  schedule_count integer;
  participant_count integer;
  leave_makeup_count integer;
  existing_supplemental_count integer;
  existing_schedule_count integer;
  existing_participant_count integer;
  existing_leave_makeup_count integer;
  identity_match_count integer;
  projected_counts jsonb;
begin
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or char_length(p_actor) > 120 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_actor_invalid';
  end if;
  perform internal.jiaowubao_direct_import_assert_staging_chunk(p_run_id, p_chunk);
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id
  for update;
  if saved_run.staged_by <> p_actor then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_actor_mismatch';
  end if;

  perform internal.jiaowubao_direct_import_assert_object_shape(
    p_projection,
    ARRAY['supplemental', 'scheduleEvents', 'leaveMakeups'],
    'jiaowubao_direct_import_projection_shape_invalid'
  );
  if jsonb_typeof(p_projection -> 'supplemental') <> 'array'
     or jsonb_typeof(p_projection -> 'scheduleEvents') <> 'array'
     or jsonb_typeof(p_projection -> 'leaveMakeups') <> 'array' then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_projection_shape_invalid';
  end if;
  for item in select value from jsonb_array_elements(p_projection -> 'supplemental') item(value) loop
    entry := item.value;
    perform internal.jiaowubao_direct_import_assert_object_shape(
      entry, ARRAY['sourceKey', 'resolution', 'identityProof'],
      'jiaowubao_direct_import_supplemental_projection_shape_invalid'
    );
    if jsonb_typeof(entry -> 'sourceKey') <> 'string'
       or entry ->> 'sourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'
       or jsonb_typeof(entry -> 'identityProof') <> 'boolean' then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_supplemental_projection_shape_invalid';
    end if;
    perform internal.jiaowubao_direct_import_assert_resolution(
      entry -> 'resolution', 'jiaowubao_direct_import_supplemental_resolution'
    );
    if (entry -> 'resolution') ->> 'state' = 'quarantined' and entry -> 'identityProof' <> 'false'::jsonb then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_supplemental_projection_shape_invalid';
    end if;
  end loop;
  for item in select value from jsonb_array_elements(p_projection -> 'scheduleEvents') item(value) loop
    entry := item.value;
    perform internal.jiaowubao_direct_import_assert_object_shape(
      entry, ARRAY['sourceKey', 'teacherResolution', 'teacherId', 'availabilityEffect', 'participants'],
      'jiaowubao_direct_import_schedule_projection_shape_invalid'
    );
    if jsonb_typeof(entry -> 'sourceKey') <> 'string'
       or entry ->> 'sourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'
       or jsonb_typeof(entry -> 'teacherResolution') <> 'string'
       or entry ->> 'teacherResolution' not in ('exact_name', 'unresolved', 'ambiguous', 'not_found')
       or jsonb_typeof(entry -> 'availabilityEffect') <> 'string'
       or entry ->> 'availabilityEffect' not in ('display_only', 'blocks_teacher_ava')
       or jsonb_typeof(entry -> 'participants') <> 'array' then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_projection_shape_invalid';
    end if;
    if entry ->> 'teacherResolution' = 'exact_name' then
      if jsonb_typeof(entry -> 'teacherId') <> 'string'
         or nullif(btrim(entry ->> 'teacherId'), '') is null
         or entry ->> 'teacherId' <> btrim(entry ->> 'teacherId')
         or char_length(entry ->> 'teacherId') > 240 then
        raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_projection_shape_invalid';
      end if;
    elsif entry -> 'teacherId' <> 'null'::jsonb then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_projection_shape_invalid';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(entry -> 'participants') participant_value(value)
      where jsonb_typeof(participant_value.value) <> 'object'
         or participant_value.value - ARRAY['participantKey', 'sourceDisplayName', 'identitySupplementalSourceKey', 'resolution']::text[] <> '{}'::jsonb
         or not (participant_value.value ?& ARRAY['participantKey', 'sourceDisplayName', 'identitySupplementalSourceKey', 'resolution'])
         or jsonb_typeof(participant_value.value -> 'participantKey') <> 'string'
         or participant_value.value ->> 'participantKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'
         or jsonb_typeof(participant_value.value -> 'sourceDisplayName') <> 'string'
         or nullif(btrim(participant_value.value ->> 'sourceDisplayName'), '') is null
         or participant_value.value ->> 'sourceDisplayName' <> btrim(participant_value.value ->> 'sourceDisplayName')
    ) or exists (
      select 1
      from jsonb_array_elements(entry -> 'participants') participant_value(value)
      group by participant_value.value ->> 'participantKey'
      having count(*) > 1
    ) then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_participant_projection_shape_invalid';
    end if;
    for participant_item in select value from jsonb_array_elements(entry -> 'participants') participant_value(value) loop
      participant := participant_item.value;
      perform internal.jiaowubao_direct_import_assert_participant_resolution(participant -> 'resolution');
      if (participant -> 'resolution') ->> 'state' = 'attached' then
        if jsonb_typeof(participant -> 'identitySupplementalSourceKey') <> 'string'
           or participant ->> 'identitySupplementalSourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$' then
          raise exception using errcode = '22023', message = 'jiaowubao_direct_import_participant_projection_shape_invalid';
        end if;
      elsif participant -> 'identitySupplementalSourceKey' <> 'null'::jsonb then
        raise exception using errcode = '22023', message = 'jiaowubao_direct_import_participant_projection_shape_invalid';
      end if;
    end loop;
  end loop;
  for item in select value from jsonb_array_elements(p_projection -> 'leaveMakeups') item(value) loop
    entry := item.value;
    perform internal.jiaowubao_direct_import_assert_object_shape(
      entry, ARRAY['sourceKey', 'incidentKind', 'resolution'],
      'jiaowubao_direct_import_leave_makeup_projection_shape_invalid'
    );
    if jsonb_typeof(entry -> 'sourceKey') <> 'string'
       or entry ->> 'sourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'
       or jsonb_typeof(entry -> 'incidentKind') <> 'string'
       or entry ->> 'incidentKind' not in ('leave', 'makeup', 'unknown') then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_leave_makeup_projection_shape_invalid';
    end if;
    perform internal.jiaowubao_direct_import_assert_resolution(
      entry -> 'resolution', 'jiaowubao_direct_import_leave_makeup_resolution'
    );
  end loop;

  select jsonb_object_agg(record.value ->> 'sourceKey', record.value)
  into records_by_key
  from jsonb_array_elements(p_chunk -> 'records') record(value);
  if exists (
    with raw_records as (
      select record.value ->> 'sourceKey' as source_key, record.value ->> 'kind' as kind
      from jsonb_array_elements(p_chunk -> 'records') record(value)
    ), projection_records as (
      select item.value ->> 'sourceKey' as source_key, 'supplemental'::text as projection_kind
      from jsonb_array_elements(p_projection -> 'supplemental') item(value)
      union all
      select item.value ->> 'sourceKey', 'schedule_event'
      from jsonb_array_elements(p_projection -> 'scheduleEvents') item(value)
      union all
      select item.value ->> 'sourceKey', 'leave_makeup'
      from jsonb_array_elements(p_projection -> 'leaveMakeups') item(value)
    )
    select 1 from projection_records group by source_key having count(*) <> 1
    union all
    select 1
    from raw_records raw_record
    left join projection_records projection_record on projection_record.source_key = raw_record.source_key
    where projection_record.source_key is null
       or (raw_record.kind in ('student_snapshot', 'quick_list', 'contract_history', 'hour_balance', 'class_membership') and projection_record.projection_kind <> 'supplemental')
       or (raw_record.kind = 'schedule_event' and projection_record.projection_kind <> 'schedule_event')
       or (raw_record.kind = 'leave_makeup' and projection_record.projection_kind <> 'leave_makeup')
    union all
    select 1
    from projection_records projection_record
    left join raw_records raw_record on raw_record.source_key = projection_record.source_key
    where raw_record.source_key is null
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_projection_coverage_invalid';
  end if;

  chunk_index_value := (p_chunk -> 'chunk' ->> 'index')::integer;
  chunk_hash := encode(extensions.digest(p_chunk::text, 'sha256'), 'hex');
  projection_hash := encode(extensions.digest(p_projection::text, 'sha256'), 'hex');
  select * into saved_chunk
  from internal.jiaowubao_direct_import_chunks chunk
  where chunk.run_id = p_run_id and chunk.chunk_index = chunk_index_value
  for update;
  if found then
    if saved_chunk.chunk_sha256 <> chunk_hash or saved_chunk.projection_sha256 <> projection_hash then
      raise exception using errcode = '23505', message = 'jiaowubao_direct_import_chunk_conflict';
    end if;
    return jsonb_build_object(
      'runId', p_run_id, 'chunkIndex', chunk_index_value,
      'state', saved_run.state, 'replayed', true
    );
  end if;
  if chunk_index_value > 0 and (
    select count(*)
    from internal.jiaowubao_direct_import_chunks prior_chunk
    where prior_chunk.run_id = p_run_id
      and prior_chunk.chunk_index between 0 and chunk_index_value - 1
  ) <> chunk_index_value then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_sequence_gap';
  end if;
  if exists (
    with incoming as (
      select record.value ->> 'sourceKey' as source_key
      from jsonb_array_elements(p_chunk -> 'records') record(value)
    ), persisted as (
      select source_key from internal.jiaowubao_direct_supplemental_records where run_id = p_run_id
      union all select source_key from internal.jiaowubao_direct_schedule_events where run_id = p_run_id
      union all select source_key from internal.jiaowubao_direct_leave_makeup_events where run_id = p_run_id
    )
    select 1 from incoming join persisted using (source_key)
  ) then
    raise exception using errcode = '23505', message = 'jiaowubao_direct_import_source_key_conflict';
  end if;

  supplemental_count := jsonb_array_length(p_projection -> 'supplemental');
  schedule_count := jsonb_array_length(p_projection -> 'scheduleEvents');
  select coalesce(sum(jsonb_array_length(item.value -> 'participants')), 0)::integer
  into participant_count
  from jsonb_array_elements(p_projection -> 'scheduleEvents') item(value);
  leave_makeup_count := jsonb_array_length(p_projection -> 'leaveMakeups');
  projected_counts := jsonb_build_object(
    'supplementalRecords', supplemental_count,
    'scheduleEvents', schedule_count,
    'scheduleParticipants', participant_count,
    'leaveMakeups', leave_makeup_count
  );
  select count(*) into existing_supplemental_count
  from internal.jiaowubao_direct_supplemental_records where run_id = p_run_id;
  select count(*) into existing_schedule_count
  from internal.jiaowubao_direct_schedule_events where run_id = p_run_id;
  select count(*) into existing_participant_count
  from internal.jiaowubao_direct_schedule_event_participants participant
  join internal.jiaowubao_direct_schedule_events schedule_event on schedule_event.id = participant.event_id
  where schedule_event.run_id = p_run_id;
  select count(*) into existing_leave_makeup_count
  from internal.jiaowubao_direct_leave_makeup_events where run_id = p_run_id;
  if existing_supplemental_count + supplemental_count > (saved_run.expected_counts ->> 'supplementalRecords')::integer
     or existing_schedule_count + schedule_count > (saved_run.expected_counts ->> 'scheduleEvents')::integer
     or existing_participant_count + participant_count > (saved_run.expected_counts ->> 'scheduleParticipants')::integer
     or existing_leave_makeup_count + leave_makeup_count > (saved_run.expected_counts ->> 'leaveMakeups')::integer then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_projected_counts_exceeded';
  end if;

  chunk_audit_id := internal.append_operational_contract_audit(
    'jiaowubao_direct_import.chunk_staged', p_actor,
    'jiaowubao_direct_import_run', p_run_id::text,
    jsonb_build_object(
      'sourceId', saved_run.source_id,
      'revision', saved_run.revision,
      'chunkIndex', chunk_index_value,
      'chunkSha256', chunk_hash,
      'projectionSha256', projection_hash,
      'sourceRecordCount', jsonb_array_length(p_chunk -> 'records'),
      'projectedRecordCounts', projected_counts
    )
  );
  insert into internal.jiaowubao_direct_import_chunks (
    run_id, chunk_index, chunk_sha256, source_record_counts, source_record_count,
    content_bytes, projection_sha256, projected_record_counts, audit_id
  ) values (
    p_run_id, chunk_index_value, chunk_hash, saved_run.source_record_counts,
    jsonb_array_length(p_chunk -> 'records'), octet_length(p_chunk::text),
    projection_hash, projected_counts, chunk_audit_id
  );

  -- Supplemental rows are inserted first so a schedule attendee in this
  -- chunk may cite a prior phone-proven canonical identity by source key.
  for item in select value from jsonb_array_elements(p_projection -> 'supplemental') item(value) loop
    entry := item.value;
    raw_record := records_by_key -> (entry ->> 'sourceKey');
    source_ref := raw_record -> 'sourceRefs' -> 0;
    resolution := entry -> 'resolution';
    source_name := raw_record #>> '{payload,source,identity,name}';
    source_phone := raw_record #>> '{payload,source,identity,phone}';
    source_payload := (raw_record -> 'payload') || jsonb_build_object(
      '_directImport', jsonb_build_object(
        'sourceKey', raw_record ->> 'sourceKey',
        'sourceDigest', raw_record ->> 'sourceDigest',
        'sourceRefs', raw_record -> 'sourceRefs',
        'studentRelationship', raw_record -> 'studentRelationship'
      )
    );
    record_hash := encode(extensions.digest(raw_record::text, 'sha256'), 'hex');
    if resolution ->> 'state' = 'attached' then
      if nullif(btrim(source_name), '') is null or nullif(btrim(source_phone), '') is null then
        raise exception using errcode = '22023', message = 'jiaowubao_direct_import_supplemental_source_identity_missing';
      end if;
      if entry -> 'identityProof' = 'true'::jsonb and exists (
        select 1
        from internal.jiaowubao_direct_supplemental_records existing_identity
        where existing_identity.run_id = p_run_id
          and existing_identity.resolution_state = 'attached'
          and existing_identity.identity_proof
          and existing_identity.student_id = resolution ->> 'studentId'
          and existing_identity.master_source_row = resolution ->> 'masterSourceRow'
          and internal.student_import_name_key(existing_identity.evidence_name) =
              internal.student_import_name_key(source_name)
      ) then
        raise exception using errcode = '22023', message = 'jiaowubao_direct_import_duplicate_identity_proof';
      end if;
    end if;
    insert into internal.jiaowubao_direct_supplemental_records (
      run_id, chunk_index, record_kind, source_key, source_workbook, source_row, source_cell,
      resolution_state, student_id, evidence_phone, identity_proof, master_source_row,
      evidence_name, match_mode, quarantine_reason, source_payload, record_sha256
    ) values (
      p_run_id, chunk_index_value,
      case raw_record ->> 'kind'
        when 'contract_history' then 'contract'
        else raw_record ->> 'kind'
      end,
      raw_record ->> 'sourceKey', source_ref ->> 'workbook', (source_ref ->> 'row')::integer,
      source_ref ->> 'cell',
      resolution ->> 'state',
      case when resolution ->> 'state' = 'attached' then resolution ->> 'studentId' else null end,
      case when resolution ->> 'state' = 'attached' then btrim(source_phone) else null end,
      case when resolution ->> 'state' = 'attached' then (entry ->> 'identityProof')::boolean else false end,
      case when resolution ->> 'state' = 'attached' then resolution ->> 'masterSourceRow' else null end,
      case when resolution ->> 'state' = 'attached' then btrim(source_name) else null end,
      case when resolution ->> 'state' = 'attached' then 'exact_name' else null end,
      case when resolution ->> 'state' = 'quarantined' then resolution ->> 'reason' else null end,
      source_payload, record_hash
    );
  end loop;

  for item in select value from jsonb_array_elements(p_projection -> 'scheduleEvents') item(value) loop
    entry := item.value;
    raw_record := records_by_key -> (entry ->> 'sourceKey');
    source_ref := raw_record -> 'sourceRefs' -> 0;
    temporal := raw_record #> '{payload,staging,temporal}';
    -- A schedule cell's display names are evidence, not optional inferred
    -- bookings. Every source display name must therefore be represented once
    -- as either an attached participant through a phone-proven identity or a
    -- read-only quarantined participant.
    if exists (
      with raw_names as (
        select internal.student_import_name_key(source_name.value) as name_key, count(*)::integer as row_count
        from jsonb_array_elements_text(coalesce(raw_record #> '{payload,source,studentDisplayNames}', '[]'::jsonb)) source_name(value)
        group by internal.student_import_name_key(source_name.value)
      ), projected_names as (
        select internal.student_import_name_key(participant_value.value ->> 'sourceDisplayName') as name_key, count(*)::integer as row_count
        from jsonb_array_elements(entry -> 'participants') participant_value(value)
        group by internal.student_import_name_key(participant_value.value ->> 'sourceDisplayName')
      )
      select 1
      from raw_names
      full join projected_names using (name_key)
      where raw_names.row_count is distinct from projected_names.row_count
         or nullif(name_key, '') is null
    ) then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_participant_coverage_invalid';
    end if;
    if jsonb_typeof(temporal) <> 'object'
       or jsonb_typeof(temporal -> 'state') <> 'string'
       or temporal ->> 'state' not in ('resolved', 'invalid')
       or jsonb_typeof(temporal -> 'sourceDate') <> 'string'
       or temporal ->> 'sourceDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or jsonb_typeof(temporal -> 'sourceTimezone') <> 'string'
       or temporal ->> 'sourceTimezone' <> 'Australia/Melbourne' then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_temporal_invalid';
    end if;
    source_date_value := (temporal ->> 'sourceDate')::date;
    if temporal ->> 'state' = 'resolved' then
      if jsonb_typeof(temporal -> 'start') <> 'string'
         or jsonb_typeof(temporal -> 'end') <> 'string'
         or jsonb_typeof(temporal -> 'sourceStartInstant') <> 'string'
         or jsonb_typeof(temporal -> 'sourceEndInstant') <> 'string' then
        raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_temporal_invalid';
      end if;
      time_parse_reason_value := null;
    else
      if jsonb_typeof(temporal -> 'reason') <> 'string'
         or temporal ->> 'reason' not in ('invalid_time_interval', 'invalid_wall_clock', 'ambiguous_wall_clock', 'non_positive_interval') then
        raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_temporal_invalid';
      end if;
      time_parse_reason_value := case temporal ->> 'reason'
        when 'non_positive_interval' then 'non_positive_time_interval'
        else temporal ->> 'reason'
      end;
    end if;
    source_payload := (raw_record -> 'payload') || jsonb_build_object(
      '_directImport', jsonb_build_object(
        'sourceKey', raw_record ->> 'sourceKey',
        'sourceDigest', raw_record ->> 'sourceDigest',
        'sourceRefs', raw_record -> 'sourceRefs',
        'studentRelationship', raw_record -> 'studentRelationship'
      )
    );
    record_hash := encode(extensions.digest(raw_record::text, 'sha256'), 'hex');
    insert into internal.jiaowubao_direct_schedule_events (
      run_id, chunk_index, source_key, source_workbook, source_row, source_cell,
      source_date, source_timezone, source_timezone_basis, time_parse_status,
      time_parse_reason, dst_resolution, source_local_start, source_local_end,
      starts_at, ends_at, class_name, course_name, teacher_display_name,
      teacher_resolution, teacher_id, subject_resolution, subject_id,
      availability_effect, declared_participant_count, source_payload, record_sha256
    ) values (
      p_run_id, chunk_index_value, raw_record ->> 'sourceKey', source_ref ->> 'workbook',
      (source_ref ->> 'row')::integer, source_ref ->> 'cell',
      source_date_value, temporal ->> 'sourceTimezone', saved_run.source_timezone_basis,
      case when temporal ->> 'state' = 'resolved' then 'parsed' else 'invalid_time' end,
      time_parse_reason_value,
      case when temporal ->> 'state' = 'resolved' then 'unambiguous' else null end,
      case when temporal ->> 'state' = 'resolved' then (temporal ->> 'start')::time else null end,
      case when temporal ->> 'state' = 'resolved' then (temporal ->> 'end')::time else null end,
      case when temporal ->> 'state' = 'resolved' then (temporal ->> 'sourceStartInstant')::timestamptz else null end,
      case when temporal ->> 'state' = 'resolved' then (temporal ->> 'sourceEndInstant')::timestamptz else null end,
      nullif(btrim(raw_record #>> '{payload,source,className}'), ''),
      nullif(btrim(raw_record #>> '{payload,source,course}'), ''),
      nullif(btrim(raw_record #>> '{payload,source,teacher}'), ''),
      entry ->> 'teacherResolution',
      case when entry ->> 'teacherResolution' = 'exact_name' then entry ->> 'teacherId' else null end,
      'unresolved', null,
      entry ->> 'availabilityEffect',
      case when jsonb_typeof(raw_record #> '{payload,source,declaredCount}') = 'number'
        then (raw_record #>> '{payload,source,declaredCount}')::integer else null end,
      source_payload, record_hash
    ) returning id into event_id;

    for participant_item in select value from jsonb_array_elements(entry -> 'participants') participant_value(value) loop
      participant := participant_item.value;
      if not exists (
        select 1
        from jsonb_array_elements_text(coalesce(raw_record #> '{payload,source,studentDisplayNames}', '[]'::jsonb)) source_name_value(value)
        where internal.student_import_name_key(source_name_value.value) =
          internal.student_import_name_key(participant ->> 'sourceDisplayName')
      ) then
        raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_participant_source_name_missing';
      end if;
      if (participant -> 'resolution') ->> 'state' = 'attached' then
        select count(*) into identity_match_count
        from internal.jiaowubao_direct_supplemental_records supplemental_record
        where supplemental_record.run_id = p_run_id
          and supplemental_record.source_key = participant ->> 'identitySupplementalSourceKey'
          and supplemental_record.resolution_state = 'attached'
          and supplemental_record.identity_proof;
        if identity_match_count <> 1 then
          raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_participant_identity_required';
        end if;
        select * into identity_record
        from internal.jiaowubao_direct_supplemental_records supplemental_record
        where supplemental_record.run_id = p_run_id
          and supplemental_record.source_key = participant ->> 'identitySupplementalSourceKey'
          and supplemental_record.resolution_state = 'attached'
          and supplemental_record.identity_proof
        for key share;
      end if;
      insert into internal.jiaowubao_direct_schedule_event_participants (
        event_id, participant_key, source_display_name, resolution_state, student_id,
        identity_supplemental_record_id, master_source_row, evidence_name, match_mode,
        quarantine_reason, source_payload, record_sha256
      ) values (
        event_id, participant ->> 'participantKey', participant ->> 'sourceDisplayName',
        participant -> 'resolution' ->> 'state',
        case when participant -> 'resolution' ->> 'state' = 'attached' then identity_record.student_id else null end,
        case when participant -> 'resolution' ->> 'state' = 'attached' then identity_record.id else null end,
        case when participant -> 'resolution' ->> 'state' = 'attached' then identity_record.master_source_row else null end,
        case when participant -> 'resolution' ->> 'state' = 'attached' then identity_record.evidence_name else null end,
        case when participant -> 'resolution' ->> 'state' = 'attached' then 'exact_name' else null end,
        case when participant -> 'resolution' ->> 'state' = 'quarantined' then participant -> 'resolution' ->> 'reason' else null end,
        source_payload,
        encode(extensions.digest(jsonb_build_object(
          'sourceKey', raw_record ->> 'sourceKey',
          'participantKey', participant ->> 'participantKey',
          'sourceDisplayName', participant ->> 'sourceDisplayName',
          'sourceDigest', raw_record ->> 'sourceDigest'
        )::text, 'sha256'), 'hex')
      );
    end loop;
  end loop;

  for item in select value from jsonb_array_elements(p_projection -> 'leaveMakeups') item(value) loop
    entry := item.value;
    raw_record := records_by_key -> (entry ->> 'sourceKey');
    source_ref := raw_record -> 'sourceRefs' -> 0;
    resolution := entry -> 'resolution';
    source_name := raw_record #>> '{payload,source,identity,name}';
    source_payload := (raw_record -> 'payload') || jsonb_build_object(
      '_directImport', jsonb_build_object(
        'sourceKey', raw_record ->> 'sourceKey',
        'sourceDigest', raw_record ->> 'sourceDigest',
        'sourceRefs', raw_record -> 'sourceRefs',
        'studentRelationship', raw_record -> 'studentRelationship'
      )
    );
    record_hash := encode(extensions.digest(raw_record::text, 'sha256'), 'hex');
    if resolution ->> 'state' = 'attached' and nullif(btrim(source_name), '') is null then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_leave_makeup_source_identity_missing';
    end if;
    insert into internal.jiaowubao_direct_leave_makeup_events (
      run_id, chunk_index, source_key, source_workbook, source_row, source_cell,
      incident_kind, source_date, source_time_text, class_name, course_name,
      teacher_display_name, resolution_state, student_id, master_source_row,
      evidence_name, match_mode, quarantine_reason, source_payload, record_sha256
    ) values (
      p_run_id, chunk_index_value, raw_record ->> 'sourceKey', source_ref ->> 'workbook',
      (source_ref ->> 'row')::integer, source_ref ->> 'cell', entry ->> 'incidentKind',
      case when raw_record #>> '{payload,source,sourceDate}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        then (raw_record #>> '{payload,source,sourceDate}')::date else null end,
      nullif(btrim(raw_record #>> '{payload,source,sourceTime}'), ''),
      nullif(btrim(raw_record #>> '{payload,source,className}'), ''),
      nullif(btrim(raw_record #>> '{payload,source,course}'), ''),
      nullif(btrim(raw_record #>> '{payload,source,teacher}'), ''),
      resolution ->> 'state',
      case when resolution ->> 'state' = 'attached' then resolution ->> 'studentId' else null end,
      case when resolution ->> 'state' = 'attached' then resolution ->> 'masterSourceRow' else null end,
      case when resolution ->> 'state' = 'attached' then btrim(source_name) else null end,
      case when resolution ->> 'state' = 'attached' then 'exact_name' else null end,
      case when resolution ->> 'state' = 'quarantined' then resolution ->> 'reason' else null end,
      source_payload, record_hash
    );
  end loop;

  return jsonb_build_object(
    'runId', p_run_id,
    'chunkIndex', chunk_index_value,
    'state', 'staging',
    'sourceRecordCount', jsonb_array_length(p_chunk -> 'records'),
    'projectedRecordCounts', projected_counts,
    'replayed', false
  );
end;
$stage_jiaowubao_direct_import_chunk$;

revoke all on function internal.stage_jiaowubao_direct_import_chunk(uuid, jsonb, jsonb, text)
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_payload_sha256(p_run_id uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_payload_sha256$
declare
  canonical_projection jsonb;
begin
  select jsonb_build_object(
    'run', jsonb_build_object(
      'sourceId', run_state.source_id,
      'revision', run_state.revision,
      'format', run_state.format,
      'sourceTimezone', run_state.source_timezone,
      'sourceTimezoneBasis', run_state.source_timezone_basis,
      'masterSource', jsonb_build_object(
        'sourceId', run_state.master_source_id,
        'revision', run_state.master_revision,
        'rowsSha256', run_state.master_rows_sha256
      ),
      'recordCounts', run_state.source_record_counts,
      'expectedCounts', run_state.expected_counts
    ),
    'chunks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'index', chunk.chunk_index,
        'chunkSha256', chunk.chunk_sha256,
        'projectionSha256', chunk.projection_sha256,
        'sourceRecordCount', chunk.source_record_count,
        'projectedRecordCounts', chunk.projected_record_counts
      ) order by chunk.chunk_index)
      from internal.jiaowubao_direct_import_chunks chunk
      where chunk.run_id = p_run_id
    ), '[]'::jsonb),
    'supplemental', coalesce((
      select jsonb_agg(jsonb_build_object(
        'chunkIndex', record.chunk_index,
        'recordKind', record.record_kind,
        'sourceKey', record.source_key,
        'recordSha256', record.record_sha256
      ) order by record.chunk_index, record.record_kind, record.source_key)
      from internal.jiaowubao_direct_supplemental_records record
      where record.run_id = p_run_id
    ), '[]'::jsonb),
    'schedule', coalesce((
      select jsonb_agg(jsonb_build_object(
        'chunkIndex', schedule_event.chunk_index,
        'sourceKey', schedule_event.source_key,
        'recordSha256', schedule_event.record_sha256
      ) order by schedule_event.chunk_index, schedule_event.source_key)
      from internal.jiaowubao_direct_schedule_events schedule_event
      where schedule_event.run_id = p_run_id
    ), '[]'::jsonb),
    'scheduleParticipants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'eventSourceKey', schedule_event.source_key,
        'participantKey', participant.participant_key,
        'recordSha256', participant.record_sha256
      ) order by schedule_event.chunk_index, schedule_event.source_key, participant.participant_key)
      from internal.jiaowubao_direct_schedule_event_participants participant
      join internal.jiaowubao_direct_schedule_events schedule_event on schedule_event.id = participant.event_id
      where schedule_event.run_id = p_run_id
    ), '[]'::jsonb),
    'leaveMakeups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'chunkIndex', leave_makeup_event.chunk_index,
        'sourceKey', leave_makeup_event.source_key,
        'recordSha256', leave_makeup_event.record_sha256
      ) order by leave_makeup_event.chunk_index, leave_makeup_event.source_key)
      from internal.jiaowubao_direct_leave_makeup_events leave_makeup_event
      where leave_makeup_event.run_id = p_run_id
    ), '[]'::jsonb)
  ) into canonical_projection
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id;
  if canonical_projection is null then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_run_not_found';
  end if;
  return encode(extensions.digest(canonical_projection::text, 'sha256'), 'hex');
end;
$jiaowubao_direct_import_payload_sha256$;

revoke all on function internal.jiaowubao_direct_import_payload_sha256(uuid)
  from public, anon, authenticated;

create or replace function internal.complete_jiaowubao_direct_import(
  p_run_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $complete_jiaowubao_direct_import$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  completion_audit_entry_id uuid;
  payload_hash text;
begin
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or char_length(p_actor) > 120 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_actor_invalid';
  end if;
  perform internal.jiaowubao_direct_import_assert_staging(p_run_id);
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id
  for update;
  if saved_run.staged_by <> p_actor then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_actor_mismatch';
  end if;
  perform internal.jiaowubao_direct_import_assert_complete(p_run_id);
  payload_hash := internal.jiaowubao_direct_import_payload_sha256(p_run_id);
  completion_audit_entry_id := internal.append_operational_contract_audit(
    'jiaowubao_direct_import.completed', p_actor,
    'jiaowubao_direct_import_run', p_run_id::text,
    jsonb_build_object(
      'sourceId', saved_run.source_id,
      'revision', saved_run.revision,
      'payloadSha256', payload_hash,
      'chunkCount', saved_run.expected_chunk_count,
      'recordCounts', saved_run.source_record_counts,
      'expectedCounts', saved_run.expected_counts,
      'masterSourceId', saved_run.master_source_id,
      'masterRevision', saved_run.master_revision,
      'masterRowsSha256', saved_run.master_rows_sha256
    )
  );
  update internal.jiaowubao_direct_import_runs run_state
  set state = 'complete', payload_sha256 = payload_hash,
      completed_at = now(), completion_audit_id = completion_audit_entry_id
  where run_state.id = p_run_id
  returning * into saved_run;
  return jsonb_build_object(
    'runId', saved_run.id,
    'sourceId', saved_run.source_id,
    'revision', saved_run.revision,
    'state', saved_run.state,
    'payloadSha256', saved_run.payload_sha256,
    'chunkCount', saved_run.expected_chunk_count,
    'recordCounts', saved_run.source_record_counts,
    'expectedCounts', saved_run.expected_counts
  );
end;
$complete_jiaowubao_direct_import$;

revoke all on function internal.complete_jiaowubao_direct_import(uuid, text)
  from public, anon, authenticated;

-- This is a small-fixture and exact-replay convenience entrypoint.
-- PostgreSQL executes it in one transaction; if begin, any chunk, or
-- completion rejects, every run, audit, ledger, and projected row rolls back
-- together. Production must use the explicit trusted-session transaction
-- above instead: passing a whole many-chunk artifact as one JSON value is
-- impractical for the 100MB-scale export and must not turn into a public API.
--
-- Exact adapter from `lib/jiaowubao-direct-import-preflight.ts`:
--   * `chunks[*].chunk` is an unchanged `JiaowubaoDirectStagingChunk`
--     (`format: jiaowubao-direct-staging-v1`), including its repeated
--     contract/workbooks/recordCounts envelope and raw `records` array.
--   * Top-level envelope fields are copied from that chunk/manifest, with
--     `format: jiaowubao-direct-import-v1`, current Tencent `masterSource`,
--     reviewed `expectedCounts`, and local `actor` added.
--   * `chunks[*].projection` is the only new, deterministic reviewed map; it
--     may select exact current IDs or quarantine states, but never names,
--     phones, source refs, timing, class values, or source payloads. Those are
--     derived below from the unchanged preflight chunk.
create or replace function internal.apply_jiaowubao_direct_import_atomic(p_import jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $apply_jiaowubao_direct_import_atomic$
declare
  envelope jsonb;
  wrapper record;
  run_id uuid;
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  completion_audit internal.operational_contract_audit%rowtype;
  completion_result jsonb;
begin
  perform internal.jiaowubao_direct_import_assert_object_shape(
    p_import,
    ARRAY[
      'format', 'sourceId', 'revision', 'sourceTimezone', 'sourceTimezoneBasis',
      'masterSource', 'workbooks', 'recordCounts', 'expectedCounts', 'chunkCount',
      'actor', 'chunks'
    ],
    'jiaowubao_direct_import_atomic_shape_invalid'
  );
  envelope := p_import - ARRAY['actor', 'chunks']::text[];
  perform internal.jiaowubao_direct_import_assert_envelope(envelope);
  if jsonb_typeof(p_import -> 'actor') <> 'string'
     or nullif(btrim(p_import ->> 'actor'), '') is null
     or p_import ->> 'actor' <> btrim(p_import ->> 'actor')
     or char_length(p_import ->> 'actor') > 120
     or jsonb_typeof(p_import -> 'chunks') <> 'array'
     or jsonb_array_length(p_import -> 'chunks') <> (p_import ->> 'chunkCount')::integer then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_atomic_shape_invalid';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_import -> 'chunks') item(value)
    where jsonb_typeof(item.value) <> 'object'
       or item.value - ARRAY['chunk', 'projection']::text[] <> '{}'::jsonb
       or not (item.value ?& ARRAY['chunk', 'projection'])
       or jsonb_typeof(item.value -> 'chunk') <> 'object'
       or jsonb_typeof(item.value -> 'projection') <> 'object'
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_atomic_chunk_shape_invalid';
  end if;

  run_id := internal.begin_jiaowubao_direct_import(envelope, p_import ->> 'actor');
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = run_id
  for update;

  -- A completed identical request is a safe retry (for example, after a local
  -- CLI lost its response after PostgreSQL committed).  It may not restage
  -- rows.  Instead, prove that every supplied raw chunk and reviewed
  -- projection hashes to the immutable persisted ledger before returning the
  -- original completion receipt.  This deliberately remains inside the
  -- server-only entrypoint: there is no public status/read RPC.
  if saved_run.state = 'complete' then
    select * into completion_audit
    from internal.operational_contract_audit audit_entry
    where audit_entry.id = saved_run.completion_audit_id;
    if completion_audit.id is null
       or completion_audit.action <> 'jiaowubao_direct_import.completed'
       or completion_audit.actor <> p_import ->> 'actor'
       or completion_audit.target_type <> 'jiaowubao_direct_import_run'
       or completion_audit.target_id <> saved_run.id::text
       or completion_audit.metadata ->> 'sourceId' <> saved_run.source_id
       or completion_audit.metadata ->> 'revision' <> saved_run.revision
       or completion_audit.metadata ->> 'payloadSha256' <> saved_run.payload_sha256
       or saved_run.payload_sha256 is null
       or (select count(*) from internal.jiaowubao_direct_import_chunks chunk
           where chunk.run_id = saved_run.id) <> saved_run.expected_chunk_count
       or exists (
         with supplied_chunks as (
           select
             case
               when jsonb_typeof(item.value -> 'chunk' -> 'chunk' -> 'index') = 'number'
                and item.value -> 'chunk' -> 'chunk' ->> 'index' ~ '^-?[0-9]+(\\.0+)?$'
                and (item.value -> 'chunk' -> 'chunk' ->> 'index')::numeric between 0 and 511
               then (item.value -> 'chunk' -> 'chunk' ->> 'index')::integer
               else null
             end as chunk_index,
             encode(extensions.digest((item.value -> 'chunk')::text, 'sha256'), 'hex') as chunk_sha256,
             encode(extensions.digest((item.value -> 'projection')::text, 'sha256'), 'hex') as projection_sha256
           from jsonb_array_elements(p_import -> 'chunks') item(value)
         ), persisted_chunks as materialized (
           select chunk.chunk_index, chunk.chunk_sha256, chunk.projection_sha256
           from internal.jiaowubao_direct_import_chunks chunk
           where chunk.run_id = saved_run.id
         )
         select 1
         from supplied_chunks
         where chunk_index is null
         union all
         select 1
         from supplied_chunks
         group by chunk_index
         having count(*) <> 1
         union all
         select 1
         from supplied_chunks supplied
         full join persisted_chunks persisted
           on persisted.chunk_index = supplied.chunk_index
         where persisted.chunk_index is null
            or supplied.chunk_index is null
            or persisted.chunk_sha256 <> supplied.chunk_sha256
            or persisted.projection_sha256 <> supplied.projection_sha256
       ) then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_completed_replay_mismatch';
    end if;
    return jsonb_build_object(
      'runId', saved_run.id,
      'sourceId', saved_run.source_id,
      'revision', saved_run.revision,
      'state', saved_run.state,
      'payloadSha256', saved_run.payload_sha256,
      'chunkCount', saved_run.expected_chunk_count,
      'recordCounts', saved_run.source_record_counts,
      'expectedCounts', saved_run.expected_counts,
      'replayed', true
    );
  end if;

  for wrapper in
    select item.value as value
    from jsonb_array_elements(p_import -> 'chunks') item(value)
    order by (item.value -> 'chunk' -> 'chunk' ->> 'index')::integer
  loop
    perform internal.stage_jiaowubao_direct_import_chunk(
      run_id, wrapper.value -> 'chunk', wrapper.value -> 'projection', p_import ->> 'actor'
    );
  end loop;
  completion_result := internal.complete_jiaowubao_direct_import(run_id, p_import ->> 'actor');
  return completion_result;
end;
$apply_jiaowubao_direct_import_atomic$;

revoke all on function internal.apply_jiaowubao_direct_import_atomic(jsonb)
  from public, anon, authenticated;
