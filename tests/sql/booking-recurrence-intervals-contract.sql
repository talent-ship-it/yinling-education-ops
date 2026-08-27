\set ON_ERROR_STOP on

-- Run against the normal Supabase migration fixture after the base schema and
-- currently deployed RPCs are loaded. The transaction is deliberately rolled
-- back: this is a repeatable contract fixture, not a deployment script.
begin;
\ir ../../supabase/migrations/20260819101400_support_booking_recurrence_intervals.sql

do $booking_recurrence_fixture$
declare
  legacy jsonb := '{"id":"FIXTURE-LEGACY","date":"2026-09-01","recurring":true}'::jsonb;
  bounded jsonb := '{"id":"FIXTURE-BOUNDED","date":"2026-09-01","recurring":true,"repeatCount":20,"recurrenceIntervalDays":2,"recurrenceEndDate":"2026-09-05"}'::jsonb;
  legacy_bounded jsonb := '{"id":"FIXTURE-LEGACY-BOUNDED","date":"2026-01-01","recurring":true,"recurrenceEndDate":"2028-01-01"}'::jsonb;
begin
  if internal.booking_recurrence_interval_days(legacy) <> 7 then
    raise exception 'booking_recurrence_legacy_interval_fixture_failed';
  end if;
  if internal.booking_recurrence_source_end_date(bounded) <> date '2026-09-05' then
    raise exception 'booking_recurrence_end_bound_fixture_failed';
  end if;
  if internal.booking_recurrence_occurrence_count(legacy_bounded) <> 105 then
    raise exception 'booking_recurrence_occurrence_count_fixture_failed';
  end if;
  begin
    perform internal.assert_jiaowubao_direct_booking_interval_available(
      'FIXTURE-STUDENT',
      'FIXTURE-TEACHER',
      '{"date":"2026-09-01","start":"10:00","timezone":"UTC","duration":60,"recurring":true}'::jsonb
    );
  exception when others then
    raise exception 'jiaowubao_legacy_weekly_fixture_failed';
  end;
  perform internal.assert_jiaowubao_direct_booking_interval_available(
    'FIXTURE-STUDENT',
    'FIXTURE-TEACHER',
    '{"date":"2026-09-01","start":"10:00","timezone":"UTC","duration":60,"recurring":true,"recurrenceIntervalDays":2,"recurrenceEndDate":"2026-09-05"}'::jsonb
  );
  begin
    perform internal.assert_jiaowubao_direct_booking_interval_available(
      'FIXTURE-STUDENT',
      'FIXTURE-TEACHER',
      '{"date":"2026-09-01","start":"10:00","timezone":"UTC","duration":60,"recurring":true,"recurrenceIntervalDays":2}'::jsonb
    );
    raise exception 'jiaowubao_nonweekly_unbounded_fixture_did_not_reject';
  exception when others then
    if sqlerrm not like '%booking_recurrence_repeat_count_required%' then raise; end if;
  end;
  begin
    perform internal.booking_recurrence_source_end_date(
      '{"id":"FIXTURE-INVALID","date":"2026-09-10","recurring":true,"repeatCount":2,"recurrenceEndDate":"2026-09-09"}'::jsonb
    );
    raise exception 'booking_recurrence_invalid_end_fixture_did_not_reject';
  exception when others then
    if sqlerrm not like '%booking_recurrence_end_date_before_start%' then raise; end if;
  end;
end;
$booking_recurrence_fixture$;

rollback;
