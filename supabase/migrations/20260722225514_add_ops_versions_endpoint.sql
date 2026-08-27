
create or replace function public.get_ops_versions(p_secret text)
returns table (
  entity text,
  version bigint,
  updated_at timestamptz,
  updated_by text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  return query
  select s.entity, s.version, s.updated_at, s.updated_by
  from public.ops_state s
  order by s.entity;
end;
$$;

revoke all on function public.get_ops_versions(text) from public;
grant execute on function public.get_ops_versions(text) to anon;
;
