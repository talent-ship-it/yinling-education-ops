\ir assert-disposable-database.sql
\set ON_ERROR_STOP on

-- Synthetic, aggregate-shaped commit/replay benchmark.  It intentionally
-- contains no production records or names.  The shape is based only on the
-- approved aggregate counts captured on 2026-08-18:
--   * 543 Tencent master rows / 1,038 JWB rows / 341 reviewed links
--   * 502 current students, all initially unnumbered and with no packages
--     or historical JWB snapshots
--   * 360 bookings referencing 212 distinct current students
--   * 530 source JWB package rows across 427 JWB accounts
-- The script calls the real atomic commit and replay RPCs, and rolls the
-- complete fixture transaction back.  It is not a production-data fixture.

begin;

create temporary table production_shape_context (
  plan_fingerprint text not null,
  source_revisions jsonb not null,
  expected_students jsonb not null,
  expected_student_version bigint not null
) on commit drop;

insert into public.ops_state (entity, payload, version, updated_by)
select entity, '[]'::jsonb, 1, 'production-shape-fixture'
from unnest(array[
  'bookings', 'files', 'lpItems', 'messages', 'operations', 'payroll',
  'renewals', 'students', 'tasks'
]::text[]) entity
on conflict (entity) do update set
  payload = excluded.payload,
  version = excluded.version,
  updated_by = excluded.updated_by;

do $production_shape_fixture$
declare
  master_rows jsonb;
  jwb_rows jsonb;
  links jsonb;
  seed_links jsonb;
  seed_projection jsonb;
  seeded_formals jsonb;
  current_students jsonb;
  bookings jsonb;
  master_source internal.student_import_source_rows%rowtype;
  jwb_source internal.student_import_source_rows%rowtype;
  student_state public.ops_state%rowtype;
  booking_state public.ops_state%rowtype;
  link_fingerprint text;
  duplicate_fingerprint text;
  attachment_fingerprint text;
  formal_date text;
  source_revisions jsonb;
  expected_students jsonb;
  plan_fingerprint text := 'sha256:' || repeat('c', 64);
  audit_id uuid;
  current_package_count integer;
  current_snapshot_count integer;
  current_number_count integer;
  reservation_count integer;
  booking_reference_count integer;
  expected_package_count integer;
  referenced_student_ids jsonb;
  source_complete_count integer;
  source_partial_count integer;
  source_none_count integer;
  source_package_account_count integer;
  source_package_count integer;
  source_purchase_count integer;
  linked_complete_count integer;
  linked_partial_count integer;
  linked_none_count integer;
  linked_package_account_count integer;
  linked_package_count integer;
  linked_purchase_count integer;
