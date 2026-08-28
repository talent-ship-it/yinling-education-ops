\set ON_ERROR_STOP on

-- Disposable local execution contract for 20260828000200. Never run this
-- fixture against production.
drop schema if exists internal cascade;
drop schema if exists extensions cascade;
drop table if exists public.ops_mutation_log cascade;
drop table if exists public.ops_state cascade;

create schema internal;
create schema extensions;
create extension if not exists pgcrypto with schema extensions;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end;
$$;

create table public.ops_state (
  entity text primary key,
  payload jsonb not null,
  version bigint not null,
  updated_at timestamptz not null default now(),
  updated_by text not null
);
create table public.ops_mutation_log (entity text not null, version bigint not null, actor text not null);
create table internal.operational_contract_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  action text not null,
  actor text not null,
  target_type text not null,
  target_id text not null,
  metadata jsonb not null,
  created_at timestamptz not null default now()
);
create table internal.legacy_task_deadline_freezes (
  task_id text primary key
);
create function internal.fixture_enforce_legacy_task_evidence()
returns trigger language plpgsql set search_path = '' as $$
declare old_task jsonb;
begin
  if new.entity <> 'tasks' then return new; end if;
  for old_task in
    select value
    from jsonb_array_elements(old.payload) item(value)
    where exists (
      select 1 from internal.legacy_task_deadline_freezes ledger
      where ledger.task_id = value ->> 'id'
    )
  loop
    if not exists (
      select 1 from jsonb_array_elements(new.payload) item(value)
      where value ->> 'id' = old_task ->> 'id'
    ) then
      raise exception using errcode = '42501', message = 'legacy_task_evidence_delete_forbidden';
    end if;
  end loop;
  return new;
end;
$$;
create trigger fixture_enforce_legacy_task_evidence
before update of payload on public.ops_state
for each row execute function internal.fixture_enforce_legacy_task_evidence();
create function internal.verify_ops_secret(p_secret text)
returns boolean language sql immutable set search_path = ''
as $$ select p_secret = 'trial-manual-fixture-secret' $$;
create function internal.append_operational_contract_audit(
  p_action text, p_actor text, p_target_type text, p_target_id text, p_metadata jsonb default '{}'::jsonb
) returns uuid language plpgsql set search_path = '' as $$
declare saved uuid;
begin
  insert into internal.operational_contract_audit(action, actor, target_type, target_id, metadata)
  values (p_action, p_actor, p_target_type, p_target_id, p_metadata)
  returning id into saved;
  return saved;
end;
$$;

\ir ../../supabase/migrations/20260819101600_lp_create_revision_atomic.sql
\ir ../../supabase/migrations/20260827000200_enforce_complete_lp_submission.sql
\ir ../../supabase/migrations/20260828000200_trial_manual_tasks_atomic.sql
\ir ../../supabase/migrations/20260828000300_preserve_trial_legacy_evidence.sql
\ir ../../supabase/migrations/20260828000400_align_trial_handbook_task_titles.sql

insert into public.ops_state(entity, payload, version, updated_by) values
  ('students', '[{"id":"STU-1","name":"Atomic Trial","guardianWechat":"Daisy","owner":"Abby","planner":"Tara","files":0}]', 1, 'fixture'),
  ('lpItems', '[]', 1, 'fixture'),
  ('tasks', '[{"id":"TSK-LEGACY-SPARSE","title":"Historical task without canonical metadata","owner":"Archive","studentId":"STU-HISTORICAL","status":"today","legacyEvidence":{"state":"frozen","reason":"missing_canonical_due_at","frozenAt":"2026-08-19T00:00:00.000Z"}},{"id":"TSK-LEGACY-MATCH","title":"Frozen legacy rule for the deterministic LP anchor","owner":"Archive","studentId":"STU-HISTORICAL","status":"today","ruleKey":"trial.parent-follow-up","anchorBookingId":"LP-ATOMIC-a8f78ee5b2f178415038e032","legacyEvidence":{"state":"frozen","reason":"missing_canonical_due_at","frozenAt":"2026-08-19T00:00:00.000Z"}}]', 1, 'fixture'),
  ('files', '[]', 1, 'fixture');
