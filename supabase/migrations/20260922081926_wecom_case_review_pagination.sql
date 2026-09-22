-- Read cases independently of message volume; immutable creation order is the
-- keyset so repeated messages cannot hide or reorder unresolved identities.
create or replace function public.read_wecom_handover_cases(
  p_secret text, p_filter text default 'pending', p_cursor uuid default null, p_limit integer default 30
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  cursor_created_at timestamptz;
  total_count bigint;
  pending_count bigint;
  result_rows jsonb;
  has_more boolean;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_filter is null or p_filter not in ('pending', 'identified', 'all') or p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid_wecom_case_filter';
  end if;
  if p_cursor is not null then
    select created_at into cursor_created_at from internal.wecom_trial_handover_cases where id = p_cursor;
    if not found then raise exception using errcode = '22023', message = 'invalid_wecom_case_cursor'; end if;
  end if;
  select count(*) filter (where p_filter = 'all' or (p_filter = 'pending' and status <> 'identified') or (p_filter = 'identified' and status = 'identified')),
    count(*) filter (where status <> 'identified')
  into total_count, pending_count from internal.wecom_trial_handover_cases;
  with page as (
    select * from internal.wecom_trial_handover_cases
    where (p_filter = 'all' or (p_filter = 'pending' and status <> 'identified') or (p_filter = 'identified' and status = 'identified'))
      and (p_cursor is null or (created_at, id) > (cursor_created_at, p_cursor))
    order by created_at, id limit p_limit + 1
  ), numbered as (select *, row_number() over (order by created_at, id) as position from page)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'wechatName', wechat_name, 'studentName', student_name,
    'operationsOwner', operations_owner, 'coursePlanner', course_planner,
    'status', status, 'createdAt', created_at
  ) order by created_at, id) filter (where position <= p_limit), '[]'::jsonb), count(*) > p_limit
  into result_rows, has_more from numbered;
  return jsonb_build_object('total', total_count, 'pendingCount', pending_count, 'rows', result_rows,
    'nextCursor', case when has_more then result_rows -> (jsonb_array_length(result_rows) - 1) ->> 'id' else null end);
end;
$$;
revoke all on function public.read_wecom_handover_cases(text,text,uuid,integer) from public;
grant execute on function public.read_wecom_handover_cases(text,text,uuid,integer) to anon, authenticated, service_role;
create index if not exists wecom_trial_handover_cases_creation_idx on internal.wecom_trial_handover_cases(created_at, id);
comment on function public.read_wecom_handover_cases(text,text,uuid,integer) is
  'Secret-gated read-only case pagination. Full administrator access is enforced by the application route.';