begin
  select jsonb_agg(jsonb_build_object(
    'sourceRow', 'M-' || n,
    'name', 'Synthetic Student ' || n,
    'status', case when n <= 150 then '不活跃 + 无课时' else '在读' end
  ) order by n)
  into master_rows
  from generate_series(1, 543) n;

  -- Exact aggregate coverage/package/purchase shape, without production data:
  -- 420 complete / 7 partial / 611 none; 427 package accounts, 530 packages,
  -- 947 purchases. Linked J1–J341 supply 135/1/205 coverage, 136 package
  -- accounts, 147 packages, and 329 purchases across 246 date keys.
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'sourceRow', 'J-' || n,
    'name', case
      when n <= 333 then 'Synthetic Student ' || n || '(VIC)'
      when n <= 543 then 'Synthetic Student ' || n
      else 'Synthetic JWB-only ' || n
    end,
    'remainingHours', package_shape.package_count,
    'contractHours', package_shape.package_count,
    'firstJwbHourEntryDate', case when n <= 341 then to_char(
      date '2024-01-01' + ((n - 1) % 246), 'YYYY-MM-DD'
    ) else null end,
    'packageCoverage', coverage_shape.coverage,
    'lessonPackages', case when package_shape.package_count > 0 then (
      select jsonb_agg(jsonb_build_object(
        'sourcePackageId', 'PKG-' || n || '-' || package_number,
        'name', 'Synthetic English package ' || n || '-' || package_number,
        'subjectIds', jsonb_build_array('ENG'),
        'purchaseRecords', (
          select jsonb_agg(jsonb_build_object(
            'sourcePurchaseId', 'BUY-' || n || '-' || package_number || '-' || purchase_number,
            'purchasedAt', '2025-01-01',
            'hours', case
              when package_shape.purchase_count = 3 and purchase_number = 3 then 0.333334
              when package_shape.purchase_count = 3 then 0.333333
              when package_shape.purchase_count = 2 then 0.5
              else 1
            end
          ) order by purchase_number)
          from generate_series(1, package_shape.purchase_count) purchase_number
        ),
        'consumedHours', 0
      ) order by package_number)
      from generate_series(1, package_shape.package_count) package_number
    ) else null end,
    'attributes', jsonb_build_object('jiaowubaoPackageImport', jsonb_build_object(
      'status', case when package_shape.package_count > 0
        then 'packages_from_current_course_balances'
        else 'aggregate_only_no_current_courses' end,
      'currentTotalHours', package_shape.package_count,
      'currentUsedHours', 0,
      'currentRemainingHours', package_shape.package_count,
      'adjustmentContracts', '[]'::jsonb
    ))
  )) order by n)
  into jwb_rows
  from generate_series(1, 1038) n
  cross join lateral (
    select case
      when n <= 135 then 'complete'
      when n = 136 then 'partial'
      when n <= 341 then 'none'
      when n <= 626 then 'complete'
      when n <= 632 then 'partial'
      else 'none'
    end as coverage
  ) coverage_shape
  cross join lateral (
    select case
      when n <= 11 then 2
      when n <= 136 then 1
      when n between 342 and 433 then 2
      when n between 434 and 632 then 1
      else 0
    end as package_count,
    case
      when n <= 24 then 3
      when n <= 136 then 2
      when n between 342 and 484 then 2
      when n between 485 and 632 then 1
      else 0
    end as purchase_count
  ) package_shape;

  select
    count(*) filter (where row_value ->> 'packageCoverage' = 'complete'),
    count(*) filter (where row_value ->> 'packageCoverage' = 'partial'),
    count(*) filter (where row_value ->> 'packageCoverage' = 'none'),
    count(*) filter (where jsonb_typeof(row_value -> 'lessonPackages') = 'array'
      and jsonb_array_length(row_value -> 'lessonPackages') > 0),
    coalesce(sum(jsonb_array_length(row_value -> 'lessonPackages')) filter (
      where jsonb_typeof(row_value -> 'lessonPackages') = 'array'
    ), 0)::integer,
    coalesce(sum(purchase_totals.purchase_count), 0)::integer
  into source_complete_count, source_partial_count, source_none_count,
    source_package_account_count, source_package_count, source_purchase_count
  from jsonb_array_elements(jwb_rows) row_value
  cross join lateral (
    select count(*)::integer as purchase_count
    from jsonb_array_elements(case when jsonb_typeof(row_value -> 'lessonPackages') = 'array'
      then row_value -> 'lessonPackages' else '[]'::jsonb end) package(value)
    cross join lateral jsonb_array_elements(package.value -> 'purchaseRecords') purchase(value)
  ) purchase_totals;

  select
    count(*) filter (where row_value ->> 'packageCoverage' = 'complete'),
    count(*) filter (where row_value ->> 'packageCoverage' = 'partial'),
    count(*) filter (where row_value ->> 'packageCoverage' = 'none'),
    count(*) filter (where jsonb_typeof(row_value -> 'lessonPackages') = 'array'
      and jsonb_array_length(row_value -> 'lessonPackages') > 0),
    coalesce(sum(jsonb_array_length(row_value -> 'lessonPackages')) filter (
      where jsonb_typeof(row_value -> 'lessonPackages') = 'array'
    ), 0)::integer,
    coalesce(sum(purchase_totals.purchase_count), 0)::integer
  into linked_complete_count, linked_partial_count, linked_none_count,
    linked_package_account_count, linked_package_count, linked_purchase_count
  from jsonb_array_elements(jwb_rows) with ordinality jwb(row_value, ordinality)
  cross join lateral (
    select count(*)::integer as purchase_count
    from jsonb_array_elements(case when jsonb_typeof(row_value -> 'lessonPackages') = 'array'
      then row_value -> 'lessonPackages' else '[]'::jsonb end) package(value)
    cross join lateral jsonb_array_elements(package.value -> 'purchaseRecords') purchase(value)
  ) purchase_totals
  where jwb.ordinality <= 341;

  if source_complete_count <> 420 or source_partial_count <> 7 or source_none_count <> 611
     or source_package_account_count <> 427 or source_package_count <> 530
     or source_purchase_count <> 947
     or linked_complete_count <> 135 or linked_partial_count <> 1 or linked_none_count <> 205
     or linked_package_account_count <> 136 or linked_package_count <> 147
     or linked_purchase_count <> 329 then
    raise exception using errcode = 'P0001', message = 'production_shape_source_jwb_aggregate_mismatch';
  end if;

  perform public.put_student_import_source_rows(
    'perf-secret', 'master', 'production-shape-master',
    'production-shape-master-r1', master_rows, 'Nixon'
  );
  perform public.put_student_import_source_rows(
    'perf-secret', 'jwb', 'production-shape-jwb',
    'production-shape-jwb-r1', jwb_rows, 'Nixon'
  );

  select * into master_source
  from internal.student_import_source_rows
  where source_kind = 'master';
  select * into jwb_source
  from internal.student_import_source_rows
  where source_kind = 'jwb';

  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'masterSourceRow', 'M-' || n,
    'jwbSourceRow', 'J-' || n,
    'studentId', internal.student_import_student_id(
      'production-shape-master', to_jsonb('M-' || n)
    ),
    'matchStrategy', case when n <= 333
      then 'jwb_latin_parenthetical_annotation_v1' else null end
  )) order by n)
  into links
  from generate_series(1, 341) n;

  select coalesce(jsonb_agg(
    link.value - 'jwbSourceRow' - 'matchStrategy'
    order by link.ordinality
  ), '[]'::jsonb)
  into seed_links
  from jsonb_array_elements(links) with ordinality as link(value, ordinality);

  -- Build 499 old formal records without JWB facts/packages.  This matches the
  -- production aggregate (no active package, snapshot, reservation, or
  -- number-provenance facts) while retaining deterministic formal identities.
  seed_projection := internal.student_import_canonical_projection(
    master_source.source_id,
    master_source.rows,
    '[]'::jsonb,
    '[]'::jsonb,
    seed_links,
    '[]'::jsonb
  );
  select coalesce(jsonb_agg(student.value order by student.ordinality), '[]'::jsonb)
  into seeded_formals
  from jsonb_array_elements(seed_projection) with ordinality as student(value, ordinality)
  where student.ordinality <= 499;

  current_students := seeded_formals || jsonb_build_array(
    jsonb_build_object(
      'id', 'MANUAL-TRIAL-A', 'name', 'Synthetic trial A',
      'status', '待排课', 'segment', '试听', 'importSource', 'manual_trial'
    ),
    jsonb_build_object(
      'id', 'MANUAL-TRIAL-B', 'name', 'Synthetic trial B',
      'status', '待排课', 'segment', '试听', 'importSource', 'manual_trial'
    ),
    jsonb_build_object(
      'id', 'MANUAL-TRIAL-C', 'name', 'Synthetic trial C',
      'status', '待排课', 'segment', '试听', 'importSource', 'manual_trial'
    )
  );

  if jsonb_array_length(current_students) <> 502 then
    raise exception using errcode = 'P0001', message = 'production_shape_current_student_count_mismatch';
  end if;

  -- Fixture setup only: production's current 502 records have no allocated
  -- number/provenance facts. Temporarily suppress row triggers while placing
  -- those historical inputs, then restore normal trigger execution before the
  -- measured real atomic commit/replay path below.
  perform pg_catalog.set_config('session_replication_role', 'replica', true);
  update public.ops_state
  set payload = current_students,
    version = 1,
    updated_by = 'production-shape-fixture'
  where entity = 'students';
  perform pg_catalog.set_config('session_replication_role', 'origin', true);

  -- Use 360 lightweight historical/trial bookings.  They exercise the same
  -- reference and booking traversal without creating a package dependency
  -- that would intentionally trip the referenced-package safety guard.
  select jsonb_agg(jsonb_build_object(
    'id', 'BOOKING-' || n,
    'studentId', case
      when ((n - 1) % 212) = 0 then 'MANUAL-TRIAL-A'
      when ((n - 1) % 212) = 1 then 'MANUAL-TRIAL-B'
      when ((n - 1) % 212) = 2 then 'MANUAL-TRIAL-C'
      else internal.student_import_student_id(
        'production-shape-master',
        to_jsonb('M-' || (((n - 4) % 209) + 1))
      )
    end,
    'kind', '试听'
  ) order by n)
  into bookings
  from generate_series(1, 360) n;

  update public.ops_state
  set payload = bookings,
    version = 1,
    updated_by = 'production-shape-fixture'
  where entity = 'bookings';

  select * into student_state from public.ops_state where entity = 'students';
  select * into booking_state from public.ops_state where entity = 'bookings';

  select
    count(*) filter (where jsonb_typeof(student.value -> 'lessonPackages') = 'array'
      and jsonb_array_length(student.value -> 'lessonPackages') > 0),
    count(*) filter (where student.value ? 'historicalJwbSnapshot'),
    count(*) filter (where student.value ? 'studentNumber'
      or student.value ? 'studentNumberDateSource')
  into current_package_count, current_snapshot_count, current_number_count
  from jsonb_array_elements(student_state.payload) student(value);
  if current_package_count <> 0 or current_snapshot_count <> 0
     or current_number_count <> 0 then
    raise exception using errcode = 'P0001', message = 'production_shape_current_student_facts_mismatch';
  end if;

  select count(*) into reservation_count from internal.student_number_reservations;
  if reservation_count <> 0 then
    raise exception using errcode = 'P0001', message = 'production_shape_reservation_count_mismatch';
  end if;

  select count(distinct booking.value ->> 'studentId')
  into booking_reference_count
  from jsonb_array_elements(booking_state.payload) booking(value);
  if jsonb_array_length(booking_state.payload) <> 360 or booking_reference_count <> 212 then
    raise exception using errcode = 'P0001', message = 'production_shape_booking_shape_mismatch';
  end if;
  select coalesce(jsonb_agg(to_jsonb(reference.student_id)
    order by reference.student_id collate "C"), '[]'::jsonb)
  into referenced_student_ids
  from (
    select distinct trim(booking.value ->> 'studentId') as student_id
    from jsonb_array_elements(booking_state.payload) booking(value)
    where nullif(trim(booking.value ->> 'studentId'), '') is not null
  ) reference;
  if jsonb_array_length(referenced_student_ids) <> 212 then
    raise exception using errcode = 'P0001', message = 'production_shape_referenced_student_count_mismatch';
  end if;

  link_fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master_source.source_id,
    'masterRevision', master_source.revision,
    'jwbSourceId', jwb_source.source_id,
    'jwbRevision', jwb_source.revision,
    'links', links
  )::text, 'sha256'), 'hex');
  audit_id := internal.append_operational_contract_audit(
    'production_shape.fixture.link_set', 'Nixon',
    'student_import_identity_link_set', 'singleton', '{}'::jsonb
  );
  insert into internal.student_import_identity_link_sets (
    singleton, master_source_id, master_revision, jwb_source_id, jwb_revision,
    students_version, review_epoch, links, link_count, link_fingerprint,
    updated_by, audit_id
  ) values (
    true, master_source.source_id, master_source.revision,
    jwb_source.source_id, jwb_source.revision,
    student_state.version, 0, links, jsonb_array_length(links), link_fingerprint,
    'Nixon', audit_id
  );

  duplicate_fingerprint := internal.student_import_master_duplicate_snapshot(
    master_source, student_state
  ) ->> 'fingerprint';
  attachment_fingerprint := internal.student_fu_attachment_reference_snapshot() ->> 'fingerprint';
  formal_date := to_char(clock_timestamp() at time zone 'Australia/Melbourne', 'YYYY-MM-DD');
  source_revisions := jsonb_build_object(
    'master', master_source.revision,
    'jwb', jwb_source.revision,
    'identityLinks', link_fingerprint,
    'masterDuplicateResolutions', duplicate_fingerprint,
    'fuAttachments', attachment_fingerprint,
    'bookingsVersion', booking_state.version,
    'formalImportDate', formal_date
  );
  expected_students := internal.student_import_canonical_projection(
    master_source.source_id, master_source.rows, jwb_source.rows,
    student_state.payload, links, referenced_student_ids
  );
  expected_students := internal.student_import_assign_student_numbers(
    expected_students, formal_date
  );

  select coalesce(sum(jsonb_array_length(student.value -> 'lessonPackages')), 0)::integer
  into expected_package_count
  from jsonb_array_elements(expected_students) student(value)
  where jsonb_typeof(student.value -> 'lessonPackages') = 'array';
  raise notice 'PRODUCTION_SHAPE prepared students=% active_packages=% source_packages=530 source_purchases=947 current=% bookings=% references=%',
    jsonb_array_length(expected_students), expected_package_count,
    jsonb_array_length(student_state.payload), jsonb_array_length(booking_state.payload),
    jsonb_array_length(referenced_student_ids);
  if jsonb_array_length(expected_students) <> 546 or expected_package_count <> 441 then
    raise exception using errcode = 'P0001', message = 'production_shape_projection_mismatch';
  end if;

  insert into production_shape_context (
    plan_fingerprint, source_revisions, expected_students, expected_student_version
  ) values (
    plan_fingerprint, source_revisions, expected_students, student_state.version
  );
