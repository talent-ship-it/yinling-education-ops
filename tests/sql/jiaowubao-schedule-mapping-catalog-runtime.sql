\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
begin;
create schema internal;
create schema extensions;
create extension pgcrypto with schema extensions;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
end $$;
\ir ../../supabase/migrations/20261026025705_expand_jiaowubao_mapping_subject_catalog.sql

do $fixture$
declare
  subjects jsonb;
  teacher jsonb;
  catalog record;
  expected_digest text;
  subject_limit integer;
begin
  foreach subject_limit in array array[544,1024] loop
    select jsonb_agg('Subject ' || item order by item) into subjects from generate_series(1,subject_limit) item;
    teacher := jsonb_build_object('id','synthetic-teacher','name','Synthetic Teacher','subjects',subjects);
    select * into strict catalog from internal.jiaowubao_direct_schedule_mapping_teacher_catalog(jsonb_build_array(teacher));
    if cardinality(catalog.subject_ids) <> subject_limit then
      raise exception 'catalog was truncated';
    end if;
    select encode(extensions.digest(convert_to(
      'jiaowubao-direct-schedule-mapping-target-v1' || chr(31)
      || 'synthetic-teacher' || chr(31) || 'Synthetic Teacher' || chr(31)
      || string_agg(value #>> '{}',chr(31) order by value #>> '{}'),'UTF8'),'sha256'),'hex')
    into expected_digest from jsonb_array_elements(subjects);
    if catalog.target_basis_sha256 <> expected_digest then
      raise exception 'target authority digest changed';
    end if;
  end loop;

  begin
    perform * from internal.jiaowubao_direct_schedule_mapping_teacher_catalog(jsonb_build_array(teacher || jsonb_build_object('subjects',subjects || '"Oversized"'::jsonb)));
    raise exception '1025 subjects accepted';
  exception when sqlstate '55000' then
    if sqlerrm <> 'jiaowubao_schedule_mapping_teacher_subject_catalog_too_large' then raise; end if;
  end;
  begin
    perform * from internal.jiaowubao_direct_schedule_mapping_teacher_catalog(jsonb_build_array(teacher || jsonb_build_object('subjects',(subjects - 1023) || jsonb_build_array(subjects->0))));
    raise exception 'duplicate subject accepted';
  exception when sqlstate '55000' then
    if sqlerrm <> 'jiaowubao_schedule_mapping_teachers_state_invalid' then raise; end if;
  end;
  begin
    perform * from internal.jiaowubao_direct_schedule_mapping_teacher_catalog(jsonb_build_array(teacher || jsonb_build_object('subjects',(subjects - 1023) || 'null'::jsonb)));
    raise exception 'invalid subject accepted';
  exception when sqlstate '55000' then
    if sqlerrm <> 'jiaowubao_schedule_mapping_teachers_state_invalid' then raise; end if;
  end;
  begin
    perform * from internal.jiaowubao_direct_schedule_mapping_teacher_catalog((select jsonb_agg(teacher) from generate_series(1,513)));
    raise exception '513 teachers accepted';
  exception when sqlstate '55000' then
    if sqlerrm <> 'jiaowubao_schedule_mapping_teacher_catalog_too_large' then raise; end if;
  end;
  if has_function_privilege('anon','internal.jiaowubao_direct_schedule_mapping_teacher_catalog(jsonb)','execute')
     or has_function_privilege('authenticated','internal.jiaowubao_direct_schedule_mapping_teacher_catalog(jsonb)','execute') then
    raise exception 'catalog access widened';
  end if;
end;
$fixture$;
rollback;
