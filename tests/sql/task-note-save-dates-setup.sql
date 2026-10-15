\set ON_ERROR_STOP on
\ir assert-disposable-database.sql

alter function internal.exam_submission_reconcile_tasks(jsonb, jsonb, text, text)
  rename to exam_submission_reconcile_tasks_legacy_20260815;

create function public.put_scoped_ops_state(
  p_secret text, p_entity text, p_payload jsonb, p_expected_version bigint,
  p_actor text, p_scope_versions jsonb default null
)
returns table(entity text, payload jsonb, version bigint, updated_at timestamptz, updated_by text)
language plpgsql security definer set search_path = '' as $$
declare saved public.ops_state%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception 'invalid_ops_secret'; end if;
  update public.ops_state s set payload = p_payload, version = s.version + 1,
    updated_at = clock_timestamp(), updated_by = p_actor
  where s.entity = p_entity and s.version = p_expected_version returning s.* into saved;
  if not found then raise exception using errcode = '40001', message = 'version_conflict'; end if;
  return query select saved.entity, saved.payload, saved.version, saved.updated_at, saved.updated_by;
end;
$$;

update public.ops_state set payload = '[
  {"id":"NOTE-1","status":"today","dueAt":"2026-10-15T00:00:00.000Z"},
  {"id":"NOTE-OLD","status":"today","dueAt":"2026-10-15T00:00:00.000Z","completionNote":"旧备注"},
  {"id":"NOTE-FROZEN","status":"today","completionNote":"冻结旧备注"}
]' where entity = 'tasks';

update public.ops_state set payload = '[{"id":"STU-1","owner":"Abby"}]' where entity = 'students';
