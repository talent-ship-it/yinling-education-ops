-- A resumable writer may discover that the Tencent master fingerprint changed
-- while a direct-import run was staging. Do not let a client-side observation
-- decide a destructive cleanup on its own: this helper pins the exact current
-- master fingerprint under lock and aborts only when it differs from the
-- run-bound master. If the current source changed again, or there is no drift,
-- it returns a no-op receipt and deletes nothing.
--
-- Scope is deliberately limited to the Tencent master source. The students and
-- teachers `ops_state` projections are separate completion authorities and do
-- not have a run-bound version in 011, so treating their drift as permission
-- to delete staged source evidence here would be unsafe. That needs a later
-- explicitly version-bound authority epoch, not an inference in this helper.

set local lock_timeout = '1s';

create or replace function internal.abort_jiaowubao_direct_import_if_current_master_differs(
  p_run_id uuid,
  p_actor text,
  p_expected_master_source_id text,
  p_expected_master_revision text,
  p_expected_master_rows_sha256 text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $abort_jiaowubao_direct_import_if_current_master_differs$
declare
  lookup_run internal.jiaowubao_direct_import_runs%rowtype;
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  current_master internal.student_import_source_rows%rowtype;
  abort_receipt jsonb;
begin
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or char_length(p_actor) > 120 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_actor_invalid';
  end if;
  if nullif(btrim(p_expected_master_source_id), '') is null
     or p_expected_master_source_id <> btrim(p_expected_master_source_id)
     or char_length(p_expected_master_source_id) > 160
     or nullif(btrim(p_expected_master_revision), '') is null
     or p_expected_master_revision <> btrim(p_expected_master_revision)
     or char_length(p_expected_master_revision) > 240
     or p_expected_master_rows_sha256 is null
     or p_expected_master_rows_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_expected_master_shape_invalid';
  end if;

  -- Use the same advisory-lock-before-run-lock ordering as begin/abort. The
  -- run binding is immutable, so this preliminary lookup is safe only to form
  -- the revision advisory key; the locked read below is authoritative.
  select * into lookup_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_run_not_found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('jiaowubao-direct-import:' || lookup_run.source_id || ':' || lookup_run.revision)
  );
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id
  for update;
  if saved_run.state <> 'staging' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_run_not_staging';
  end if;
  if saved_run.staged_by <> p_actor then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_actor_mismatch';
  end if;

  -- Completion also locks run then master. Keep that order so an authority
  -- refresh cannot pass between the caller's observation and cleanup.
  select * into current_master
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'master'
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_master_source_unavailable';
  end if;

  if current_master.source_id is distinct from p_expected_master_source_id
     or current_master.revision is distinct from p_expected_master_revision
     or current_master.rows_sha256 is distinct from p_expected_master_rows_sha256 then
    return jsonb_build_object(
      'runId', saved_run.id,
      'state', saved_run.state,
      'aborted', false,
      'reason', 'current_master_not_expected'
    );
  end if;

  if current_master.source_id is not distinct from saved_run.master_source_id
     and current_master.revision is not distinct from saved_run.master_revision
     and current_master.rows_sha256 is not distinct from saved_run.master_rows_sha256 then
    return jsonb_build_object(
      'runId', saved_run.id,
      'state', saved_run.state,
      'aborted', false,
      'reason', 'run_master_still_current'
    );
  end if;

  -- Delegate the actual transition, audit, transaction-local cleanup
  -- capability, and dependency-ordered deletion to the 011 abort function.
  -- The parent-run and master locks acquired above remain held until commit.
  abort_receipt := internal.abort_jiaowubao_direct_import(p_run_id, p_actor);
  return abort_receipt || jsonb_build_object(
    'runId', p_run_id,
    'state', 'aborted',
    'aborted', true
  );
end;
$abort_jiaowubao_direct_import_if_current_master_differs$;

revoke all on function internal.abort_jiaowubao_direct_import_if_current_master_differs(uuid, text, text, text, text)
  from public, anon, authenticated;
