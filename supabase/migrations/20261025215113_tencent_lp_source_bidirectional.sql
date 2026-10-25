create table internal.tencent_lp_source_lease (
  singleton boolean primary key default true check (singleton),
  token uuid,
  expires_at timestamptz not null default '-infinity'
);
insert into internal.tencent_lp_source_lease(singleton) values(true);
alter table internal.tencent_lp_source_lease enable row level security;
revoke all on table internal.tencent_lp_source_lease from public, anon, authenticated, service_role;

create table internal.tencent_lp_source_baselines (
  lp_item_id text not null check (lp_item_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  identity_sha256 text not null check (identity_sha256 ~ '^[a-f0-9]{64}$'),
  field text not null check (field in ('planner','resultStatus','lpFinalized','trialPaid','trialLedgerNote')),
  revision bigint not null default 0 check (revision >= 0),
  initialized boolean not null default false,
  common_value jsonb not null default 'null',
  pending_before jsonb,
  pending_target jsonb,
  pending_phase text check (pending_phase in ('planned','attempted')),
  last_command uuid,
  last_intent_sha256 text,
  updated_at timestamptz not null default now(),
  primary key (lp_item_id,field),
  check ((pending_phase is null and pending_before is null and pending_target is null)
    or (pending_phase is not null and pending_before is not null and pending_target is not null and pending_target <> 'null'::jsonb)),
  check (internal.trial_ledger_value_valid(field,common_value)),
  check (pending_before is null or internal.trial_ledger_value_valid(field,pending_before)),
  check (pending_target is null or internal.trial_ledger_value_valid(field,pending_target))
);
alter table internal.tencent_lp_source_baselines enable row level security;
revoke all on table internal.tencent_lp_source_baselines from public, anon, authenticated, service_role;

create function internal.tencent_lp_baseline_json(p_row internal.tencent_lp_source_baselines)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('field',p_row.field,'revision',p_row.revision,'initialized',p_row.initialized,
    'commonValue',p_row.common_value,'pending',case when p_row.pending_phase is null then null else
      jsonb_build_object('before',p_row.pending_before,'target',p_row.pending_target,'phase',p_row.pending_phase) end);
$$;
revoke all on function internal.tencent_lp_baseline_json(internal.tencent_lp_source_baselines) from public, anon, authenticated, service_role;

create function public.tencent_lp_source_sync_action(p_secret text,p_token uuid,p_action text,p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  lease internal.tencent_lp_source_lease%rowtype;
  baseline internal.tencent_lp_source_baselines%rowtype;
  l public.ops_state%rowtype;
  item jsonb;
  current_value jsonb;
  expected_value jsonb := coalesce(p_args -> 'expectedSystem','null'::jsonb);
  next_value jsonb := coalesce(p_args -> 'value','null'::jsonb);
  before_value jsonb := coalesce(p_args -> 'before','null'::jsonb);
  command_uuid uuid;
  intent_hash text;
  fields jsonb;
  receipt record;
begin
  if internal.verify_ops_secret(p_secret) is distinct from true then raise exception using errcode='42501',message='invalid_ops_secret'; end if;
  if p_token is null or p_action is null or jsonb_typeof(p_args) is distinct from 'object'
    or octet_length(p_args::text) > 16384
    or p_args - 'lpItemId' - 'identityHash' - 'field' - 'revision' - 'expectedSystem' - 'value' - 'before' - 'commandId' - 'expectedLpVersion' <> '{}'::jsonb then
    raise exception using errcode='22023',message='tencent_lp_sync_request_invalid';
  end if;
  select * into lease from internal.tencent_lp_source_lease where singleton for update;
  if p_action='claim' then
    if lease.token is not null and lease.token <> p_token and lease.expires_at > clock_timestamp() then return jsonb_build_object('claimed',false); end if;
    update internal.tencent_lp_source_lease set token=p_token,expires_at=clock_timestamp()+interval '250 seconds' where singleton;
    return jsonb_build_object('claimed',true);
  end if;
  if p_action='release' then
    update internal.tencent_lp_source_lease set token=null,expires_at='-infinity' where singleton and token=p_token;
    return jsonb_build_object('released',found);
  end if;
  if lease.token is distinct from p_token or lease.expires_at <= clock_timestamp() then
    raise exception using errcode='40001',message='tencent_lp_sync_lease_expired';
  end if;
  if coalesce(p_args->>'lpItemId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    or coalesce(p_args->>'identityHash','') !~ '^[a-f0-9]{64}$' then raise exception using errcode='22023',message='tencent_lp_sync_identity_invalid'; end if;
  if exists(select 1 from internal.tencent_lp_source_baselines b where b.lp_item_id=p_args->>'lpItemId'
    and b.identity_sha256 <> p_args->>'identityHash') then raise exception using errcode='40001',message='tencent_lp_sync_identity_drift'; end if;
  if p_action='read' then
    select coalesce(jsonb_agg(internal.tencent_lp_baseline_json(b) order by b.field),'[]'::jsonb) into fields
    from internal.tencent_lp_source_baselines b where b.lp_item_id=p_args->>'lpItemId';
    return jsonb_build_object('fields',fields);
  end if;
  if p_action not in ('observe','import','stage','attempt','complete','cancel')
    or coalesce(p_args->>'field','') not in ('planner','resultStatus','lpFinalized','trialPaid','trialLedgerNote')
    or coalesce(p_args->>'revision','') !~ '^[0-9]{1,16}$'
    or coalesce(p_args->>'commandId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or not internal.trial_ledger_value_valid(p_args->>'field',expected_value)
    or not internal.trial_ledger_value_valid(p_args->>'field',next_value)
    or not internal.trial_ledger_value_valid(p_args->>'field',before_value) then
    raise exception using errcode='22023',message='tencent_lp_sync_field_invalid';
  end if;
  command_uuid := (p_args->>'commandId')::uuid;
  intent_hash := encode(extensions.digest(jsonb_build_object('action',p_action,'args',p_args)::text,'sha256'),'hex');
  insert into internal.tencent_lp_source_baselines(lp_item_id,identity_sha256,field)
  values(p_args->>'lpItemId',p_args->>'identityHash',p_args->>'field') on conflict do nothing;
  select * into baseline from internal.tencent_lp_source_baselines b
  where b.lp_item_id=p_args->>'lpItemId' and b.field=p_args->>'field' for update;
  if baseline.last_command=command_uuid then
    if baseline.last_intent_sha256 <> intent_hash then raise exception using errcode='23505',message='tencent_lp_sync_command_conflict'; end if;
    return internal.tencent_lp_baseline_json(baseline);
  end if;
  if baseline.revision <> (p_args->>'revision')::bigint then raise exception using errcode='40001',message='tencent_lp_sync_baseline_conflict'; end if;
  if p_action in ('observe','import','stage','attempt') then
    select * into l from public.ops_state where entity='lpItems' for update;
    select value into item from jsonb_array_elements(l.payload) where value->>'id'=p_args->>'lpItemId';
    if item is null or coalesce(item->>'workflowType','') not in ('试听 LP','换老师试听') then
      raise exception using errcode='22023',message='tencent_lp_sync_lp_not_found';
    end if;
    if (p_args->>'expectedLpVersion')::bigint is distinct from l.version then raise exception using errcode='40001',message='tencent_lp_sync_identity_version_conflict'; end if;
    current_value := internal.trial_ledger_stored_value(item,p_args->>'field');
    if current_value is distinct from expected_value then raise exception using errcode='40001',message='tencent_lp_sync_system_conflict'; end if;
  end if;
  if p_action='observe' then
    if baseline.pending_phase is not null or current_value is distinct from next_value then
      raise exception using errcode='40001',message='tencent_lp_sync_observation_conflict'; end if;
    if baseline.initialized and baseline.common_value=next_value then return internal.tencent_lp_baseline_json(baseline) || jsonb_build_object('lpVersion',l.version); end if;
    baseline.common_value:=next_value; baseline.initialized:=true;
  elsif p_action='import' then
    if next_value='null'::jsonb or next_value='""'::jsonb then raise exception using errcode='22023',message='tencent_lp_sync_empty_import'; end if;
    select * into receipt from public.mutate_trial_ledger_field_atomic(p_secret,command_uuid::text,
      jsonb_build_object('lpItemId',p_args->>'lpItemId','field',p_args->>'field','expectedValue',expected_value,'value',next_value),
      p_args->>'lpItemId',p_args->>'field',expected_value,next_value,'Tencent LP Source Worker');
    if receipt.lp_item_id is distinct from p_args->>'lpItemId' or receipt.field is distinct from p_args->>'field' then
      raise exception using errcode='55000',message='tencent_lp_sync_receipt_invalid'; end if;
    l := receipt.lp_items_row;
    baseline.common_value:=next_value; baseline.initialized:=true;
    baseline.pending_before:=null; baseline.pending_target:=null; baseline.pending_phase:=null;
  elsif p_action='stage' then
    if baseline.pending_phase is not null or next_value='null'::jsonb or next_value='""'::jsonb or current_value is distinct from next_value then
      raise exception using errcode='40001',message='tencent_lp_sync_stage_conflict'; end if;
    baseline.pending_before:=before_value; baseline.pending_target:=next_value; baseline.pending_phase:='planned';
  elsif p_action='attempt' then
    if baseline.pending_phase is distinct from 'planned' or current_value is distinct from baseline.pending_target then
      raise exception using errcode='40001',message='tencent_lp_sync_attempt_conflict'; end if;
    baseline.pending_phase:='attempted';
  elsif p_action='complete' then
    if baseline.pending_phase is null or next_value is distinct from baseline.pending_target then
      raise exception using errcode='40001',message='tencent_lp_sync_completion_conflict'; end if;
    baseline.common_value:=baseline.pending_target; baseline.initialized:=true;
    baseline.pending_before:=null; baseline.pending_target:=null; baseline.pending_phase:=null;
  elsif p_action='cancel' then
    if baseline.pending_phase is distinct from 'planned' then raise exception using errcode='40001',message='tencent_lp_sync_uncertain_write'; end if;
    baseline.pending_before:=null; baseline.pending_target:=null; baseline.pending_phase:=null;
  end if;
  update internal.tencent_lp_source_baselines set revision=baseline.revision+1,initialized=baseline.initialized,
    common_value=baseline.common_value,pending_before=baseline.pending_before,pending_target=baseline.pending_target,pending_phase=baseline.pending_phase,
    last_command=command_uuid,last_intent_sha256=intent_hash,updated_at=clock_timestamp()
  where lp_item_id=baseline.lp_item_id and field=baseline.field returning * into baseline;
  return internal.tencent_lp_baseline_json(baseline) || jsonb_build_object('lpVersion',l.version);
end;
$$;
revoke all on function public.tencent_lp_source_sync_action(text,uuid,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.tencent_lp_source_sync_action(text,uuid,text,jsonb) to anon;
