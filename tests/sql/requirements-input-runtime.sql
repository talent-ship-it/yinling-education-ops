\set ON_ERROR_STOP on
-- Synthetic local-only assertions; never execute against production.
begin;
do $$
declare b jsonb := '{"id":"REQ-SQL","date":"2099-09-07","start":"10:00","duration":180,"timezone":"Australia/Melbourne","recurring":false}'::jsonb; minutes numeric; request_id uuid := 'dd7a0e55-2222-4444-8888-abcdefabcdef'; caught text;
begin
 foreach minutes in array array[15,40,180,360] loop
  perform internal.assert_jiaowubao_direct_booking_interval_available('SQL-S','SQL-T', b || jsonb_build_object('duration',minutes));
 end loop;
 foreach minutes in array array[0,14,361,40.5] loop
  begin
   perform internal.assert_jiaowubao_direct_booking_interval_available('SQL-S','SQL-T', b || jsonb_build_object('duration',minutes));
   raise exception 'fixture_invalid_duration_accepted';
  exception when others then
   get stacked diagnostics caught = message_text;
   if caught = 'fixture_invalid_duration_accepted' then raise; end if;
  end;
 end loop;
 perform public.submit_teacher_leave_request('booking-projection-fixture-secret',request_id,'SQL-T','Synthetic teacher','2099-09-07','2099-09-08','Synthetic leave reason');
 perform public.submit_teacher_leave_request('booking-projection-fixture-secret',request_id,'SQL-T','Synthetic teacher','2099-09-07','2099-09-08','Synthetic leave reason');
 if (select count(*) from internal.teacher_leave_requests where id=request_id) <> 1 then raise exception 'fixture_duplicate_request'; end if;
 if (select count(*) from public.read_teacher_leave_requests('booking-projection-fixture-secret',array['SQL-OTHER'])) <> 0 then raise exception 'fixture_scope_leak'; end if;
 begin
  perform public.submit_teacher_leave_request('booking-projection-fixture-secret',request_id,'SQL-OTHER','Synthetic teacher','2099-09-07','2099-09-08','Synthetic leave reason');
  raise exception 'fixture_changed_intent_accepted';
 exception when others then
  get stacked diagnostics caught = message_text;
  if caught <> 'request_id_conflict' then raise; end if;
 end;
 begin
  perform public.read_teacher_leave_requests('invalid',array['SQL-T']);
  raise exception 'fixture_invalid_secret_accepted';
 exception when others then
  get stacked diagnostics caught = message_text;
  if caught <> 'unauthorized' then raise; end if;
 end;
 begin
  perform public.read_teacher_leave_requests(null,array['SQL-T']);
  raise exception 'fixture_null_secret_accepted';
 exception when others then
  get stacked diagnostics caught = message_text;
  if caught <> 'unauthorized' then raise; end if;
 end;
end; $$;
rollback;
