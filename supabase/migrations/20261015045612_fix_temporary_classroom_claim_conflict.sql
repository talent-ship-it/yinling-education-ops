do $temporary_classroom_claim_conflict$
declare
  target_oid oid;
  source_definition text;
  old_clause constant text := ') on conflict (request_identity) do nothing';
  new_clause constant text := ') on conflict on constraint temporary_classroom_requests_pkey do nothing';
begin
  target_oid := to_regprocedure(
    'public.claim_temporary_classroom_request(text,text,jsonb,text,text,text,text,text)'
  );
  if target_oid is null then
    raise exception 'temporary_classroom_claim_function_missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'internal.temporary_classroom_requests'::regclass
      and conname = 'temporary_classroom_requests_pkey'
      and contype = 'p'
      and pg_catalog.pg_get_constraintdef(oid) = 'PRIMARY KEY (request_identity)'
  ) then
    raise exception 'temporary_classroom_claim_constraint_mismatch';
  end if;

  select pg_catalog.pg_get_functiondef(target_oid) into source_definition;
  if position(new_clause in source_definition) > 0
     and position(old_clause in source_definition) = 0 then
    return;
  end if;
  if (length(source_definition) - length(replace(source_definition, old_clause, '')))
       / length(old_clause) <> 1 then
    raise exception 'temporary_classroom_claim_source_mismatch';
  end if;

  execute replace(source_definition, old_clause, new_clause);
end;
$temporary_classroom_claim_conflict$;
