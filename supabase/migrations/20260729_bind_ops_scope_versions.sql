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
  scope_row public.ops_state%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception 'invalid_ops_secret';
  end if;

  -- Full and limited admin accounts are not scoped by these assignment rows.
  if p_actor not in ('Nixon', 'Ops Admin') then
    if jsonb_typeof(p_scope_versions) <> 'object' then
      raise exception using errcode = '40001', message = 'access_scope_changed';
    end if;

    -- Lock in a stable order, then compare against the exact versions used to
    -- derive this user's scope in the API route.
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
