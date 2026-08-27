-- The first bilingual matcher was deliberately conservative but used a
-- per-character PL/pgSQL loop. Replace it with PostgreSQL's native regex
-- engine so the canonical projection remains bounded for the full JWB batch.
create or replace function internal.student_import_jwb_auto_name_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  with runs as (
    select match[1] as chinese_run
    from pg_catalog.regexp_matches(
      internal.student_import_display_name(p_name),
      '([㐀-䶿一-龥豈-龎𠀀-𪘀]+)',
      'g'
    ) match
  )
  select case
    when count(*) = 1 and pg_catalog.char_length(max(chinese_run)) >= 2 then max(chinese_run)
    else ''::text
  end
  from runs
$$;

revoke all on function internal.student_import_jwb_auto_name_key(text)
  from public, anon, authenticated;

do $$
begin
  if internal.student_import_jwb_auto_name_key('张三') <> '张三'
     or internal.student_import_jwb_auto_name_key('张三 Zhang San') <> '张三'
     or internal.student_import_jwb_auto_name_key('Alice 张三') <> '张三'
     or internal.student_import_jwb_auto_name_key('Alice 张三 王') <> '' then
    raise exception using errcode = '22023', message = 'bilingual_jwb_regex_name_key_fixture_mismatch';
  end if;
end;
$$;
