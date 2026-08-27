-- Curated read-only access to the completed Jiaowubao direct-import
-- projection. The importer itself remains internal-only (001). These two
-- secret-gated readers are for server-side Next.js routes only: they expose
-- no raw workbook rows, phones, source coordinates, evidence names, or write
-- operation.

set local lock_timeout = '1s';

-- Calendar events are selected by UTC interval overlap, not source dates, so
-- a lesson around Melbourne midnight is shown in the correct day/month for
-- the viewer's chosen IANA timezone. Invalid source intervals are not plotted
-- as lessons; their aggregate is returned for a visible data-quality notice.
create or replace function public.get_jiaowubao_direct_schedule_window(
  p_secret text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_scope text,
  p_scope_teacher_ids text[] default null,
  p_scope_student_ids text[] default null,
  p_limit integer default 250,
  p_cursor_start timestamptz default null,
  p_cursor_event_id uuid default null,
  p_run_token uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $get_jiaowubao_direct_schedule_window$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  invalid_time_event_count integer := 0;
  events jsonb := '[]'::jsonb;
  has_more boolean := false;
  next_cursor jsonb := null;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_window_start is null or p_window_end is null
     or not isfinite(p_window_start) or not isfinite(p_window_end)
     or p_window_end <= p_window_start
     or p_window_end - p_window_start > interval '63 days'
     or p_limit is null or p_limit not between 1 and 250
     or ((p_cursor_start is null) <> (p_cursor_event_id is null))
     or (p_cursor_start is not null and p_run_token is null)
     or (p_cursor_start is not null and (
       not isfinite(p_cursor_start)
       or p_cursor_start >= p_window_end
     ))
     or p_scope is null or p_scope <> btrim(p_scope)
     or p_scope not in ('all', 'teacher', 'student', 'availability')
     or (p_scope = 'all' and (p_scope_teacher_ids is not null or p_scope_student_ids is not null))
     or (p_scope = 'teacher' and (
       coalesce(cardinality(p_scope_teacher_ids), 0) not between 1 and 512
       or exists (
         select 1 from unnest(p_scope_teacher_ids) item(value)
         where item.value is null
           or item.value <> btrim(item.value)
           or char_length(item.value) not between 1 and 240
       )
       or exists (
         select item.value
         from unnest(p_scope_teacher_ids) item(value)
         group by item.value having count(*) > 1
       )
       or (p_scope_student_ids is not null and (
         coalesce(cardinality(p_scope_student_ids), 0) > 1024
         or exists (
           select 1 from unnest(p_scope_student_ids) item(value)
           where item.value is null
             or item.value <> btrim(item.value)
             or char_length(item.value) not between 1 and 240
         )
         or exists (
           select item.value
           from unnest(p_scope_student_ids) item(value)
           group by item.value having count(*) > 1
         )
       ))
     ))
     or (p_scope = 'availability' and (
       coalesce(cardinality(p_scope_teacher_ids), 0) <> 1
       or p_scope_student_ids is not null
       or exists (
         select 1 from unnest(p_scope_teacher_ids) item(value)
         where item.value is null
           or item.value <> btrim(item.value)
           or char_length(item.value) not between 1 and 240
       )
     ))
     or (p_scope = 'student' and (
       coalesce(cardinality(p_scope_student_ids), 0) not between 1 and 1024
       or p_scope_teacher_ids is not null
       or exists (
         select 1 from unnest(p_scope_student_ids) item(value)
         where item.value is null
           or item.value <> btrim(item.value)
           or char_length(item.value) not between 1 and 240
       )
       or exists (
         select item.value
         from unnest(p_scope_student_ids) item(value)
         group by item.value having count(*) > 1
       )
     )) then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_direct_schedule_window';
  end if;

  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.state = 'complete'
  order by run_state.completed_at desc, run_state.id desc
  limit 1;

  if saved_run.id is null then
    return jsonb_build_object(
      'state', 'absent',
      'events', '[]'::jsonb,
      'invalidTimeEventCount', 0,
      'hasMore', false,
      'nextCursor', null,
      'runToken', null
    );
  end if;

  -- A cursor pins a browser pagination sequence to the current completed
  -- import.  Never serve an arbitrary historical run; if a newer import
  -- completed between pages, tell the route/client to restart from page one.
  if p_run_token is not null and p_run_token <> saved_run.id then
    return jsonb_build_object(
      'state', 'reset',
      'events', '[]'::jsonb,
      'invalidTimeEventCount', 0,
      'hasMore', false,
      'nextCursor', null,
      'runToken', saved_run.id::text
    );
  end if;

  -- The client retains this value from the first page while it accumulates a
  -- fixed run. Recounting every invalid source event for every keyset page
  -- would reintroduce a full-run read under a large calendar response.
  if p_cursor_start is null and p_scope <> 'availability' then
    select count(*)::integer into invalid_time_event_count
    from internal.jiaowubao_direct_schedule_events schedule_event
    where schedule_event.run_id = saved_run.id
      and schedule_event.time_parse_status = 'invalid_time'
      and (
        p_scope = 'all'
        or (p_scope = 'teacher' and schedule_event.teacher_id = any(p_scope_teacher_ids))
        or (p_scope = 'student' and exists (
          select 1
          from internal.jiaowubao_direct_schedule_event_participants participant_filter
          where participant_filter.event_id = schedule_event.id
            and participant_filter.resolution_state = 'attached'
            and participant_filter.student_id = any(p_scope_student_ids)
        ))
      );
  end if;

  with page_plus_one as materialized (
    select
      schedule_event.id,
      schedule_event.source_date,
      schedule_event.starts_at,
      schedule_event.ends_at,
      case when p_scope = 'availability' then null else schedule_event.course_name end as course_name,
      schedule_event.teacher_id,
      schedule_event.availability_effect
    from internal.jiaowubao_direct_schedule_events schedule_event
    where schedule_event.run_id = saved_run.id
      and schedule_event.time_parse_status = 'parsed'
      and schedule_event.starts_at < p_window_end
      and schedule_event.ends_at > p_window_start
      and tstzrange(schedule_event.starts_at, schedule_event.ends_at, '[)')
        && tstzrange(p_window_start, p_window_end, '[)')
      and (
        p_scope <> 'availability'
        or schedule_event.availability_effect = 'blocks_teacher_ava'
      )
      and (
        p_cursor_start is null
        or (schedule_event.starts_at, schedule_event.id) > (p_cursor_start, p_cursor_event_id)
      )
      and (
        p_scope = 'all'
        or (p_scope = 'teacher' and schedule_event.teacher_id = any(p_scope_teacher_ids))
        or (p_scope = 'availability' and schedule_event.teacher_id = any(p_scope_teacher_ids))
        or (p_scope = 'student' and exists (
          select 1
          from internal.jiaowubao_direct_schedule_event_participants participant_filter
          where participant_filter.event_id = schedule_event.id
            and participant_filter.resolution_state = 'attached'
          and participant_filter.student_id = any(p_scope_student_ids)
        ))
      )
    order by schedule_event.starts_at, schedule_event.id
    limit p_limit + 1
  ), page_events as materialized (
    select *
    from page_plus_one
    order by starts_at, id
    limit p_limit
  ), page_state as materialized (
    select
      exists(select 1 from page_plus_one offset p_limit) as has_more,
      (
        select jsonb_build_object(
          'startsAt', to_char(last_event.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'eventId', last_event.id::text
        )
        from (
          select page_event.starts_at, page_event.id
          from page_events page_event
          order by page_event.starts_at desc, page_event.id desc
          limit 1
        ) last_event
      ) as next_cursor
  ), event_rows as materialized (
    select
      schedule_event.id,
      schedule_event.source_date,
      schedule_event.starts_at,
      schedule_event.ends_at,
      schedule_event.course_name,
      schedule_event.teacher_id,
      schedule_event.availability_effect,
      coalesce(participant_page.visible_student_ids, ARRAY[]::text[]) as visible_student_ids,
      coalesce(participant_page.visible_students_truncated, false) as visible_students_truncated
    from page_events schedule_event
    left join lateral (
      -- A class may have many participants.  A calendar page needs enough
      -- names to orient an authorized operator, not an unbounded cohort dump.
      -- Read at most one sentinel beyond the visible 100; AVA never depends
      -- on this display-only participant slice.
      select
        coalesce(
          (array_agg(visible_participant.student_id order by visible_participant.student_id))[1:100],
          ARRAY[]::text[]
        ) as visible_student_ids,
        count(*) > 100 as visible_students_truncated
      from (
        select distinct participant.student_id
        from internal.jiaowubao_direct_schedule_event_participants participant
        where participant.event_id = schedule_event.id
          and participant.resolution_state = 'attached'
          and (
            p_scope = 'all'
            or p_scope_student_ids is null
            or participant.student_id = any(p_scope_student_ids)
          )
        order by participant.student_id
        limit 101
      ) visible_participant
    ) participant_page on p_scope <> 'availability'
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'eventId', event_row.id,
            'sourceDate', event_row.source_date,
            'startsAt', event_row.starts_at,
            'endsAt', event_row.ends_at,
            'courseName', event_row.course_name,
            'teacherId', event_row.teacher_id,
            'availabilityEffect', event_row.availability_effect,
            'visibleStudentIds', to_jsonb(event_row.visible_student_ids),
            'visibleStudentsTruncated', event_row.visible_students_truncated
          )
          order by event_row.starts_at, event_row.id
        )
        from event_rows event_row
      ),
      '[]'::jsonb
    ),
    (select page_state.has_more from page_state),
    (
      select case when page_state.has_more then page_state.next_cursor else null end
      from page_state
    )
    into events, has_more, next_cursor;

  return jsonb_build_object(
    'state', 'complete',
    'events', events,
    'invalidTimeEventCount', invalid_time_event_count,
    'hasMore', has_more,
    'nextCursor', next_cursor,
    'runToken', saved_run.id::text
  );
