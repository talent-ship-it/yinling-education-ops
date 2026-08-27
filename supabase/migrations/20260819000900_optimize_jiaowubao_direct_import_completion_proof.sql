-- Bound the 40k-row completion proof. The original proof expanded every
-- parsed endpoint across 105 hypothetical UTC offsets. Australia/Melbourne
-- has a single transition at a time, so the offsets immediately before and
-- after the direct conversion are the complete candidate set. For the
-- exported 2021-2029 Melbourne calendar, the only alternate transition
-- candidate is exactly one hour either side of the direct conversion. Strict
-- UTC round trips therefore prove the wall clock in constant work.

set local lock_timeout = '1s';

create or replace function internal.jiaowubao_direct_import_assert_unambiguous_schedule_time(
  p_time_parse_status text,
  p_source_date date,
  p_source_timezone text,
  p_source_local_start time,
  p_source_local_end time,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_dst_resolution text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_unambiguous_schedule_time$
declare
  local_start timestamp;
  local_end timestamp;
  direct_start timestamptz;
  direct_end timestamptz;
begin
  if p_time_parse_status <> 'parsed' then
    return;
  end if;
  if p_source_timezone is distinct from 'Australia/Melbourne'
     or p_source_date is null
     or p_source_local_start is null
     or p_source_local_end is null
     or p_starts_at is null
     or p_ends_at is null
     or p_dst_resolution is distinct from 'unambiguous' then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_time_proof_invalid';
  end if;

  local_start := p_source_date + p_source_local_start;
  local_end := p_source_date + p_source_local_end;
  direct_start := local_start at time zone 'Australia/Melbourne';
  direct_end := local_end at time zone 'Australia/Melbourne';

  if direct_start at time zone 'Australia/Melbourne' is distinct from local_start
     or direct_end at time zone 'Australia/Melbourne' is distinct from local_end
     or direct_start is distinct from p_starts_at
     or direct_end is distinct from p_ends_at
     or (direct_start - interval '1 hour') at time zone 'Australia/Melbourne' = local_start
     or (direct_start + interval '1 hour') at time zone 'Australia/Melbourne' = local_start
     or (direct_end - interval '1 hour') at time zone 'Australia/Melbourne' = local_end
     or (direct_end + interval '1 hour') at time zone 'Australia/Melbourne' = local_end
     or p_starts_at >= p_ends_at then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_time_proof_invalid';
  end if;
end;
$jiaowubao_direct_import_assert_unambiguous_schedule_time$;

revoke all on function internal.jiaowubao_direct_import_assert_unambiguous_schedule_time(text, date, text, time, time, timestamptz, timestamptz, text)
  from public, anon, authenticated;

-- Keep the Tencent authority proof set-based while scanning the schedule
-- relation once. Every parsed endpoint receives an O(1) direct/adjacent UTC
-- proof, and teacher/subject checks reuse the same narrow materialization.
create or replace function internal.jiaowubao_direct_import_validate_projection(
  p_run_id uuid,
  p_master_rows jsonb,
  p_students_payload jsonb,
  p_teachers_payload jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_validate_projection$
declare
  violation text;
begin
  if jsonb_typeof(p_master_rows) <> 'array'
     or jsonb_typeof(p_students_payload) <> 'array'
     or jsonb_typeof(p_teachers_payload) <> 'array' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_authority_state_unavailable';
  end if;

  with
  master_rows as materialized (
    select
      internal.student_import_source_key(master_row.value -> 'sourceRow') as source_row,
      internal.student_import_name_key(master_row.value ->> 'name') as name_key,
      btrim(coalesce(master_row.value ->> 'status', '')) as status
    from jsonb_array_elements(p_master_rows) master_row(value)
  ),
  master_by_source as materialized (
    select source_row, count(*)::integer as row_count, min(name_key) as name_key, min(status) as status
    from master_rows
    where nullif(source_row, '') is not null
    group by source_row
  ),
  active_master_names as materialized (
    select name_key, count(*)::integer as row_count
    from master_rows
    where name_key <> '' and status <> '不活跃 + 无课时'
    group by name_key
  ),
  current_students as materialized (
    select
      student_row.value ->> 'id' as student_id,
      internal.student_import_source_key(student_row.value -> 'sourceRow') as source_row,
      internal.student_import_name_key(student_row.value ->> 'name') as name_key,
      count(*)::integer as row_count
    from jsonb_array_elements(p_students_payload) student_row(value)
    where student_row.value ->> 'importSource' = 'master'
      and coalesce(student_row.value ->> 'importArchived', 'false') <> 'true'
      and btrim(coalesce(student_row.value ->> 'status', '')) <> '不活跃 + 无课时'
    group by
      student_row.value ->> 'id',
      internal.student_import_source_key(student_row.value -> 'sourceRow'),
      internal.student_import_name_key(student_row.value ->> 'name')
  ),
  current_teachers as materialized (
    select
      teacher_row.value ->> 'id' as teacher_id,
      internal.student_import_name_key(teacher_row.value ->> 'name') as name_key,
      count(*)::integer as row_count
    from jsonb_array_elements(p_teachers_payload) teacher_row(value)
    group by teacher_row.value ->> 'id', internal.student_import_name_key(teacher_row.value ->> 'name')
  ),
  current_teacher_names as materialized (
    select name_key, sum(row_count)::integer as row_count
    from current_teachers
    where name_key <> ''
    group by name_key
  ),
  attached_records as materialized (
    select
      'supplemental'::text as record_type,
      record.source_key,
      record.student_id,
      record.master_source_row,
      record.evidence_name,
      internal.student_import_name_key(record.evidence_name) as evidence_name_key
    from internal.jiaowubao_direct_supplemental_records record
    where record.run_id = p_run_id and record.resolution_state = 'attached'
    union all
    select
      'schedule_participant'::text,
      schedule_event.source_key || ':' || participant.participant_key,
      participant.student_id,
      participant.master_source_row,
      participant.evidence_name,
      internal.student_import_name_key(participant.evidence_name)
    from internal.jiaowubao_direct_schedule_event_participants participant
    join internal.jiaowubao_direct_schedule_events schedule_event on schedule_event.id = participant.event_id
    where schedule_event.run_id = p_run_id and participant.resolution_state = 'attached'
    union all
    select
      'leave_makeup'::text,
      leave_makeup_event.source_key,
      leave_makeup_event.student_id,
      leave_makeup_event.master_source_row,
      leave_makeup_event.evidence_name,
      internal.student_import_name_key(leave_makeup_event.evidence_name)
    from internal.jiaowubao_direct_leave_makeup_events leave_makeup_event
    where leave_makeup_event.run_id = p_run_id and leave_makeup_event.resolution_state = 'attached'
  ),
  attached_checked as materialized (
    select
      attachment.*,
      coalesce(master_source.row_count, 0) as master_source_count,
      master_source.name_key as master_name_key,
      master_source.status as master_status,
      coalesce(active_name.row_count, 0) as active_name_count,
      coalesce(current_student.row_count, 0) as current_student_count
    from attached_records attachment
    left join master_by_source master_source on master_source.source_row = attachment.master_source_row
    left join active_master_names active_name on active_name.name_key = attachment.evidence_name_key
    left join current_students current_student
      on current_student.student_id = attachment.student_id
     and current_student.source_row = attachment.master_source_row
     and current_student.name_key = attachment.evidence_name_key
  ),
  participant_identity as materialized (
    select
      participant.event_id,
      participant.participant_key,
      participant.student_id,
      participant.master_source_row,
      participant.evidence_name,
      participant.source_display_name,
      participant.source_payload,
      identity_record.id as identity_id,
      identity_record.run_id as identity_run_id,
      identity_record.resolution_state as identity_state,
      identity_record.identity_proof,
      identity_record.evidence_phone,
      identity_record.student_id as identity_student_id,
      identity_record.master_source_row as identity_master_source_row,
      identity_record.evidence_name as identity_evidence_name
    from internal.jiaowubao_direct_schedule_event_participants participant
    join internal.jiaowubao_direct_schedule_events schedule_event on schedule_event.id = participant.event_id
    left join internal.jiaowubao_direct_supplemental_records identity_record
      on identity_record.id = participant.identity_supplemental_record_id
    where schedule_event.run_id = p_run_id and participant.resolution_state = 'attached'
  ),
  schedule_checked as materialized (
    select
      schedule_event.id,
      schedule_event.source_date,
      schedule_event.source_timezone,
      schedule_event.source_local_start,
      schedule_event.source_local_end,
      schedule_event.starts_at,
      schedule_event.ends_at,
      schedule_event.dst_resolution,
      schedule_event.time_parse_status,
      wall_clock.local_start,
      wall_clock.local_end,
      direct_candidate.direct_start,
      direct_candidate.direct_end,
      schedule_event.teacher_resolution,
      schedule_event.teacher_id,
      schedule_event.teacher_display_name,
      schedule_event.subject_resolution,
      schedule_event.subject_id,
      case when schedule_event.teacher_resolution = 'exact_name'
        then schedule_event.source_payload #>> '{source,teacher}'
      end as source_teacher_name
    from internal.jiaowubao_direct_schedule_events schedule_event
    cross join lateral (
      values (
        schedule_event.source_date + schedule_event.source_local_start,
        schedule_event.source_date + schedule_event.source_local_end
      )
    ) wall_clock(local_start, local_end)
    cross join lateral (
      values (
        wall_clock.local_start at time zone 'Australia/Melbourne',
        wall_clock.local_end at time zone 'Australia/Melbourne'
      )
    ) direct_candidate(direct_start, direct_end)
    where schedule_event.run_id = p_run_id
  ),
  exact_teacher_evidence as materialized (
    select distinct
      schedule_event.teacher_id,
      schedule_event.teacher_display_name,
      schedule_event.source_teacher_name
    from schedule_checked schedule_event
    where schedule_event.teacher_resolution = 'exact_name'
  ),
  exact_teacher_checked as materialized (
    select
      teacher_evidence.*,
      normalized_name.source_teacher_name_key,
      normalized_name.teacher_display_name_key,
      coalesce(current_teacher.row_count, 0) as current_teacher_count,
      coalesce(current_teacher_name.row_count, 0) as current_teacher_name_count
    from exact_teacher_evidence teacher_evidence
    cross join lateral (
      values (
        internal.student_import_name_key(teacher_evidence.source_teacher_name),
        internal.student_import_name_key(teacher_evidence.teacher_display_name)
      )
    ) normalized_name(source_teacher_name_key, teacher_display_name_key)
    left join current_teachers current_teacher
      on current_teacher.teacher_id = teacher_evidence.teacher_id
     and current_teacher.name_key = normalized_name.teacher_display_name_key
    left join current_teacher_names current_teacher_name
      on current_teacher_name.name_key = normalized_name.teacher_display_name_key
  ),
  violation_rows as (
    select 'jiaowubao_direct_import_master_row_unknown'::text as code
    from attached_checked where master_source_count <> 1
    union all
    select 'jiaowubao_direct_import_excluded_master_forbidden'
    from attached_checked where master_status = '不活跃 + 无课时'
    union all
    select 'jiaowubao_direct_import_attachment_name_mismatch'
    from attached_checked where master_name_key is distinct from evidence_name_key
    union all
    select 'jiaowubao_direct_import_attachment_name_ambiguous'
    from attached_checked where active_name_count <> 1
    union all
    select 'jiaowubao_direct_import_student_id_not_current_tencent_record'
    from attached_checked where current_student_count <> 1
    union all
    select 'jiaowubao_direct_import_schedule_participant_identity_invalid'
    from participant_identity identity_link
    where identity_id is null
       or identity_run_id <> p_run_id
       or identity_state <> 'attached'
       or identity_proof is not true
       or nullif(btrim(evidence_phone), '') is null
       or identity_student_id is distinct from student_id
       or identity_master_source_row is distinct from master_source_row
       or internal.student_import_name_key(identity_evidence_name) <>
          internal.student_import_name_key(evidence_name)
       or internal.student_import_name_key(identity_evidence_name) <>
          internal.student_import_name_key(source_display_name)
       or not exists (
         select 1
         from jsonb_array_elements_text(coalesce(source_payload #> '{source,studentDisplayNames}', '[]'::jsonb)) source_name(value)
         where internal.student_import_name_key(source_name.value) =
               internal.student_import_name_key(source_display_name)
       )
    union all
    select 'jiaowubao_direct_import_schedule_time_proof_invalid'
    from schedule_checked schedule_event
    where schedule_event.time_parse_status = 'parsed'
      and (
        schedule_event.source_timezone is distinct from 'Australia/Melbourne'
        or schedule_event.dst_resolution is distinct from 'unambiguous'
        or schedule_event.direct_start at time zone 'Australia/Melbourne'
           is distinct from schedule_event.local_start
        or schedule_event.direct_end at time zone 'Australia/Melbourne'
           is distinct from schedule_event.local_end
        or schedule_event.direct_start is distinct from schedule_event.starts_at
        or schedule_event.direct_end is distinct from schedule_event.ends_at
        or (schedule_event.direct_start - interval '1 hour') at time zone 'Australia/Melbourne'
           = schedule_event.local_start
        or (schedule_event.direct_start + interval '1 hour') at time zone 'Australia/Melbourne'
           = schedule_event.local_start
        or (schedule_event.direct_end - interval '1 hour') at time zone 'Australia/Melbourne'
           = schedule_event.local_end
        or (schedule_event.direct_end + interval '1 hour') at time zone 'Australia/Melbourne'
           = schedule_event.local_end
        or schedule_event.starts_at is null
        or schedule_event.ends_at is null
        or schedule_event.starts_at >= schedule_event.ends_at
      )
    union all
    select 'jiaowubao_direct_import_teacher_name_evidence_invalid'
    from exact_teacher_checked teacher_evidence
    where nullif(btrim(teacher_evidence.source_teacher_name), '') is null
       or teacher_evidence.source_teacher_name_key <> teacher_evidence.teacher_display_name_key
    union all
    select 'jiaowubao_direct_import_teacher_id_not_exact_current_record'
    from exact_teacher_checked teacher_evidence
    where teacher_evidence.current_teacher_count <> 1
    union all
    select 'jiaowubao_direct_import_teacher_name_ambiguous'
    from exact_teacher_checked teacher_evidence
    where teacher_evidence.current_teacher_name_count <> 1
    union all
    select 'jiaowubao_direct_import_subject_resolution_not_yet_authoritative'
    from schedule_checked schedule_event
    where schedule_event.subject_resolution <> 'unresolved' or schedule_event.subject_id is not null
  )
  select violation_row.code into violation
  from violation_rows violation_row
  limit 1;

  if violation is not null then
    raise exception using errcode = '22023', message = violation;
  end if;
end;
$jiaowubao_direct_import_validate_projection$;

revoke all on function internal.jiaowubao_direct_import_validate_projection(uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
