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
  begin
    raw_variant:=source_record||jsonb_build_object('dated','  '||(source_record->>'dated')||'  ','time_start',' 09:00 ','time_end',' 10:00 ');
    update internal.jiaowubao_open_api_schedule_snapshot_ingest_items set item=jsonb_build_object('record',raw_variant);
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(next_lp),seed->'tasks') into receipt;
    if (receipt.lp_items_row).payload<>jsonb_build_array(next_lp) then raise exception 'Padded source date or times diverged from snapshot reader'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  begin
    select jsonb_set(source_record,'{stu_list}',jsonb_agg(source_record#>'{stu_list,0}')) into raw_variant from generate_series(1,150);
    update internal.jiaowubao_open_api_schedule_snapshot_ingest_items set item=jsonb_build_object('record',raw_variant);
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(next_lp),seed->'tasks') into receipt;
    if (receipt.lp_items_row).payload<>jsonb_build_array(next_lp) then raise exception 'Repeated raw participants were counted before reader deduplication'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  begin
    select jsonb_set(source_record,'{stu_list}',jsonb_agg(jsonb_build_object('mem_id',value::text,'name',case when value=1 then '试听学员A' else 'Synthetic Member '||value end))) into raw_variant from generate_series(1,100) value;
    update internal.jiaowubao_open_api_schedule_snapshot_ingest_items set item=jsonb_build_object('record',raw_variant);
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(next_lp),seed->'tasks') into receipt;
    if (receipt.lp_items_row).payload<>jsonb_build_array(next_lp) then raise exception 'Exactly100 distinct source participants were rejected'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  begin
    select jsonb_set(source_record,'{stu_list}',jsonb_agg(jsonb_build_object('mem_id',value::text,'name',case when value=1 then '试听学员A' else 'Synthetic Member '||value end))) into raw_variant from generate_series(1,101) value;
    update internal.jiaowubao_open_api_schedule_snapshot_ingest_items set item=jsonb_build_object('record',raw_variant);
    perform internal.fixture_expect_failure(internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(next_lp),seed->'tasks'),'trial_handover_source_projection_invalid');
    if (select payload from public.ops_state where entity='lpItems')<>jsonb_build_array(lp) then raise exception 'Truncated participant rejection changed LP state'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
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
create function pg_temp.restore_reminder(p_rule text,p_link jsonb,p_request text)
returns jsonb language plpgsql as $$
declare due_at timestamptz; due_local timestamp; heading text; lead_days integer;
begin
  lead_days := ((p_link->>'startsAt')::timestamptz at time zone 'Australia/Melbourne')::date
    - (p_request::timestamptz at time zone 'Australia/Melbourne')::date;
  if p_rule='trial.jiaowubao.lp-finalize-tomorrow-n3' then
    due_at := ((((p_link->>'startsAt')::timestamptz at time zone 'Australia/Melbourne')::date-3)+time '18:00') at time zone 'Australia/Melbourne';
    heading := '《教务+教统》【明日LP定稿】';
  else
    due_at := case when lead_days between 0 and 2 then least((p_link->>'startsAt')::timestamptz,
      ((p_request::timestamptz at time zone 'Australia/Melbourne')::date+time '18:00') at time zone 'Australia/Melbourne')
      else ((((p_link->>'startsAt')::timestamptz at time zone 'Australia/Melbourne')::date-2)+time '18:00') at time zone 'Australia/Melbourne' end;
    heading := '《教务+教统》【今日LP定稿】';
  end if;
  due_local := due_at at time zone 'Asia/Shanghai';
  return jsonb_build_object('id',case when p_rule='trial.jiaowubao.lp-finalize-tomorrow-n3' then 'RESTORE-N3' else 'RESTORE-N2' end,
    'studentId','S-1','title',heading||'<'||(p_link->>'studentName')||'> <'||(p_link->>'teacherName')||'>',
    'owner','Ella','assignees','["Ella","Ops Admin"]'::jsonb,'watchers','["Ops Admin"]'::jsonb,'category','LP',
    'ruleKey',p_rule,'anchorBookingId','JWB:jwb-open-api:schedule:1','requestAnchorBookingId','LP-1','status','upcoming','tone','blue',
    'dueAt',to_char(due_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'due',extract(year from due_local)::integer||'年'||extract(month from due_local)::integer||'月'||extract(day from due_local)::integer||'日 '||to_char(due_local,'HH24:MI'),
    'completionNote','保留手写跟进备注','completionNoteUpdatedAt','2026-10-20T00:00:00.000Z');
end $$;

do $$
declare
  seed jsonb; lp jsonb; linked jsonb; link jsonb; old_source jsonb; request_at text;
  initial_tasks jsonb; closed_tasks jsonb; restored_tasks jsonb; attempted jsonb; reference jsonb; intent jsonb; versions jsonb;
  n3 jsonb; n2 jsonb; variant jsonb; before_state jsonb; before_counts jsonb; first_audit uuid;
  record_value jsonb; receipt record; statement text; key text;
  target_day date; source_revision text := 'sha256:'||repeat('e',64);
begin
  delete from public.ops_state;
  delete from internal.jiaowubao_open_api_schedule_snapshot_ingest_items;
  delete from internal.jiaowubao_open_api_schedule_snapshot_current;
  delete from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs;
  seed := internal.fixture_trial_handover_seed();
  select item->'record' into old_source from internal.jiaowubao_open_api_schedule_snapshot_ingest_items;
  request_at := to_char(((seed#>>'{link,startsAt}')::timestamptz-interval '4 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  lp := jsonb_set(seed->'lp','{trialIntake,requestSentAt}',to_jsonb(request_at));
  lp := jsonb_set(lp,'{fields,writingRequired}','true');
  initial_tasks := (seed->'tasks') || jsonb_build_array(
    pg_temp.restore_reminder('trial.jiaowubao.lp-materials-n2',seed->'link',request_at) || '{"id":"HUMAN-CURRENT","status":"done","tone":"green","completionOutcome":"done","result":"人工确认完成","closedAt":"2026-10-20T00:00:00.000Z"}'::jsonb,
    pg_temp.restore_reminder('trial.jiaowubao.lp-materials-n2',seed->'link',request_at) || '{"id":"REVIEW-CURRENT","ruleKey":"trial.jiaowubao.request-follow-up-n3","status":"done","tone":"green","completionOutcome":"done","result":"二要一发所需动作均已完成","closedAt":"2026-10-20T00:00:00.000Z","trialRequestFollowUpRules":["trial.manual-request.writing"]}'::jsonb);
  update public.ops_state set payload=jsonb_build_array(lp) where entity='lpItems';
  update public.ops_state set payload=initial_tasks where entity='tasks';
  linked := internal.trial_handover_enriched_lp(lp,old_source,jsonb_build_array(seed->'student'),60) || jsonb_build_object('trialSchedule',seed->'link');
  n3 := pg_temp.restore_reminder('trial.jiaowubao.lp-finalize-tomorrow-n3',seed->'link',request_at);
  n2 := pg_temp.restore_reminder('trial.jiaowubao.lp-materials-n2',seed->'link',request_at);
  execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(linked),initial_tasks||jsonb_build_array(n3,n2)) into receipt;
  if not receipt.applied or (receipt.lp_items_row).version<>2 or (receipt.tasks_row).version<>2 then raise exception 'Initial real v3 matching did not apply'; end if;
  select * into receipt from public.mutate_trial_ledger_field_atomic('local-jwb-fixture',extensions.gen_random_uuid()::text,
    '{"lpItemId":"LP-1","field":"lpFinalized","expectedValue":null,"value":true}','LP-1','lpFinalized','null','true','Ella');
  linked := (receipt.lp_items_row).payload->0;
  select payload into closed_tasks from public.ops_state where entity='tasks';
  if (select count(*) from jsonb_array_elements(closed_tasks) where value->>'result'='试听台账已确认LP定稿')<>2 then raise exception 'LP finalization did not close exactly automatic tasks'; end if;
  update internal.jiaowubao_open_api_schedule_snapshot_current set revision=source_revision;
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set revision=source_revision;
  delete from internal.jiaowubao_open_api_schedule_snapshot_ingest_items;
  reference := jsonb_build_array(jsonb_build_object('lpItemId','LP-1','eventId',seed#>>'{link,eventId}','startsAt',seed#>>'{link,startsAt}'));
  intent := jsonb_build_object('snapshotRevision',source_revision,'window',jsonb_build_object('startsAt',seed#>>'{link,startsAt}','endsAt',seed#>>'{link,endsAt}'),
    'matches','[]'::jsonb,'revocations',reference,'expectedVersions','{"lpItems":3,"tasks":3}'::jsonb);
  select * into receipt from public.sync_jiaowubao_trial_matches_atomic_v3('local-jwb-fixture',extensions.gen_random_uuid()::text,intent,source_revision,
    '[]',reference,intent->'expectedVersions',jsonb_build_array(linked-'trialSchedule'),closed_tasks,'Ella');
  if not receipt.applied or (receipt.lp_items_row).payload->0 ? 'trialSchedule'
    or (receipt.tasks_row).payload<>closed_tasks then raise exception 'Future source revocation changed closed history'; end if;
  select * into receipt from public.mutate_trial_ledger_field_atomic('local-jwb-fixture',extensions.gen_random_uuid()::text,
    '{"lpItemId":"LP-1","field":"lpFinalized","expectedValue":true,"value":false}','LP-1','lpFinalized','true','false','Ella');
  lp := (receipt.lp_items_row).payload->0;
  if (select payload from public.ops_state where entity='tasks')<>closed_tasks then raise exception 'Missing-link uncheck unexpectedly reopened history'; end if;
  versions := jsonb_build_object('lpItems',(receipt.lp_items_row).version,'tasks',(select version from public.ops_state where entity='tasks'));
  target_day := (seed->>'sourceDay')::date+1;
  source_revision := 'sha256:'||repeat('f',64);
  update internal.jiaowubao_open_api_schedule_snapshot_current set revision=source_revision;
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set revision=source_revision,
    query=jsonb_build_object('start',seed->>'sourceDay','end',target_day::text);
  record_value := old_source || jsonb_build_object('dated',target_day::text,'teacher_title','Synthetic Restored Teacher');
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items values((seed->>'runId')::uuid,seed#>>'{link,eventId}',jsonb_build_object('record',record_value));
  link := seed->'link' || jsonb_build_object('sourceRevision',source_revision,'teacherName','Synthetic Restored Teacher',
    'startsAt',to_char(((target_day+time '09:00') at time zone 'Australia/Melbourne') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt',to_char(((target_day+time '10:00') at time zone 'Australia/Melbourne') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  linked := lp || jsonb_build_object('trialSchedule',link);
  n3 := pg_temp.restore_reminder('trial.jiaowubao.lp-finalize-tomorrow-n3',link,request_at);
  n2 := pg_temp.restore_reminder('trial.jiaowubao.lp-materials-n2',link,request_at);
  restored_tasks := initial_tasks || jsonb_build_array(n3,n2);
  key := extensions.gen_random_uuid()::text;
  statement := internal.fixture_trial_handover_call(key,jsonb_build_array(linked),restored_tasks,versions);
  select jsonb_agg(to_jsonb(s) order by entity) into before_state from public.ops_state s;
  before_counts := jsonb_build_object('audits',(select count(*) from internal.operational_contract_audit),'logs',(select count(*) from public.ops_mutation_log),'commands',(select count(*) from internal.jiaowubao_trial_sync_commands));
  for variant in select value from jsonb_array_elements(jsonb_build_array(
    n3 || '{"title":"Forged title"}'::jsonb,
    n3 || '{"dueAt":"2026-10-20T00:00:00.000Z"}'::jsonb,
    n3 || '{"due":"Forged date"}'::jsonb,
    n3 || '{"owner":"Tiffany","assignees":["Tiffany","Ops Admin"]}'::jsonb,
    n3 || '{"completionNote":"Forged note"}'::jsonb,
    n3 || '{"completionNoteUpdatedAt":"2026-10-21T00:00:00.000Z"}'::jsonb,
    n3 || '{"anchorBookingId":"JWB:other-event"}'::jsonb,
    n3 || '{"requestAnchorBookingId":"OTHER-LP"}'::jsonb,
    n3 || '{"studentId":"OTHER-STUDENT"}'::jsonb
  )) loop
    attempted := initial_tasks || jsonb_build_array(variant,n2);
    perform internal.fixture_expect_failure(internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(linked),attempted,versions),'jiaowubao_trial_');
  end loop;
  for variant in select value from jsonb_array_elements(jsonb_build_array(
    '{"result":"人工确认完成"}'::jsonb,'{"completionOutcome":"cannot_do"}'::jsonb,
    '{"legacyEvidence":null}'::jsonb,'{"closedAt":"invalid"}'::jsonb
  )) loop
    begin
      update public.ops_state set payload=jsonb_set(payload,'{4}',(payload->4)||variant) where entity='tasks';
      perform internal.fixture_expect_failure(statement,'jiaowubao_trial_completed_history_changed');
      raise exception using errcode='P0042',message='fixture_rollback';
    exception when sqlstate 'P0042' then null; end;
  end loop;
  begin
    insert into internal.legacy_task_deadline_freezes values('RESTORE-N3');
    perform internal.fixture_expect_failure(statement,'jiaowubao_trial_completed_history_changed');
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  attempted := jsonb_set(restored_tasks,'{2}',(restored_tasks->2)-'closedAt'-'result'-'completionOutcome'||'{"status":"upcoming","tone":"blue"}'::jsonb);
  perform internal.fixture_expect_failure(internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(linked),attempted,versions),'jiaowubao_trial_completed_history_changed');
  attempted := jsonb_set(restored_tasks,'{3}',(restored_tasks->3)-'closedAt'-'result'-'completionOutcome'||'{"status":"upcoming","tone":"blue"}'::jsonb);
  perform internal.fixture_expect_failure(internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(linked),attempted,versions),'jiaowubao_trial_completed_history_changed');
  attempted := (restored_tasks-0);
  perform internal.fixture_expect_failure(internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(linked),attempted,versions),'jiaowubao_trial_completed_history_changed');
  begin
    update public.ops_state set payload=jsonb_build_array(lp||'{"trialLpFinalized":true}'::jsonb) where entity='lpItems';
    perform internal.fixture_expect_failure(internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(linked||'{"trialLpFinalized":true}'::jsonb),restored_tasks,versions),'jiaowubao_trial_completed_history_changed');
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  if (select jsonb_agg(to_jsonb(s) order by entity) from public.ops_state s)<>before_state
    or (select count(*) from internal.operational_contract_audit)<>(before_counts->>'audits')::integer
    or (select count(*) from public.ops_mutation_log)<>(before_counts->>'logs')::integer
    or (select count(*) from internal.jiaowubao_trial_sync_commands)<>(before_counts->>'commands')::integer then raise exception 'Rejected restoration changed state'; end if;
  reference := jsonb_build_array(jsonb_build_object('lpItemId','LP-1','eventId',link->>'eventId','startsAt',link->>'startsAt'));
  for variant in select value from jsonb_array_elements('[{"stage":"完成"},{"resultStatus":"已取消"},{"resultStatus":"被家长取消"},{"trialLpFinalized":true}]') loop
    if internal.trial_lp_auto_reminder_reopen_valid(closed_tasks->4,n3,reference,jsonb_build_array(lp||variant),jsonb_build_array(linked||variant)) then
      raise exception 'Terminal or finalized LP allowed automatic restoration';
    end if;
  end loop;
  execute statement into receipt;
  if not receipt.applied or (receipt.tasks_row).payload<>restored_tasks or (receipt.lp_items_row).payload<>jsonb_build_array(linked)
    or (receipt.tasks_row).version<>(versions->>'tasks')::integer+1 then raise exception 'Restored changed source did not reopen exactly automatic reminders'; end if;
  first_audit := receipt.audit_entry_id;
  execute statement into receipt;
  if receipt.applied or receipt.audit_entry_id<>first_audit then raise exception 'Restoration replay duplicated writes'; end if;
  begin
    request_at := to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    target_day := (now() at time zone 'Australia/Melbourne')::date+1;
    source_revision := 'sha256:'||repeat('b',64);
    lp := jsonb_set(lp,'{trialIntake,requestSentAt}',to_jsonb(request_at));
    link := link || jsonb_build_object('sourceRevision',source_revision,
      'startsAt',to_char(((target_day+time '09:00') at time zone 'Australia/Melbourne') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'endsAt',to_char(((target_day+time '10:00') at time zone 'Australia/Melbourne') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    linked := lp || jsonb_build_object('trialSchedule',link);
    update public.ops_state set payload=jsonb_build_array(lp) where entity='lpItems';
    update public.ops_state set payload=closed_tasks where entity='tasks';
    update internal.jiaowubao_open_api_schedule_snapshot_current set revision=source_revision;
    update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set revision=source_revision,
      query=jsonb_build_object('start',(now() at time zone 'Australia/Melbourne')::date::text,'end',target_day::text);
    update internal.jiaowubao_open_api_schedule_snapshot_ingest_items set item=jsonb_build_object('record',record_value||jsonb_build_object('dated',target_day::text));
    select jsonb_object_agg(entity,version) into versions from public.ops_state where entity in ('lpItems','tasks');
    n3 := pg_temp.restore_reminder('trial.jiaowubao.lp-finalize-tomorrow-n3',link,request_at);
    n2 := pg_temp.restore_reminder('trial.jiaowubao.lp-materials-n2',link,request_at);
    perform internal.fixture_expect_failure(internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(linked),initial_tasks||jsonb_build_array(n3,n2),versions),'jiaowubao_trial_completed_history_changed');
    attempted := initial_tasks||jsonb_build_array(closed_tasks->4,n2);
    execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(linked),attempted,versions) into receipt;
    if not receipt.applied or (receipt.tasks_row).payload<>attempted then raise exception 'Short-notice N2 restoration or N3 history preservation failed'; end if;
    raise exception using errcode='P0042',message='fixture_rollback';
  exception when sqlstate 'P0042' then null; end;
  if has_function_privilege('anon','internal.trial_lp_auto_reminder_reopen_valid(jsonb,jsonb,jsonb,jsonb,jsonb)','execute')
    or has_function_privilege('authenticated','internal.trial_lp_auto_reminder_reopen_valid(jsonb,jsonb,jsonb,jsonb,jsonb)','execute') then raise exception 'Restoration helper was exposed'; end if;
end $$;

do $$
declare
  seed jsonb; lp jsonb; linked jsonb; link jsonb; source_record jsonb; request_at text;
  initial_tasks jsonb; closed_tasks jsonb; n3 jsonb; n2 jsonb; expected jsonb; actual jsonb; history jsonb;
  versions jsonb; receipt record; statement text; command_id text := extensions.gen_random_uuid()::text;
  source_day date; source_revision text := 'sha256:'||repeat('c',64);
begin
  delete from public.ops_state;
  delete from internal.jiaowubao_open_api_schedule_snapshot_ingest_items;
  delete from internal.jiaowubao_open_api_schedule_snapshot_current;
  delete from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs;
  seed := internal.fixture_trial_handover_seed();
  select item->'record' into source_record from internal.jiaowubao_open_api_schedule_snapshot_ingest_items;
  request_at := to_char(((seed#>>'{link,startsAt}')::timestamptz-interval '4 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  lp := jsonb_set(seed->'lp','{trialIntake,requestSentAt}',to_jsonb(request_at));
  n3 := pg_temp.restore_reminder('trial.jiaowubao.lp-finalize-tomorrow-n3',seed->'link',request_at);
  n2 := pg_temp.restore_reminder('trial.jiaowubao.lp-materials-n2',seed->'link',request_at);
  initial_tasks := (seed->'tasks') || jsonb_build_array(
    n2 || '{"id":"CURRENT-MANUAL","status":"done","tone":"green","completionOutcome":"done","result":"人工确认完成","closedAt":"2026-10-20T00:00:00.000Z"}'::jsonb,
    n2 || '{"id":"CURRENT-CANNOT","status":"done","tone":"green","completionOutcome":"cannot_do","result":"无法完成","closedAt":"2026-10-20T00:00:00.000Z"}'::jsonb,
    n3 || '{"id":"CURRENT-FROZEN","status":"done","tone":"green","completionOutcome":"done","result":"试听台账已确认LP定稿","closedAt":"2026-10-20T00:00:00.000Z","legacyEvidence":{"state":"frozen"}}'::jsonb);
  insert into internal.legacy_task_deadline_freezes values('CURRENT-FROZEN');
  update public.ops_state set payload=jsonb_build_array(lp) where entity='lpItems';
  update public.ops_state set payload=initial_tasks where entity='tasks';
  linked := internal.trial_handover_enriched_lp(lp,source_record,jsonb_build_array(seed->'student'),60) || jsonb_build_object('trialSchedule',seed->'link');
  execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(linked),initial_tasks||jsonb_build_array(n3,n2)) into receipt;
  select * into receipt from public.mutate_trial_ledger_field_atomic('local-jwb-fixture',extensions.gen_random_uuid()::text,
    '{"lpItemId":"LP-1","field":"lpFinalized","expectedValue":null,"value":true}','LP-1','lpFinalized','null','true','Ella');
  lp := (receipt.lp_items_row).payload->0;
  select payload into closed_tasks from public.ops_state where entity='tasks';
  source_day := (seed->>'sourceDay')::date+1;
  update internal.jiaowubao_open_api_schedule_snapshot_current set revision=source_revision;
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set revision=source_revision,
    query=jsonb_build_object('start',seed->>'sourceDay','end',source_day::text);
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_items set item=jsonb_build_object('record',source_record||jsonb_build_object('dated',source_day::text,'teacher_title','Synthetic Current Teacher'));
  update public.ops_state set payload=jsonb_set(payload,'{0,owner}','"Erin"'),version=version+1 where entity='students';
  link := seed->'link'||jsonb_build_object('sourceRevision',source_revision,'teacherName','Synthetic Current Teacher',
    'startsAt',to_char(((source_day+time '09:00') at time zone 'Australia/Melbourne') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt',to_char(((source_day+time '10:00') at time zone 'Australia/Melbourne') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  linked := lp||jsonb_build_object('trialSchedule',link);
  versions := '{"lpItems":3,"tasks":3}';
  execute internal.fixture_trial_handover_call(extensions.gen_random_uuid()::text,jsonb_build_array(linked),closed_tasks,versions) into receipt;
  if not receipt.applied or (receipt.tasks_row).payload<>closed_tasks or (receipt.tasks_row).version<>3
    or (receipt.lp_items_row).version<>4 then raise exception 'Finalized sync changed task completion history'; end if;
  select * into receipt from public.mutate_trial_ledger_field_atomic('local-jwb-fixture',command_id,
    '{"lpItemId":"LP-1","field":"lpFinalized","expectedValue":true,"value":false}','LP-1','lpFinalized','true','false','Erin');
  for expected in select value from jsonb_array_elements(jsonb_build_array(
    pg_temp.restore_reminder('trial.jiaowubao.lp-finalize-tomorrow-n3',link,request_at),
    pg_temp.restore_reminder('trial.jiaowubao.lp-materials-n2',link,request_at))) loop
    select value into actual from jsonb_array_elements((select payload from public.ops_state where entity='tasks')) where value->>'id'=expected->>'id';
    if actual->>'status'='done' or actual->>'dueAt'<>expected->>'dueAt' or actual->>'due'<>expected->>'due'
      or actual->>'title'<>expected->>'title' or actual->>'owner'<>'Erin' or actual->'assignees'<>'["Erin","Ops Admin"]'::jsonb
      or actual->>'completionNote'<>expected->>'completionNote' or actual->>'completionNoteUpdatedAt'<>expected->>'completionNoteUpdatedAt'
      or actual ?| array['result','closedAt','completionOutcome'] then raise exception 'LP uncheck reopened stale source metadata'; end if;
  end loop;
  for history in select value from jsonb_array_elements(initial_tasks) loop
    if not exists(select 1 from jsonb_array_elements((select payload from public.ops_state where entity='tasks')) where value=history) then raise exception 'LP uncheck rewrote protected completion history'; end if;
  end loop;
  if (receipt.lp_items_row).payload->0#>>'{trialIntake,requestSentAt}'<>request_at or (select version from public.ops_state where entity='tasks')<>4 then raise exception 'LP uncheck reset request clock or missed atomic task update'; end if;
  select * into receipt from public.mutate_trial_ledger_field_atomic('local-jwb-fixture',command_id,
    '{"lpItemId":"LP-1","field":"lpFinalized","expectedValue":true,"value":false}','LP-1','lpFinalized','true','false','Erin');
  if receipt.applied or (select version from public.ops_state where entity='tasks')<>4 then raise exception 'LP uncheck replay changed tasks twice'; end if;
  if has_function_privilege('anon','internal.trial_lp_reminder_source_fields(jsonb,text)','execute')
    or has_function_privilege('authenticated','internal.trial_lp_reminder_source_fields(jsonb,text)','execute') then raise exception 'Current-source reminder helper was exposed'; end if;
end $$;

rollback;
