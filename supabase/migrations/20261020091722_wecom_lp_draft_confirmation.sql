do $wecom_trial_planner$
declare definition text;
  old_fragment text := $old$p_fields ->> 'planner' not in ('待分配', 'Tara', 'Eileen')$old$;
  new_fragment text := $new$p_fields ->> 'planner' not in ('待分配', 'Tara', 'Eileen', 'Abby')$new$;
begin
  definition := pg_catalog.pg_get_functiondef('internal.validate_student_creation_fields(jsonb)'::pg_catalog.regprocedure);
  if pg_catalog.strpos(definition, new_fragment) = 0 then
    if (length(definition) - length(replace(definition, old_fragment, ''))) / length(old_fragment) <> 1 then
      raise exception 'wecom_lp_planner_contract_drift';
    end if;
    execute replace(definition, old_fragment, new_fragment);
  end if;
end;
$wecom_trial_planner$;

create table internal.wecom_lp_confirmations (
  source_message_id text primary key references internal.wecom_archive_messages(message_id) on delete restrict,
  case_id uuid not null references internal.wecom_trial_handover_cases(id) on delete restrict,
  command_uuid text not null unique,
  confirmation_intent jsonb not null check (jsonb_typeof(confirmation_intent) = 'object'),
  student_id text not null,
  lp_item_id text not null,
  actor text not null,
  audit_id uuid not null references internal.operational_contract_audit(id) on delete restrict,
  confirmed_at timestamptz not null default now()
);
alter table internal.wecom_lp_confirmations enable row level security;
revoke all on table internal.wecom_lp_confirmations from public, anon, authenticated, service_role;

create function internal.wecom_is_lp_template(p_body text)
returns boolean language sql immutable strict set search_path = '' as $$
  select p_body ~ E'(?m)^[[:space:]]*[【\\[]?(安排教师|安排老师|任课教师|任课老师|授课老师|老师|教师)[】\\]]?[[:space:]]*[:：]'
     and p_body ~ E'(?m)^[[:space:]]*[【\\[]?(安排科目|试听科目|课程科目|科目|学科)[】\\]]?[[:space:]]*[:：]';
$$;
revoke all on function internal.wecom_is_lp_template(text) from public, anon, authenticated, service_role;

