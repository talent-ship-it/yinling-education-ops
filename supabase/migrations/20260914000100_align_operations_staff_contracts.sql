-- Match the application's historical identity contract. Current account status
-- and student ownership checks remain separate authorization boundaries.
do $align_staff$
declare target record; definition text; updated text;
begin
  for target in select * from (values
    ('internal.validate_student_creation_fields(jsonb)',
     '''Nixon'', ''Ops Admin'', ''Abby'', ''Ella'', ''Molly'', ''Thea'', ''Tiffany'', ''Tara'', ''Eileen'', ''思佳''',
     '''Nixon'', ''Ops Admin'', ''Abby'', ''Ella'', ''Erin'', ''Molly'', ''Thea'', ''Tiffany'', ''Tara'', ''Eileen'', ''思佳'''),
    ('public.mutate_legacy_operation_task_atomic(text,text,jsonb,text,text,text,text,text,text,text,jsonb,text)',
     '''Nixon'', ''Ops Admin'', ''Abby'', ''Ella'', ''Molly'', ''Thea'', ''Tiffany'', ''Tara'', ''Eileen'', ''思佳''',
     '''Nixon'', ''Ops Admin'', ''Abby'', ''Ella'', ''Erin'', ''Molly'', ''Thea'', ''Tiffany'', ''Tara'', ''Eileen'', ''思佳'''),
    ('public.mutate_lp_atomic_without_complete_template_guard(text,text,jsonb,text,text,jsonb,text,text,jsonb,text,jsonb,jsonb,text)',
     'array[''Abby'',''Ella'',''Molly'',''Thea'',''Tiffany'',''Tara'',''Eileen'',''思佳'']',
     'array[''Abby'',''Ella'',''Erin'',''Molly'',''Thea'',''Tiffany'',''Tara'',''Eileen'',''思佳'']')
  ) as targets(signature, old_list, new_list) loop
    definition := pg_get_functiondef(target.signature::regprocedure);
    if position(target.new_list in definition) > 0 then continue; end if;
    updated := replace(definition, target.old_list, target.new_list);
    if updated = definition
       or (length(definition) - length(replace(definition, target.old_list, ''))) / length(target.old_list) <> 1 then
      raise exception 'staff_contract_definition_drift: %', target.signature;
    end if;
    -- pg_get_functiondef preserves SECURITY DEFINER and search_path; CREATE OR
    -- REPLACE preserves the function OID and its existing execution grants.
    execute updated;
  end loop;
end;
$align_staff$;
