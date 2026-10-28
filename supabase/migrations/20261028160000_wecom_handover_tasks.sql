create table internal.wecom_handover_task_state (
  source_message_id text primary key references internal.wecom_archive_messages(message_id),
  version bigint not null default 1 check (version > 0),
  tasks jsonb not null check (jsonb_typeof(tasks) = 'array'),
  updated_at timestamptz not null default now(),
  updated_by text not null
);
alter table internal.wecom_handover_task_state enable row level security;
revoke all on internal.wecom_handover_task_state from public, anon, authenticated, service_role;

create function public.read_wecom_handover_task_input(p_secret text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare sources jsonb; states jsonb; rows jsonb; events jsonb; coverage jsonb;
  current_run uuid; current_revision text; epoch text;
begin
  if internal.verify_ops_secret(p_secret) is not true then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  select c.run_id,c.revision into current_run,current_revision
  from internal.jiaowubao_open_api_schedule_snapshot_current c where c.api_source_key='jwb-open-api-schedule';
  select e.revision::text into epoch from internal.wecom_handover_schedule_epoch e where singleton;
  select coalesce(jsonb_agg(source || jsonb_build_object('identityAt',identity_at) order by sent_at,message_id),'[]') into sources
  from (
    select m.message_id,m.sent_at,internal.wecom_lp_draft_source(m.message_id) || jsonb_build_object('handoverAt',m.sent_at) as source,
      (select i.sent_at from internal.wecom_archive_messages i where i.message_id=c.identity_message_id) as identity_at
    from internal.wecom_archive_messages m join internal.wecom_trial_handover_cases c on c.id=m.trial_handover_id
    where m.ingested_by='WeCom Bot Receiver' and m.message_type='text' and m.classification='handover'
      and m.sent_at >= now()-interval '62 days' and internal.wecom_is_trial_lp_template(m.body)
      and not exists(select 1 from internal.wecom_lp_confirmations x where x.source_message_id=m.message_id)
      and internal.wecom_lp_superseded_by(m.message_id) is null
  ) eligible where source is not null;
  if jsonb_array_length(sources)>2000 then raise exception using errcode='54000',message='wecom_handover_task_source_limit'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('sourceMessageId',s.source_message_id,'version',s.version,'tasks',s.tasks)),'[]') into states
    from internal.wecom_handover_task_state s where exists(select 1 from jsonb_array_elements(sources) x where x->>'sourceMessageId'=s.source_message_id);
  select coalesce(jsonb_agg(to_jsonb(s)),'[]') into rows from public.ops_state s where entity in ('students','teachers','lpItems');
  select coalesce(jsonb_agg(internal.wecom_schedule_event(i.source_key,i.item->'record',current_revision,current_run,false)),'[]') into events
    from internal.wecom_schedule_run_metadata metadata
    cross join lateral jsonb_object_keys(metadata.trial_source_keys) key
    join internal.jiaowubao_open_api_schedule_snapshot_ingest_items i on i.run_id=metadata.run_id and i.source_key=key
    where metadata.run_id=current_run and metadata.trial_rule_fingerprint=internal.wecom_schedule_trial_rule_fingerprint();
  select jsonb_build_array(jsonb_build_object('startsAt',internal.wecom_schedule_date(r.query->>'start')::timestamp at time zone 'Australia/Melbourne',
    'endsAt',(internal.wecom_schedule_date(r.query->>'end')+1)::timestamp at time zone 'Australia/Melbourne','historical',false)) into coverage
    from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r where r.id=current_run and r.state='complete';
  return jsonb_build_object('snapshotRevision',coalesce(current_revision,'absent'),'inputRevision',epoch,
    'targetSourceMessageIds','[]'::jsonb,'sources',sources,'states',states,'rows',rows,'events',events,'coverage',coalesce(coverage,'[]'));
end;
$$;
revoke all on function public.read_wecom_handover_task_input(text) from public,anon,authenticated,service_role;
grant execute on function public.read_wecom_handover_task_input(text) to anon,authenticated;

