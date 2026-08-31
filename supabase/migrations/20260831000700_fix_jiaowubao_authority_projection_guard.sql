-- One immutable guard protects both projection tables, whose row types differ.
-- Compare generic JSON row images so the entity-table branch never resolves a
-- runs-only field (and vice versa). The same narrow initialization updates are
-- still the only updates allowed; deletes and later mutations remain blocked.

create or replace function internal.guard_jiaowubao_authority_projection_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_record jsonb := to_jsonb(old);
  new_record jsonb := to_jsonb(new);
begin
  if tg_table_schema = 'internal'
     and tg_table_name = 'jiaowubao_authority_projection_runs'
     and tg_op = 'UPDATE'
     and old_record -> 'summary' = '{}'::jsonb
     and new_record -> 'summary' <> '{}'::jsonb
     and (new_record - 'summary') = (old_record - 'summary') then
    return new;
  end if;

  if tg_table_schema = 'internal'
     and tg_table_name = 'jiaowubao_authority_projection_entities'
     and tg_op = 'UPDATE'
     and exists (
       select 1
       from internal.jiaowubao_authority_projection_runs projection_run
       where projection_run.id = (old_record ->> 'projection_run_id')::uuid
         and projection_run.summary = '{}'::jsonb
     )
     and (new_record - array['match_status','match_strategy','matched_entity_id','conflict_type']::text[])
       = (old_record - array['match_status','match_strategy','matched_entity_id','conflict_type']::text[]) then
    return new;
  end if;

  raise exception using errcode = '55000', message = 'jiaowubao_authority_projection_immutable';
end;
$$;

revoke all on function internal.guard_jiaowubao_authority_projection_immutable()
  from public, anon, authenticated;
