do $lp_nonretryable_conflicts$
declare signature text; definition text; old_fragment text; new_fragment text; expected integer;
begin
  for signature, old_fragment, expected in select * from (values
    ('public.read_wecom_lp_draft(text,text,text,boolean)',
     'errcode = ''40001'', message = ''wecom_lp_source_superseded''',1),
    ('public.confirm_wecom_lp_draft_atomic(text,uuid,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,boolean,text)',
     'errcode = ''40001'', message = ''wecom_lp_source_superseded''',1),
    ('public.confirm_wecom_lp_draft_atomic(text,uuid,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,boolean,text)',
     'errcode = ''40001'', message = ''wecom_lp_confirmation_busy''',2)
  ) targets(signature, fragment, occurrences) loop
    definition := pg_catalog.pg_get_functiondef(signature::regprocedure);
    if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment) <> expected then
      raise exception 'wecom_lp_nonretryable_conflict_drift: %',signature;
    end if;
    new_fragment := replace(old_fragment,'''40001''','''PT409''');
    execute replace(definition,old_fragment,new_fragment);
  end loop;
end;
$lp_nonretryable_conflicts$;
