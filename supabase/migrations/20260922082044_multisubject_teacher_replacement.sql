begin;

-- Authorization comes from the departure ledger and exact occurrence closure,
-- not the legacy single-teacher display field. Preserve every other guard.
do $migration$
declare
  original text;
  old_guard text := $old$
     or (
       nullif(trim(current_student ->> 'teacher'), '') is not null
       and nullif(trim(current_student ->> 'teacher'), '') not in (
         nullif(trim(current_source_teacher ->> 'name'), ''), '待匹配', '待确认'
       )
     )$old$;
  old_projection text := $old$case when item.value ->> 'id' = p_student_id
      then jsonb_set(item.value, '{teacher}', to_jsonb(replacement_teacher_name), true)$old$;
  new_projection text := $new$case when item.value ->> 'id' = p_student_id
      and (nullif(trim(item.value ->> 'teacher'), '') is null
        or trim(item.value ->> 'teacher') in (trim(current_source_teacher ->> 'name'), '待匹配', '待确认'))
      then jsonb_set(item.value, '{teacher}', to_jsonb(replacement_teacher_name), true)$new$;
begin
  original := pg_get_functiondef('public.confirm_permanent_teacher_replacement_atomic(text,text,jsonb,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure);
  if position(old_guard in original) = 0 or position(old_projection in original) = 0
     or (length(original) - length(replace(original, old_guard, ''))) <> length(old_guard)
     or (length(original) - length(replace(original, old_projection, ''))) <> length(old_projection) then
    raise exception 'Unexpected permanent replacement assignment revision';
  end if;
  execute replace(replace(original, old_guard, ''), old_projection, new_projection);
end;
$migration$;

commit;
