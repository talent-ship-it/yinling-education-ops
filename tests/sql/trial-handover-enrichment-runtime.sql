\ir assert-disposable-database.sql
\set ON_ERROR_STOP on
begin;
\ir trial-handover-enrichment-setup.sql

do $$
declare seed jsonb; lp jsonb; next_lp jsonb; fields jsonb; intake jsonb; source_record jsonb; statement text; receipt record; counts jsonb; variant jsonb; projected jsonb; raw_variant jsonb; screenshot_intent jsonb; screenshot_statement text; revocation_intent jsonb; key text:=extensions.gen_random_uuid()::text;
begin
  seed:=internal.fixture_trial_handover_seed(); lp:=seed->'lp';
  fields:=lp->'fields'||'{"assignedTeacher":"Synthetic Teacher","studentNameKnown":true,"studentName":"Synthetic Child","trialDurationMinutes":60}'::jsonb;
  intake:=lp->'trialIntake'||'{"studentName":"Synthetic Child","trialDurationMinutes":60}'::jsonb;
  next_lp:=lp||jsonb_build_object('fields',fields,'trialIntake',intake,'trialSchedule',seed->'link');
  source_record:=(select item->'record' from internal.jiaowubao_open_api_schedule_snapshot_ingest_items);
  if internal.trial_handover_name_key('Ｓｙｎｔｈｅｔｉｃ　Ｃｈｉｌｄ')<>internal.trial_handover_name_key('synthetic child') then raise exception 'Name normalization mismatch'; end if;
  if internal.trial_handover_account_letter('试听学员A(Tara龙) 2026')<>'a' or internal.trial_handover_account_letter('Trial account B 2026')<>'b' or internal.trial_handover_account_letter('Synthetic Child') is not null then raise exception 'Shared account parser mismatch'; end if;
  statement:=internal.fixture_trial_handover_call(key,jsonb_build_array(next_lp),seed->'tasks');
  perform internal.fixture_expect_failure(replace(statement,quote_literal('local-jwb-fixture'),quote_literal('wrong-secret')),'invalid_ops_secret');
  update public.ops_state set version=2 where entity='lpItems';
  perform internal.fixture_expect_failure(statement,'version_conflict');
  update public.ops_state set version=1 where entity='lpItems';
  update internal.jiaowubao_open_api_schedule_snapshot_current set published_at=now()-interval '3 hours';
  perform internal.fixture_expect_failure(statement,'trial_handover_source_changed');
  update internal.jiaowubao_open_api_schedule_snapshot_current set published_at=now(),revision='sha256:'||repeat('b',64);
  perform internal.fixture_expect_failure(statement,'trial_handover_source_changed');
  update internal.jiaowubao_open_api_schedule_snapshot_current set revision=seed->>'revision';
  perform internal.fixture_expect_failure(replace(statement,'Human subject','Forged subject'),'trial_handover_fields_projection_invalid');
  perform internal.fixture_expect_failure(replace(statement,'Human result','Forged result'),'trial_handover_fields_projection_invalid');
  perform internal.fixture_expect_failure(replace(statement,'"sharedAccountLetter": "a"','"sharedAccountLetter": "b"'),'trial_handover_source_projection_invalid');
  perform internal.fixture_expect_failure(replace(statement,'"sharedAccountLabel": "试听学员A"','"sharedAccountLabel": "试听学员B"'),'trial_handover_source_projection_invalid');
  perform internal.fixture_expect_failure(replace(statement,'"durationMinutes": 60','"durationMinutes": 45'),'trial_handover_source_projection_invalid');
  perform internal.fixture_expect_failure(replace(statement,'Synthetic Teacher','Forged Teacher'),'trial_handover_source_projection_invalid');
  perform internal.fixture_expect_failure(replace(statement,'"trialDurationMinutes": 60','"trialDurationMinutes": 45'),'trial_handover_fields_projection_invalid');
  update public.ops_state set payload=jsonb_build_array((seed->'student')||'{"id":"S-1"}'::jsonb,(seed->'student')||'{"id":"S-2"}'::jsonb) where entity='students';
  perform internal.fixture_expect_failure(statement,'trial_handover_fields_projection_invalid');
  update public.ops_state set payload=jsonb_build_array(seed->'student') where entity='students';
  update public.ops_state set payload=jsonb_build_array(lp||'{"resultStatus":"已取消"}'::jsonb) where entity='lpItems';
  perform internal.fixture_expect_failure(internal.fixture_trial_handover_call(key,jsonb_build_array(next_lp||'{"resultStatus":"已取消"}'::jsonb),seed->'tasks'),'trial_handover_lp_not_found');
  update public.ops_state set payload=jsonb_build_array(lp) where entity='lpItems';
  counts:=jsonb_build_object('mutations',(select count(*) from public.ops_mutation_log),'audits',(select count(*) from internal.operational_contract_audit));
  perform internal.fixture_expect_failure(internal.fixture_trial_handover_call(key,jsonb_build_array(next_lp),jsonb_build_array(seed#>'{tasks,1}')),'jiaowubao_trial_completed_history_changed');
  if (select payload from public.ops_state where entity='lpItems')<>jsonb_build_array(lp) or (select version from public.ops_state where entity='lpItems')<>1
    or (select count(*) from public.ops_mutation_log)<>(counts->>'mutations')::int or (select count(*) from internal.operational_contract_audit)<>(counts->>'audits')::int then raise exception 'Enrichment was not rolled back with delegate failure'; end if;
  begin
    update internal.jiaowubao_open_api_schedule_snapshot_current set published_at=now()-interval '3 hours';
    insert into internal.jiaowubao_open_api_schedule_projection_jobs values('jwb-open-api-schedule',seed->>'revision','pending');
    perform internal.fixture_expect_failure(replace(statement,quote_literal('Ella'),quote_literal('Ops Admin')),'trial_handover_source_changed');
    update internal.jiaowubao_open_api_schedule_projection_jobs set state='complete';
    perform internal.fixture_expect_failure(replace(statement,quote_literal('Ella'),quote_literal('Ops Admin')),'trial_handover_source_changed');
    update internal.jiaowubao_open_api_schedule_projection_jobs set state='authority_done',revision='sha256:'||repeat('b',64);
    perform internal.fixture_expect_failure(replace(statement,quote_literal('Ella'),quote_literal('Ops Admin')),'trial_handover_source_changed');
    update internal.jiaowubao_open_api_schedule_projection_jobs set revision=seed->>'revision';
    perform internal.fixture_expect_failure(statement,'trial_handover_source_changed');
    execute replace(statement,quote_literal('Ella'),quote_literal('Ops Admin')) into receipt;
    if not receipt.applied or (receipt.lp_items_row).payload<>jsonb_build_array(next_lp) then raise exception 'Approved pinned recovery did not preserve released v2 stale guard'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  begin
    raw_variant:=jsonb_set(source_record,'{course_title}','"English - Trial account A试听"'::jsonb);
    update internal.jiaowubao_open_api_schedule_snapshot_ingest_items set item=jsonb_build_object('record',raw_variant);
    update public.ops_state set payload=jsonb_build_array((seed->'student')||'{"name":"Trial account A"}'::jsonb) where entity='students';
    projected:=lp||jsonb_build_object('fields',(lp->'fields')||'{"assignedTeacher":"Synthetic Teacher","trialDurationMinutes":60}'::jsonb,'trialIntake',(lp->'trialIntake')||'{"trialDurationMinutes":60}'::jsonb,'trialSchedule',(seed->'link')||'{"courseName":"English - Trial account A试听","studentName":"Trial account A"}'::jsonb);
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(projected),seed->'tasks') into receipt;
    if (receipt.lp_items_row).payload<>jsonb_build_array(projected) then raise exception 'Shared trial account was filled as a real student identity'; end if;
    variant:=projected||jsonb_build_object('fields',(projected->'fields')||'{"studentNameKnown":true,"studentName":"Trial account A"}'::jsonb,'trialIntake',(projected->'trialIntake')||'{"studentName":"Trial account A"}'::jsonb);
    perform internal.fixture_expect_failure(internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(variant),seed->'tasks','{"lpItems":2,"tasks":1}'::jsonb),'trial_handover_fields_projection_invalid');
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  for raw_variant in select jsonb_set(source_record,'{stu_list}',value) from (values
    ('[{"mem_id":"9","name":"试听学员A"},{"mem_id":"2","name":"  Trial account A 2026  "},{"mem_id":"2","name":"Trial account B 2026"}]'::jsonb),
    ('[{"mem_id":"2","name":"Trial account B 2026"},{"mem_id":"2","name":"  Trial account A 2026  "},{"mem_id":"9","name":"试听学员A"}]'::jsonb)
  ) variants(value) loop
    begin
      update internal.jiaowubao_open_api_schedule_snapshot_ingest_items set item=jsonb_build_object('record',raw_variant);
      projected:=jsonb_set(next_lp,'{trialSchedule,sharedAccountLabel}','"Trial account A 2026"'::jsonb);
      perform internal.fixture_expect_failure(internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(jsonb_set(projected,'{trialSchedule,sharedAccountLabel}','"试听学员A"'::jsonb)),seed->'tasks'),'trial_handover_source_projection_invalid');
      execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(projected),seed->'tasks') into receipt;
      if (receipt.lp_items_row).payload<>jsonb_build_array(projected) then raise exception 'Shared account metadata did not follow source participant deduplication and sort'; end if;
      raise exception using errcode='P0042',message='fixture_rollback';
    exception when sqlstate 'P0042' then null; end;
  end loop;
  for raw_variant in select jsonb_set(source_record,'{teacher_title}',value) from (values ('null'::jsonb),('"  "'::jsonb)) variants(value) loop
    begin
      update internal.jiaowubao_open_api_schedule_snapshot_ingest_items set item=jsonb_build_object('record',raw_variant);
      projected:=next_lp||jsonb_build_object('fields',fields||jsonb_build_object('assignedTeacher',lp#>'{fields,assignedTeacher}'),'trialSchedule',(seed->'link')||'{"teacherName":"待核对老师映射"}'::jsonb);
      perform internal.fixture_expect_failure(internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(jsonb_set(projected,'{trialSchedule,teacherName}','"Forged Teacher"'::jsonb)),seed->'tasks'),'trial_handover_source_projection_invalid');
      perform internal.fixture_expect_failure(internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(jsonb_set(projected,'{fields,assignedTeacher}','"待核对老师映射"'::jsonb)),seed->'tasks'),'trial_handover_fields_projection_invalid');
      execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(projected),seed->'tasks') into receipt;
      if (receipt.lp_items_row).payload<>jsonb_build_array(projected) or (receipt.lp_items_row).payload#>'{0,fields,assignedTeacher}' is distinct from lp#>'{fields,assignedTeacher}' then raise exception 'Missing source teacher changed v2 schedule fallback or filled handover teacher'; end if;
      raise exception using errcode='P0042',message='fixture_rollback';
    exception when sqlstate 'P0042' then null; end;
  end loop;
  for raw_variant in select jsonb_set(source_record,'{course_title}',to_jsonb(value)) from (values ('  '||repeat('A',80)||'试听  '),('  English - '||repeat('A',80)||'试听  ')) variants(value) loop
    begin
      update internal.jiaowubao_open_api_schedule_snapshot_ingest_items set item=jsonb_build_object('record',raw_variant);
      update public.ops_state set payload=jsonb_build_array((seed->'student')||jsonb_build_object('name',repeat('A',80))) where entity='students';
      projected:=next_lp||jsonb_build_object('fields',fields||jsonb_build_object('studentName',repeat('A',80)),'trialIntake',intake||jsonb_build_object('studentName',repeat('A',80)),'trialSchedule',(seed->'link')||jsonb_build_object('courseName',internal.trial_handover_trim(raw_variant->>'course_title'),'studentName',repeat('A',80)));
      execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(projected),seed->'tasks') into receipt;
      if (receipt.lp_items_row).payload<>jsonb_build_array(projected) then raise exception 'Padded80 character course name diverged from TypeScript trim-first projection'; end if;
      raise exception using errcode='P0042',message='fixture_rollback';
    exception when sqlstate 'P0042' then null; end;
  end loop;
  begin
    variant:=lp||jsonb_build_object('fields',(lp->'fields')||'{"assignedTeacher":"Human Teacher","studentNameKnown":true,"studentName":"Reviewed Name","trialDurationMinutes":45}'::jsonb,'trialIntake',(lp->'trialIntake')||'{"studentName":"Reviewed Intake","trialDurationMinutes":30}'::jsonb);
    update public.ops_state set payload=jsonb_build_array(variant) where entity='lpItems';
    projected:=variant||jsonb_build_object('trialSchedule',seed->'link');
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(projected),seed->'tasks') into receipt;
    if (receipt.lp_items_row).payload<>jsonb_build_array(projected) then raise exception 'Manual nonempty fields were overwritten'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  begin
    variant:=lp||jsonb_build_object('fields',(lp->'fields')||'{"assignedTeacher":"Human Teacher","studentNameKnown":true,"studentName":"Reviewed Name","trialDurationMinutes":45}'::jsonb);
    projected:=variant||jsonb_build_object('trialIntake',intake,'trialSchedule',seed->'link');
    update public.ops_state set payload=jsonb_build_array(variant) where entity='lpItems';
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(projected),seed->'tasks') into receipt;
    if (receipt.lp_items_row).payload<>jsonb_build_array(projected) then raise exception 'Intake fill must be independent of reviewed LP fields'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  begin
    raw_variant:=jsonb_set(source_record,'{time_end}','"09:30"'::jsonb);
    update internal.jiaowubao_open_api_schedule_snapshot_ingest_items set item=jsonb_build_object('record',raw_variant);
    projected:=next_lp||jsonb_build_object('fields',fields||'{"trialDurationMinutes":null}'::jsonb,'trialIntake',intake||'{"trialDurationMinutes":null}'::jsonb,'trialSchedule',(seed->'link')||jsonb_build_object('durationMinutes',30,'endsAt',to_char((((seed->>'sourceDay')||' 09:30')::timestamp at time zone 'Australia/Melbourne') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(projected),seed->'tasks') into receipt;
    if (receipt.lp_items_row).payload<>jsonb_build_array(projected) then raise exception 'Non45/60 source duration changed restricted intake'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  begin
    variant:=lp||jsonb_build_object('fields',(lp->'fields')||'{"trialDurationMinutes":0}'::jsonb,'trialIntake',(lp->'trialIntake')||'{"trialDurationMinutes":0}'::jsonb);
    projected:=next_lp||jsonb_build_object('fields',fields||'{"trialDurationMinutes":0}'::jsonb,'trialIntake',intake||'{"trialDurationMinutes":0}'::jsonb);
    update public.ops_state set payload=jsonb_build_array(variant) where entity='lpItems';
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(projected),seed->'tasks') into receipt;
    if (receipt.lp_items_row).payload<>jsonb_build_array(projected) then raise exception 'Numeric zero was treated as missing'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  begin
    raw_variant:=jsonb_set(source_record,'{course_title}','"English - Nguyễn试听"'::jsonb);
    update internal.jiaowubao_open_api_schedule_snapshot_ingest_items set item=jsonb_build_object('record',raw_variant);
    update public.ops_state set payload=jsonb_build_array((seed->'student')||'{"name":"Nguyễn"}'::jsonb) where entity='students';
    projected:=lp||jsonb_build_object('fields',(lp->'fields')||'{"assignedTeacher":"Synthetic Teacher","trialDurationMinutes":60}'::jsonb,'trialIntake',(lp->'trialIntake')||'{"trialDurationMinutes":60}'::jsonb,'trialSchedule',(seed->'link')||'{"courseName":"English - Nguyễn试听","studentName":"Nguyễn"}'::jsonb);
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(projected),seed->'tasks') into receipt;
    if (receipt.lp_items_row).payload<>jsonb_build_array(projected) then raise exception 'Rare Latin auto-fill restriction diverged'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  begin
    variant:=lp-'fields'-'trialIntake';
    projected:=variant||jsonb_build_object('fields','{"assignedTeacher":"Synthetic Teacher","studentNameKnown":true,"studentName":"Synthetic Child","trialDurationMinutes":60}'::jsonb,'trialSchedule',seed->'link');
    update public.ops_state set payload=jsonb_build_array(variant) where entity='lpItems';
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(projected),seed->'tasks') into receipt;
    if (receipt.lp_items_row).payload<>jsonb_build_array(projected) or projected?'trialIntake' then raise exception 'Legacy missing fields did not fill narrowly'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  begin
    update public.ops_state set payload=jsonb_build_array(seed->'student',(seed->'student')||'{"id":"S-2"}'::jsonb) where entity='students';
    projected:=lp||jsonb_build_object('fields',(lp->'fields')||'{"assignedTeacher":"Synthetic Teacher","trialDurationMinutes":60}'::jsonb,'trialIntake',(lp->'trialIntake')||'{"trialDurationMinutes":60}'::jsonb,'trialSchedule',seed->'link');
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(projected),seed->'tasks') into receipt;
    if (receipt.lp_items_row).payload<>jsonb_build_array(projected) then raise exception 'Ambiguous names did not remain unknown'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  begin
    raw_variant:=jsonb_set(source_record,'{stu_list}','[{"mem_id":"8001","name":"试听学员A"},{"mem_id":"8002","name":"试听学员B"}]'::jsonb);
    update internal.jiaowubao_open_api_schedule_snapshot_ingest_items set item=jsonb_build_object('record',raw_variant);
    projected:=jsonb_set(jsonb_set(next_lp,'{trialSchedule,sharedAccountLetter}','null'::jsonb),'{trialSchedule,sharedAccountLabel}','null'::jsonb);
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(projected),seed->'tasks') into receipt;
    if (receipt.lp_items_row).payload<>jsonb_build_array(projected) then raise exception 'Ambiguous shared account was guessed'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  begin
    variant:=lp||jsonb_build_object('trialScheduleReview',jsonb_build_object('source','screenshot-review','eventId','jwb-open-api:schedule:1'));
    projected:=next_lp||jsonb_build_object('trialScheduleReview',variant->'trialScheduleReview','trialSchedule',(seed->'link')||'{"confirmation":"screenshot-review"}'::jsonb);
    update public.ops_state set payload=jsonb_build_array(variant) where entity='lpItems';
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(projected),seed->'tasks') into receipt;
    if (receipt.lp_items_row).payload<>jsonb_build_array(projected) then raise exception 'Restored reviewed event lost its pin'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  begin
    projected:=next_lp||jsonb_build_object('trialScheduleReview',jsonb_build_object('source','screenshot-review','eventId','jwb-open-api:schedule:1'),'trialSchedule',(seed->'link')||'{"confirmation":"screenshot-review"}'::jsonb);
    screenshot_intent:=jsonb_build_object('lpItemId','LP-1','eventId','jwb-open-api:schedule:1','sourceRevision',seed->>'revision','sourceDate',seed->>'sourceDay','expectedVersions','{"students":1,"lpItems":1,"tasks":1}'::jsonb);
    screenshot_statement:=format('select * from public.confirm_trial_screenshot_atomic(%L,%L,%L::jsonb,%L::jsonb,%L::jsonb,%L::jsonb,%L,true)','local-jwb-fixture',extensions.gen_random_uuid()::text,screenshot_intent,screenshot_intent->'expectedVersions',jsonb_build_array(projected),seed->'tasks','Ella');
    perform internal.fixture_expect_failure(replace(screenshot_statement,'"sharedAccountLetter": "a"','"sharedAccountLetter": "b"'),'trial_screenshot_projection_invalid');
    execute screenshot_statement into receipt;
    if (receipt.lp_items_row).payload<>jsonb_build_array(projected) then raise exception 'Screenshot metadata compatibility failed'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  begin
    projected:=lp||jsonb_build_object('trialSchedule',(seed->'link')-'durationMinutes'-'sharedAccountLabel'-'sharedAccountLetter');
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(projected),seed->'tasks') into receipt;
    if (receipt.lp_items_row).payload<>jsonb_build_array(projected) then raise exception 'Legacy v2-shaped projection compatibility failed'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  begin
    variant:=lp||jsonb_build_object('trialSchedule',seed->'link');
    update public.ops_state set payload=jsonb_build_array(variant) where entity='lpItems';
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(next_lp),seed->'tasks') into receipt;
    if not receipt.applied or (receipt.lp_items_row).version<>2 or (select count(*) from public.ops_mutation_log where entity='lpItems')<>1 then raise exception 'Fields-only enrichment missed OCC or double logged'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  execute statement into receipt;
  if not receipt.applied or (receipt.lp_items_row).payload<>jsonb_build_array(next_lp) or (receipt.lp_items_row).version<>2
    or (receipt.tasks_row).payload<>seed->'tasks' or (select payload from public.ops_state where entity='students')<>jsonb_build_array(seed->'student')
    or not exists(select 1 from internal.operational_contract_audit where action='trial.jiaowubao.handover_enrich')
    or (select count(*) from public.ops_mutation_log where entity='lpItems')<>1 then raise exception 'Narrow enrichment changed unrelated data or omitted receipt'; end if;
  select * into receipt from public.get_jiaowubao_trial_sync_command_result('local-jwb-fixture',key,(select c.command_intent from internal.jiaowubao_trial_sync_commands c where c.command_key=key::uuid),'Ella');
  if (receipt.lp_items_row).payload<>jsonb_build_array(next_lp) or receipt.audit_entry_id<>(select c.audit_id from internal.jiaowubao_trial_sync_commands c where c.command_key=key::uuid) then raise exception 'Existing receipt reader lost enrichment'; end if;
  counts:=jsonb_build_object('mutations',(select count(*) from public.ops_mutation_log),'audits',(select count(*) from internal.operational_contract_audit));
  update internal.jiaowubao_open_api_schedule_snapshot_current set revision='sha256:'||repeat('c',64);
  execute statement into receipt;
  if receipt.applied or (select count(*) from public.ops_mutation_log)<>(counts->>'mutations')::int or (select count(*) from internal.operational_contract_audit)<>(counts->>'audits')::int then raise exception 'Replay duplicated enrichment'; end if;
  perform internal.fixture_expect_failure(replace(statement,quote_literal('Ella'),quote_literal('Tiffany')),'jiaowubao_trial_sync_idempotency_conflict');
  update internal.jiaowubao_open_api_schedule_snapshot_current set revision='sha256:'||repeat('d',64);
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set revision='sha256:'||repeat('d',64);
  delete from internal.jiaowubao_open_api_schedule_snapshot_ingest_items;
  revocation_intent:=jsonb_build_object('snapshotRevision','sha256:'||repeat('d',64),'window',jsonb_build_object('startsAt',seed#>>'{link,startsAt}','endsAt',seed#>>'{link,endsAt}'),'matches','[]'::jsonb,
    'revocations',jsonb_build_array(jsonb_build_object('lpItemId','LP-1','eventId','jwb-open-api:schedule:1','startsAt',seed#>>'{link,startsAt}')),'expectedVersions','{"lpItems":2,"tasks":1}'::jsonb);
  select * into receipt from public.sync_jiaowubao_trial_matches_atomic_v3('local-jwb-fixture',extensions.gen_random_uuid()::text,revocation_intent,revocation_intent->>'snapshotRevision','[]'::jsonb,revocation_intent->'revocations',revocation_intent->'expectedVersions',jsonb_build_array(next_lp-'trialSchedule'),seed->'tasks','Ella');
  if not receipt.applied or (receipt.lp_items_row).payload<>jsonb_build_array(next_lp-'trialSchedule') or (receipt.tasks_row).payload<>seed->'tasks' then raise exception 'Source revocation lost enrichment or completed history'; end if;
end;
$$;
rollback;
