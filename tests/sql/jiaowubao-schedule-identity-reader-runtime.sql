\ir assert-disposable-database.sql
begin;

insert into internal.jiaowubao_open_api_schedule_snapshot_current(
  api_source_key, run_id, revision, row_count
) values (
  'jwb-open-api-schedule',
  '10000000-0000-4000-8000-000000000001',
  'sha256:' || repeat('a', 64),
  2
);

insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items(
  run_id, source_key, item
) values
  (
    '10000000-0000-4000-8000-000000000001',
    'jwb-open-api:schedule:A-upper',
    '{"sourceKey":"jwb-open-api:schedule:A-upper","record":{"cal_id":"A-upper","dated":"2026-09-22"}}'
  ),
  (
    '10000000-0000-4000-8000-000000000001',
    'jwb-open-api:schedule:a-lower',
    '{"sourceKey":"jwb-open-api:schedule:a-lower","record":{"cal_id":"a-lower","dated":17}}'
  );

do $fixture$
declare
  page jsonb;
begin
  page := public.get_jiaowubao_open_api_schedule_snapshot_identity_page(
    'identity-reader-fixture-secret', 'jwb-open-api-schedule',
    'sha256:' || repeat('a', 64), 1, null
  );
  if page ->> 'state' <> 'complete'
     or (page ->> 'rowCount')::integer <> 2
     or not (page ->> 'hasMore')::boolean
     or page ->> 'nextCursor' <> 'jwb-open-api:schedule:A-upper'
     or page -> 'items' -> 0 ->> 'sourceDate' <> '2026-09-22' then
    raise exception 'jiaowubao_identity_reader_first_page_invalid';
  end if;

  page := public.get_jiaowubao_open_api_schedule_snapshot_identity_page(
    'identity-reader-fixture-secret', 'jwb-open-api-schedule',
    'sha256:' || repeat('a', 64), 1, 'jwb-open-api:schedule:A-upper'
  );
  if page ->> 'state' <> 'complete'
     or (page ->> 'hasMore')::boolean
     or page -> 'nextCursor' <> 'null'::jsonb
     or page -> 'items' -> 0 ->> 'sourceKey' <> 'jwb-open-api:schedule:a-lower'
     or page -> 'items' -> 0 -> 'sourceDate' <> 'null'::jsonb then
    raise exception 'jiaowubao_identity_reader_second_page_invalid';
  end if;

  page := public.get_jiaowubao_open_api_schedule_snapshot_identity_page(
    'identity-reader-fixture-secret', 'jwb-open-api-schedule',
    'sha256:' || repeat('b', 64), 500, null
  );
  if page ->> 'state' <> 'reset'
     or page ->> 'revision' <> 'sha256:' || repeat('a', 64) then
    raise exception 'jiaowubao_identity_reader_reset_invalid';
  end if;

  begin
    perform public.get_jiaowubao_open_api_schedule_snapshot_identity_page(
      'wrong-secret', 'jwb-open-api-schedule',
      'sha256:' || repeat('a', 64), 500, null
    );
    raise exception 'jiaowubao_identity_reader_accepted_wrong_secret';
  exception when sqlstate '42501' then
    null;
  end;
end;
$fixture$;

rollback;
