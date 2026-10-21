create function internal.wecom_lp_explicit_types(p_body text)
returns text[] language sql immutable strict set search_path = '' as $$
  with lines as (
    select line, regexp_replace(regexp_replace(line,'\[Rose\]|\[玫瑰\]|🌹','','gi'),'[[:space:]【】\[\]]','','g') as heading
    from regexp_split_to_table(pg_catalog.normalize(p_body,'NFKC'), E'\n') line
  ), labels as (
    select upper(regexp_replace(coalesce(
      (regexp_match(heading,'^(.*?)信息交接(表|单)?$'))[1],
      (regexp_match(line,'^[[:space:]【\[]*(LP类型|业务类型)[】\]]*[[:space:]]*[:：][[:space:]]*(.*?)[[:space:]]*$'))[2]
    ),'[[:space:]【】\[\]]','','g')) as label from lines
  ), types as (
    select case label
      when '试听LP' then '试听 LP'
      when '老生新LP' then '老师新 LP'
      when '老生加课LP' then '老师新 LP'
      when '老师新LP' then '老师新 LP'
      when '二次试听' then '换老师试听'
      when '换老师试听' then '换老师试听'
      when '老生LP修改' then '老师 LP 修改'
      when '老师LP修改' then '老师 LP 修改'
    end as kind from labels
  )
  select coalesce(array_agg(distinct kind order by kind) filter (where kind is not null),array[]::text[]) from types;
$$;
revoke all on function internal.wecom_lp_explicit_types(text) from public, anon, authenticated, service_role;

create or replace function internal.wecom_lp_template_type(p_body text)
returns text language sql immutable strict set search_path = '' as $$
  select case cardinality(types) when 0 then '试听 LP' when 1 then types[1] else null end
  from (select internal.wecom_lp_explicit_types(p_body) as types) source;
$$;
revoke all on function internal.wecom_lp_template_type(text) from public, anon, authenticated, service_role;

create or replace function internal.wecom_is_lp_template(p_body text)
returns boolean language sql immutable strict set search_path = '' as $template$
  select (
    p_body ~ E'(?m)^[[:space:]]*[【\\[]?(安排教师|安排老师|任课教师|任课老师|授课老师|老师|教师)[】\\]]?[[:space:]]*[:：]'
    and p_body ~ E'(?m)^[[:space:]]*[【\\[]?(安排科目|试听科目|课程科目|科目|学科)[】\\]]?[[:space:]]*[:：]'
  ) or (
    cardinality(internal.wecom_lp_explicit_types(p_body)) > 0
    and p_body ~ E'(?m)^[[:space:]]*[【\\[]?(学生姓名|学生|姓名)[】\\]]?[[:space:]]*[:：][[:space:]]*[^[:space:]]'
    and (
      ('老师 LP 修改' = any(internal.wecom_lp_explicit_types(p_body)) and
        p_body ~ E'(?m)^[[:space:]]*[【\\[]?(涉及科目|科目|学科)[】\\]]?[[:space:]]*[:：]'
        and p_body ~ E'(?m)^[[:space:]]*[【\\[]?(变动内容|修改要求|修改内容)[】\\]]?[[:space:]]*[:：]'
      ) or ('换老师试听' = any(internal.wecom_lp_explicit_types(p_body)) and
        p_body ~ E'(?m)^[[:space:]]*[【\\[]?(安排教师|安排老师|新老师|老师|教师)[】\\]]?[[:space:]]*[:：]'
      ) or ('老师新 LP' = any(internal.wecom_lp_explicit_types(p_body)) and p_body ~ E'(?m)^[[:space:]]*[【\\[]?(安排科目|科目|学科)[】\\]]?[[:space:]]*[:：]'
      )
    )
  );
$template$;
revoke all on function internal.wecom_is_lp_template(text) from public, anon, authenticated, service_role;