end;
$get_jiaowubao_direct_schedule_window$;

revoke all on function public.get_jiaowubao_direct_schedule_window(text, timestamptz, timestamptz, text, text[], text[], integer, timestamptz, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_jiaowubao_direct_schedule_window(text, timestamptz, timestamptz, text, text[], text[], integer, timestamptz, uuid, uuid)
  to anon, authenticated;

-- The page selector is deliberately applied before participant aggregation.
-- These indexes keep the bounded read path bounded for a large completed run.
create index if not exists jiaowubao_direct_schedule_events_reader_window_idx
  on internal.jiaowubao_direct_schedule_events (run_id, starts_at, id)
  where time_parse_status = 'parsed';

create index if not exists jiaowubao_direct_schedule_events_reader_range_idx
  on internal.jiaowubao_direct_schedule_events
  using gist (tstzrange(starts_at, ends_at, '[)'))
  where time_parse_status = 'parsed';

create index if not exists jiaowubao_direct_schedule_events_reader_teacher_window_idx
  on internal.jiaowubao_direct_schedule_events (run_id, teacher_id, starts_at, id)
  where time_parse_status = 'parsed';

create index if not exists jiaowubao_direct_schedule_events_reader_invalid_idx
  on internal.jiaowubao_direct_schedule_events (run_id)
  where time_parse_status = 'invalid_time';

create index if not exists jiaowubao_direct_schedule_events_reader_invalid_teacher_idx
  on internal.jiaowubao_direct_schedule_events (run_id, teacher_id)
  where time_parse_status = 'invalid_time';

create index if not exists jiaowubao_direct_schedule_participants_reader_student_event_idx
  on internal.jiaowubao_direct_schedule_event_participants (student_id, event_id)
  where resolution_state = 'attached';

create index if not exists jiaowubao_direct_schedule_participants_reader_event_student_idx
  on internal.jiaowubao_direct_schedule_event_participants (event_id, student_id)
  where resolution_state = 'attached';

create index if not exists jiaowubao_direct_leave_makeup_reader_student_idx
  on internal.jiaowubao_direct_leave_makeup_events (run_id, student_id, source_date, id)
  where resolution_state = 'attached';

create index if not exists jiaowubao_direct_supplemental_reader_student_idx
  on internal.jiaowubao_direct_supplemental_records (
    run_id,
    student_id,
    (case record_kind
      when 'hour_balance' then 0
      when 'contract' then 1
      when 'class_membership' then 2
      when 'student_snapshot' then 3
      else 4
    end),
    source_workbook,
    source_row
  )
  where resolution_state = 'attached';

-- Attached-only per-student source history. It deliberately does not create
-- active lesson packages, deduct hours, change a booking, or expose raw source
-- identities. A current signed session must authorize the student before the
-- server route calls this function.
create or replace function public.get_jiaowubao_direct_student_history(
  p_secret text,
  p_student_id text,
  p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $get_jiaowubao_direct_student_history$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  supplemental_items jsonb := '[]'::jsonb;
  leave_makeup_items jsonb := '[]'::jsonb;
  supplemental_truncated boolean := false;
  leave_makeups_truncated boolean := false;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_student_id is null or p_student_id <> btrim(p_student_id)
     or char_length(p_student_id) not between 1 and 240
     or p_limit is null
     or p_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_direct_student_history';
  end if;

  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.state = 'complete'
  order by run_state.completed_at desc, run_state.id desc
  limit 1;

  if saved_run.id is null then
    return jsonb_build_object(
      'state', 'absent',
      'supplemental', jsonb_build_object('items', '[]'::jsonb, 'truncated', false),
      'leaveMakeups', jsonb_build_object('items', '[]'::jsonb, 'truncated', false)
    );
  end if;

  select exists (
    select 1
    from internal.jiaowubao_direct_supplemental_records supplemental_record
    where supplemental_record.run_id = saved_run.id
      and supplemental_record.resolution_state = 'attached'
      and supplemental_record.student_id = p_student_id
    offset p_limit
  ) into supplemental_truncated;

  select coalesce(
    jsonb_agg(item.payload order by item.ordinal),
    '[]'::jsonb
  ) into supplemental_items
  from (
    select
      row_number() over (
        order by
          case supplemental_record.record_kind
            when 'hour_balance' then 0
            when 'contract' then 1
            when 'class_membership' then 2
            when 'student_snapshot' then 3
            else 4
          end,
          supplemental_record.source_workbook,
          supplemental_record.source_row
      ) as ordinal,
      jsonb_strip_nulls(jsonb_build_object(
        'kind', supplemental_record.record_kind,
        'courseName', nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,课程}'), ''),
        'className', coalesce(
          nullif(btrim(supplemental_record.source_payload #>> '{source,className}'), ''),
          nullif(btrim(supplemental_record.source_payload #>> '{source,raw,values,className}'), '')
        ),
        'classType', coalesce(
          nullif(btrim(supplemental_record.source_payload #>> '{source,classType}'), ''),
          nullif(btrim(supplemental_record.source_payload #>> '{source,raw,values,classType}'), '')
        ),
        'studentType', nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,学员类型}'), ''),
        'totalHours', coalesce(
          nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,课时数}'), ''),
          nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,总课时数}'), '')
        ),
        'usedHours', nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,已消课时}'), ''),
        'remainingHours', nullif(btrim(supplemental_record.source_payload #>> '{source,raw,fields,剩余课时}'), '')
      )) as payload
    from internal.jiaowubao_direct_supplemental_records supplemental_record
    where supplemental_record.run_id = saved_run.id
      and supplemental_record.resolution_state = 'attached'
      and supplemental_record.student_id = p_student_id
    order by
      case supplemental_record.record_kind
        when 'hour_balance' then 0
        when 'contract' then 1
        when 'class_membership' then 2
        when 'student_snapshot' then 3
        else 4
      end,
      supplemental_record.source_workbook,
      supplemental_record.source_row
    limit p_limit
  ) item;

  select exists (
    select 1
    from internal.jiaowubao_direct_leave_makeup_events leave_makeup_event
    where leave_makeup_event.run_id = saved_run.id
      and leave_makeup_event.resolution_state = 'attached'
      and leave_makeup_event.student_id = p_student_id
    offset p_limit
  ) into leave_makeups_truncated;

  select coalesce(
    jsonb_agg(item.payload order by item.ordinal),
    '[]'::jsonb
  ) into leave_makeup_items
  from (
    select
      row_number() over (order by leave_makeup_event.source_date nulls last, leave_makeup_event.id) as ordinal,
      jsonb_strip_nulls(jsonb_build_object(
        'date', leave_makeup_event.source_date,
        'timeText', leave_makeup_event.source_time_text,
        'kind', leave_makeup_event.incident_kind,
        'courseName', leave_makeup_event.course_name
      )) as payload
    from internal.jiaowubao_direct_leave_makeup_events leave_makeup_event
    where leave_makeup_event.run_id = saved_run.id
      and leave_makeup_event.resolution_state = 'attached'
      and leave_makeup_event.student_id = p_student_id
    order by leave_makeup_event.source_date nulls last, leave_makeup_event.id
    limit p_limit
  ) item;

  return jsonb_build_object(
    'state', 'complete',
    'supplemental', jsonb_build_object('items', supplemental_items, 'truncated', supplemental_truncated),
    'leaveMakeups', jsonb_build_object('items', leave_makeup_items, 'truncated', leave_makeups_truncated)
  );
end;
$get_jiaowubao_direct_student_history$;

revoke all on function public.get_jiaowubao_direct_student_history(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.get_jiaowubao_direct_student_history(text, text, integer)
  to anon, authenticated;
