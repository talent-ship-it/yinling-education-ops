-- A current partial JWB ledger keeps its verified packages active and records
-- the unverified aggregate as `currentAggregate`.  On replay, that same
-- current ledger must not be mistaken for stale facts and moved into
-- `retained`; doing so changes the canonical JSONB on every replay.

set local lock_timeout = '1s';

do $student_import_partial_jwb_snapshot_replay$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_projection_missing';
  end if;

  anchor := $partial_snapshot_declaration_anchor$  partial_ledger boolean;
  source_remaining numeric;
$partial_snapshot_declaration_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_partial_snapshot_declaration_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $partial_snapshot_declaration_replacement$  partial_ledger boolean;
  partial_same_jwb_source boolean := false;
  source_remaining numeric;
$partial_snapshot_declaration_replacement$);

  anchor := $partial_snapshot_facts_anchor$    existing_snapshot := internal.student_import_historical_jwb_snapshot(
      existing_student -> 'historicalJwbSnapshot'
    );
    displaced_facts := null;
    if not complete_ledger and (
      jsonb_array_length(displaced_jwb_packages) > 0
      or jsonb_typeof(existing_student -> 'remainingHours') = 'number'
      or jsonb_typeof(existing_student -> 'contractHours') = 'number'
      or (jsonb_typeof(existing_student -> 'contractEffectiveDate') = 'string'
        and nullif(btrim(existing_student ->> 'contractEffectiveDate'), '') is not null)
      or (jsonb_typeof(existing_student -> 'firstJwbHourEntryDate') = 'string'
        and nullif(btrim(existing_student ->> 'firstJwbHourEntryDate'), '') is not null)
      or existing_coverage is not null
    ) then
      displaced_facts := internal.student_import_historical_jwb_facts(
        jsonb_strip_nulls(jsonb_build_object(
          'lessonPackages', case when jsonb_array_length(displaced_jwb_packages) > 0
            then displaced_jwb_packages else null end,
          'remainingHours', case when jsonb_typeof(existing_student -> 'remainingHours') = 'number'
            then existing_student -> 'remainingHours' else null end,
          'contractHours', case when jsonb_typeof(existing_student -> 'contractHours') = 'number'
            then existing_student -> 'contractHours' else null end,
          'contractEffectiveDate', case when jsonb_typeof(existing_student -> 'contractEffectiveDate') = 'string'
            then btrim(existing_student ->> 'contractEffectiveDate') else null end,
          'firstJwbHourEntryDate', case when jsonb_typeof(existing_student -> 'firstJwbHourEntryDate') = 'string'
            then btrim(existing_student ->> 'firstJwbHourEntryDate') else null end,
          'packageCoverage', existing_coverage,
          'jwbSourceRow', case when existing_student ? 'jwbSourceRow'
            then existing_student -> 'jwbSourceRow' else null end
        )), true
      );
    end if;
$partial_snapshot_facts_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_partial_snapshot_facts_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $partial_snapshot_facts_replacement$    existing_snapshot := internal.student_import_historical_jwb_snapshot(
      existing_student -> 'historicalJwbSnapshot'
    );
    -- A partial ledger from the same JWB source is current evidence, not
    -- stale history. Preserve only genuinely displaced PKG-JWB rows; never
    -- re-snapshot its active aggregate, date, coverage, or source pointer.
    partial_same_jwb_source := coalesce(partial_ledger, false)
      and internal.student_import_source_key(existing_student -> 'jwbSourceRow')
        is not distinct from internal.student_import_source_key(matched_jwb -> 'sourceRow');
    displaced_facts := null;
    if not complete_ledger and (
      jsonb_array_length(displaced_jwb_packages) > 0
      or (
        not partial_same_jwb_source
        and (
          jsonb_typeof(existing_student -> 'remainingHours') = 'number'
          or jsonb_typeof(existing_student -> 'contractHours') = 'number'
          or (jsonb_typeof(existing_student -> 'contractEffectiveDate') = 'string'
            and nullif(btrim(existing_student ->> 'contractEffectiveDate'), '') is not null)
          or (jsonb_typeof(existing_student -> 'firstJwbHourEntryDate') = 'string'
            and nullif(btrim(existing_student ->> 'firstJwbHourEntryDate'), '') is not null)
          or existing_coverage is not null
        )
      )
    ) then
      displaced_facts := internal.student_import_historical_jwb_facts(
        jsonb_strip_nulls(jsonb_build_object(
          'lessonPackages', case when jsonb_array_length(displaced_jwb_packages) > 0
            then displaced_jwb_packages else null end,
          'remainingHours', case when not partial_same_jwb_source
            and jsonb_typeof(existing_student -> 'remainingHours') = 'number'
            then existing_student -> 'remainingHours' else null end,
          'contractHours', case when not partial_same_jwb_source
            and jsonb_typeof(existing_student -> 'contractHours') = 'number'
            then existing_student -> 'contractHours' else null end,
          'contractEffectiveDate', case when not partial_same_jwb_source
            and jsonb_typeof(existing_student -> 'contractEffectiveDate') = 'string'
            then btrim(existing_student ->> 'contractEffectiveDate') else null end,
          'firstJwbHourEntryDate', case when not partial_same_jwb_source
            and jsonb_typeof(existing_student -> 'firstJwbHourEntryDate') = 'string'
            then btrim(existing_student ->> 'firstJwbHourEntryDate') else null end,
          'packageCoverage', case when not partial_same_jwb_source
            then existing_coverage else null end,
          'jwbSourceRow', case when not partial_same_jwb_source
            and existing_student ? 'jwbSourceRow'
            then existing_student -> 'jwbSourceRow' else null end
        )), true
      );
    end if;
$partial_snapshot_facts_replacement$);

  execute definition;

  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if position('partial_same_jwb_source boolean := false' in definition) = 0
     or position('partial_same_jwb_source := coalesce(partial_ledger, false)' in definition) = 0
     or position('is not distinct from internal.student_import_source_key(matched_jwb -> ''sourceRow'')' in definition) = 0 then
    raise exception using errcode = 'P0001', message = 'student_import_partial_snapshot_patch_verification_failed';
  end if;
end;
$student_import_partial_jwb_snapshot_replay$;
