-- Postgres Management API bridge for the already-reviewed, exact/unique JWB
-- identity merge batch.
--
-- This is a private owner path.  It deliberately does not call or alter the
-- existing public OPS-secret RPCs.  The same canonical candidate, plan, CAS,
-- replay and immutable command-ledger protocol is recomputed in this
-- transaction, but the bridge obtains its authority from the Management API
-- postgres session rather than from OPS_API_SECRET.
--
-- The requested release batch is intentionally narrow: exactly eight current
-- pending merge candidates, with no unresolved duplicate-master group.  A
-- changed source revision, student version, review epoch, link set, or
-- candidate set changes the opaque key and fails closed.

create or replace function internal.student_import_identity_bulk_management_session()
returns void
language plpgsql
security invoker
set search_path = ''
as $student_import_identity_bulk_management_session$
begin
  if session_user <> 'postgres' or current_user <> 'postgres' then
    raise exception using errcode = '42501',
      message = 'student_import_identity_bulk_management_session_required';
  end if;
end;
$student_import_identity_bulk_management_session$;

revoke all on function internal.student_import_identity_bulk_management_session()
  from public, anon, authenticated, service_role;

create or replace function internal.student_import_identity_bulk_management_review(
  p_mode text,
  p_confirmation_key text default null,
  p_actor text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '8s'
as $student_import_identity_bulk_management_review$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
  saved internal.student_import_identity_link_sets%rowtype;
  prior_command internal.student_import_identity_bulk_review_commands%rowtype;
  active_links jsonb := '[]'::jsonb;
  active_fingerprint text;
  duplicate_snapshot jsonb;
  resolved_master_rows jsonb;
  merge_candidates jsonb;
  merge_plan jsonb;
  expected_key text;
  after_fingerprint text;
  audit_entry_id uuid;
  review_epoch bigint;
  saved_matches_current boolean := false;
  unresolved_duplicate_group_count integer := 0;
  before_link_count integer;
  requested_count integer;
  newly_applied_count integer;
  already_applied_count integer;
  final_count integer;
  expected_review_count constant integer := 8;
begin
  perform internal.student_import_identity_bulk_management_session();

  if p_mode is null
     or p_mode not in ('preview', 'commit')
     or nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or p_actor not in ('Nixon', 'Ops Admin')
     or (p_mode = 'preview' and p_confirmation_key is not null)
     or (p_mode = 'commit'
       and coalesce(p_confirmation_key, '') !~ '^sha256:[a-f0-9]{64}$') then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_bulk_management_request';
  end if;

  -- Preview and commit use the same ordered locks.  Preview therefore cannot
  -- issue a key from a half-written source or link-set state.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'student_import_identity_link_set:singleton', 0
  ));
  select * into jwb
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'jwb'
  for update;
  select * into master
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'master'
  for update;
  select * into saved
  from internal.student_import_identity_link_sets identity_state
  where identity_state.singleton
  for update;
  select * into students_state
  from public.ops_state state_row
  where state_row.entity = 'students'
  for update;

  if master.source_kind is null or jwb.source_kind is null then
    raise exception using errcode = 'P0002',
      message = 'student_import_source_rows_unavailable';
  end if;
  if students_state.entity is null
     or jsonb_typeof(students_state.payload) <> 'array'
     or students_state.version < 0
     or students_state.version > 9007199254740991 then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;

  review_epoch := coalesce(saved.review_epoch, 0);
  if review_epoch < 0 or review_epoch > 9007199254740991 then
    raise exception using errcode = '55000',
      message = 'student_import_identity_review_epoch_invalid';
  end if;

  if saved.singleton
     and saved.master_source_id = master.source_id
     and saved.master_revision = master.revision
     and saved.jwb_source_id = jwb.source_id
     and saved.jwb_revision = jwb.revision
     and saved.students_version = students_state.version then
    saved_matches_current := true;
    active_links := saved.links;
  end if;

  active_fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', active_links
  )::text, 'sha256'), 'hex');
  if saved_matches_current and (
    saved.link_count <> jsonb_array_length(active_links)
    or saved.link_fingerprint <> active_fingerprint
  ) then
    raise exception using errcode = '55000',
      message = 'student_import_identity_bulk_review_linkset_invalid';
  end if;

  -- The duplicate snapshot is the same authoritative decision boundary used
  -- by the public bulk review.  Count only groups with no matching saved
  -- decision; an already-reviewed duplicate group is not an ambiguity.
  duplicate_snapshot := internal.student_import_master_duplicate_snapshot(
    master, students_state
  );
  select count(*)::integer
  into unresolved_duplicate_group_count
  from jsonb_array_elements(duplicate_snapshot -> 'candidates') candidate(value)
  where not exists (
    select 1
    from jsonb_array_elements(duplicate_snapshot -> 'decisions') decision(value)
    where decision.value -> 'sourceRows' = candidate.value -> 'sourceRows'
  );

  if p_mode = 'commit' then
    -- A command replay is accepted only for the same source/CAS state and
    -- only if the prior command itself was this exact eight-row release batch.
    select * into prior_command
    from internal.student_import_identity_bulk_review_commands command
    where command.confirmation_key = p_confirmation_key
    for update;
    if found then
      if prior_command.requested_count <> expected_review_count
         or prior_command.master_source_id <> master.source_id
         or prior_command.master_revision <> master.revision
         or prior_command.master_rows_sha256 <> master.rows_sha256
         or prior_command.jwb_source_id <> jwb.source_id
         or prior_command.jwb_revision <> jwb.revision
         or prior_command.jwb_rows_sha256 <> jwb.rows_sha256
         or prior_command.students_version <> students_state.version
         or prior_command.review_epoch <> review_epoch
         or unresolved_duplicate_group_count <> 0
         or prior_command.duplicate_resolution_fingerprint <>
            duplicate_snapshot ->> 'fingerprint'
         or not saved_matches_current
         or saved.link_fingerprint <> prior_command.after_link_fingerprint
         or saved.link_count <> prior_command.final_count
         or saved.audit_id <> prior_command.audit_id then
        raise exception using errcode = '40001',
          message = 'student_import_identity_bulk_review_replay_conflict';
      end if;
      return jsonb_build_object(
        'mode', 'commit',
        'confirmationKey', prior_command.confirmation_key,
        'fingerprint', prior_command.after_link_fingerprint,
        'count', prior_command.final_count,
        'requestedCount', prior_command.requested_count,
        'newlyAppliedCount', prior_command.newly_applied_count,
        'alreadyAppliedCount', prior_command.already_applied_count,
        'finalCount', prior_command.final_count,
        'masterRevision', master.revision,
        'jwbRevision', jwb.revision,
        'studentsVersion', students_state.version,
        'reviewEpoch', review_epoch,
        'reviewedBatchCount', expected_review_count,
        'unchanged', true
      );
    end if;
  end if;

  -- Reuse the established duplicate-resolved master projection and the
  -- established set-based merge candidates and planner verbatim.
  resolved_master_rows := internal.student_import_identity_resolved_master_rows(
    master.rows, duplicate_snapshot
  );
  merge_candidates := internal.student_import_identity_bulk_merge_candidates(
    master.source_id, master.revision, resolved_master_rows,
    jwb.source_id, jwb.revision, jwb.rows,
    students_state.version, review_epoch, students_state.payload
  );
  merge_plan := internal.student_import_identity_bulk_merge_plan(
    merge_candidates, active_links
  );
  expected_key := internal.student_import_identity_bulk_review_key(
    master.source_id, master.revision, master.rows_sha256,
    jwb.source_id, jwb.revision, jwb.rows_sha256,
    students_state.version, review_epoch, active_fingerprint,
    duplicate_snapshot ->> 'fingerprint', merge_plan ->> 'planFingerprint'
  );

  requested_count := (merge_plan ->> 'mergeCandidateCount')::integer;
  newly_applied_count := (merge_plan ->> 'pendingMergeCount')::integer;
  already_applied_count := (merge_plan ->> 'alreadyLinkedMergeCount')::integer;
  before_link_count := (merge_plan ->> 'currentLinkCount')::integer;
  final_count := (merge_plan ->> 'resultingLinkCount')::integer;

  if p_mode = 'preview' then
    return jsonb_build_object(
      'mode', 'preview',
      'confirmationKey', expected_key,
      'mergeCandidateCount', requested_count,
      'pendingMergeCount', newly_applied_count,
      'alreadyLinkedMergeCount', already_applied_count,
      'currentLinkCount', before_link_count,
      'resultingLinkCount', final_count,
      'reviewedBatchCount', expected_review_count,
      'unresolvedDuplicateGroupCount', unresolved_duplicate_group_count,
      'masterSourceId', master.source_id,
      'masterRevision', master.revision,
      'masterRowsSha256', master.rows_sha256,
      'jwbSourceId', jwb.source_id,
      'jwbRevision', jwb.revision,
      'jwbRowsSha256', jwb.rows_sha256,
      'studentsVersion', students_state.version,
      'reviewEpoch', review_epoch,
      'canSubmit', requested_count = expected_review_count
        and newly_applied_count = expected_review_count
        and unresolved_duplicate_group_count = 0
    );
  end if;

  if expected_key <> p_confirmation_key then
    raise exception using errcode = '23503',
      message = 'student_import_identity_bulk_review_unavailable';
  end if;
  if requested_count <> expected_review_count
     or newly_applied_count <> expected_review_count
     or unresolved_duplicate_group_count <> 0
     or requested_count <> newly_applied_count + already_applied_count
     or final_count <> before_link_count + newly_applied_count
     or final_count <> jsonb_array_length(merge_plan -> 'combinedLinks') then
    raise exception using errcode = '55000',
      message = 'student_import_identity_bulk_management_batch_not_exact';
  end if;

  after_fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', merge_plan -> 'combinedLinks'
  )::text, 'sha256'), 'hex');

  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.identity_bulk_review_confirmed', p_actor,
    'student_import_identity_bulk_review', p_confirmation_key,
    jsonb_build_object(
      'confirmationKey', p_confirmation_key,
      'masterSourceId', master.source_id,
      'masterRevision', master.revision,
      'masterRowsSha256', master.rows_sha256,
      'jwbSourceId', jwb.source_id,
      'jwbRevision', jwb.revision,
      'jwbRowsSha256', jwb.rows_sha256,
      'studentsVersion', students_state.version,
      'reviewEpoch', review_epoch,
      'duplicateResolutionFingerprint', duplicate_snapshot ->> 'fingerprint',
      'planFingerprint', merge_plan ->> 'planFingerprint',
      'beforeLinkFingerprint', active_fingerprint,
      'afterLinkFingerprint', after_fingerprint,
      'beforeLinkCount', before_link_count,
      'requestedCount', requested_count,
      'newlyAppliedCount', newly_applied_count,
      'alreadyAppliedCount', already_applied_count,
      'finalCount', final_count,
      'managementBridge', true
    )
  );

  insert into internal.student_import_identity_link_sets (
    singleton, master_source_id, master_revision, jwb_source_id, jwb_revision,
    students_version, review_epoch, links, link_count, link_fingerprint,
    updated_by, updated_at, audit_id
  ) values (
    true, master.source_id, master.revision, jwb.source_id, jwb.revision,
    students_state.version, review_epoch,
    merge_plan -> 'combinedLinks', final_count, after_fingerprint,
    left(trim(p_actor), 120), now(), audit_entry_id
  ) on conflict (singleton) do update set
    master_source_id = excluded.master_source_id,
    master_revision = excluded.master_revision,
    jwb_source_id = excluded.jwb_source_id,
    jwb_revision = excluded.jwb_revision,
    students_version = excluded.students_version,
    review_epoch = excluded.review_epoch,
    links = excluded.links,
    link_count = excluded.link_count,
    link_fingerprint = excluded.link_fingerprint,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at,
    audit_id = excluded.audit_id;

  insert into internal.student_import_identity_bulk_review_commands (
    confirmation_key,
    master_source_id, master_revision, master_rows_sha256,
    jwb_source_id, jwb_revision, jwb_rows_sha256,
    students_version, review_epoch,
    duplicate_resolution_fingerprint, plan_fingerprint,
    before_link_fingerprint, after_link_fingerprint, before_link_count,
    requested_count, newly_applied_count, already_applied_count, final_count,
    confirmed_by, confirmed_at, audit_id
  ) values (
    p_confirmation_key,
    master.source_id, master.revision, master.rows_sha256,
    jwb.source_id, jwb.revision, jwb.rows_sha256,
    students_state.version, review_epoch,
    duplicate_snapshot ->> 'fingerprint', merge_plan ->> 'planFingerprint',
    active_fingerprint, after_fingerprint, before_link_count,
    requested_count, newly_applied_count, already_applied_count, final_count,
    left(trim(p_actor), 120), now(), audit_entry_id
  );

  return jsonb_build_object(
    'mode', 'commit',
    'confirmationKey', p_confirmation_key,
    'fingerprint', after_fingerprint,
    'count', final_count,
    'requestedCount', requested_count,
    'newlyAppliedCount', newly_applied_count,
    'alreadyAppliedCount', already_applied_count,
    'finalCount', final_count,
    'masterRevision', master.revision,
    'jwbRevision', jwb.revision,
    'studentsVersion', students_state.version,
    'reviewEpoch', review_epoch,
    'reviewedBatchCount', expected_review_count,
    'unchanged', false
  );
