begin;

-- Teachers provide LP material; the student's operations owner executes and
-- tracks the handover. Keep due dates, watchers and all command guards intact.
do $migration$
declare
  original text;
  old_owner text := $old$'title', '写 LP 给新老师', 'owner', source_teacher_name,
      'assignees', jsonb_build_array(source_teacher_name)$old$;
  new_owner text := $new$'title', '写 LP 给新老师', 'owner', coalesce(nullif(trim(p_student_owner), ''), '待分配'),
      'assignees', jsonb_build_array(coalesce(nullif(trim(p_student_owner), ''), '待分配'))$new$;
  old_absence_owner text := $old$select coalesce(case when jsonb_typeof(value -> 'name') = 'string' then nullif(trim(value ->> 'name'), '') end, p_source_teacher_id) into task_owner from jsonb_array_elements(h.payload) where jsonb_typeof(value -> 'id') = 'string' and value ->> 'id' = p_source_teacher_id limit 1;$old$;
begin
  original := pg_get_functiondef('internal.teacher_departure_creation_tasks_v2(text,text,text,text,text,jsonb,date,timestamp with time zone)'::regprocedure);
  if position(old_owner in original) = 0
     or (length(original) - length(replace(original, old_owner, ''))) <> length(old_owner) then
    raise exception 'Unexpected departure LP owner revision';
  end if;
  execute replace(original, old_owner, new_owner);

  original := pg_get_functiondef('public.create_teacher_absence_atomic(text,text,jsonb,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,text)'::regprocedure);
  if position(old_absence_owner in original) = 0
     or (length(original) - length(replace(original, old_absence_owner, ''))) <> length(old_absence_owner) then
    raise exception 'Unexpected absence LP owner revision';
  end if;
  execute replace(original, old_absence_owner,
    $new$task_owner := coalesce(case when jsonb_typeof(student_item -> 'owner') = 'string' then nullif(trim(student_item ->> 'owner'), '') end, '待分配');$new$);
end;
$migration$;

commit;
