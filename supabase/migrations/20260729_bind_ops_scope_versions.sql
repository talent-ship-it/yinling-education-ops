-- Prevent a scoped user from saving data after their student/teacher assignment
-- changed between the initial read and the write request.
create or replace function public.put_scoped_ops_state(
  p_secret text,
  p_entity text,
  p_payload jsonb,
  p_expected_version bigint,
  p_actor text,
  p_scope_versions jsonb default null
)
returns table (
  entity text,
  payload jsonb,
  version bigint,
  updated_at timestamptz,
  updated_by text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  booking_row public.ops_state%rowtype;
  scope_row public.ops_state%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception 'invalid_ops_secret';
  end if;

  -- A generic booking edit derives availability and shared-package capacity
  -- from students/teachers. Lock in the same global order as the atomic
  -- booking workflows, even for admins: bookings -> students -> teachers.
  if p_entity = 'bookings' then
    if jsonb_typeof(p_scope_versions) <> 'object'
       or jsonb_typeof(p_scope_versions -> 'students') <> 'number'
       or (p_scope_versions ->> 'students') !~ '^[1-9][0-9]*$'
       or (
         case
         when jsonb_typeof(p_scope_versions -> 'students') = 'number'
          and (p_scope_versions ->> 'students') ~ '^[1-9][0-9]*$'
         then (p_scope_versions ->> 'students')::numeric > 9223372036854775807
         else false
         end
       )
       or jsonb_typeof(p_scope_versions -> 'teachers') <> 'number'
       or (p_scope_versions ->> 'teachers') !~ '^[1-9][0-9]*$'
       or (
         case
         when jsonb_typeof(p_scope_versions -> 'teachers') = 'number'
          and (p_scope_versions ->> 'teachers') ~ '^[1-9][0-9]*$'
         then (p_scope_versions ->> 'teachers')::numeric > 9223372036854775807
         else false
         end
       ) then
      raise exception using errcode = '40001', message = 'access_scope_changed';
    end if;

    select state.*
    into booking_row
    from public.ops_state as state
    where state.entity = 'bookings'
    for update;

    if not found then
      raise exception using errcode = 'P0002', message = 'bookings_ops_state_missing';
    end if;
    if booking_row.version <> p_expected_version then
      raise exception using errcode = '40001', message = 'version_conflict';
    end if;

    select state.*
    into scope_row
    from public.ops_state as state
    where state.entity = 'students'
    for update;
    if not found
       or (p_scope_versions ->> 'students')::bigint <> scope_row.version then
      raise exception using errcode = '40001', message = 'access_scope_changed';
    end if;

    select state.*
    into scope_row
    from public.ops_state as state
    where state.entity = 'teachers'
    for update;
    if not found
       or (p_scope_versions ->> 'teachers')::bigint <> scope_row.version then
      raise exception using errcode = '40001', message = 'access_scope_changed';
    end if;
  -- Preserve the existing assignment-scope behavior for every non-admin
  -- write to another entity. Admin writes to other entities remain unchanged.
  elsif p_actor not in ('Nixon', 'Ops Admin') then
    if jsonb_typeof(p_scope_versions) <> 'object' then
      raise exception using errcode = '40001', message = 'access_scope_changed';
    end if;

    for scope_row in
      select state.*
      from public.ops_state as state
      where state.entity in ('bookings', 'students', 'teachers')
      order by state.entity
      for update
    loop
      if coalesce((p_scope_versions ->> scope_row.entity)::bigint, -1) <> scope_row.version then
        raise exception using errcode = '40001', message = 'access_scope_changed';
      end if;
    end loop;
  end if;

  return query
  select *
  from public.put_ops_state(
    p_secret,
    p_entity,
    p_payload,
    p_expected_version,
    p_actor
  );
end;
$$;

revoke all on function public.put_scoped_ops_state(text, text, jsonb, bigint, text, jsonb) from public;
grant execute on function public.put_scoped_ops_state(text, text, jsonb, bigint, text, jsonb) to anon, authenticated;
