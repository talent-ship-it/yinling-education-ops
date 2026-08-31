-- Remove only the named synthetic acceptance fixtures used during the trial
-- workflow rollout.  Unlike operational cleanup, this intentionally removes
-- their completed task rows as well: they are QA data, not business evidence.

do $migration$
declare
  s public.ops_state%rowtype;
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
  saved public.ops_state%rowtype;
  qa_student_ids text[];
  qa_lp_ids text[];
  next_s jsonb;
  next_l jsonb;
  next_t jsonb;
begin
  select * into s from public.ops_state where entity = 'students' for update;
  select * into l from public.ops_state where entity = 'lpItems' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  if s.entity is null or l.entity is null or t.entity is null
     or jsonb_typeof(s.payload) is distinct from 'array'
     or jsonb_typeof(l.payload) is distinct from 'array'
     or jsonb_typeof(t.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'trial_acceptance_fixture_state_missing';
  end if;

  select coalesce(array_agg(student.value ->> 'id'), array[]::text[])
  into qa_student_ids
  from jsonb_array_elements(s.payload) student(value)
  where student.value ->> 'name' = 'QA 系统验收 20260827';

  select coalesce(array_agg(lp.value ->> 'id'), array[]::text[])
  into qa_lp_ids
  from jsonb_array_elements(l.payload) lp(value)
  where lp.value ->> 'studentId' = any(qa_student_ids)
     or lp.value #>> '{fields,specialNotes}' = 'E2E-QA-NO-FOLLOWUP-20260831-02';

  next_s := (
    select coalesce(jsonb_agg(student.value order by student.ordinality), '[]'::jsonb)
    from jsonb_array_elements(s.payload) with ordinality student(value, ordinality)
    where not ((student.value ->> 'id') = any(qa_student_ids))
  );
  next_l := (
    select coalesce(jsonb_agg(lp.value order by lp.ordinality), '[]'::jsonb)
    from jsonb_array_elements(l.payload) with ordinality lp(value, ordinality)
    where not ((lp.value ->> 'id') = any(qa_lp_ids))
  );
  next_t := (
    select coalesce(jsonb_agg(task.value order by task.ordinality), '[]'::jsonb)
    from jsonb_array_elements(t.payload) with ordinality task(value, ordinality)
    where not (
      (task.value ->> 'studentId') = any(qa_student_ids)
      or (task.value ->> 'anchorBookingId') = any(qa_lp_ids)
      or btrim(coalesce(task.value ->> 'title', '')) like '%QA 系统验收 20260827%'
    )
  );

  if next_s is distinct from s.payload then
    update public.ops_state
    set payload = next_s,
        version = s.version + 1,
        updated_at = now(),
        updated_by = 'migration:trial-acceptance-fixture-cleanup'
    where entity = 'students'
    returning * into saved;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('students', saved.version, saved.updated_by);
  end if;

  if next_l is distinct from l.payload then
    update public.ops_state
    set payload = next_l,
        version = l.version + 1,
        updated_at = now(),
        updated_by = 'migration:trial-acceptance-fixture-cleanup'
    where entity = 'lpItems'
    returning * into saved;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('lpItems', saved.version, saved.updated_by);
  end if;

  if next_t is distinct from t.payload then
    update public.ops_state
    set payload = next_t,
        version = t.version + 1,
        updated_at = now(),
        updated_by = 'migration:trial-acceptance-fixture-cleanup'
    where entity = 'tasks'
    returning * into saved;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('tasks', saved.version, saved.updated_by);
  end if;
end;
$migration$;
