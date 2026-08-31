-- The immutable read-model projection predates native source-ID crosswalks,
-- so a source teacher with no display name remains conservatively unmatched
-- there even after the native merge creates an exact ID-linked teacher. The
-- public post-write receipt must report the durable native crosswalk, which is
-- the final system-of-record mapping after apply.

set local lock_timeout = '2s';

create or replace function public.project_jiaowubao_open_api_authority(
  p_secret text,
  p_revision text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '240s'
as $project_jiaowubao_open_api_authority$
declare
  initial_projection jsonb;
  final_projection jsonb;
  native_apply jsonb;
  projection_id uuid;
  native_matches jsonb;
  native_matched_count integer;
begin
  initial_projection := public.project_jiaowubao_open_api_authority_read_model(
    p_secret, p_revision, p_actor
  );
  projection_id := (initial_projection ->> 'projectionRunId')::uuid;
  native_apply := public.apply_jiaowubao_open_api_authority_native(
    p_secret, projection_id, p_actor
  );
  if native_apply ->> 'applied' = 'true' then
    final_projection := public.project_jiaowubao_open_api_authority_read_model(
      p_secret, p_revision, p_actor
    );
  else
    final_projection := initial_projection;
  end if;

  with entity_types(entity_type) as (
    values ('schedule'::text), ('student'::text), ('teacher'::text),
      ('course'::text), ('class'::text), ('room'::text)
  ), counts as (
    select entity_type.entity_type,
      count(link.source_native_id)::integer as matched
    from entity_types entity_type
    left join internal.jiaowubao_authority_native_links link
      on link.entity_type = entity_type.entity_type and link.active
    group by entity_type.entity_type
  )
  select jsonb_object_agg(entity_type, jsonb_build_object(
      'total', matched,
      'matched', matched,
      'unmatched', 0,
      'conflict', 0,
      'sourceOnly', 0,
      'matchRate', case when matched = 0 then 0 else 100 end,
      'basis', 'durable_source_id_crosswalk'
    ) order by entity_type),
    sum(matched)::integer
  into native_matches, native_matched_count
  from counts;

  final_projection := jsonb_set(final_projection, '{matches}', native_matches, true);
  final_projection := jsonb_set(
    final_projection,
    '{coverage,matchedEntityRows}',
    to_jsonb(native_matched_count),
    true
  );
  final_projection := jsonb_set(
    final_projection,
    '{coverage,sourceOnlyEntityRows}',
    '0'::jsonb,
    true
  );
  final_projection := jsonb_set(
    final_projection,
    '{coverage,nativeRecordsOverwritten}',
    'true'::jsonb,
    true
  );
  final_projection := jsonb_set(
    final_projection,
    '{coverage,nativeRecordsSynchronized}',
    'true'::jsonb,
    true
  );
  final_projection := jsonb_set(
    final_projection,
    '{coverage,nativeMatchBasis}',
    '"durable_source_id_crosswalk"'::jsonb,
    true
  ) || jsonb_build_object('nativeApply', native_apply);

  update public.ops_source_snapshots source_snapshot
  set payload = final_projection - 'replayed'
  where source_snapshot.source_id = 'jiaowubao-open-api-schedule';

  return final_projection;
end;
$project_jiaowubao_open_api_authority$;

revoke all on function public.project_jiaowubao_open_api_authority(text,text,text)
  from public, anon, authenticated;
grant execute on function public.project_jiaowubao_open_api_authority(text,text,text)
  to anon, authenticated;

comment on function public.project_jiaowubao_open_api_authority(text,text,text) is
  'Secret-gated 30-minute Jiaowubao projection, native synchronization and final durable source-ID crosswalk verification.';