create function internal.resolve_wecom_lp_business_identity()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare student jsonb; candidates jsonb; name_hint text; guardian text;
begin
  if new.ingested_by <> 'WeCom Bot Receiver' or new.message_type <> 'text'
     or new.classification <> 'handover' or new.trial_handover_id is not null
     or not coalesce(internal.wecom_is_lp_template(new.body), false)
     or internal.wecom_lp_template_type(new.body) = '试听 LP'
     or internal.wecom_guardian_identity_label(new.guardian_wechat_hint) is not null then
    return new;
  end if;
  name_hint := coalesce(nullif(btrim(new.student_name_hint), ''),
    nullif(btrim((regexp_match(new.body,
      E'(?m)^[[:space:]]*[【\\[]?(?:学生姓名|学生|姓名)[】\\]]?[[:space:]]*[:：][[:space:]]*([^\\n\\r]{1,240})'))[1]), ''));
  if name_hint is null then return new; end if;
  select coalesce(jsonb_agg(item), '[]'::jsonb) into candidates
  from public.ops_state state cross join lateral jsonb_array_elements(state.payload) item
  where state.entity = 'students' and coalesce(item ->> 'importArchived','false') <> 'true'
    and internal.wecom_name_key(item ->> 'name') = internal.wecom_name_key(name_hint);
  if jsonb_array_length(candidates) <> 1 then return new; end if;
  student := candidates -> 0;
  guardian := internal.wecom_guardian_identity_label(coalesce(nullif(btrim(student ->> 'guardianWechat'),''),student ->> 'guardian'));
  if guardian is null then return new; end if;
  new.student_name_hint := name_hint;
  new.guardian_wechat_hint := guardian;
  new.operations_owner_hint := coalesce(new.operations_owner_hint, nullif(btrim(student ->> 'owner'),''));
  new.course_planner_hint := coalesce(new.course_planner_hint, nullif(btrim(student ->> 'planner'),''));
  return new;
end;
$$;
revoke all on function internal.resolve_wecom_lp_business_identity() from public, anon, authenticated, service_role;
create trigger resolve_wecom_lp_business_identity
before insert or update of body, classification, student_name_hint, guardian_wechat_hint,
  operations_owner_hint, course_planner_hint
on internal.wecom_archive_messages
for each row execute function internal.resolve_wecom_lp_business_identity();

drop function public.confirm_wecom_lp_draft_atomic(text,uuid,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,boolean);

create function public.confirm_wecom_lp_draft_atomic(
  p_secret text, p_case_id uuid, p_source_message_id text, p_source_revision text,
  p_command_uuid text, p_student_id text, p_new_student jsonb, p_fields jsonb,
  p_authorized_assignment jsonb, p_expected_versions jsonb, p_actor text, p_full_admin boolean,
  p_workflow_type text default '试听 LP'
) returns table(command_key text, operation text, applied boolean, student_id text, lp_item_id text,
  students_row public.ops_state, lp_items_row public.ops_state, tasks_row public.ops_state,
  files_row public.ops_state, audit_entry_id uuid)
language plpgsql security definer set search_path = '' as $$
declare source jsonb; prior internal.wecom_lp_confirmations%rowtype; command_prior internal.wecom_lp_confirmations%rowtype;
  confirmation jsonb; inner_intent jsonb; next_versions jsonb; student_fields jsonb; source_types text[];
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
     or p_workflow_type is null or p_workflow_type not in ('试听 LP','老师新 LP','换老师试听','老师 LP 修改')
     or (p_workflow_type <> '试听 LP' and p_new_student is not null)
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
    'newStudent', p_new_student, 'workflowType', p_workflow_type,
    'fields', p_fields, 'assignment', p_authorized_assignment);
  select * into prior from internal.wecom_lp_confirmations r where r.source_message_id = p_source_message_id;
  select * into command_prior from internal.wecom_lp_confirmations r where r.command_uuid = command_value;
  if command_prior.source_message_id is not null and command_prior.source_message_id <> p_source_message_id then
    raise exception using errcode = '23505', message = 'wecom_lp_idempotency_conflict';
  end if;
  if prior.source_message_id is not null and (prior.confirmation_intent || jsonb_build_object('workflowType', coalesce(prior.confirmation_intent ->> 'workflowType','试听 LP'))) is distinct from confirmation then
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
  select coalesce(array_agg(distinct detected.kind),array[]::text[]) into source_types
  from jsonb_array_elements(source -> 'messages') message
  cross join lateral unnest(internal.wecom_lp_explicit_types(message ->> 'text')) detected(kind);
  if cardinality(source_types) > 1
     or (cardinality(source_types) = 1 and source_types[1] <> p_workflow_type)
     or (cardinality(source_types) = 0 and p_workflow_type <> '试听 LP') then
    raise exception using errcode = '22023', message = 'wecom_lp_source_workflow_mismatch';
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
    'workflowType', p_workflow_type, 'fields', p_fields, 'expectedVersions', next_versions);
  select * into receipt from public.mutate_lp_atomic(p_secret, command_value, inner_intent,
    'create', selected_id, null, null, p_workflow_type, p_fields, null, p_authorized_assignment, next_versions, p_actor);
  audit_id_value := internal.append_operational_contract_audit('wecom.lp.confirm', btrim(p_actor), 'wecom_message',
    p_source_message_id, jsonb_build_object('caseId', p_case_id, 'sourceRevision', p_source_revision,
      'workflowType', p_workflow_type, 'commandUuid', command_value, 'studentId', receipt.student_id, 'lpItemId', receipt.lp_item_id,
      'lpAuditId', receipt.audit_entry_id));
  insert into internal.wecom_lp_confirmations(source_message_id, case_id, command_uuid, confirmation_intent,
    student_id, lp_item_id, actor, audit_id)
  values(p_source_message_id, p_case_id, command_value, confirmation,
    receipt.student_id, receipt.lp_item_id, btrim(p_actor), audit_id_value);
  return query select command_value, 'create'::text, receipt.applied, receipt.student_id, receipt.lp_item_id,
    receipt.students_row, receipt.lp_items_row, receipt.tasks_row, receipt.files_row, audit_id_value;
