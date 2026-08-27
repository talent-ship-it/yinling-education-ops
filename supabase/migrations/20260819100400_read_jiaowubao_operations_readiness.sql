-- Curated, admin-only operational readiness for the latest completed
-- Jiaowubao direct import. This is an evidence reader only: it never creates
-- a booking, task, package, operation, classroom, or source mutation.
--
-- The public function remains secret-gated and is intended solely for the
-- server-owned Next.js route. It intentionally exposes no raw workbook
-- payload, source coordinate/key, student source name, evidence name, or
-- phone. A teacher source label is included only because an authorized admin
-- needs it to resolve a teacher mapping; it is never exposed to other roles.

set local lock_timeout = '1s';

create or replace function public.get_jiaowubao_direct_operations_readiness(
  p_secret text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_schedule_limit integer default 120,
  p_leave_makeup_limit integer default 120,
  p_renewal_limit integer default 160
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $get_jiaowubao_direct_operations_readiness$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  schedule_summary jsonb := '{}'::jsonb;
  schedule_rows jsonb := '[]'::jsonb;
  schedule_truncated boolean := false;
  leave_makeup_summary jsonb := '{}'::jsonb;
  leave_makeup_rows jsonb := '[]'::jsonb;
  leave_makeup_truncated boolean := false;
  renewal_summary jsonb := '{}'::jsonb;
  renewal_rows jsonb := '[]'::jsonb;
  renewal_truncated boolean := false;
  invalid_time_count integer := 0;
  window_start_text text;
  window_end_text text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_window_start is null or p_window_end is null
     or not isfinite(p_window_start) or not isfinite(p_window_end)
     or p_window_end <= p_window_start
     or p_window_end - p_window_start > interval '63 days'
     or p_schedule_limit is null or p_schedule_limit not between 1 and 250
     or p_leave_makeup_limit is null or p_leave_makeup_limit not between 1 and 250
     or p_renewal_limit is null or p_renewal_limit not between 1 and 250 then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_direct_operations_readiness';
  end if;

  -- Keep every API instant in the same canonical UTC form expected by the
  -- browser parser. Do not leak PostgreSQL's display-format variations.
  window_start_text := to_char(p_window_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  window_end_text := to_char(p_window_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.state = 'complete'
  order by run_state.completed_at desc, run_state.id desc
  limit 1;

  if saved_run.id is null then
    return jsonb_build_object(
      'state', 'absent',
      'runToken', null,
      'window', jsonb_build_object('startsAt', window_start_text, 'endsAt', window_end_text),
      'schedule', jsonb_build_object(
        'summary', jsonb_build_object(
          'windowEvents', 0,
          'needsTeacherMapping', 0,
          'needsCourseMapping', 0,
          'readyForAvaReview', 0,
          'invalidTime', 0
        ),
        'rows', '[]'::jsonb,
        'truncated', false
      ),
      'leaveMakeups', jsonb_build_object(
        'summary', jsonb_build_object('attached', 0, 'leave', 0, 'makeup', 0, 'unknown', 0),
        'rows', '[]'::jsonb,
        'truncated', false
      ),
      'renewalEvidence', jsonb_build_object(
        'summary', jsonb_build_object('candidates', 0, 'withContract', 0, 'withHourBalance', 0),
        'rows', '[]'::jsonb,
        'truncated', false
      )
    );
  end if;

  -- Invalid source times have no trustworthy instant. Count them only by the
  -- requested Melbourne wall-date span and never present them as AVA blocks.
  select count(*)::integer into invalid_time_count
  from internal.jiaowubao_direct_schedule_events schedule_event
  where schedule_event.run_id = saved_run.id
    and schedule_event.time_parse_status = 'invalid_time'
    and schedule_event.source_date >= (p_window_start at time zone 'Australia/Melbourne')::date
    and schedule_event.source_date <= (p_window_end at time zone 'Australia/Melbourne')::date;

  select jsonb_build_object(
    'windowEvents', count(*)::integer,
    'needsTeacherMapping', (count(*) filter (where schedule_event.teacher_resolution <> 'exact_name'))::integer,
    'needsCourseMapping', (count(*) filter (where schedule_event.subject_resolution <> 'exact_name'))::integer,
    'readyForAvaReview', (count(*) filter (
      where schedule_event.teacher_resolution = 'exact_name'
        and schedule_event.availability_effect = 'blocks_teacher_ava'
    ))::integer,
    'invalidTime', invalid_time_count
  ) into schedule_summary
  from internal.jiaowubao_direct_schedule_events schedule_event
  where schedule_event.run_id = saved_run.id
    and schedule_event.time_parse_status = 'parsed'
    and schedule_event.starts_at >= p_window_start
    and schedule_event.starts_at < p_window_end;

  with page_plus_one as materialized (
    select
      schedule_event.id,
      schedule_event.source_date,
      schedule_event.starts_at,
      schedule_event.ends_at,
      schedule_event.course_name,
      schedule_event.teacher_id,
      schedule_event.teacher_display_name,
      schedule_event.teacher_resolution,
      schedule_event.subject_resolution,
      schedule_event.availability_effect
    from internal.jiaowubao_direct_schedule_events schedule_event
    where schedule_event.run_id = saved_run.id
      and schedule_event.time_parse_status = 'parsed'
      and schedule_event.starts_at >= p_window_start
      and schedule_event.starts_at < p_window_end
    order by
      case
        when schedule_event.teacher_resolution <> 'exact_name' then 0
        when schedule_event.subject_resolution <> 'exact_name' then 1
        when schedule_event.availability_effect = 'blocks_teacher_ava' then 2
        else 3
      end,
      schedule_event.starts_at,
      schedule_event.id
    limit p_schedule_limit + 1
  ), page as materialized (
    select * from page_plus_one limit p_schedule_limit
  )
  select
    coalesce(
      jsonb_agg(jsonb_build_object(
        'eventId', page.id::text,
        'sourceDate', page.source_date,
        'startsAt', to_char(page.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'endsAt', to_char(page.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'courseName', page.course_name,
        'teacherId', page.teacher_id,
        'teacherLabel', page.teacher_display_name,
        'teacherResolution', page.teacher_resolution,
        'subjectResolution', page.subject_resolution,
        'availabilityEffect', page.availability_effect,
        'attachedParticipantCount', participant_count.count,
        'needsTeacherMapping', page.teacher_resolution <> 'exact_name',
        'needsCourseMapping', page.subject_resolution <> 'exact_name',
        'readyForAvaReview', page.teacher_resolution = 'exact_name'
          and page.availability_effect = 'blocks_teacher_ava'
      ) order by
        case
          when page.teacher_resolution <> 'exact_name' then 0
          when page.subject_resolution <> 'exact_name' then 1
          when page.availability_effect = 'blocks_teacher_ava' then 2
          else 3
        end,
        page.starts_at,
        page.id),
      '[]'::jsonb
    ),
    (select count(*) > p_schedule_limit from page_plus_one)
  into schedule_rows, schedule_truncated
  from page
  cross join lateral (
    select count(*)::integer as count
    from internal.jiaowubao_direct_schedule_event_participants participant
    where participant.event_id = page.id
      and participant.resolution_state = 'attached'
  ) participant_count;

  select jsonb_build_object(
    'attached', count(*)::integer,
    'leave', (count(*) filter (where incident.incident_kind = 'leave'))::integer,
    'makeup', (count(*) filter (where incident.incident_kind = 'makeup'))::integer,
    'unknown', (count(*) filter (where incident.incident_kind = 'unknown'))::integer
  ) into leave_makeup_summary
  from internal.jiaowubao_direct_leave_makeup_events incident
  where incident.run_id = saved_run.id
    and incident.resolution_state = 'attached';

  with page_plus_one as materialized (
    select
      incident.id,
      incident.student_id,
      incident.incident_kind,
      incident.source_date,
      incident.source_time_text,
      incident.course_name,
      incident.class_name,
      incident.teacher_display_name
    from internal.jiaowubao_direct_leave_makeup_events incident
    where incident.run_id = saved_run.id
      and incident.resolution_state = 'attached'
    order by incident.source_date desc nulls last, incident.id
    limit p_leave_makeup_limit + 1
  ), page as materialized (
    select * from page_plus_one limit p_leave_makeup_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'incidentId', page.id::text,
      'studentId', page.student_id,
      'kind', page.incident_kind,
      'sourceDate', page.source_date,
      'timeText', page.source_time_text,
      'courseName', page.course_name,
      'className', page.class_name,
      'teacherLabel', page.teacher_display_name
    ) order by page.source_date desc nulls last, page.id), '[]'::jsonb),
    (select count(*) > p_leave_makeup_limit from page_plus_one)
  into leave_makeup_rows, leave_makeup_truncated
  from page;

  -- Contract/hour rows remain source evidence. A candidate means only that
  -- attached evidence exists; it is never a guessed renewal threshold or a
  -- generated renewal task. The latest source row is deterministic only,
  -- not a claim that workbook row order is a business timestamp.
  with evidence as materialized (
    select
      supplemental_record.student_id,
      nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,课程}'), '') as course_name,
      supplemental_record.record_kind,
      supplemental_record.source_row,
      coalesce(
        nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,课时数}'), ''),
        nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,总课时数}'), '')
      ) as total_hours,
      nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,已消课时}'), '') as used_hours,
      nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,剩余课时}'), '') as remaining_hours
    from internal.jiaowubao_direct_supplemental_records supplemental_record
    where supplemental_record.run_id = saved_run.id
      and supplemental_record.resolution_state = 'attached'
      and supplemental_record.record_kind in ('contract', 'hour_balance')
  ), contract_evidence as materialized (
    select distinct student_id, course_name
    from evidence
    where record_kind = 'contract'
  ), hour_evidence as materialized (
    select distinct on (student_id, course_name)
      student_id, course_name, total_hours, used_hours, remaining_hours
    from evidence
    where record_kind = 'hour_balance'
    order by student_id, course_name nulls first, source_row desc
  ), candidates as materialized (
    select
      coalesce(contract_evidence.student_id, hour_evidence.student_id) as student_id,
      coalesce(contract_evidence.course_name, hour_evidence.course_name) as course_name,
      contract_evidence.student_id is not null as has_contract_evidence,
      hour_evidence.student_id is not null as has_hour_balance_evidence,
      hour_evidence.total_hours,
      hour_evidence.used_hours,
      hour_evidence.remaining_hours
    from contract_evidence
    full join hour_evidence
      on hour_evidence.student_id = contract_evidence.student_id
      and hour_evidence.course_name is not distinct from contract_evidence.course_name
  )
  select jsonb_build_object(
    'candidates', count(*)::integer,
    'withContract', (count(*) filter (where has_contract_evidence))::integer,
    'withHourBalance', (count(*) filter (where has_hour_balance_evidence))::integer
  ) into renewal_summary
  from candidates;

  with evidence as materialized (
    select
      supplemental_record.student_id,
      nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,课程}'), '') as course_name,
      supplemental_record.record_kind,
      supplemental_record.source_row,
      coalesce(
        nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,课时数}'), ''),
        nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,总课时数}'), '')
      ) as total_hours,
      nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,已消课时}'), '') as used_hours,
      nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,剩余课时}'), '') as remaining_hours
    from internal.jiaowubao_direct_supplemental_records supplemental_record
    where supplemental_record.run_id = saved_run.id
      and supplemental_record.resolution_state = 'attached'
      and supplemental_record.record_kind in ('contract', 'hour_balance')
  ), contract_evidence as materialized (
    select distinct student_id, course_name
    from evidence
    where record_kind = 'contract'
  ), hour_evidence as materialized (
    select distinct on (student_id, course_name)
      student_id, course_name, total_hours, used_hours, remaining_hours
    from evidence
    where record_kind = 'hour_balance'
    order by student_id, course_name nulls first, source_row desc
  ), candidates as materialized (
    select
      coalesce(contract_evidence.student_id, hour_evidence.student_id) as student_id,
      coalesce(contract_evidence.course_name, hour_evidence.course_name) as course_name,
      contract_evidence.student_id is not null as has_contract_evidence,
      hour_evidence.student_id is not null as has_hour_balance_evidence,
      hour_evidence.total_hours,
      hour_evidence.used_hours,
      hour_evidence.remaining_hours
    from contract_evidence
    full join hour_evidence
      on hour_evidence.student_id = contract_evidence.student_id
      and hour_evidence.course_name is not distinct from contract_evidence.course_name
  ), page_plus_one as materialized (
    select *
    from candidates
    order by
      case when has_hour_balance_evidence then 0 else 1 end,
      student_id,
      course_name nulls last
    limit p_renewal_limit + 1
  ), page as materialized (
    select * from page_plus_one limit p_renewal_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'studentId', page.student_id,
      'courseName', page.course_name,
      'hasContractEvidence', page.has_contract_evidence,
      'hasHourBalanceEvidence', page.has_hour_balance_evidence,
      'totalHours', page.total_hours,
      'usedHours', page.used_hours,
      'remainingHours', page.remaining_hours
    ) order by
      case when page.has_hour_balance_evidence then 0 else 1 end,
      page.student_id,
      page.course_name nulls last), '[]'::jsonb),
    (select count(*) > p_renewal_limit from page_plus_one)
  into renewal_rows, renewal_truncated
  from page;

  return jsonb_build_object(
    'state', 'complete',
    'runToken', saved_run.id::text,
    'window', jsonb_build_object('startsAt', window_start_text, 'endsAt', window_end_text),
    'schedule', jsonb_build_object(
      'summary', schedule_summary,
      'rows', schedule_rows,
      'truncated', schedule_truncated
    ),
    'leaveMakeups', jsonb_build_object(
      'summary', leave_makeup_summary,
      'rows', leave_makeup_rows,
      'truncated', leave_makeup_truncated
    ),
    'renewalEvidence', jsonb_build_object(
      'summary', renewal_summary,
      'rows', renewal_rows,
      'truncated', renewal_truncated
    )
  );
end;
$get_jiaowubao_direct_operations_readiness$;

revoke all on function public.get_jiaowubao_direct_operations_readiness(text, timestamptz, timestamptz, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.get_jiaowubao_direct_operations_readiness(text, timestamptz, timestamptz, integer, integer, integer)
  to anon, authenticated;

-- Bounded queue reads select the most recent attached leave/makeup rows by
-- source date. The existing per-student index cannot serve this ordering.
create index if not exists jiaowubao_direct_leave_makeup_readiness_date_idx
  on internal.jiaowubao_direct_leave_makeup_events (run_id, source_date desc nulls last, id)
  where resolution_state = 'attached';

-- Renewal evidence is grouped only from attached contract/hour rows.
create index if not exists jiaowubao_direct_supplemental_readiness_evidence_idx
  on internal.jiaowubao_direct_supplemental_records (run_id, record_kind, student_id, source_row desc)
  where resolution_state = 'attached'
    and record_kind in ('contract', 'hour_balance');