create function public.save_wecom_handover_tasks(
  p_secret text,p_source_message_id text,p_source_revision text,p_snapshot_revision text,p_input_revision text,
  p_expected_version bigint,p_tasks jsonb,p_actor text,p_full_admin boolean
) returns bigint language plpgsql security definer set search_path = '' as $$
declare source jsonb; current_version bigint; next_version bigint; revision text; epoch text;
begin
  if internal.verify_ops_secret(p_secret) is not true then raise exception using errcode='42501',message='invalid_ops_secret'; end if;
  if nullif(btrim(p_actor),'') is null or length(p_actor)>120 or p_full_admin is null or p_expected_version is null or p_expected_version<0
    or jsonb_typeof(p_tasks) is distinct from 'array' or jsonb_array_length(p_tasks)>20 then
    raise exception using errcode='22023',message='invalid_wecom_handover_task_command';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wecom-lp:'||p_source_message_id,0));
  begin
    perform 1 from internal.wecom_trial_handover_cases c join internal.wecom_archive_messages m on m.trial_handover_id=c.id
      where m.message_id=p_source_message_id for share of c nowait;
    perform 1 from internal.jiaowubao_open_api_schedule_snapshot_current where api_source_key='jwb-open-api-schedule' for share nowait;
    perform 1 from internal.wecom_handover_schedule_epoch where singleton for share nowait;
  exception when lock_not_available then
    raise exception using errcode='PT409',message='wecom_handover_task_input_busy';
  end;
  source := internal.wecom_lp_draft_source(p_source_message_id);
  if source is null or source->'confirmed' <> 'null'::jsonb or internal.wecom_lp_superseded_by(p_source_message_id) is not null
    or source->>'sourceRevision' is distinct from p_source_revision then
    raise exception using errcode='PT409',message='wecom_handover_task_source_changed';
  end if;
  if not p_full_admin and source->>'operationsOwner' is distinct from btrim(p_actor) then
    raise exception using errcode='42501',message='wecom_handover_task_scope_forbidden';
  end if;
  select c.revision into revision from internal.jiaowubao_open_api_schedule_snapshot_current c where c.api_source_key='jwb-open-api-schedule';
  select e.revision::text into epoch from internal.wecom_handover_schedule_epoch e where singleton;
  if coalesce(revision,'absent') is distinct from p_snapshot_revision or epoch is distinct from p_input_revision then
    raise exception using errcode='PT409',message='wecom_handover_task_input_changed';
  end if;
  if exists(select 1 from jsonb_array_elements(p_tasks) t where jsonb_typeof(t) is distinct from 'object'
    or t->>'id' is distinct from internal.trial_manual_task_id(t->>'anchorBookingId',t->>'ruleKey')
    or t->>'studentId' is distinct from 'WECOM:'||(source->>'caseId')
    or t->>'owner' is distinct from source->>'operationsOwner'
    or coalesce(t->>'ruleKey','') !~ '^(wecom\.handover\.identity|trial\.(manual-request\.(specified-content|writing|paper-send|paper-receive|parent-progress-24h|parent-progress-48h|scheduling-anomaly-72h)|scheduling|jiaowubao\.(request-follow-up-n3|prep-n1)))$'
    or case when t->>'ruleKey' like 'trial.jiaowubao.%' then
      coalesce(t->>'anchorBookingId','') not like 'JWB:%' or t->>'requestAnchorBookingId' is distinct from p_source_message_id
      else t->>'anchorBookingId' is distinct from p_source_message_id end
    or coalesce(t->>'status','') not in ('today','upcoming','waiting','overdue','done')
    or coalesce(t->>'dueAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
    or (select count(distinct t->>'id') from jsonb_array_elements(p_tasks) t) <> jsonb_array_length(p_tasks) then
    raise exception using errcode='22023',message='invalid_wecom_handover_tasks';
  end if;
  select s.version into current_version from internal.wecom_handover_task_state s where s.source_message_id=p_source_message_id for update;
  if coalesce(current_version,0)<>p_expected_version then raise exception using errcode='PT409',message='wecom_handover_task_version_changed'; end if;
  next_version := coalesce(current_version,0)+1;
  insert into internal.wecom_handover_task_state(source_message_id,version,tasks,updated_by)
    values(p_source_message_id,next_version,p_tasks,btrim(p_actor))
    on conflict(source_message_id) do update set version=excluded.version,tasks=excluded.tasks,updated_at=now(),updated_by=excluded.updated_by;
  return next_version;
end;
$$;
revoke all on function public.save_wecom_handover_tasks(text,text,text,text,text,bigint,jsonb,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.save_wecom_handover_tasks(text,text,text,text,text,bigint,jsonb,text,boolean) to anon,authenticated;

create function internal.transfer_wecom_handover_tasks()
returns trigger language plpgsql security definer set search_path = '' as $$
declare saved public.ops_state%rowtype; previous jsonb; transferred jsonb; item jsonb; source jsonb; identity_at timestamptz; saved_identity jsonb;
begin
  source := internal.wecom_lp_draft_source(new.source_message_id);
  if source is null or new.case_id is null or coalesce(new.confirmation_intent->>'workflowType','试听 LP') <> '试听 LP' then return new; end if;
  select * into saved from public.ops_state where entity='tasks' for update;
  select tasks into previous from internal.wecom_handover_task_state where source_message_id=new.source_message_id;
  transferred := '[]'::jsonb;
  for item in select value from jsonb_array_elements(coalesce(previous,'[]')) loop
    if item->>'ruleKey'='wecom.handover.identity' then saved_identity := item; continue; end if;
    item := item || jsonb_build_object('studentId',new.student_id,'owner',new.confirmation_intent->'assignment'->>'owner');
    if item->>'ruleKey' like 'trial.jiaowubao.%' then
      item := item || jsonb_build_object('requestAnchorBookingId',new.lp_item_id);
    else
      item := item || jsonb_build_object('anchorBookingId',new.lp_item_id,
        'id',internal.trial_manual_task_id(new.lp_item_id,item->>'ruleKey'));
    end if;
    transferred := transferred || jsonb_build_array(item);
  end loop;
  select i.sent_at into identity_at from internal.wecom_trial_handover_cases c
    join internal.wecom_archive_messages i on i.message_id=c.identity_message_id where c.id=new.case_id;
  transferred := transferred || jsonb_build_array(coalesce(saved_identity,'{}'::jsonb) || jsonb_build_object('id',internal.trial_manual_task_id(new.lp_item_id,'wecom.handover.identity'),
      'title','《教务》【交接身份匹配】<'||coalesce(source->>'studentName',source->>'wechatName')||'>',
      'owner',new.confirmation_intent->'assignment'->>'owner','studentId',new.student_id,'status','done','tone','green','category','LP',
      'ruleKey','wecom.handover.identity','anchorBookingId',new.lp_item_id,'result','真名和微信名已匹配，交接身份任务自动完成',
      'dueAt',to_char(coalesce(identity_at,new.confirmed_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'closedAt',to_char(coalesce(identity_at,new.confirmed_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'completionOutcome','done'));
  select coalesce(jsonb_agg(t.value order by t.ordinality),'[]') into previous
    from jsonb_array_elements(saved.payload) with ordinality t(value,ordinality)
    where not exists(select 1 from jsonb_array_elements(transferred) x where x->>'id'=t.value->>'id');
  update public.ops_state set payload=previous||transferred,version=version+1,updated_at=now(),updated_by=new.actor
    where entity='tasks' returning * into saved;
  insert into public.ops_mutation_log(entity,version,actor) values('tasks',saved.version,saved.updated_by);
  return new;
end;
$$;
revoke all on function internal.transfer_wecom_handover_tasks() from public,anon,authenticated,service_role;
create trigger wecom_handover_tasks_after_confirmation after insert on internal.wecom_lp_confirmations
  for each row execute function internal.transfer_wecom_handover_tasks();

do $confirmation_task_receipt$
declare definition text; marker text := 'receipt.students_row, receipt.lp_items_row, receipt.tasks_row, receipt.files_row, audit_id_value;';
begin
  definition := pg_catalog.pg_get_functiondef('public.confirm_wecom_lp_draft_atomic(text,uuid,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,boolean,text)'::regprocedure);
  if (length(definition)-length(replace(definition,marker,'')))/length(marker) <> 1 then
    raise exception 'wecom_handover_task_confirmation_contract_drift';
  end if;
  execute replace(definition,marker,'receipt.students_row, receipt.lp_items_row, (select task_state from public.ops_state task_state where task_state.entity=''tasks''), receipt.files_row, audit_id_value;');
end;
$confirmation_task_receipt$;
notify pgrst,'reload schema';