end;
$production_shape_fixture$;

do $production_shape_commit$
declare
  context_row production_shape_context%rowtype;
  started_at timestamptz;
  elapsed interval;
  committed_student_count integer;
  committed_booking_count integer;
begin
  select * into context_row from production_shape_context;
  started_at := clock_timestamp();
  perform public.commit_student_import_plan_atomic(
    'perf-secret', context_row.plan_fingerprint, context_row.expected_student_version,
    context_row.source_revisions, context_row.expected_students, 'Nixon'
  );
  elapsed := clock_timestamp() - started_at;
  select jsonb_array_length(payload) into committed_student_count
  from public.ops_state where entity = 'students';
  select jsonb_array_length(payload) into committed_booking_count
  from public.ops_state where entity = 'bookings';
  if committed_student_count <> 546 or committed_booking_count <> 360 then
    raise exception using errcode = 'P0001', message = 'production_shape_commit_result_mismatch';
  end if;
  if (select payload from public.ops_state where entity = 'students')
       is distinct from context_row.expected_students then
    raise exception using errcode = 'P0001', message = 'production_shape_commit_payload_mismatch';
  end if;
  raise notice 'PRODUCTION_SHAPE commit=% students=% bookings=%',
    elapsed, committed_student_count, committed_booking_count;
end;
$production_shape_commit$;

do $production_shape_replay$
declare
  context_row production_shape_context%rowtype;
  started_at timestamptz;
  elapsed interval;
begin
  select * into context_row from production_shape_context;
  started_at := clock_timestamp();
  perform public.get_student_import_commit_replay_result(
    'perf-secret', context_row.plan_fingerprint, context_row.expected_student_version, 'Nixon'
  );
  elapsed := clock_timestamp() - started_at;
  raise notice 'PRODUCTION_SHAPE replay=%', elapsed;
end;
$production_shape_replay$;

rollback;
