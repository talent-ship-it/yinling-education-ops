\ir assert-disposable-database.sql
\set ON_ERROR_STOP on

-- Run against a disposable database migrated through 20260818000700.  The
-- partial-ledger wrapper patch must make a first canonical projection exactly
-- replayable, while still moving only genuinely displaced/stale JWB facts to
-- read-only history.  All values are synthetic.
begin;

\ir ../../supabase/migrations/20260818000800_fix_partial_jwb_snapshot_replay.sql

do $partial_jwb_snapshot_replay$
declare
  same_master jsonb := '[{"sourceRow":"M-SAME","name":"Same source","status":"在读"}]'::jsonb;
  same_jwb jsonb := '[{"sourceRow":101,"name":"Same source","packageCoverage":"partial","remainingHours":1,"contractHours":1,"firstJwbHourEntryDate":"2024-05-15","lessonPackages":[{"sourcePackageId":"SOURCE-PKG-SAME","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"SOURCE-BUY-SAME","purchasedAt":"2025-01-01","hours":1}],"consumedHours":0}]}]'::jsonb;
  same_links jsonb := jsonb_build_array(jsonb_build_object(
    'masterSourceRow', 'M-SAME',
    'jwbSourceRow', 101,
    'studentId', internal.student_import_student_id('partial-snapshot-fixture', to_jsonb('M-SAME'::text))
  ));
  first_same jsonb;
  replay_same jsonb;
  displaced_current jsonb;
  displaced_projection jsonb;
  displaced_replay jsonb;
  stale_package jsonb := jsonb_build_object(
    'id', 'PKG-JWB-STALE-PARTIAL',
    'name', 'Old English package',
    'subjectIds', jsonb_build_array('ENG'),
    'purchaseRecords', jsonb_build_array(jsonb_build_object(
      'id', 'BUY-JWB-STALE-PARTIAL', 'purchasedAt', '2024-01-01T00:00:00.000Z', 'hours', 2
    )),
    'consumedHours', 0
  );
  switched_master jsonb := '[{"sourceRow":"M-SWITCH","name":"Switched source","status":"在读"}]'::jsonb;
  switched_jwb jsonb := '[{"sourceRow":"J-NEW","name":"Switched source","packageCoverage":"partial","remainingHours":1,"contractHours":1,"firstJwbHourEntryDate":"2025-06-01","lessonPackages":[{"sourcePackageId":"SOURCE-PKG-NEW","name":"English","subjectIds":["ENG"],"purchaseRecords":[{"sourcePurchaseId":"SOURCE-BUY-NEW","purchasedAt":"2025-06-01","hours":1}],"consumedHours":0}]}]'::jsonb;
  switched_links jsonb := jsonb_build_array(jsonb_build_object(
    'masterSourceRow', 'M-SWITCH',
    'jwbSourceRow', 'J-NEW',
    'studentId', internal.student_import_student_id('partial-snapshot-fixture', to_jsonb('M-SWITCH'::text))
  ));
  switched_current jsonb := jsonb_build_array(jsonb_build_object(
    'id', internal.student_import_student_id('partial-snapshot-fixture', to_jsonb('M-SWITCH'::text)),
    'name', 'Switched source',
    'importSource', 'master',
    'jwbSourceRow', 'J-OLD',
    'packageCoverage', 'partial',
    'remainingHours', 2,
    'contractHours', 3,
    'firstJwbHourEntryDate', '2024-01-01',
    'lessonPackages', jsonb_build_array(stale_package)
  ));
  switched_projection jsonb;
  switched_replay jsonb;
begin
  -- Numeric source rows exercise source-key equality rather than raw JSON
  -- equality. A normal first projection must reproduce byte-for-byte.
  first_same := internal.student_import_canonical_projection(
    'partial-snapshot-fixture', same_master, same_jwb, '[]'::jsonb,
    same_links, '[]'::jsonb
  );
  replay_same := internal.student_import_canonical_projection(
    'partial-snapshot-fixture', same_master, same_jwb, first_same,
    same_links, '[]'::jsonb
  );
  if replay_same is distinct from first_same or replay_same::text <> first_same::text
     or replay_same #> '{0,historicalJwbSnapshot,retained}' is not null
     or (replay_same #>> '{0,historicalJwbSnapshot,currentAggregate,jwbSourceRow}') <> '101' then
    raise exception using errcode = 'P0001',
      message = 'student_import_partial_same_source_replay_mismatch';
  end if;

  -- A partial same-source replay may still displace an obsolete PKG-JWB row,
  -- but it must not copy active aggregates/date/coverage/source into retained.
  displaced_current := jsonb_set(
    first_same,
    '{0,lessonPackages}',
    (first_same #> '{0,lessonPackages}') || jsonb_build_array(stale_package),
    true
  );
  displaced_projection := internal.student_import_canonical_projection(
    'partial-snapshot-fixture', same_master, same_jwb, displaced_current,
    same_links, '[]'::jsonb
  );
  displaced_replay := internal.student_import_canonical_projection(
    'partial-snapshot-fixture', same_master, same_jwb, displaced_projection,
    same_links, '[]'::jsonb
  );
  if displaced_replay is distinct from displaced_projection
     or displaced_replay::text <> displaced_projection::text
     or (displaced_projection #>> '{0,historicalJwbSnapshot,retained,lessonPackages,0,id}')
        <> 'PKG-JWB-STALE-PARTIAL'
     or displaced_projection #> '{0,historicalJwbSnapshot,retained,remainingHours}' is not null
     or displaced_projection #> '{0,historicalJwbSnapshot,retained,contractHours}' is not null
     or displaced_projection #> '{0,historicalJwbSnapshot,retained,firstJwbHourEntryDate}' is not null
     or displaced_projection #> '{0,historicalJwbSnapshot,retained,packageCoverage}' is not null
     or displaced_projection #> '{0,historicalJwbSnapshot,retained,jwbSourceRow}' is not null then
    raise exception using errcode = 'P0001',
      message = 'student_import_partial_same_source_displaced_package_mismatch';
  end if;

  -- A switched/missing source is genuinely historical: retain the prior
  -- aggregate and source facts along with old PKG-JWB evidence, then replay
  -- the resulting JSONB exactly.
  switched_projection := internal.student_import_canonical_projection(
    'partial-snapshot-fixture', switched_master, switched_jwb, switched_current,
    switched_links, '[]'::jsonb
  );
  switched_replay := internal.student_import_canonical_projection(
    'partial-snapshot-fixture', switched_master, switched_jwb, switched_projection,
    switched_links, '[]'::jsonb
  );
  if switched_replay is distinct from switched_projection
     or switched_replay::text <> switched_projection::text
     or (switched_projection #>> '{0,historicalJwbSnapshot,retained,jwbSourceRow}') <> 'J-OLD'
     or (switched_projection #>> '{0,historicalJwbSnapshot,retained,remainingHours}') <> '2'
     or (switched_projection #>> '{0,historicalJwbSnapshot,retained,contractHours}') <> '3'
     or (switched_projection #>> '{0,historicalJwbSnapshot,retained,firstJwbHourEntryDate}') <> '2024-01-01'
     or (switched_projection #>> '{0,historicalJwbSnapshot,retained,lessonPackages,0,id}')
        <> 'PKG-JWB-STALE-PARTIAL'
     or (switched_projection #>> '{0,historicalJwbSnapshot,currentAggregate,jwbSourceRow}') <> 'J-NEW' then
    raise exception using errcode = 'P0001',
      message = 'student_import_partial_switched_source_replay_mismatch';
  end if;
end;
$partial_jwb_snapshot_replay$;

rollback;
