-- The base projection already validates every JWB package ledger, in source
-- order, before it makes an identity or master-loop decision.  Reuse that
-- proof for the matched-row projection instead of running the complete
-- validate-and-canonicalize helper a second time per matched student.  The
-- public helper remains validate -> private projector for ingress/direct
-- callers, so malformed ledgers retain the exact established error contract.

set local lock_timeout = '1s';

create or replace function internal.student_import_project_prevalidated_jwb_packages(
  p_student_id text,
  p_packages jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $student_import_project_prevalidated_jwb_packages$
declare
  package_item record;
  purchase_item record;
  package_value jsonb;
  purchase_value jsonb;
  package_id text;
  clean_name text;
  clean_note text;
  purchased_at timestamptz;
  purchased_at_text text;
  result_items jsonb[] := array[]::jsonb[];
  purchases_items jsonb[];
  subjects jsonb;
begin
  -- This private projector is invoked by the base only after its verbatim
  -- all-source preflight. The public canonical helper below preserves the
  -- same validation boundary for every other caller.
  for package_item in
    select value, position
    from jsonb_array_elements(p_packages) with ordinality item(value, position)
    order by position
  loop
    package_value := package_item.value;
    clean_name := internal.student_import_display_name(package_value ->> 'name');
    select jsonb_agg(to_jsonb(clean_subject) order by subject_position)
    into subjects
    from (
      select internal.student_import_display_name(subject.value #>> '{}') as clean_subject,
        subject.position as subject_position
      from jsonb_array_elements(package_value -> 'subjectIds') with ordinality subject(value, position)
      where jsonb_typeof(subject.value) = 'string'
    ) canonical_subjects
    where clean_subject <> '' and length(clean_subject) <= 240;

    package_id := internal.student_import_package_id(
      p_student_id, package_value -> 'sourcePackageId'
    );
    purchases_items := array[]::jsonb[];
    for purchase_item in
      select value, position
      from jsonb_array_elements(package_value -> 'purchaseRecords') with ordinality item(value, position)
      order by position
    loop
      purchase_value := purchase_item.value;
      -- Retain the public helper's date normalization exactly. Preflight has
      -- already verified this shape and date, but the projector must emit the
      -- same canonical UTC-millisecond text and purchase IDs.
      begin
        if trim(purchase_value ->> 'purchasedAt') ~ '^\d{4}-\d{2}-\d{2}$' then
          purchased_at := (trim(purchase_value ->> 'purchasedAt') || 'T00:00:00.000Z')::timestamptz;
        elsif trim(purchase_value ->> 'purchasedAt') ~ '^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$' then
          purchased_at := trim(purchase_value ->> 'purchasedAt')::timestamptz;
        else
          raise exception using errcode = '22023', message = 'invalid_student_import_jwb_purchase_date';
        end if;
      exception when others then
        raise exception using errcode = '22023', message = 'invalid_student_import_jwb_purchase_date';
      end;
      purchased_at_text := to_char(
        date_trunc('milliseconds', purchased_at at time zone 'UTC'),
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      );
      clean_note := trim(coalesce(purchase_value ->> 'note', ''));
      purchase_value := jsonb_build_object(
        'id', internal.student_import_purchase_id(
          package_id, purchase_value -> 'sourcePurchaseId'
        ),
        'purchasedAt', purchased_at_text,
        'hours', (purchase_value ->> 'hours')::numeric
      );
      if clean_note <> '' then
        purchase_value := purchase_value || jsonb_build_object('note', clean_note);
      end if;
      purchases_items := array_append(purchases_items, purchase_value);
    end loop;

    result_items := array_append(result_items, jsonb_build_object(
      'id', package_id,
      'name', clean_name,
      'subjectIds', subjects,
      'purchaseRecords', coalesce(to_jsonb(purchases_items), '[]'::jsonb),
      'consumedHours', (package_value ->> 'consumedHours')::numeric
    ));
  end loop;

  return coalesce(to_jsonb(result_items), '[]'::jsonb);
end;
$student_import_project_prevalidated_jwb_packages$;

revoke all on function internal.student_import_project_prevalidated_jwb_packages(text, jsonb)
  from public, anon, authenticated;

create or replace function internal.student_import_canonical_jwb_packages(
  p_student_id text,
  p_packages jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $student_import_canonical_jwb_packages_validate_then_project$
begin
  perform internal.student_import_validate_jwb_packages(p_packages);
  return internal.student_import_project_prevalidated_jwb_packages(p_student_id, p_packages);
end;
$student_import_canonical_jwb_packages_validate_then_project$;

revoke all on function internal.student_import_canonical_jwb_packages(text, jsonb)
  from public, anon, authenticated;

do $student_import_reuse_prevalidated_jwb_package_projection$
declare
  definition text;
  anchor text;
  preflight_anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection_170008_base(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  preflight_anchor := $verbatim_preflight$  perform internal.student_import_validate_jwb_packages(
    jwb -> 'lessonPackages'
  )
  from jsonb_array_elements(p_jwb_rows) jwb
  where jwb ? 'lessonPackages';$verbatim_preflight$;
  if definition is null then
    raise exception using errcode = 'P0001',
      message = 'student_import_prevalidated_jwb_projection_base_missing';
  end if;

  anchor := $base_projector_anchor$    if matched_jwb is not null and matched_jwb ? 'lessonPackages' then
      authoritative_packages := internal.student_import_canonical_jwb_packages(
        student_id, matched_jwb -> 'lessonPackages'
      );
    end if;
$base_projector_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001',
      message = 'student_import_prevalidated_jwb_projection_base_projector_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $base_projector_replacement$    if matched_jwb is not null and matched_jwb ? 'lessonPackages' then
      authoritative_packages := internal.student_import_project_prevalidated_jwb_packages(
        student_id, matched_jwb -> 'lessonPackages'
      );
    end if;
$base_projector_replacement$);

  anchor := '(internal.student_import_package_totals(authoritative_packages) ->> ''remainingHours'')::numeric';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001',
      message = 'student_import_prevalidated_jwb_projection_remaining_total_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, '(totals ->> ''remainingHours'')::numeric');

  anchor := '(internal.student_import_package_totals(authoritative_packages) ->> ''contractHours'')::numeric';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001',
      message = 'student_import_prevalidated_jwb_projection_contract_total_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, '(totals ->> ''contractHours'')::numeric');

  execute definition;

  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection_170008_base(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  count_anchor := (length(definition) - length(replace(definition, preflight_anchor, ''))) / length(preflight_anchor);
  if count_anchor <> 1
     or position('student_import_project_prevalidated_jwb_packages(' in definition) = 0
     or position('student_import_canonical_jwb_packages(' in definition) <> 0
     or position('student_import_package_totals(authoritative_packages)' in definition) <> 0
     or position('(totals ->> ''remainingHours'')::numeric' in definition) = 0
     or position('(totals ->> ''contractHours'')::numeric' in definition) = 0 then
    raise exception using errcode = 'P0001',
      message = 'student_import_prevalidated_jwb_projection_patch_verification_failed';
  end if;
end;
$student_import_reuse_prevalidated_jwb_package_projection$;
