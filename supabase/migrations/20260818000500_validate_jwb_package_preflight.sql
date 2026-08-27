-- The canonical projection validates every JWB package ledger, including
-- unmatched rows, before it selects the master roster.  That all-source pass
-- deliberately discards its generated package/purchase IDs and JSON output.
-- Keep the same validation order and error contract in a private validator;
-- the per-master canonicalizer remains the sole producer of active ledger
-- rows and IDs.

set local lock_timeout = '1s';

create or replace function internal.student_import_validate_jwb_packages(
  p_packages jsonb
)
returns void
language plpgsql
immutable
set search_path = ''
as $student_import_validate_jwb_packages$
declare
  package_item record;
  purchase_item record;
  package_value jsonb;
  purchase_value jsonb;
  source_package_key text;
  source_purchase_key text;
  clean_name text;
  purchased_at timestamptz;
  subjects jsonb;
  purchase_total numeric := 0;
  consumed_total numeric := 0;
  remaining_total numeric;
begin
  if jsonb_typeof(p_packages) <> 'array'
     or jsonb_array_length(p_packages) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid_student_import_jwb_packages';
  end if;

  for package_item in
    select value, position
    from jsonb_array_elements(p_packages) with ordinality item(value, position)
    order by position
  loop
    package_value := package_item.value;
    source_package_key := internal.student_import_source_key(package_value -> 'sourcePackageId');
    clean_name := internal.student_import_display_name(package_value ->> 'name');
    if jsonb_typeof(package_value) <> 'object'
       or package_value - 'sourcePackageId' - 'name' - 'subjectIds' - 'purchaseRecords' - 'consumedHours' <> '{}'::jsonb
       or source_package_key is null or length(source_package_key) not between 1 and 240
       or jsonb_typeof(package_value -> 'name') <> 'string'
       or clean_name = '' or length(clean_name) > 240
       or jsonb_typeof(package_value -> 'subjectIds') <> 'array'
       or jsonb_array_length(package_value -> 'subjectIds') not between 1 and 100
       or jsonb_typeof(package_value -> 'purchaseRecords') <> 'array'
       or jsonb_array_length(package_value -> 'purchaseRecords') not between 1 and 1000
       or not internal.student_import_has_microhour_precision(package_value -> 'consumedHours')
       or (package_value ->> 'consumedHours')::numeric < 0
       or exists (
         select 1
         from jsonb_array_elements(p_packages) with ordinality duplicate(value, position)
         where duplicate.position <> package_item.position
           and internal.student_import_source_key(duplicate.value -> 'sourcePackageId') = source_package_key
       ) then
      raise exception using errcode = '22023', message = 'invalid_student_import_jwb_package';
    end if;

    select jsonb_agg(to_jsonb(clean_subject) order by subject_position)
    into subjects
    from (
      select internal.student_import_display_name(subject.value #>> '{}') as clean_subject,
        subject.position as subject_position
      from jsonb_array_elements(package_value -> 'subjectIds') with ordinality subject(value, position)
      where jsonb_typeof(subject.value) = 'string'
    ) canonical_subjects
    where clean_subject <> '' and length(clean_subject) <= 240;
    if subjects is null
       or jsonb_array_length(subjects) <> jsonb_array_length(package_value -> 'subjectIds')
       or jsonb_array_length(subjects) <> (
         select count(distinct internal.student_import_display_name(value #>> '{}'))
         from jsonb_array_elements(package_value -> 'subjectIds')
       ) then
      raise exception using errcode = '22023', message = 'invalid_student_import_jwb_subjects';
    end if;

    consumed_total := consumed_total + (package_value ->> 'consumedHours')::numeric;
    for purchase_item in
      select value, position
      from jsonb_array_elements(package_value -> 'purchaseRecords') with ordinality item(value, position)
      order by position
    loop
      purchase_value := purchase_item.value;
      source_purchase_key := internal.student_import_source_key(purchase_value -> 'sourcePurchaseId');
      if jsonb_typeof(purchase_value) <> 'object'
         or purchase_value - 'sourcePurchaseId' - 'purchasedAt' - 'hours' - 'note' <> '{}'::jsonb
         or source_purchase_key is null or length(source_purchase_key) not between 1 and 240
         or jsonb_typeof(purchase_value -> 'purchasedAt') <> 'string'
         or not internal.student_import_has_microhour_precision(purchase_value -> 'hours')
         or (purchase_value ->> 'hours')::numeric <= 0
         or (purchase_value ? 'note' and jsonb_typeof(purchase_value -> 'note') <> 'string')
         or length(coalesce(purchase_value ->> 'note', '')) > 1000
         or exists (
           select 1
           from jsonb_array_elements(package_value -> 'purchaseRecords') with ordinality duplicate(value, position)
           where duplicate.position <> purchase_item.position
             and internal.student_import_source_key(duplicate.value -> 'sourcePurchaseId') = source_purchase_key
         ) then
        raise exception using errcode = '22023', message = 'invalid_student_import_jwb_purchase';
      end if;
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
      purchase_total := purchase_total + (purchase_value ->> 'hours')::numeric;
    end loop;
  end loop;

  remaining_total := purchase_total - consumed_total;
  if abs(purchase_total * 1000000) > 9007199254740991
     or abs(consumed_total * 1000000) > 9007199254740991
     or abs(remaining_total * 1000000) > 9007199254740991 then
    raise exception using errcode = '22023', message = 'invalid_student_import_jwb_package_total';
  end if;
end;
$student_import_validate_jwb_packages$;

revoke all on function internal.student_import_validate_jwb_packages(jsonb)
  from public, anon, authenticated;

do $student_import_jwb_package_preflight_patch$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection_170008_base(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_jwb_package_preflight_base_missing';
  end if;

  anchor := $preflight_anchor$  perform internal.student_import_canonical_jwb_packages(
    'STU-JWB-VALIDATION', jwb -> 'lessonPackages'
  )
  from jsonb_array_elements(p_jwb_rows) jwb
  where jwb ? 'lessonPackages';$preflight_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_jwb_package_preflight_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $preflight_replacement$  perform internal.student_import_validate_jwb_packages(
    jwb -> 'lessonPackages'
  )
  from jsonb_array_elements(p_jwb_rows) jwb
  where jwb ? 'lessonPackages';$preflight_replacement$);

  execute definition;

  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection_170008_base(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if position('perform internal.student_import_validate_jwb_packages(' in definition) = 0
     or position(anchor in definition) <> 0 then
    raise exception using errcode = 'P0001', message = 'student_import_jwb_package_preflight_patch_verification_failed';
  end if;
end;
$student_import_jwb_package_preflight_patch$;
