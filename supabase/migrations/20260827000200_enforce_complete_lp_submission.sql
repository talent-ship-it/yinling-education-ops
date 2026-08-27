-- Preserve permissive readers for historical LP rows, but prevent every new
-- atomic command from creating the legacy-minimal shapes that the current UI
-- can no longer submit.

alter function public.mutate_lp_atomic(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  rename to mutate_lp_atomic_without_complete_template_guard;

revoke all on function public.mutate_lp_atomic_without_complete_template_guard(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;

create or replace function public.mutate_lp_atomic(
  p_secret text,
  p_command_uuid text,
  p_command_intent jsonb,
  p_operation text,
  p_student_id text,
  p_provisional_intake jsonb,
  p_lp_item_id text,
  p_workflow_type text,
  p_fields jsonb,
  p_revision_note text,
  p_authorized_assignment jsonb,
  p_expected_versions jsonb,
  p_actor text
)
returns table(command_key text, operation text, applied boolean, student_id text, lp_item_id text,
  students_row public.ops_state, lp_items_row public.ops_state, tasks_row public.ops_state,
  files_row public.ops_state, audit_entry_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  required_key text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  if p_operation = 'create' and p_workflow_type = '学生直报（无试听）' then
    raise exception using errcode = '22023', message = 'direct_enrollment_required';
  end if;

  if p_operation = 'create' and p_workflow_type = '老师新 LP' then
    foreach required_key in array array['additionalNotes','basicInfo','studentFoundation','learningGoal','recommendedResources','teachingLanguage','firstLessonContent','lessonSchedule'] loop
      if nullif(trim(p_fields ->> required_key), '') is null then
        raise exception using errcode = '22023', message = 'incomplete_teacher_new_lp_template';
      end if;
    end loop;
  end if;

  if p_operation = 'create' and p_workflow_type = '老师 LP 修改'
     and nullif(trim(p_fields ->> 'modificationRequirements'), '') is null then
    raise exception using errcode = '22023', message = 'incomplete_teacher_lp_modification_template';
  end if;

  if p_operation = 'create' and p_workflow_type = '换老师试听' then
    foreach required_key in array array['handoverFromTeacher','materialsAndContentTaught','recommendedNextContent','studentStrengthsAndLearningProfile','lastHomework','lastLessonRecordingUrl'] loop
      if nullif(trim(p_fields ->> required_key), '') is null then
        raise exception using errcode = '22023', message = 'incomplete_teacher_change_lp_template';
      end if;
    end loop;
  end if;

  if p_operation = 'create' and p_workflow_type = '代课 LP' then
    foreach required_key in array array['additionalNotes','basicInfo','studentFoundation','learningGoal','allocatedLessonContentAndResources','teachingLanguage','lastHomework','lastLessonRecordingUrl'] loop
      if nullif(trim(p_fields ->> required_key), '') is null then
        raise exception using errcode = '22023', message = 'incomplete_substitute_lp_template';
      end if;
    end loop;
  end if;

  if p_operation = 'create' and p_workflow_type = '学生报名交接'
     and (
       jsonb_typeof(p_fields -> 'purchasedHours') is distinct from 'number'
       or jsonb_typeof(p_fields -> 'bonusHours') is distinct from 'number'
       or coalesce((p_fields ->> 'purchasedHours')::numeric, 0)
          + coalesce((p_fields ->> 'bonusHours')::numeric, 0) <= 0
       or nullif(trim(p_fields ->> 'lessonFrequency'), '') is null
       or nullif(trim(p_fields ->> 'preferredTime'), '') is null
       or nullif(trim(p_fields ->> 'coursesAndTeachers'), '') is null
     ) then
    raise exception using errcode = '22023', message = 'incomplete_enrollment_handover_template';
  end if;

  return query
  select guarded.command_key, guarded.operation, guarded.applied, guarded.student_id, guarded.lp_item_id,
    guarded.students_row, guarded.lp_items_row, guarded.tasks_row, guarded.files_row, guarded.audit_entry_id
  from public.mutate_lp_atomic_without_complete_template_guard(
    p_secret,
    p_command_uuid,
    p_command_intent,
    p_operation,
    p_student_id,
    p_provisional_intake,
    p_lp_item_id,
    p_workflow_type,
    p_fields,
    p_revision_note,
    p_authorized_assignment,
    p_expected_versions,
    p_actor
  ) as guarded;
end;
$$;

revoke all on function public.mutate_lp_atomic(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.mutate_lp_atomic(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  to anon, authenticated;