end;
$$;
revoke all on function public.confirm_wecom_lp_draft_atomic(text,uuid,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,boolean,text)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_wecom_lp_draft_atomic(text,uuid,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,boolean,text)
  to anon, authenticated;

create function internal.lp_business_handover_tasks(p_tasks jsonb, p_lp jsonb, p_created_at timestamptz)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb; fields jsonb := p_lp -> 'fields'; kind text := p_lp ->> 'workflowType';
  request_at timestamptz := (p_lp #>> '{fields,requestSentAt}')::timestamptz;
  rule text; task_due timestamptz; title_value text; generated jsonb;
  rules text[] := array['lp.handover'];
begin
  if kind not in ('老师新 LP','老师 LP 修改','换老师试听') then return p_tasks; end if;
  select coalesce(jsonb_agg(task.value order by task.ordinality),'[]'::jsonb) into result
  from jsonb_array_elements(p_tasks) with ordinality task(value,ordinality)
  where coalesce(task.value ->> 'anchorBookingId','') <> p_lp ->> 'id'
     or task.value ->> 'status' = 'done' or task.value ? 'legacyEvidence'
     or exists (select 1 from internal.legacy_task_deadline_freezes evidence where evidence.task_id = task.value ->> 'id');
  if kind = '老师新 LP' then
    rules := rules || array['lp.scheduling'];
    if fields ->> 'specifiedContentStatus' in ('需要跟进','需教务跟进') then rules := array_append(rules,'lp.specified-content'); end if;
    if (fields ->> 'writingRequired')::boolean then rules := array_append(rules,'lp.writing'); end if;
    if (fields ->> 'paperRequired')::boolean then rules := rules || array['lp.paper-send','lp.paper-receive']; end if;
  elsif kind = '换老师试听' then
    rules := rules || array['trial.scheduling'];
  else
    rules := rules || array['lp.modification-review'];
  end if;
  foreach rule in array rules loop
    task_due := case rule
      when 'lp.scheduling' then request_at + interval '48 hours'
      when 'trial.scheduling' then request_at + interval '24 hours'
      when 'lp.modification-review' then request_at + interval '7 days'
      when 'lp.paper-receive' then request_at + interval '24 hours'
      when 'lp.handover' then request_at
      else greatest(request_at, ((request_at at time zone 'Asia/Shanghai')::date + time '18:00') at time zone 'Asia/Shanghai')
    end;
    title_value := case rule
      when 'lp.handover' then case when kind = '老师 LP 修改' then '修改 LP 并提交截图审核' else kind || '：核对交接信息' end
      when 'lp.scheduling' then '老生新 LP：确认首课课表'
      when 'trial.scheduling' then '换老师试听：完成排课'
      when 'lp.modification-review' then 'LP 修改：每周检查完成及截图'
      when 'lp.specified-content' then '老生新 LP：要指定内容'
      when 'lp.writing' then '老生新 LP：要写作'
      when 'lp.paper-send' then '老生新 LP：发试卷'
      else '老生新 LP：收试卷'
    end;
    if exists (select 1 from jsonb_array_elements(result) task
      where task ->> 'anchorBookingId' = p_lp ->> 'id' and task ->> 'ruleKey' = rule) then continue; end if;
    generated := jsonb_build_object(
      'id', internal.trial_manual_task_id(p_lp ->> 'id',rule),
      'title',title_value,'owner',p_lp ->> 'owner','assignees',jsonb_build_array(p_lp ->> 'owner'),
      'watchers',jsonb_build_array('Ops Admin'),'studentId',p_lp ->> 'studentId',
      'due',to_char(task_due at time zone 'Asia/Shanghai','YYYY"年"MM"月"DD"日" HH24:MI'),
      'dueAt',to_char(task_due at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'status',case when (task_due at time zone 'Australia/Melbourne')::date < (p_created_at at time zone 'Australia/Melbourne')::date then 'overdue'
        when (task_due at time zone 'Australia/Melbourne')::date = (p_created_at at time zone 'Australia/Melbourne')::date then 'today' else 'upcoming' end,
      'tone',case when rule in ('lp.scheduling','trial.scheduling','lp.modification-review') or kind = '老师 LP 修改' then 'red' else 'blue' end,
      'category',case when rule in ('lp.scheduling','trial.scheduling') then '排课' else 'LP' end,
      'trigger',kind || ' 信息交接','ruleKey',rule,'anchorBookingId',p_lp ->> 'id'
    );
    result := result || jsonb_build_array(generated);
  end loop;
  return result;
end;
$$;
revoke all on function internal.lp_business_handover_tasks(jsonb,jsonb,timestamptz) from public, anon, authenticated, service_role;

do $lp_business_schema$
declare definition text; target record;
begin
  definition := pg_catalog.pg_get_functiondef('public.mutate_lp_atomic_without_complete_template_guard(text,text,jsonb,text,text,jsonb,text,text,jsonb,text,jsonb,jsonb,text)'::pg_catalog.regprocedure);
  for target in select * from (values
    ($old$'enrollmentHandoverNotes'))$old$, $new$'enrollmentHandoverNotes','requestSentAt','writingRequired','writingNote','paperRequired','paperNote'))$new$),
    ($old$('isUniversityStudent','timeMentioned','studentNameKnown')$old$, $new$('isUniversityStudent','timeMentioned','studentNameKnown','writingRequired','paperRequired')$new$),
    ($old$('isUniversityStudent','timeMentioned','studentNameKnown','purchasedHours','bonusHours')$old$, $new$('isUniversityStudent','timeMentioned','studentNameKnown','writingRequired','paperRequired','purchasedHours','bonusHours')$new$),
    ($old$coalesce(fields ->> 'specifiedContentStatus', '') = '需要跟进'$old$, $new$coalesce(fields ->> 'specifiedContentStatus', '') in ('需要跟进','需教务跟进')$new$),
    ($old$p_fields ->> 'specifiedContentStatus' not in ('已指定','无需指定','需要跟进')$old$, $new$p_fields ->> 'specifiedContentStatus' not in ('已指定','无需指定','需要跟进','需教务跟进')$new$),
    ($old$    if p_workflow_type = '换老师试听' and (nullif(trim(p_fields ->> 'originalTeacher'),'') is null or nullif(trim(p_fields ->> 'newTeacher'),'') is null or nullif(trim(p_fields ->> 'subject'),'') is null or nullif(trim(p_fields ->> 'changeReason'),'') is null or nullif(trim(p_fields ->> 'trialInformation'),'') is null) then$old$, $new$    if p_workflow_type = '换老师试听' and (nullif(trim(p_fields ->> 'newTeacher'),'') is null or nullif(trim(p_fields ->> 'subject'),'') is null or nullif(trim(p_fields ->> 'changeReason'),'') is null) then$new$),
    ($old$    if p_workflow_type in ('老师新 LP','老师 LP 修改') and (nullif(trim(p_fields ->> 'teacher'),'') is null or nullif(trim(p_fields ->> 'subject'),'') is null) then$old$, $new$    if p_workflow_type in ('老师新 LP','老师 LP 修改') and (nullif(trim(p_fields ->> 'subject'),'') is null or (p_workflow_type = '老师新 LP' and nullif(trim(p_fields ->> 'teacher'),'') is null)) then$new$)
  ) replacements(old_fragment,new_fragment) loop
    if (length(definition) - length(replace(definition,target.old_fragment,''))) / length(target.old_fragment) <> 1 then
      raise exception 'lp_business_schema_contract_drift';
    end if;
    definition := replace(definition,target.old_fragment,target.new_fragment);
  end loop;
  definition := replace(definition,
    $old$    if p_workflow_type in ('试听 LP', '换老师试听') then
      lp_item := lp_item || jsonb_build_object('requestedAt', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    end if;$old$,
    $new$    if p_workflow_type in ('老师新 LP','老师 LP 修改','换老师试听') then
      lp_item := lp_item || jsonb_build_object('requestedAt',to_char((fields ->> 'requestSentAt')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    elsif p_workflow_type = '试听 LP' then
      lp_item := lp_item || jsonb_build_object('requestedAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    end if;$new$);
  definition := replace(definition,
    $old$    if p_workflow_type = '老师 LP 修改' then
      lp_item := lp_item || jsonb_build_object('publishedDate', (created_at at time zone 'Australia/Melbourne')::date::text);
    end if;$old$,
    $new$    if p_workflow_type = '老师 LP 修改' then
      lp_item := lp_item || jsonb_build_object('publishedDate',((fields ->> 'requestSentAt')::timestamptz at time zone 'Australia/Melbourne')::date::text);
    end if;$new$);
  if (length(definition)-length(replace(definition,$old$    next_s := (select coalesce(jsonb_agg(case when x.value ->> 'id' = student_id_value then x.value || jsonb_build_object('owner',owner_value,'planner',planner_value,'lpNeed',lp_need_value,'next',title_value || ' 已创建','nextTone','amber') else x.value end order by x.ordinality), '[]'::jsonb) from jsonb_array_elements(next_s) with ordinality x(value, ordinality));$old$,'')))/length($old$    next_s := (select coalesce(jsonb_agg(case when x.value ->> 'id' = student_id_value then x.value || jsonb_build_object('owner',owner_value,'planner',planner_value,'lpNeed',lp_need_value,'next',title_value || ' 已创建','nextTone','amber') else x.value end order by x.ordinality), '[]'::jsonb) from jsonb_array_elements(next_s) with ordinality x(value, ordinality));$old$) <> 1 then
    raise exception 'lp_business_task_contract_drift';
  end if;
  definition := replace(definition,$old$    next_s := (select coalesce(jsonb_agg(case when x.value ->> 'id' = student_id_value then x.value || jsonb_build_object('owner',owner_value,'planner',planner_value,'lpNeed',lp_need_value,'next',title_value || ' 已创建','nextTone','amber') else x.value end order by x.ordinality), '[]'::jsonb) from jsonb_array_elements(next_s) with ordinality x(value, ordinality));$old$,$new$    if p_workflow_type in ('老师新 LP','老师 LP 修改','换老师试听') then
      next_t := internal.lp_business_handover_tasks(next_t,lp_item,created_at);
    end if;
    next_s := (select coalesce(jsonb_agg(case when x.value ->> 'id' = student_id_value then x.value || jsonb_build_object('owner',owner_value,'planner',planner_value,'lpNeed',lp_need_value,'next',title_value || ' 已创建','nextTone','amber') else x.value end order by x.ordinality), '[]'::jsonb) from jsonb_array_elements(next_s) with ordinality x(value, ordinality));$new$);
  execute definition;

  definition := pg_catalog.pg_get_functiondef('public.mutate_lp_atomic_before_trial_manual_tasks(text,text,jsonb,text,text,jsonb,text,text,jsonb,text,jsonb,jsonb,text)'::pg_catalog.regprocedure);
  if (length(definition) - length(replace(definition,$old$  if p_operation = 'create' and p_workflow_type = '老师新 LP' then
    foreach required_key in array array['additionalNotes','basicInfo','studentFoundation','learningGoal','recommendedResources','teachingLanguage','firstLessonContent','lessonSchedule'] loop
      if nullif(trim(p_fields ->> required_key), '') is null then
        raise exception using errcode = '22023', message = 'incomplete_teacher_new_lp_template';
      end if;
    end loop;
  end if;

$old$,''))) / length($old$  if p_operation = 'create' and p_workflow_type = '老师新 LP' then
    foreach required_key in array array['additionalNotes','basicInfo','studentFoundation','learningGoal','recommendedResources','teachingLanguage','firstLessonContent','lessonSchedule'] loop
      if nullif(trim(p_fields ->> required_key), '') is null then
        raise exception using errcode = '22023', message = 'incomplete_teacher_new_lp_template';
      end if;
    end loop;
  end if;

$old$) <> 1 then
    raise exception 'lp_business_template_contract_drift';
  end if;
  definition := replace(definition,$old$  if p_operation = 'create' and p_workflow_type = '老师新 LP' then
    foreach required_key in array array['additionalNotes','basicInfo','studentFoundation','learningGoal','recommendedResources','teachingLanguage','firstLessonContent','lessonSchedule'] loop
      if nullif(trim(p_fields ->> required_key), '') is null then
        raise exception using errcode = '22023', message = 'incomplete_teacher_new_lp_template';
      end if;
    end loop;
  end if;

$old$,'');
  if (length(definition) - length(replace(definition,$old$  if p_operation = 'create' and p_workflow_type = '换老师试听' then
    foreach required_key in array array['handoverFromTeacher','materialsAndContentTaught','recommendedNextContent','studentStrengthsAndLearningProfile','lastHomework','lastLessonRecordingUrl'] loop
      if nullif(trim(p_fields ->> required_key), '') is null then
        raise exception using errcode = '22023', message = 'incomplete_teacher_change_lp_template';
      end if;
    end loop;
  end if;

$old$,''))) / length($old$  if p_operation = 'create' and p_workflow_type = '换老师试听' then
    foreach required_key in array array['handoverFromTeacher','materialsAndContentTaught','recommendedNextContent','studentStrengthsAndLearningProfile','lastHomework','lastLessonRecordingUrl'] loop
      if nullif(trim(p_fields ->> required_key), '') is null then
        raise exception using errcode = '22023', message = 'incomplete_teacher_change_lp_template';
      end if;
    end loop;
  end if;

$old$) <> 1 then
    raise exception 'lp_business_template_contract_drift';
  end if;
  definition := replace(definition,$old$  if p_operation = 'create' and p_workflow_type = '换老师试听' then
    foreach required_key in array array['handoverFromTeacher','materialsAndContentTaught','recommendedNextContent','studentStrengthsAndLearningProfile','lastHomework','lastLessonRecordingUrl'] loop
      if nullif(trim(p_fields ->> required_key), '') is null then
        raise exception using errcode = '22023', message = 'incomplete_teacher_change_lp_template';
      end if;
    end loop;
  end if;

$old$,'');
  definition := replace(definition,$old$  if p_operation = 'create' and p_workflow_type = '老师 LP 修改'$old$,$new$  if p_operation = 'create' and p_workflow_type in ('老师新 LP','老师 LP 修改','换老师试听') then
    if jsonb_typeof(p_fields -> 'requestSentAt') is distinct from 'string'
       or nullif(btrim(p_fields ->> 'requestSentAt'),'') is null then
      raise exception using errcode = '22023', message = 'invalid_lp_business_request_time';
    end if;
    begin
      if not pg_catalog.isfinite((p_fields ->> 'requestSentAt')::timestamptz) then
        raise exception using errcode = '22023', message = 'invalid_lp_business_request_time';
      end if;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_lp_business_request_time';
    end;
    if p_workflow_type = '老师新 LP' and (
      jsonb_typeof(p_fields -> 'writingRequired') is distinct from 'boolean'
      or jsonb_typeof(p_fields -> 'paperRequired') is distinct from 'boolean'
    ) then
      raise exception using errcode = '22023', message = 'invalid_lp_business_material_flags';
    end if;
  end if;

  if p_operation = 'create' and p_workflow_type = '老师 LP 修改'$new$);
  execute definition;
end;
$lp_business_schema$;

do $existing_business_handover_identity$
begin
  update internal.wecom_archive_messages
  set guardian_wechat_hint = guardian_wechat_hint
  where ingested_by = 'WeCom Bot Receiver' and message_type = 'text'
    and classification = 'handover' and trial_handover_id is null
    and internal.wecom_lp_template_type(body) <> '试听 LP'
    and internal.wecom_is_lp_template(body);
end;
$existing_business_handover_identity$;