insert into internal.legacy_task_deadline_freezes(task_id)
values ('TSK-LEGACY-SPARSE'), ('TSK-LEGACY-MATCH');

do $trial_manual_runtime$
declare
  fields jsonb := '{
    "responsibleOperations":"Abby",
    "specifiedContentStatus":"需教务跟进",
    "specialNotes":"",
    "preparationFollowUp":"否",
    "isUniversityStudent":false,
    "universityMajor":"",
    "universityYear":"",
    "assignedTeacher":"Grace",
    "subject":"English",
    "oneSentenceDescription":"Atomic trial",
    "locationTimezone":"Australia/Melbourne",
    "contactPerson":"家长",
    "timeMentioned":false,
    "preferredTime":"",
    "studentNameKnown":true,
    "trialPaymentMethod":"免费试听",
    "planner":"Tara",
    "requestSentAt":"2099-08-28T02:00:00.000Z",
    "contactParents":true,
    "contactStudent":false,
    "contactNote":"Parent first",
    "writingRequired":true,
    "writingNote":"Essay",
    "paperRequired":true,
    "paperNote":"PDF",
    "preparationNote":"Prepare materials",
    "studentName":"Atomic Trial",
    "trialDurationMinutes":60,
    "trialDurationNote":"Standard"
  }';
  expected jsonb := '{"students":1,"lpItems":1,"tasks":1,"files":1}';
  intent jsonb;
  receipt record;
  replay record;
  lookup record;
  lp jsonb;
  rules text[];
  caught_state text;
  caught_message text;
