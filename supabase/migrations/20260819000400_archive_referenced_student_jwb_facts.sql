-- Referenced-history students are retained for immutable operational links,
-- but they are not part of the active Tencent-authoritative roster. Move any
-- former JWB ledger facts into the existing read-only historical snapshot so
-- signed legacy balances remain valid evidence without being consumed by
-- booking or capacity balances. Every package stays top-level because an
-- immutable historical booking may still reference its stable ID; an archive
-- with a JWB package is explicitly partial rather than a complete live ledger.

set local lock_timeout = '1s';

create or replace function internal.student_import_canonical_archive(p_student jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $archive_referenced_student_jwb_facts$
declare
  existing_packages jsonb := case
    when jsonb_typeof(p_student -> 'lessonPackages') = 'array'
      then p_student -> 'lessonPackages'
    else '[]'::jsonb
  end;
  existing_jwb_packages jsonb := '[]'::jsonb;
  existing_coverage text;
  existing_snapshot jsonb;
  displaced_facts jsonb;
  retained_facts jsonb;
  snapshot jsonb;
  archived jsonb;
begin
  select coalesce(jsonb_agg(package.value order by package.ordinal), '[]'::jsonb)
  into existing_jwb_packages
  from jsonb_array_elements(existing_packages) with ordinality package(value, ordinal)
  where coalesce(package.value ->> 'id', '') like 'PKG-JWB-%';

  existing_coverage := case
    when p_student ->> 'packageCoverage' in ('complete', 'partial', 'none')
      then p_student ->> 'packageCoverage'
    else null
  end;
  existing_snapshot := internal.student_import_historical_jwb_snapshot(
    p_student -> 'historicalJwbSnapshot'
  );
  -- `partial` on an existing archive is structural: it explains why package
  -- IDs remain referenceable, not the original JWB source coverage. Keep the
  -- original coverage already recorded in retained history on every replay.
  if p_student -> 'importArchived' = 'true'::jsonb
     and p_student ->> 'importArchivedReason' = 'referenced_history'
     and (existing_snapshot -> 'retained') ? 'packageCoverage'
  then
    existing_coverage := null;
  end if;

  displaced_facts := null;
  if jsonb_array_length(existing_jwb_packages) > 0
     or jsonb_typeof(p_student -> 'remainingHours') = 'number'
     or jsonb_typeof(p_student -> 'contractHours') = 'number'
     or (jsonb_typeof(p_student -> 'contractEffectiveDate') = 'string'
       and nullif(btrim(p_student ->> 'contractEffectiveDate'), '') is not null)
     or (jsonb_typeof(p_student -> 'firstJwbHourEntryDate') = 'string'
       and nullif(btrim(p_student ->> 'firstJwbHourEntryDate'), '') is not null)
     or existing_coverage is not null
  then
    displaced_facts := internal.student_import_historical_jwb_facts(
      jsonb_strip_nulls(jsonb_build_object(
        'lessonPackages', case when jsonb_array_length(existing_jwb_packages) > 0
          then existing_jwb_packages else null end,
        'remainingHours', case when jsonb_typeof(p_student -> 'remainingHours') = 'number'
          then p_student -> 'remainingHours' else null end,
        'contractHours', case when jsonb_typeof(p_student -> 'contractHours') = 'number'
          then p_student -> 'contractHours' else null end,
        'contractEffectiveDate', case when jsonb_typeof(p_student -> 'contractEffectiveDate') = 'string'
          then btrim(p_student ->> 'contractEffectiveDate') else null end,
        'firstJwbHourEntryDate', case when jsonb_typeof(p_student -> 'firstJwbHourEntryDate') = 'string'
          then btrim(p_student ->> 'firstJwbHourEntryDate') else null end,
        'packageCoverage', existing_coverage,
        'jwbSourceRow', case when p_student ? 'jwbSourceRow'
          then p_student -> 'jwbSourceRow' else null end
      )), true
    );
  end if;

  retained_facts := internal.student_import_merge_historical_jwb_facts(
    existing_snapshot -> 'retained', displaced_facts
  );
  snapshot := internal.student_import_historical_jwb_snapshot(
    jsonb_strip_nulls(jsonb_build_object(
      'retained', retained_facts,
      'currentAggregate', existing_snapshot -> 'currentAggregate'
    ))
  );

  archived := internal.student_import_defaults(p_student)
    || (p_student
      - 'importSource'
      - 'jwbMatchStatus'
      - 'jwbSourceRow'
      - 'remainingHours'
      - 'contractHours'
      - 'contractEffectiveDate'
      - 'firstJwbHourEntryDate'
      - 'historicalJwbSnapshot'
      - 'studentNumberJwbDateCandidate'
      - 'lessonPackages'
      - 'packageCoverage');
  if jsonb_array_length(existing_packages) > 0 then
    archived := archived || jsonb_build_object('lessonPackages', existing_packages);
  end if;
  if jsonb_array_length(existing_jwb_packages) > 0 then
    archived := archived || jsonb_build_object('packageCoverage', 'partial');
  end if;
  if snapshot is not null then
    archived := archived || jsonb_build_object('historicalJwbSnapshot', snapshot);
  end if;
  return archived || jsonb_build_object(
    'status', '不活跃 + 无课时',
    'next', '历史引用归档，只读',
    'nextTone', 'neutral',
    'importArchived', true,
    'importArchivedReason', 'referenced_history'
  );
end;
$archive_referenced_student_jwb_facts$;

revoke all on function internal.student_import_canonical_archive(jsonb)
  from public, anon, authenticated;
