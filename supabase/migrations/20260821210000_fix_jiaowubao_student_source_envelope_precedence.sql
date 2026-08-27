-- PostgreSQL parses JSONB extraction and subtraction with operator precedence
-- that is not safe for a nested object.  Keep the already-deployed migration
-- immutable and replace only the private envelope validator so a valid
-- expectedPublishedJwb object reaches the reviewed shape checks.

set local lock_timeout = '1s';

create or replace function internal.assert_jiaowubao_student_source_envelope(
  p_envelope jsonb
)
returns void
language plpgsql
immutable
set search_path = ''
as $jiaowubao_student_source_envelope$
begin
  if p_envelope is null
     or jsonb_typeof(p_envelope) <> 'object'
     or p_envelope - ARRAY[
       'sourceId', 'revision', 'candidateArtifactSha256',
       'sourceRevisions', 'normalizedRowsSha256',
       'expectedPublishedJwb',
       'expectedRowCount', 'expectedChunkCount', 'sourceMetadata'
     ]::text[] <> '{}'::jsonb
     or jsonb_typeof(p_envelope -> 'sourceId') <> 'string'
     or nullif(btrim(p_envelope ->> 'sourceId'), '') is null
     or p_envelope ->> 'sourceId' <> btrim(p_envelope ->> 'sourceId')
     or length(p_envelope ->> 'sourceId') > 160
     or jsonb_typeof(p_envelope -> 'revision') <> 'string'
     or nullif(btrim(p_envelope ->> 'revision'), '') is null
     or p_envelope ->> 'revision' <> btrim(p_envelope ->> 'revision')
     or length(p_envelope ->> 'revision') > 240
     or jsonb_typeof(p_envelope -> 'candidateArtifactSha256') <> 'string'
     or (p_envelope ->> 'candidateArtifactSha256') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'sourceRevisions') <> 'object'
     or internal.jiaowubao_student_source_jsonb_object_size(p_envelope -> 'sourceRevisions') not between 1 and 32
     or exists (
       select 1
       from jsonb_each(p_envelope -> 'sourceRevisions') source_revision(key, value)
       where nullif(btrim(source_revision.key), '') is null
          or length(source_revision.key) > 80
          or jsonb_typeof(source_revision.value) <> 'string'
          or nullif(btrim(source_revision.value #>> '{}'), '') is null
          or length(source_revision.value #>> '{}') > 240
     )
     or jsonb_typeof(p_envelope -> 'normalizedRowsSha256') <> 'string'
     or (p_envelope ->> 'normalizedRowsSha256') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'expectedPublishedJwb') <> 'object'
     or (p_envelope -> 'expectedPublishedJwb') - ARRAY[
       'sourceId', 'revision', 'rowsSha256', 'rowCount'
     ]::text[] <> '{}'::jsonb
     or jsonb_typeof(p_envelope -> 'expectedPublishedJwb' -> 'sourceId') <> 'string'
     or nullif(btrim(p_envelope -> 'expectedPublishedJwb' ->> 'sourceId'), '') is null
     or p_envelope -> 'expectedPublishedJwb' ->> 'sourceId'
       <> btrim(p_envelope -> 'expectedPublishedJwb' ->> 'sourceId')
     or length(p_envelope -> 'expectedPublishedJwb' ->> 'sourceId') > 160
     or jsonb_typeof(p_envelope -> 'expectedPublishedJwb' -> 'revision') <> 'string'
     or nullif(btrim(p_envelope -> 'expectedPublishedJwb' ->> 'revision'), '') is null
     or p_envelope -> 'expectedPublishedJwb' ->> 'revision'
       <> btrim(p_envelope -> 'expectedPublishedJwb' ->> 'revision')
     or length(p_envelope -> 'expectedPublishedJwb' ->> 'revision') > 240
     or jsonb_typeof(p_envelope -> 'expectedPublishedJwb' -> 'rowsSha256') <> 'string'
     or (p_envelope -> 'expectedPublishedJwb' ->> 'rowsSha256') !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'expectedPublishedJwb' -> 'rowCount') <> 'number'
     or (p_envelope -> 'expectedPublishedJwb' ->> 'rowCount')::numeric
       <> trunc((p_envelope -> 'expectedPublishedJwb' ->> 'rowCount')::numeric)
     or (p_envelope -> 'expectedPublishedJwb' ->> 'rowCount')::integer not between 1 and 10000
     or jsonb_typeof(p_envelope -> 'expectedRowCount') <> 'number'
     or (p_envelope ->> 'expectedRowCount')::numeric <> trunc((p_envelope ->> 'expectedRowCount')::numeric)
     or (p_envelope ->> 'expectedRowCount')::integer not between 1 and 10000
     or jsonb_typeof(p_envelope -> 'expectedChunkCount') <> 'number'
     or (p_envelope ->> 'expectedChunkCount')::numeric <> trunc((p_envelope ->> 'expectedChunkCount')::numeric)
     or (p_envelope ->> 'expectedChunkCount')::integer not between 1 and 512
     or jsonb_typeof(p_envelope -> 'sourceMetadata') <> 'object'
     or octet_length((p_envelope -> 'sourceMetadata')::text) not between 2 and 32768 then
    raise exception using errcode = '22023', message = 'jiaowubao_student_source_envelope_invalid';
  end if;
end;
$jiaowubao_student_source_envelope$;

revoke all on function internal.assert_jiaowubao_student_source_envelope(jsonb)
  from public, anon, authenticated;
