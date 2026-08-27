create table public.teacher_availability_submissions (
  id bigint generated always as identity primary key,
  teacher_id text not null,
  teacher_name text not null,
  submission_month text not null check (submission_month ~ '^\\d{4}-(0[1-9]|1[0-2])$'),
  availability_timezone text not null,
  current_city text,
  additional_students integer not null check (additional_students between 0 and 10),
  availability_slots jsonb not null check (jsonb_typeof(availability_slots) = 'array'),
  notes text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  review_note text
);

alter table public.teacher_availability_submissions enable row level security;
revoke all on table public.teacher_availability_submissions from public, anon, authenticated;

create function public.submit_teacher_availability(
  p_secret text,
  p_teacher_id text,
  p_teacher_name text,
  p_submission_month text,
  p_availability_timezone text,
  p_current_city text,
  p_additional_students integer,
  p_availability_slots jsonb,
  p_notes text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  matching_count integer;
  matched_teacher_id text;
  submission_id bigint;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  if p_submission_month !~ '^\\d{4}-(0[1-9]|1[0-2])$'
    or p_additional_students not between 0 and 10
    or jsonb_typeof(p_availability_slots) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_submission';
  end if;

  select count(*), max(candidate ->> 'id')
  into matching_count, matched_teacher_id
  from public.ops_state state
  cross join lateral jsonb_array_elements(state.payload) candidate
  where state.entity = 'teachers'
    and lower(regexp_replace(btrim(candidate ->> 'name'), '\\s+', ' ', 'g'))
      = lower(regexp_replace(btrim(p_teacher_name), '\\s+', ' ', 'g'));

  if matching_count <> 1 or matched_teacher_id <> p_teacher_id then
    raise exception using errcode = 'P0002', message = 'teacher_not_unique';
  end if;

  insert into public.teacher_availability_submissions (
    teacher_id, teacher_name, submission_month, availability_timezone,
    current_city, additional_students, availability_slots, notes
  ) values (
    p_teacher_id, p_teacher_name, p_submission_month, p_availability_timezone,
    nullif(p_current_city, ''), p_additional_students, p_availability_slots, nullif(p_notes, '')
  )
  returning id into submission_id;

  return submission_id;
end;
$$;

create function public.get_teacher_availability_submissions(p_secret text)
returns table (
  id bigint,
  teacher_id text,
  teacher_name text,
  submission_month text,
  availability_timezone text,
  current_city text,
  additional_students integer,
  availability_slots jsonb,
  notes text,
  status text,
  submitted_at timestamptz
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
  select
    s.id, s.teacher_id, s.teacher_name, s.submission_month, s.availability_timezone,
    s.current_city, s.additional_students, s.availability_slots, s.notes, s.status, s.submitted_at
  from public.teacher_availability_submissions s
  order by s.submitted_at desc;
end;
$$;

revoke all on function public.submit_teacher_availability(text, text, text, text, text, text, integer, jsonb, text) from public;
revoke all on function public.get_teacher_availability_submissions(text) from public;
grant execute on function public.submit_teacher_availability(text, text, text, text, text, text, integer, jsonb, text) to anon;
grant execute on function public.get_teacher_availability_submissions(text) to anon;;
