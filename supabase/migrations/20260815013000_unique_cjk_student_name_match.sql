-- Match a student by a punctuation-free Chinese-only key only when the
-- canonical projection proves that key is unique on both source sides.
-- Mixed-script names fail closed; Latin-only names retain the existing exact
-- NFKC/whitespace/ASCII-case contract.
create or replace function internal.student_import_cjk_name_key(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  display_name text := internal.student_import_display_name(p_name);
  result text := '';
  character_value text;
  code_point integer;
  character_position integer;
begin
  if display_name = '' then
    return '';
  end if;
  for character_position in 1..pg_catalog.char_length(display_name) loop
    character_value := pg_catalog.substr(display_name, character_position, 1);
    code_point := pg_catalog.ascii(character_value);
    if code_point = 32
       or (code_point between 33 and 47)
       or (code_point between 58 and 64)
       or (code_point between 91 and 96)
       or (code_point between 123 and 126)
       or code_point = 183
       or (code_point between 8208 and 8231)
       or (code_point between 8240 and 8286)
       or (code_point between 12289 and 12291)
       or (code_point between 12296 and 12305)
       or (code_point between 12308 and 12319)
       or code_point = 12336
       or code_point = 12349
       or code_point = 12539
       or (code_point between 65040 and 65049)
       or (code_point between 65072 and 65106)
       or (code_point between 65108 and 65121)
       or code_point = 65123
       or code_point = 65128 then
      continue;
    elsif (code_point between 13312 and 19903)
       or (code_point between 19968 and 40959)
       or (code_point between 63744 and 64255)
       or (code_point between 131072 and 195103)
       or (code_point between 196608 and 201551) then
      result := result || character_value;
    else
      return '';
    end if;
  end loop;
  return case when pg_catalog.char_length(result) >= 2 then result else '' end;
end;
$$;

create or replace function internal.student_import_name_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    nullif(internal.student_import_cjk_name_key(p_name), ''),
    pg_catalog.translate(
      internal.student_import_display_name(p_name),
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'abcdefghijklmnopqrstuvwxyz'
    )
  )
$$;

revoke all on function internal.student_import_cjk_name_key(text)
  from public, anon, authenticated;
revoke all on function internal.student_import_name_key(text)
  from public, anon, authenticated;

-- Migration-time golden fixtures exercise the existing canonical projection,
-- proving the helper is used at the SQL write boundary as well as in TS.
do $$
declare
  matched_projection jsonb;
  duplicate_projection jsonb;
  short_projection jsonb;
begin
  if internal.student_import_cjk_name_key('张 · 三') <> '张三'
     or internal.student_import_cjk_name_key('Alice 张三') <> ''
     or internal.student_import_cjk_name_key('Alice 张') <> ''
     or internal.student_import_name_key('ÉLODIE') <> 'Élodie'
     or internal.student_import_name_key('张·三') <>
        internal.student_import_name_key('张（三）') then
    raise exception using errcode = '22023', message = 'student_import_cjk_name_key_fixture_mismatch';
  end if;

  matched_projection := internal.student_import_canonical_projection(
    'cjk-fixture-master',
    '[{"sourceRow":"M-1","name":"张·三","status":"在读"}]'::jsonb,
    '[{"sourceRow":"J-1","name":"张（三）","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb
  );
  if matched_projection #>> '{0,jwbMatchStatus}' <> 'matched'
     or matched_projection #>> '{0,jwbSourceRow}' <> 'J-1' then
    raise exception using errcode = '22023', message = 'student_import_cjk_projection_match_fixture_mismatch';
  end if;

  duplicate_projection := internal.student_import_canonical_projection(
    'cjk-fixture-master',
    '[{"sourceRow":"M-1","name":"张三","status":"在读"}]'::jsonb,
    '[{"sourceRow":"J-1","name":"张·三","remainingHours":1,"contractHours":1,"packageCoverage":"none"},{"sourceRow":"J-2","name":"张（三）","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb
  );
  if duplicate_projection #>> '{0,jwbMatchStatus}' <> 'ambiguous'
     or (duplicate_projection -> 0) ? 'jwbSourceRow' then
    raise exception using errcode = '22023', message = 'student_import_cjk_projection_duplicate_fixture_mismatch';
  end if;

  short_projection := internal.student_import_canonical_projection(
    'cjk-fixture-master',
    '[{"sourceRow":"M-1","name":"Alice 张","status":"在读"}]'::jsonb,
    '[{"sourceRow":"J-1","name":"张 Bob","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb
  );
  if short_projection #>> '{0,jwbMatchStatus}' <> 'unmatched'
     or (short_projection -> 0) ? 'jwbSourceRow' then
    raise exception using errcode = '22023', message = 'student_import_cjk_projection_short_fixture_mismatch';
  end if;
end;
$$;
