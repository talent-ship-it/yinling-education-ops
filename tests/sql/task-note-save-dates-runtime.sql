\set ON_ERROR_STOP on
\ir assert-disposable-database.sql

begin;
do $runtime$
declare
  saved public.ops_state%rowtype;
  before_row public.ops_state%rowtype;
  stamp text;
  next_stamp text;
  started_at timestamptz := clock_timestamp();
  next_payload jsonb;
  projected jsonb;
  previous jsonb;
  incoming jsonb;
  frozen jsonb;
  audit_count bigint;
  booking jsonb := '{"id":"BOOK-NOTE","studentId":"STU-1","teacherId":"TEA-1","date":"2099-01-10","start":"10:00","duration":60,"kind":"试听","status":"待确认","timezone":"Australia/Melbourne","requestedAt":"2099-01-01T00:00:00.000Z"}';
begin
  select * into saved from public.ops_state where entity = 'tasks';
  frozen := saved.payload -> 2;
  if (saved.payload -> 1) ? 'completionNoteUpdatedAt'
     or (frozen ? 'completionNoteUpdatedAt') then raise exception 'legacy_note_date_invented'; end if;
  next_payload := jsonb_set(saved.payload, '{0,completionNote}', '"首次备注"');
  next_payload := jsonb_set(next_payload, '{0,completionNoteUpdatedAt}', '"2000-01-01T00:00:00.000Z"');
  select * into saved from public.put_scoped_ops_state('booking-projection-fixture-secret', 'tasks', next_payload, saved.version, 'Abby');
  stamp := saved.payload #>> '{0,completionNoteUpdatedAt}';
  if not internal.task_due_at_is_canonical(stamp) or stamp::timestamptz < started_at
     or stamp::timestamptz > clock_timestamp() then raise exception 'note_date_not_server_authoritative'; end if;
  if (saved.payload -> 1) ? 'completionNoteUpdatedAt' or saved.payload -> 2 <> frozen then
    raise exception 'unrelated_legacy_note_changed'; end if;
  if (select payload from public.ops_state where entity = 'tasks') <> saved.payload then raise exception 'receipt_not_actual_saved_payload'; end if;
  if not exists(select 1 from internal.operational_contract_audit where metadata ->> 'payloadSha256' = encode(extensions.digest(saved.payload::text, 'sha256'), 'hex')) then
    raise exception 'audit_not_actual_saved_payload'; end if;

  next_payload := jsonb_set(saved.payload, '{0,title}', '"改任务标题"') #- '{0,completionNoteUpdatedAt}';
  select * into saved from public.put_scoped_ops_state('booking-projection-fixture-secret', 'tasks', next_payload, saved.version, 'Abby');
  if saved.payload #>> '{0,completionNoteUpdatedAt}' <> stamp then raise exception 'unchanged_note_date_lost'; end if;
  next_payload := jsonb_set(saved.payload, '{0,completionNoteUpdatedAt}', '"2099-01-01T00:00:00.000Z"');
  select * into saved from public.put_scoped_ops_state('booking-projection-fixture-secret', 'tasks', next_payload, saved.version, 'Abby');
  if saved.payload #>> '{0,completionNoteUpdatedAt}' <> stamp then raise exception 'note_date_forged'; end if;

  perform pg_sleep(0.003);
  next_payload := jsonb_set(saved.payload, '{0,completionNote}', '"修改后的备注"');
  select * into saved from public.put_scoped_ops_state('booking-projection-fixture-secret', 'tasks', next_payload, saved.version, 'Ella');
  next_stamp := saved.payload #>> '{0,completionNoteUpdatedAt}';
  if not internal.task_due_at_is_canonical(next_stamp) or next_stamp::timestamptz <= stamp::timestamptz then raise exception 'changed_note_date_not_advanced'; end if;

  before_row := saved;
  select count(*) into audit_count from internal.operational_contract_audit;
  begin
    perform public.put_scoped_ops_state('booking-projection-fixture-secret', 'tasks', jsonb_set(saved.payload, '{0,completionNote}', '"不得写入"'), saved.version - 1, 'Abby');
    raise exception 'stale_note_write_allowed';
  exception when serialization_failure then null;
  end;
  begin
    perform public.put_scoped_ops_state('booking-projection-fixture-secret', 'tasks', jsonb_set(saved.payload, '{2,completionNote}', '"篡改冻结证据"'), saved.version, 'Abby');
    raise exception 'frozen_note_write_allowed';
  exception when insufficient_privilege then null;
  end;
  if (select payload from public.ops_state where entity = 'tasks') <> before_row.payload
     or (select count(*) from internal.operational_contract_audit) <> audit_count then raise exception 'failed_note_write_not_atomic'; end if;

  next_payload := (saved.payload #- '{0,completionNote}');
  select * into saved from public.put_scoped_ops_state('booking-projection-fixture-secret', 'tasks', next_payload, saved.version, 'Abby');
  if (saved.payload -> 0) ? 'completionNoteUpdatedAt' then raise exception 'cleared_note_date_retained'; end if;
  next_payload := saved.payload || '[{"id":"IMPORTED","status":"done","completionNote":"导入旧备注","completionNoteUpdatedAt":"2000-01-01T00:00:00.000Z"}]';
  select * into saved from public.put_scoped_ops_state('booking-projection-fixture-secret', 'tasks', next_payload, saved.version, 'Abby');
  if (saved.payload -> 3) ? 'completionNoteUpdatedAt' then raise exception 'imported_note_date_invented'; end if;

  previous := '[{"id":"EXAM-NOTE","status":"today","tone":"blue","ruleKey":"exam:E-1:care","anchorBookingId":"exam:E-1","dueAt":"2026-10-15T00:00:00.000Z","completionNote":"考试备注","completionNoteUpdatedAt":"2026-10-15T01:00:00.000Z"},{"id":"EXAM-PLAN","status":"today","tone":"blue","ruleKey":"exam:E-1:planning","anchorBookingId":"exam:E-1","dueAt":"2026-10-15T00:00:00.000Z","completionNote":"规划备注","completionNoteUpdatedAt":"2026-10-15T02:00:00.000Z"}]';
  select jsonb_agg(value - 'completionNote' - 'completionNoteUpdatedAt') into incoming from jsonb_array_elements(previous);
  projected := internal.exam_submission_reconcile_tasks(previous, incoming, 'E-1', '2026-10-15T03:00:00.000Z');
  if projected <> previous then raise exception 'exam_rebuild_note_date_lost: %', projected; end if;

  previous := '[{"id":"BOOK-NOTE-TASK","studentId":"STU-1","status":"today","tone":"blue","ruleKey":"trial.parent-follow-up","anchorBookingId":"BOOK-NOTE","dueAt":"2099-01-01T07:00:00.000Z","completionNote":"排课备注","completionNoteUpdatedAt":"2026-10-15T01:00:00.000Z"}]';
  projected := internal.rebuild_booking_trial_tasks_base_191019(previous, '[]', booking, null, 'create', '2099-01-01T01:00:00.000Z');
  if not exists(select 1 from jsonb_array_elements(projected) task where task ->> 'id' = 'BOOK-NOTE-TASK' and task ->> 'completionNote' = '排课备注' and task ->> 'completionNoteUpdatedAt' = '2026-10-15T01:00:00.000Z') then raise exception 'booking_rebuild_note_date_lost'; end if;

  next_payload := '[{"id":"UNRELATED","completionNote":"other","completionNoteUpdatedAt":"as-is"}]';
  update public.ops_state set payload = next_payload where entity = 'teachers';
  if (select payload from public.ops_state where entity = 'teachers') <> next_payload then raise exception 'non_task_payload_changed'; end if;
  if has_function_privilege('anon', 'internal.stamp_ops_task_note_dates()', 'execute')
     or has_function_privilege('authenticated', 'internal.stamp_ops_task_note_dates()', 'execute')
     or has_function_privilege('service_role', 'internal.stamp_ops_task_note_dates()', 'execute')
     or (select prosecdef from pg_proc where oid = 'internal.stamp_ops_task_note_dates()'::regprocedure) then
    raise exception 'note_date_trigger_permissions_changed'; end if;
  if (select array_agg(tgname::text order by tgname) from pg_trigger where tgrelid = 'public.ops_state'::regclass and not tgisinternal)
      <> array['ops_state_enforce_task_canonical_deadlines', 'ops_state_stamp_task_note_dates'] then raise exception 'note_date_trigger_order_changed'; end if;
end;
$runtime$;
rollback;
select 'task_note_save_dates_runtime_ok' as result;
