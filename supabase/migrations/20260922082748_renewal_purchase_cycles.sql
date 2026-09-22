begin;

create or replace function internal.renewal_package_remaining_hours(p_student jsonb, p_package_id text)
returns numeric language sql immutable security invoker set search_path = '' as $function$
  select round(coalesce((select sum((purchase ->> 'hours')::numeric)
    from jsonb_array_elements(package -> 'purchaseRecords') purchase),0) - (package ->> 'consumedHours')::numeric,6)
  from jsonb_array_elements(case when jsonb_typeof(p_student -> 'lessonPackages') = 'array' then p_student -> 'lessonPackages' else '[]'::jsonb end) package
  where package ->> 'id' = p_package_id;
$function$;
revoke all on function internal.renewal_package_remaining_hours(jsonb,text) from public, anon, authenticated, service_role;

create or replace function internal.renewal_cycle_task_anchor(p_student jsonb, p_package_id text, p_base_anchor text, p_renewal jsonb)
returns text language plpgsql immutable security invoker set search_path = '' as $function$
declare purchase jsonb; purchased_at timestamptz; latest_purchase timestamptz; remaining_hours numeric;
begin
  for purchase in
    select purchase.value
    from jsonb_array_elements(case when jsonb_typeof(p_student -> 'lessonPackages') = 'array' then p_student -> 'lessonPackages' else '[]'::jsonb end) package(value)
    cross join lateral jsonb_array_elements(case when jsonb_typeof(package.value -> 'purchaseRecords') = 'array' then package.value -> 'purchaseRecords' else '[]'::jsonb end) purchase(value)
    where package.value ->> 'id' = p_package_id
  loop
    begin
      purchased_at := (purchase ->> 'purchasedAt')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then continue;
    end;
    if isfinite(purchased_at) and (latest_purchase is null or purchased_at > latest_purchase) then latest_purchase := purchased_at; end if;
  end loop;
  remaining_hours := internal.renewal_package_remaining_hours(p_student, p_package_id);
  if coalesce(p_renewal ->> 'businessStatus',p_renewal ->> 'status') in ('renewed','已续课')
    and (remaining_hours <= 0 or remaining_hours < (p_renewal ->> 'remainingHoursAtRenewal')::numeric)
    and nullif(p_renewal ->> 'lastAttemptAt','') is not null then
    purchased_at := (p_renewal ->> 'lastAttemptAt')::timestamptz;
    if isfinite(purchased_at) and (latest_purchase is null or purchased_at > latest_purchase) then latest_purchase := purchased_at; end if;
  end if;
  return case when latest_purchase is null then p_base_anchor
    else p_base_anchor || ':cycle:' || floor(extract(epoch from latest_purchase) * 1000)::bigint::text end;
end;
$function$;
revoke all on function internal.renewal_cycle_task_anchor(jsonb,text,text,jsonb) from public, anon, authenticated, service_role;

do $migration$
declare original text;
  old_assignment text := $old$      || replace(resolved_package_id, ':', '%3A');$old$;
  new_assignment text := $new$      || replace(resolved_package_id, ':', '%3A');
    -- Close only the current purchase cycle, retaining previous task history.
    -- Before a legacy task is adopted by the client, retain its exact fallback.
    if exists (select 1 from jsonb_array_elements(tasks_state.payload) item
      where item.value ->> 'studentId' = canonical_student_id
        and item.value ->> 'ruleKey' = 'renewal.package-depletion'
        and item.value ->> 'anchorBookingId' = internal.renewal_cycle_task_anchor(current_student, resolved_package_id, task_anchor, current_renewal)) then
      task_anchor := internal.renewal_cycle_task_anchor(current_student, resolved_package_id, task_anchor, current_renewal);
    end if;$new$;
begin
  original := pg_get_functiondef('public.put_renewal_follow_up_atomic(text,text,jsonb,text,text,text,text,text,timestamp with time zone,text,text,text,text,text,text,text,jsonb,text)'::regprocedure);
  if position(old_assignment in original) = 0
     or (length(original) - length(replace(original, old_assignment, ''))) <> length(old_assignment) then
    raise exception 'Unexpected renewal task anchor revision';
  end if;
  original := replace(original, old_assignment, new_assignment);
  if position('  next_student := current_student;' in original) = 0 then
    raise exception 'Unexpected renewal balance snapshot insertion point';
  end if;
  execute replace(original, '  next_student := current_student;', $new$
  next_renewal := next_renewal - 'remainingHoursAtRenewal';
  if p_business_status = 'renewed' and resolved_package_id is not null then
    next_renewal := next_renewal || jsonb_build_object('remainingHoursAtRenewal',
      internal.renewal_package_remaining_hours(current_student,resolved_package_id));
  end if;
  next_student := current_student;$new$);
end;
$migration$;

commit;