end;
$student_import_identity_bulk_management_review$;

revoke all on function internal.student_import_identity_bulk_management_review(text, text, text)
  from public, anon, authenticated, service_role;

create or replace function internal.student_import_identity_bulk_management_preview(p_actor text)
returns jsonb
language sql
security invoker
set search_path = ''
as $student_import_identity_bulk_management_preview$
  select internal.student_import_identity_bulk_management_review('preview', null, p_actor)
$student_import_identity_bulk_management_preview$;

revoke all on function internal.student_import_identity_bulk_management_preview(text)
  from public, anon, authenticated, service_role;

create or replace function internal.student_import_identity_bulk_management_commit(
  p_confirmation_key text,
  p_actor text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $student_import_identity_bulk_management_commit$
  select internal.student_import_identity_bulk_management_review('commit', p_confirmation_key, p_actor)
$student_import_identity_bulk_management_commit$;

revoke all on function internal.student_import_identity_bulk_management_commit(text, text)
  from public, anon, authenticated, service_role;

alter function internal.student_import_identity_bulk_management_session() owner to postgres;
alter function internal.student_import_identity_bulk_management_review(text, text, text) owner to postgres;
alter function internal.student_import_identity_bulk_management_preview(text) owner to postgres;
alter function internal.student_import_identity_bulk_management_commit(text, text) owner to postgres;

comment on function internal.student_import_identity_bulk_management_preview(text)
  is 'Postgres Management API-only aggregate preview for the exact eight-row JWB identity merge release batch.';
comment on function internal.student_import_identity_bulk_management_commit(text, text)
  is 'Postgres Management API-only commit for the opaque key returned by the exact eight-row JWB identity preview.';