begin
  intent := jsonb_build_object(
    'operation','create','studentId','STU-1','workflowType','试听 LP',
    'fields',fields,'expectedVersions',expected
  );
  select * into receipt from public.mutate_lp_atomic(
    'trial-manual-fixture-secret','00000000-0000-4000-8000-000000000101',intent,
    'create','STU-1',null,null,'试听 LP',fields,null,
    '{"owner":"Abby","planner":"Tara","mayReassign":false}',expected,'Abby'
  );
  if not receipt.applied
     or (receipt.students_row).version <> 2
     or (receipt.lp_items_row).version <> 3
     or (receipt.tasks_row).version <> 3
     or (receipt.files_row).version <> 1 then
    raise exception 'trial_manual_atomic_versions_failed';
  end if;

  select value into lp
  from jsonb_array_elements((receipt.lp_items_row).payload)
  where value ->> 'id' = receipt.lp_item_id;
  if lp ->> 'requestedAt' <> '2099-08-28T02:00:00.000Z'
     or lp -> 'trialIntake' ->> 'planner' <> 'Tara'
     or lp -> 'trialIntake' ->> 'paperRequired' <> 'true'
     or lp -> 'fields' ->> 'specifiedContentStatus' <> '需教务跟进'
     or lp -> 'fields' ->> 'requestSentAt' <> '2099-08-28T02:00:00.000Z'
     or lp -> 'revisions' -> 0 -> 'after' ->> 'requestSentAt' <> '2099-08-28T02:00:00.000Z' then
    raise exception 'trial_manual_lp_projection_failed';
  end if;

  select array_agg(task ->> 'ruleKey' order by task ->> 'ruleKey') into rules
  from jsonb_array_elements((receipt.tasks_row).payload) task
  where task ->> 'anchorBookingId' = receipt.lp_item_id
    and not (task ? 'legacyEvidence');
  if rules is distinct from array[
    'lp.handover',
    'trial.manual-request.paper-receive',
    'trial.manual-request.paper-send',
    'trial.manual-request.parent-progress-24h',
    'trial.manual-request.parent-progress-48h',
    'trial.manual-request.scheduling-alert-36h',
    'trial.manual-request.specified-content',
    'trial.manual-request.writing'
  ] then
    raise exception 'trial_manual_rule_projection_failed: %', rules;
  end if;
  if exists (
    select 1
    from jsonb_array_elements((receipt.tasks_row).payload) task
    where task ->> 'anchorBookingId' = receipt.lp_item_id
      and task ->> 'ruleKey' like 'trial.manual-request.%'
      and task ->> 'title' not like '%<Atomic Trial> <Daisy>'
  ) then
    raise exception 'trial_manual_guardian_title_failed';
  end if;
  if (select task ->> 'title' from jsonb_array_elements((receipt.tasks_row).payload) task
      where task ->> 'ruleKey' = 'trial.manual-request.specified-content')
      <> '《教务+教统》【要指定内容】<Atomic Trial> <Daisy>'
     or (select task ->> 'title' from jsonb_array_elements((receipt.tasks_row).payload) task
      where task ->> 'ruleKey' = 'trial.manual-request.parent-progress-48h')
      <> '《教务+教统》【二次向家长交待排课进度】<Atomic Trial> <Daisy>' then
    raise exception 'trial_manual_handbook_title_failed';
  end if;
  if exists (
    select 1 from jsonb_array_elements((receipt.tasks_row).payload) task
    where task ->> 'anchorBookingId' = receipt.lp_item_id
      and not (task ? 'legacyEvidence')
      and task ->> 'ruleKey' in (
        'trial.parent-follow-up','trial.scheduling','trial.parent-no-reply-follow-up',
        'trial.teaching-control-escalation','trial.parent-progress-sync.1'
      )
  ) then
    raise exception 'trial_legacy_rules_remained';
  end if;
  if (select count(*) from jsonb_array_elements((receipt.tasks_row).payload) task
      where task = '{"id":"TSK-LEGACY-SPARSE","title":"Historical task without canonical metadata","owner":"Archive","studentId":"STU-HISTORICAL","status":"today","legacyEvidence":{"state":"frozen","reason":"missing_canonical_due_at","frozenAt":"2026-08-19T00:00:00.000Z"}}'::jsonb) <> 1
     or (select count(*) from jsonb_array_elements((receipt.tasks_row).payload) task
      where task = '{"id":"TSK-LEGACY-MATCH","title":"Frozen legacy rule for the deterministic LP anchor","owner":"Archive","studentId":"STU-HISTORICAL","status":"today","ruleKey":"trial.parent-follow-up","anchorBookingId":"LP-ATOMIC-a8f78ee5b2f178415038e032","legacyEvidence":{"state":"frozen","reason":"missing_canonical_due_at","frozenAt":"2026-08-19T00:00:00.000Z"}}'::jsonb) <> 1 then
    raise exception 'trial_legacy_evidence_changed';
  end if;
  if internal.trial_manual_task_id(receipt.lp_item_id, 'trial.manual-request.writing')
     <> (select task ->> 'id' from jsonb_array_elements((receipt.tasks_row).payload) task
         where task ->> 'ruleKey' = 'trial.manual-request.writing') then
    raise exception 'trial_manual_task_id_failed';
  end if;

  select * into replay from public.mutate_lp_atomic(
    'trial-manual-fixture-secret','00000000-0000-4000-8000-000000000101',intent,
    'create','STU-1',null,null,'试听 LP',fields,null,
    '{"owner":"Abby","planner":"Tara","mayReassign":false}',expected,'Abby'
  );
  if replay.applied
     or (replay.lp_items_row).version <> (receipt.lp_items_row).version
     or (replay.tasks_row).version <> (receipt.tasks_row).version
     or replay.audit_entry_id <> receipt.audit_entry_id then
    raise exception 'trial_manual_replay_failed';
  end if;

  select * into lookup from public.get_lp_atomic_command_result(
    'trial-manual-fixture-secret','00000000-0000-4000-8000-000000000101',intent,'Abby'
  );
  if lookup.lp_item_id <> receipt.lp_item_id or lookup.audit_entry_id <> receipt.audit_entry_id then
    raise exception 'trial_manual_lookup_failed';
  end if;

  begin
    perform public.mutate_lp_atomic(
      'trial-manual-fixture-secret','00000000-0000-4000-8000-000000000101',
      intent || jsonb_build_object('fields', fields || '{"paperNote":"Different"}'::jsonb),
      'create','STU-1',null,null,'试听 LP',fields || '{"paperNote":"Different"}'::jsonb,null,
      '{"owner":"Abby","planner":"Tara","mayReassign":false}',expected,'Abby'
    );
    raise exception 'trial_manual_idempotency_conflict_missing';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '23505' or caught_message <> 'lp_idempotency_conflict' then raise; end if;
  end;
end;
$trial_manual_runtime$;

select 'trial_manual_lp_atomic_runtime_ok' as result;
