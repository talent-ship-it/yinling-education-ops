begin;
do $migration$
declare original text; definition text;
begin
 original := pg_get_functiondef('public.complete_lesson_occurrence_atomic(text,text,bigint,jsonb,text,jsonb,text,text,text,text)'::regprocedure);
 if position('lesson_hours := round(lesson_minutes / 60.0, 6);' in original)=0 or position('::numeric, 6) <> lesson_hours' in original)=0 then raise exception 'Unexpected settlement contract revision'; end if;
 definition := replace(original, 'lesson_hours numeric;', 'lesson_hours numeric; teacher_hours numeric; adjustment jsonb;');
 if definition=original then raise exception 'Missing settlement declaration'; end if;
 definition := replace(definition, 'lesson_hours := round(lesson_minutes / 60.0, 6);', $patch$
 lesson_hours := round(lesson_minutes / 60.0, 6);
 teacher_hours := lesson_hours;
 adjustment := p_settlement -> 'manualAdjustment';
 if adjustment is not null then
   if p_actor not in ('Nixon','Ops Admin') or nullif(trim(p_override_reason),'') is null or nullif(trim(p_attendance_reference),'') is not null or p_callback_nonce_sha256 is not null then raise exception 'manual_adjustment_forbidden'; end if;
   if jsonb_typeof(adjustment) <> 'object' or adjustment - 'actualMinutes' - 'studentMinutes' - 'teacherMinutes' <> '{}'::jsonb
     or not (adjustment ?& array['actualMinutes','studentMinutes','teacherMinutes']) then raise exception 'invalid_manual_adjustment'; end if;
   if exists(select 1 from jsonb_each(adjustment) v where jsonb_typeof(v.value) <> 'number' or v.value::text !~ '^([1-9]|[1-9][0-9]|[12][0-9]{2}|3[0-5][0-9]|360)$') then raise exception 'invalid_manual_minutes'; end if;
   lesson_hours := round((adjustment ->> 'studentMinutes')::numeric / 60.0, 6);
   teacher_hours := round((adjustment ->> 'teacherMinutes')::numeric / 60.0, 6);
 end if;
 $patch$);
 definition := replace(definition, 'round((teacher_credit ->> ''payableHours'')::numeric, 6) <> lesson_hours', 'round((teacher_credit ->> ''payableHours'')::numeric, 6) <> teacher_hours');
 -- A completed occurrence is read-only, but an exact receipt replay may return
 -- after the current versions, parties and archive checks have succeeded.
 if position('or current_status in (''cancelled'', ''leave'', ''completed'')' in definition)=0 then raise exception 'Unexpected settlement replay guard'; end if;
 definition := replace(definition, 'or current_status in (''cancelled'', ''leave'', ''completed'')', 'or current_status in (''cancelled'', ''leave'') or (current_status = ''completed'' and not replaying_prior)');
 execute definition;
end;
$migration$;
commit;