create function internal.wecom_lp_draft_source(p_source_message_id text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with source as (
    select m.*, c.wechat_name, c.student_name as case_student_name,
      c.operations_owner, c.course_planner, c.status as identity_status,
      c.identity_message_id, c.updated_at as case_updated_at
    from internal.wecom_archive_messages m
    join internal.wecom_trial_handover_cases c on c.id = m.trial_handover_id
    where m.message_id = p_source_message_id
      and m.ingested_by = 'WeCom Bot Receiver'
      and m.message_type = 'text' and m.classification = 'handover'
      and internal.wecom_is_lp_template(m.body)
  ), next_template as (
    select m.sent_at, m.message_id from internal.wecom_archive_messages m, source s
    where m.trial_handover_id = s.trial_handover_id
      and m.ingested_by = 'WeCom Bot Receiver' and m.message_type = 'text'
      and m.classification = 'handover' and internal.wecom_is_lp_template(m.body)
      and (m.sent_at, m.message_id) > (s.sent_at, s.message_id)
    order by m.sent_at, m.message_id limit 1
  ), relevant as (
    select m.* from internal.wecom_archive_messages m, source s
    where m.trial_handover_id = s.trial_handover_id
      and m.ingested_by = 'WeCom Bot Receiver' and m.message_type = 'text'
      and m.classification = 'handover'
      and (m.message_id = s.message_id or (
        not internal.wecom_is_lp_template(m.body)
        and (m.sent_at, m.message_id) > (s.sent_at, s.message_id)
        and not exists (select 1 from next_template n where (m.sent_at, m.message_id) >= (n.sent_at, n.message_id))
      ))
  ), data as (
    select jsonb_build_object(
      'id', s.message_id, 'sourceMessageId', s.message_id, 'caseId', s.trial_handover_id,
      'wechatName', s.wechat_name,
      'studentName', coalesce(s.student_name_hint, (
        select r.student_name_hint from relevant r where r.student_name_hint is not null
        order by r.sent_at desc, r.message_id desc limit 1
      )),
      'operationsOwner', coalesce(s.operations_owner_hint, s.operations_owner),
      'coursePlanner', coalesce(s.course_planner_hint, s.course_planner),
      'status', s.identity_status, 'createdAt', s.ingested_at,
      'messages', coalesce((select jsonb_agg(jsonb_build_object(
        'messageId', r.message_id, 'text', r.body, 'sentAt', r.sent_at, 'studentId', r.student_id
      ) order by r.sent_at, r.message_id) from relevant r), '[]'::jsonb)
    ) as payload,
    jsonb_build_object('studentName', s.case_student_name, 'status', s.identity_status,
      'operationsOwner', s.operations_owner, 'coursePlanner', s.course_planner,
      'identityMessageId', s.identity_message_id, 'updatedAt', s.case_updated_at) as identity
    from source s
  )
  select d.payload || jsonb_build_object(
    'sourceRevision', encode(extensions.digest(jsonb_build_object('source', d.payload, 'identity', d.identity)::text, 'sha256'), 'hex'),
    'confirmed', (select jsonb_build_object('studentId', c.student_id, 'lpItemId', c.lp_item_id)
      from internal.wecom_lp_confirmations c where c.source_message_id = p_source_message_id)
  ) from data d;
$$;
revoke all on function internal.wecom_lp_draft_source(text) from public, anon, authenticated, service_role;

create function public.read_wecom_lp_draft(
  p_secret text, p_source_message_id text, p_actor text, p_full_admin boolean
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare source jsonb;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if nullif(btrim(p_actor), '') is null or length(p_actor) > 120 or p_full_admin is null then
    raise exception using errcode = '22023', message = 'invalid_wecom_lp_scope';
  end if;
  source := internal.wecom_lp_draft_source(p_source_message_id);
  if source is not null and not p_full_admin
     and source ->> 'operationsOwner' is distinct from btrim(p_actor) then
    raise exception using errcode = '42501', message = 'wecom_lp_owner_scope_forbidden';
  end if;
  return source;
end;
$$;
revoke all on function public.read_wecom_lp_draft(text,text,text,boolean) from public, anon, authenticated, service_role;
grant execute on function public.read_wecom_lp_draft(text,text,text,boolean) to anon, authenticated;

create function public.read_wecom_lp_drafts(
  p_secret text, p_actor text, p_full_admin boolean,
  p_cursor text default null, p_limit integer default 30
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare cursor_at timestamptz; result_rows jsonb; more boolean; total_count bigint;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if nullif(btrim(p_actor), '') is null or length(p_actor) > 120 or p_full_admin is null
     or p_limit is null or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'invalid_wecom_lp_scope';
  end if;
  if p_cursor is not null then
    select ingested_at into cursor_at from internal.wecom_archive_messages where message_id = p_cursor;
    if not found then raise exception using errcode = '22023', message = 'invalid_wecom_lp_cursor'; end if;
  end if;
  with eligible as materialized (
    select m.message_id, m.ingested_at
    from internal.wecom_archive_messages m
    join internal.wecom_trial_handover_cases c on c.id = m.trial_handover_id
    where m.ingested_by = 'WeCom Bot Receiver' and m.message_type = 'text'
      and m.classification = 'handover' and internal.wecom_is_lp_template(m.body)
      and (p_full_admin or coalesce(m.operations_owner_hint, c.operations_owner) = btrim(p_actor))
      and not exists (select 1 from internal.wecom_lp_confirmations r where r.source_message_id = m.message_id)
  ), page as (
    select * from eligible
    where p_cursor is null or (ingested_at, message_id) > (cursor_at, p_cursor)
    order by ingested_at, message_id limit p_limit + 1
  ), numbered as (
    select *, row_number() over (order by ingested_at, message_id) as position from page
  )
  select coalesce(jsonb_agg(internal.wecom_lp_draft_source(message_id) order by ingested_at, message_id)
      filter (where position <= p_limit), '[]'::jsonb), count(*) > p_limit, (select count(*) from eligible)
  into result_rows, more, total_count from numbered;
  return jsonb_build_object('rows', result_rows, 'total', total_count,
    'nextCursor', case when more then result_rows -> (jsonb_array_length(result_rows) - 1) ->> 'sourceMessageId' else null end);
end;
$$;
revoke all on function public.read_wecom_lp_drafts(text,text,boolean,text,integer) from public, anon, authenticated, service_role;
grant execute on function public.read_wecom_lp_drafts(text,text,boolean,text,integer) to anon, authenticated;

create function public.confirm_wecom_lp_draft_atomic(
  p_secret text, p_case_id uuid, p_source_message_id text, p_source_revision text,
  p_command_uuid text, p_student_id text, p_new_student jsonb, p_fields jsonb,
  p_authorized_assignment jsonb, p_expected_versions jsonb, p_actor text, p_full_admin boolean
) returns table(command_key text, operation text, applied boolean, student_id text, lp_item_id text,
  students_row public.ops_state, lp_items_row public.ops_state, tasks_row public.ops_state,
  files_row public.ops_state, audit_entry_id uuid)
language plpgsql security definer set search_path = '' as $$
declare source jsonb; prior internal.wecom_lp_confirmations%rowtype; command_prior internal.wecom_lp_confirmations%rowtype;
  confirmation jsonb; inner_intent jsonb; next_versions jsonb; student_fields jsonb;
  s public.ops_state%rowtype; l public.ops_state%rowtype; t public.ops_state%rowtype; f public.ops_state%rowtype;
  selected_student jsonb; selected_id text; created record; receipt record; audit_id_value uuid;
  command_value text := lower(btrim(p_command_uuid));
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_case_id is null or nullif(p_source_message_id, '') is null
     or coalesce(p_source_revision, '') !~ '^[a-f0-9]{64}$'
     or coalesce(command_value, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or nullif(btrim(p_actor), '') is null or length(p_actor) > 120 or p_full_admin is null
     or jsonb_typeof(p_fields) is distinct from 'object'
     or jsonb_typeof(p_authorized_assignment) is distinct from 'object'
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or ((nullif(btrim(p_student_id), '') is null) = (p_new_student is null)) then
    raise exception using errcode = '22023', message = 'invalid_wecom_lp_confirmation';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wecom-lp:' || p_source_message_id, 0));
  begin
    perform 1 from internal.wecom_trial_handover_cases where id = p_case_id for update nowait;
    select * into f from public.ops_state where entity = 'files' for update nowait;
    select * into s from public.ops_state where entity = 'students' for update nowait;
    select * into l from public.ops_state where entity = 'lpItems' for update nowait;
    select * into t from public.ops_state where entity = 'tasks' for update nowait;
  exception when lock_not_available then
    raise exception using errcode = '40001', message = 'wecom_lp_confirmation_busy';
  end;
  source := internal.wecom_lp_draft_source(p_source_message_id);
  if source is null or source ->> 'caseId' <> p_case_id::text then
    raise exception using errcode = 'P0002', message = 'wecom_lp_source_not_found';
  end if;
  if not p_full_admin and (source ->> 'operationsOwner' is distinct from btrim(p_actor)
     or p_authorized_assignment ->> 'owner' is distinct from btrim(p_actor)) then
    raise exception using errcode = '42501', message = 'wecom_lp_owner_scope_forbidden';
  end if;
  confirmation := jsonb_build_object('caseId', p_case_id, 'sourceMessageId', p_source_message_id,
    'sourceRevision', p_source_revision, 'studentId', nullif(btrim(p_student_id), ''),
    'newStudent', p_new_student, 'fields', p_fields, 'assignment', p_authorized_assignment);
  select * into prior from internal.wecom_lp_confirmations r where r.source_message_id = p_source_message_id;
  select * into command_prior from internal.wecom_lp_confirmations r where r.command_uuid = command_value;
  if command_prior.source_message_id is not null and command_prior.source_message_id <> p_source_message_id then
    raise exception using errcode = '23505', message = 'wecom_lp_idempotency_conflict';
  end if;
  if prior.source_message_id is not null and prior.confirmation_intent is distinct from confirmation then
    raise exception using errcode = '23505', message = 'wecom_lp_source_already_confirmed';
  end if;
  if prior.source_message_id is null then
    if source ->> 'status' in ('identity_conflict', 'identity_ambiguous') then
      raise exception using errcode = '23505', message = 'wecom_lp_identity_conflict';
    end if;
    if source ->> 'sourceRevision' <> p_source_revision then
      raise exception using errcode = '40001', message = 'wecom_lp_source_changed';
    end if;
  end if;
  if prior.source_message_id is not null then
    if not p_full_admin and exists (select 1 from jsonb_array_elements(s.payload) student
      where student ->> 'id' = prior.student_id and student ->> 'owner' is distinct from btrim(p_actor)) then
      raise exception using errcode = '42501', message = 'wecom_lp_student_scope_forbidden';
    end if;
    return query select prior.command_uuid, 'create'::text, false, prior.student_id, prior.lp_item_id,
      s, l, t, f, prior.audit_id;
    return;
  end if;
  if s.entity is null or l.entity is null or t.entity is null or f.entity is null then
    raise exception using errcode = '55000', message = 'lp_atomic_state_missing';
  end if;
  if (select array_agg(key order by key) from jsonb_object_keys(p_expected_versions) key)
       is distinct from array['files','lpItems','students','tasks']::text[]
     or exists (select 1 from jsonb_each(p_expected_versions) x
       where jsonb_typeof(x.value) is distinct from 'number' or x.value #>> '{}' !~ '^[1-9][0-9]*$') then
    raise exception using errcode = '22023', message = 'invalid_lp_versions';
  end if;
  if s.version <> (p_expected_versions ->> 'students')::bigint
     or l.version <> (p_expected_versions ->> 'lpItems')::bigint
     or t.version <> (p_expected_versions ->> 'tasks')::bigint
     or f.version <> (p_expected_versions ->> 'files')::bigint then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  next_versions := p_expected_versions;
  if p_new_student is not null then
    if jsonb_typeof(p_new_student) is distinct from 'object'
       or p_new_student ->> 'segment' is distinct from '试听'
       or p_new_student ->> 'lpNeed' is distinct from '试听LP'
       or p_new_student ->> 'owner' is distinct from p_authorized_assignment ->> 'owner'
       or p_new_student ->> 'planner' is distinct from p_authorized_assignment ->> 'planner'
       or p_new_student ->> 'course' is distinct from p_fields ->> 'subject'
       or p_new_student ->> 'location' is distinct from p_fields ->> 'locationTimezone'
       or ((p_fields ->> 'studentNameKnown')::boolean
         and nullif(btrim(p_new_student ->> 'name'), '') is distinct from nullif(btrim(p_fields ->> 'studentName'), ''))
       or (not (p_fields ->> 'studentNameKnown')::boolean
         and nullif(btrim(p_new_student ->> 'name'), '') is not null
         and btrim(p_new_student ->> 'name') is distinct from btrim(p_new_student ->> 'guardianWechat'))
       or p_new_student ? 'remainingHours'
       or nullif(btrim(p_new_student ->> 'guardianWechat'), '') is null then
      raise exception using errcode = '22023', message = 'invalid_wecom_lp_new_student';
    end if;
    if exists (
      select 1 from jsonb_array_elements(s.payload) student
      where coalesce(student ->> 'importArchived', 'false') <> 'true'
        and internal.wecom_identity_key(coalesce(nullif(btrim(student ->> 'guardianWechat'), ''), student ->> 'guardian'))
          = internal.wecom_identity_key(p_new_student ->> 'guardianWechat')
        and (not (p_fields ->> 'studentNameKnown')::boolean
          or internal.wecom_name_key(student ->> 'name') = internal.wecom_name_key(p_new_student ->> 'name'))
    ) then
      raise exception using errcode = '23505', message = 'wecom_lp_student_already_exists';
    end if;
    student_fields := p_new_student;
    select * into created from public.create_student_with_tasks_atomic(
      p_secret, 'student-create:' || command_value,
      jsonb_build_object('studentFields', student_fields, 'expectedVersions', p_expected_versions - 'lpItems' - 'files'),
      student_fields, p_expected_versions - 'lpItems' - 'files', p_actor
    );
    selected_id := created.student_id;
    next_versions := next_versions || jsonb_build_object('students', (created.students_row).version, 'tasks', (created.tasks_row).version);
  else
    selected_id := btrim(p_student_id);
    select student into selected_student from jsonb_array_elements(s.payload) student where student ->> 'id' = selected_id;
    if selected_student is null then raise exception using errcode = 'P0002', message = 'student_not_found'; end if;
    if not p_full_admin and selected_student ->> 'owner' is distinct from btrim(p_actor) then
      raise exception using errcode = '42501', message = 'wecom_lp_student_scope_forbidden';
    end if;
  end if;
  inner_intent := jsonb_build_object('operation', 'create', 'studentId', selected_id,
    'workflowType', '试听 LP', 'fields', p_fields, 'expectedVersions', next_versions);
  select * into receipt from public.mutate_lp_atomic(p_secret, command_value, inner_intent,
    'create', selected_id, null, null, '试听 LP', p_fields, null, p_authorized_assignment, next_versions, p_actor);
  audit_id_value := internal.append_operational_contract_audit('wecom.lp.confirm', btrim(p_actor), 'wecom_message',
    p_source_message_id, jsonb_build_object('caseId', p_case_id, 'sourceRevision', p_source_revision,
      'commandUuid', command_value, 'studentId', receipt.student_id, 'lpItemId', receipt.lp_item_id,
      'lpAuditId', receipt.audit_entry_id));
  insert into internal.wecom_lp_confirmations(source_message_id, case_id, command_uuid, confirmation_intent,
    student_id, lp_item_id, actor, audit_id)
  values(p_source_message_id, p_case_id, command_value, confirmation,
    receipt.student_id, receipt.lp_item_id, btrim(p_actor), audit_id_value);
  return query select command_value, 'create'::text, receipt.applied, receipt.student_id, receipt.lp_item_id,
    receipt.students_row, receipt.lp_items_row, receipt.tasks_row, receipt.files_row, audit_id_value;
end;
$$;
revoke all on function public.confirm_wecom_lp_draft_atomic(text,uuid,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_wecom_lp_draft_atomic(text,uuid,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,boolean)
  to anon, authenticated;
