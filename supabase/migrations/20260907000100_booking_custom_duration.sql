begin;
-- Preserve every existing authorization, ledger and OCC check. Refuse to patch
-- an unexpected function revision rather than overwriting an independently changed contract.
do $migration$
declare definition text; original text;
begin
  original := pg_get_functiondef('internal.assert_jiaowubao_direct_booking_interval_available(text,text,jsonb)'::regprocedure);
  if position('occurrence_duration not in (60, 90, 120)' in original) = 0 then
    raise exception 'Unexpected booking duration guard revision';
  end if;
  definition := replace(original, 'occurrence_duration not in (60, 90, 120)', 'occurrence_duration not between 15 and 360');
  definition := replace(definition, 'occurrence_duration := (p_booking ->> ''duration'')::integer;', 'if (p_booking ->> ''duration'') !~ ''^(1[5-9]|[2-9][0-9]|[12][0-9]{2}|3[0-5][0-9]|360)$'' then raise exception ''invalid_booking_duration''; end if; occurrence_duration := (p_booking ->> ''duration'')::integer;');
  definition := replace(definition, 'occurrence_duration := coalesce((occurrence_override ->> ''durationMinutes'')::integer, (p_booking ->> ''duration'')::integer);', 'if coalesce(occurrence_override ->> ''durationMinutes'', p_booking ->> ''duration'') !~ ''^(1[5-9]|[2-9][0-9]|[12][0-9]{2}|3[0-5][0-9]|360)$'' then raise exception ''invalid_booking_duration''; end if; occurrence_duration := coalesce((occurrence_override ->> ''durationMinutes'')::integer, (p_booking ->> ''duration'')::integer);');
  if position('if (p_booking ->> ''duration'') !~' in definition) = 0 or position('if coalesce(occurrence_override ->> ''durationMinutes'', p_booking ->> ''duration'') !~' in definition) = 0 then raise exception 'Missing duration validation insertion'; end if;
  execute definition;
  original := pg_get_functiondef('public.mutate_booking_projection_atomic(text,text,jsonb,text,text,jsonb,jsonb,jsonb,jsonb,text,text,text,text)'::regprocedure);
  if position('not in (''60'', ''90'', ''120'')' in original) = 0 then raise exception 'Unexpected booking projection revision'; end if;
  definition := replace(original, 'not in (''60'', ''90'', ''120'')', '!~ ''^(1[5-9]|[2-9][0-9]|[12][0-9]{2}|3[0-5][0-9]|360)$''');
  execute definition;
end;
$migration$;
commit;
