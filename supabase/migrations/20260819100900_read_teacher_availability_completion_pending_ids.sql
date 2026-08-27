-- Narrow, server-only reader for the monthly AVA completion queue.
--
-- The review inbox deliberately keeps its existing full pending-submission
-- contract.  This reader is different: the completion surface only needs to
-- know whether a current-month pending submission exists for a teacher, never
-- the submitted city, slots, notes, reviewer fields, or historical rows.

set local lock_timeout = '1s';

-- Supports the exact current-month pending-ID scan and its deterministic
-- teacher-ID ordering without reading the historical review ledger.
create index if not exists teacher_availability_pending_month_teacher_idx
  on public.teacher_availability_submissions (submission_month, teacher_id)
  where status = 'pending';

create or replace function public.get_teacher_availability_completion_pending_teacher_ids(
  p_secret text,
  p_month text,
  p_limit integer
)
returns table (
  pending_teacher_ids text[],
  overflowed boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $get_teacher_availability_completion_pending_teacher_ids$
declare
  selected_teacher_ids text[];
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_month, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
     or p_limit is null
     or p_limit < 1
     or p_limit > 1000 then
    raise exception using errcode = '22023', message = 'invalid_teacher_availability_completion_reader';
  end if;

  -- Fetch at most one extra distinct teacher ID.  The caller must fail closed
  -- on overflow rather than silently drop a teacher from the completion queue.
  select coalesce(array_agg(candidate.teacher_id order by candidate.teacher_id), '{}'::text[])
    into selected_teacher_ids
  from (
    select distinct submission.teacher_id
    from public.teacher_availability_submissions submission
    where submission.status = 'pending'
      and submission.submission_month = p_month
    order by submission.teacher_id
    limit p_limit + 1
  ) candidate;

  return query select
    coalesce(selected_teacher_ids[1:p_limit], '{}'::text[]),
    coalesce(array_length(selected_teacher_ids, 1), 0) > p_limit;
end;
$get_teacher_availability_completion_pending_teacher_ids$;

revoke all on function public.get_teacher_availability_completion_pending_teacher_ids(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.get_teacher_availability_completion_pending_teacher_ids(text, text, integer)
  to anon, authenticated;
