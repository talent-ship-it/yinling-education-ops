begin;

-- Candidate discovery is advisory at registration. Keep the exact affected
-- occurrence closure, OCC, actor scope and candidate validation; confirmation
-- must still validate a real replacement before reassigning any lesson.
do $migration$
declare
  original text;
  old_guard text := E'\n      or jsonb_array_length(item.value -> ''candidateTeacherIds'') = 0';
begin
  original := pg_get_functiondef('public.create_teacher_departure_atomic(text,text,jsonb,text,text,text,jsonb,jsonb,jsonb,jsonb,text,text)'::regprocedure);
  if position(old_guard in original) = 0
     or (length(original) - length(replace(original, old_guard, ''))) <> length(old_guard) then
    raise exception 'Unexpected departure candidate guard revision';
  end if;
  execute replace(original, old_guard, '');
end;
$migration$;

commit;
