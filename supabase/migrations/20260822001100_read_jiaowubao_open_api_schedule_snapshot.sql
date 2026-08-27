-- Read-only, bounded access to the immutable Open API schedule snapshot.
--
-- The 30-minute cron writes the jiaowubao_open_api_schedule_snapshot_* tables.
-- This reader never consults the older jiaowubao_direct_import projection and
-- never exposes the stored record, stu_list, source names, or price fields to
-- a browser. The Next route uses the source keys returned here only to map
-- against the current Ops state and then emits its own minimal DTO.

create or replace function public.get_jiaowubao_open_api_schedule_snapshot_window(
  p_secret text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_scope text,
  p_scope_teacher_labels text[] default null,
  p_scope_student_member_ids text[] default null,
  p_limit integer default 250,
  p_cursor_start timestamptz default null,
  p_cursor_event_id text default null,
  p_snapshot_revision text default null,
  p_scope_student_name_keys text[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $get_jiaowubao_open_api_schedule_snapshot_window$
declare
  current_row internal.jiaowubao_open_api_schedule_snapshot_current%rowtype;
  run_state internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype;
  source_start_date text;
  source_end_date text;
  source_start_at timestamptz;
  source_end_at timestamptz;
  freshness_value text;
  state_value text;
  events jsonb := '[]'::jsonb;
  has_more boolean := false;
  next_cursor jsonb := null;
  invalid_time_event_count integer := 0;
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
     or (p_cursor_start is not null and p_snapshot_revision is null)
     or (p_cursor_start is not null and (
       not isfinite(p_cursor_start) or p_cursor_start >= p_window_end
     ))
     or (p_cursor_event_id is not null and (
       p_cursor_event_id <> btrim(p_cursor_event_id)
       or p_cursor_event_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
     ))
     or (p_snapshot_revision is not null and p_snapshot_revision !~ '^sha256:[a-f0-9]{64}$')
     or p_scope is null or p_scope <> btrim(p_scope)
     or p_scope not in ('all', 'teacher', 'student', 'availability')
    or (p_scope = 'all' and (
      p_scope_teacher_labels is not null
      or p_scope_student_member_ids is not null
      or p_scope_student_name_keys is not null
     ))
    or (p_scope in ('teacher', 'availability') and (
      coalesce(cardinality(p_scope_teacher_labels), 0) not between 1 and 512
       or exists (
         select 1 from unnest(p_scope_teacher_labels) item(value)
         where item.value is null
           or item.value <> btrim(item.value)
           or char_length(item.value) not between 1 and 240
       )
       or exists (
         select normalized_label
         from unnest(p_scope_teacher_labels) item(value)
         cross join lateral (
           select lower(regexp_replace(btrim(item.value), E'\\s+', '', 'g')) as normalized_label
         ) normalized
         group by normalized_label having count(*) > 1
       )
     ))
    or (p_scope in ('teacher', 'availability') and p_scope_student_name_keys is not null)
    or (p_scope = 'availability' and p_scope_student_member_ids is not null)
    or (p_scope in ('teacher', 'availability') and p_scope_student_member_ids is not null)
    or (p_scope = 'student' and (
      coalesce(cardinality(p_scope_student_member_ids), 0) > 1024
      or coalesce(cardinality(p_scope_student_name_keys), 0) > 1024
      or coalesce(cardinality(p_scope_student_member_ids), 0)
        + coalesce(cardinality(p_scope_student_name_keys), 0) < 1
      or p_scope_teacher_labels is not null
      or exists (
        select 1 from unnest(p_scope_student_member_ids) item(value)
         where item.value is null
           or item.value <> btrim(item.value)
          or item.value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$'
      )
      or exists (
        select 1 from unnest(p_scope_student_name_keys) item(value)
        where item.value is null
          or item.value <> btrim(item.value)
          or char_length(item.value) not between 1 and 240
      )
      or exists (
        select item.value from unnest(p_scope_student_member_ids) item(value)
        group by item.value having count(*) > 1
      )
      or exists (
        select item.value from unnest(p_scope_student_name_keys) item(value)
        group by item.value having count(*) > 1
      )
    )) then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_open_api_schedule_snapshot_window';
  end if;

  select * into current_row
  from internal.jiaowubao_open_api_schedule_snapshot_current snapshot_current
  where snapshot_current.api_source_key = 'jwb-open-api-schedule';

  if not found then
    return jsonb_build_object(
      'state', 'absent',
      'events', '[]'::jsonb,
      'invalidTimeEventCount', 0,
      'hasMore', false,
      'nextCursor', null,
      'revision', null,
      'publishedAt', null,
      'sourceWindow', null,
      'freshness', 'absent',
      'empty', true
    );
  end if;

  select * into run_state
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs snapshot_run
  where snapshot_run.id = current_row.run_id
    and snapshot_run.state = 'complete'
    and snapshot_run.api_source_key = current_row.api_source_key;
  if not found then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_current_invalid';
  end if;
  if current_row.revision is distinct from run_state.revision then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_current_invalid';
  end if;

  if p_snapshot_revision is not null and p_snapshot_revision <> current_row.revision then
    return jsonb_build_object(
      'state', 'reset',
      'events', '[]'::jsonb,
      'invalidTimeEventCount', 0,
      'hasMore', false,
      'nextCursor', null,
      'revision', current_row.revision,
      'publishedAt', current_row.published_at,
      'sourceWindow', jsonb_build_object(
        'start', run_state.query ->> 'start',
        'end', run_state.query ->> 'end'
      ),
      'freshness', 'stale',
      'empty', true
    );
  end if;

  source_start_date := run_state.query ->> 'start';
  source_end_date := run_state.query ->> 'end';
  -- The ingest envelope checks the date shape, but an already-published run
  -- must still be treated as hostile input. Validate the shape before casting;
  -- malformed source dates therefore fail closed instead of relying on OR
  -- short-circuiting around a date cast.
  if source_start_date is null or source_end_date is null
     or source_start_date !~ '^\d{4}-\d{2}-\d{2}$'
     or source_end_date !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_source_window_invalid';
  end if;
  begin
    source_start_at := (source_start_date::date::timestamp at time zone 'Australia/Melbourne');
    source_end_at := ((source_end_date::date + 1)::timestamp at time zone 'Australia/Melbourne');
  exception when others then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_source_window_invalid';
  end;
  if source_end_at <= source_start_at then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_source_window_invalid';
  end if;
  freshness_value := case
    when current_row.published_at >= clock_timestamp() - interval '2 hours'
      and p_window_start >= source_start_at
      and p_window_end <= source_end_at
    then 'fresh'
    else 'stale'
  end;
  -- `state` describes whether a readable publication exists.  Freshness is a
  -- separate signal so a stale but complete snapshot remains displayable.
  state_value := case when freshness_value = 'fresh' then 'complete' else 'stale' end;

  -- A cursor pins the sequence to this immutable publication.  The route
  -- signs the revision and window; this check prevents a mixed snapshot if a
  -- cron tick publishes between browser page requests.
  with snapshot_items as materialized (
    select item_row.source_key as event_id,
      item_row.item -> 'record' as record
    from internal.jiaowubao_open_api_schedule_snapshot_ingest_items item_row
    where item_row.run_id = current_row.run_id
  ), raw_fields as materialized (
    select snapshot_item.event_id,
      snapshot_item.record,
      nullif(btrim(snapshot_item.record ->> 'dated'), '') as source_date,
      nullif(btrim(snapshot_item.record ->> 'time_start'), '') as start_text,
      nullif(btrim(snapshot_item.record ->> 'time_end'), '') as end_text,
      nullif(btrim(snapshot_item.record ->> 'teacher_id'), '') as source_teacher_id,
      nullif(btrim(snapshot_item.record ->> 'teacher_title'), '') as source_teacher_label,
      nullif(btrim(snapshot_item.record ->> 'course_title'), '') as course_name
    from snapshot_items snapshot_item
  ), date_fields as materialized (
    select raw_field.*,
      case when raw_field.source_date ~ '^\d{4}-\d{2}-\d{2}$'
        then substring(raw_field.source_date from 1 for 4)::integer end as date_year,
      case when raw_field.source_date ~ '^\d{4}-\d{2}-\d{2}$'
        then substring(raw_field.source_date from 6 for 2)::integer end as date_month,
      case when raw_field.source_date ~ '^\d{4}-\d{2}-\d{2}$'
        then substring(raw_field.source_date from 9 for 2)::integer end as date_day
    from raw_fields raw_field
  ), parsed_fields as materialized (
    select date_field.*,
      case
        when date_field.source_date ~ '^\d{4}-\d{2}-\d{2}$'
        then case
          when date_field.date_year between 1 and 9999
            and date_field.date_month between 1 and 12
            and date_field.date_day between 1 and 31
          then to_char(to_date(date_field.source_date, 'YYYY-MM-DD'), 'YYYY-MM-DD') = date_field.source_date
          else false
        end
        else false
      end as valid_date,
      case when date_field.start_text ~ '^\d{2}:\d{2}$'
        then substring(date_field.start_text from 1 for 2)::integer end as start_hour,
      case when date_field.start_text ~ '^\d{2}:\d{2}$'
        then substring(date_field.start_text from 4 for 2)::integer end as start_minute,
      case when date_field.end_text ~ '^\d{2}:\d{2}$'
        then substring(date_field.end_text from 1 for 2)::integer end as end_hour,
      case when date_field.end_text ~ '^\d{2}:\d{2}$'
        then substring(date_field.end_text from 4 for 2)::integer end as end_minute
    from date_fields date_field
  ), parsed_events as materialized (
    select parsed_field.*,
      case when parsed_field.valid_date
        and parsed_field.start_hour between 0 and 23
        and parsed_field.end_hour between 0 and 23
        and parsed_field.start_minute between 0 and 59
        and parsed_field.end_minute between 0 and 59
        and (parsed_field.end_hour * 60 + parsed_field.end_minute)
          > (parsed_field.start_hour * 60 + parsed_field.start_minute)
        then ((parsed_field.source_date || ' ' || parsed_field.start_text || ':00')::timestamp at time zone 'Australia/Melbourne')
      end as starts_at,
      case when parsed_field.valid_date
        and parsed_field.start_hour between 0 and 23
        and parsed_field.end_hour between 0 and 23
        and parsed_field.start_minute between 0 and 59
        and parsed_field.end_minute between 0 and 59
        and (parsed_field.end_hour * 60 + parsed_field.end_minute)
          > (parsed_field.start_hour * 60 + parsed_field.start_minute)
        then ((parsed_field.source_date || ' ' || parsed_field.end_text || ':00')::timestamp at time zone 'Australia/Melbourne')
      end as ends_at
    from parsed_fields parsed_field
  ), source_name_keys as materialized (
    select name_key.value as name_key,
      count(distinct nullif(btrim(student_value ->> 'mem_id'), '')) as member_count,
      count(*) filter (where nullif(btrim(student_value ->> 'mem_id'), '') is null) as missing_member_count
    from snapshot_items snapshot_item
    cross join jsonb_array_elements(case
      when jsonb_typeof(snapshot_item.record -> 'stu_list') = 'array'
      then snapshot_item.record -> 'stu_list'
      else '[]'::jsonb
    end) student_value
    cross join lateral (values
      (internal.student_import_name_key(student_value ->> 'name')),
      (internal.student_import_jwb_auto_name_key(student_value ->> 'name'))
    ) name_key(value)
    where p_scope = 'student'
      and p_scope_student_name_keys is not null
      and name_key.value <> ''
      and name_key.value = any(p_scope_student_name_keys)
    group by name_key.value
  ), scoped_events as materialized (
    select parsed_event.*
    from parsed_events parsed_event
    where (
      p_scope = 'all'
      or (
        p_scope in ('teacher', 'availability')
        and exists (
          select 1
          from unnest(p_scope_teacher_labels) teacher_label(value)
          where lower(regexp_replace(btrim(teacher_label.value), E'\\s+', '', 'g'))
            = lower(regexp_replace(coalesce(parsed_event.source_teacher_label, ''), E'\\s+', '', 'g'))
        )
      )
      or (
        p_scope = 'student'
        and exists (
          select 1
          from jsonb_array_elements(case
            when jsonb_typeof(parsed_event.record -> 'stu_list') = 'array'
            then parsed_event.record -> 'stu_list'
            else '[]'::jsonb
          end) student_value
          where (p_scope_student_member_ids is not null
              and btrim(student_value ->> 'mem_id') = any(p_scope_student_member_ids))
             or (p_scope_student_name_keys is not null
              and (
                internal.student_import_name_key(student_value ->> 'name')
                  = any(p_scope_student_name_keys)
                or internal.student_import_jwb_auto_name_key(student_value ->> 'name')
                  = any(p_scope_student_name_keys)
              )
              and exists (
                select 1 from source_name_keys source_name
                where source_name.name_key = any(p_scope_student_name_keys)
                  and source_name.name_key in (
                    internal.student_import_name_key(student_value ->> 'name'),
                    internal.student_import_jwb_auto_name_key(student_value ->> 'name')
                  )
                  and source_name.member_count = 1
                  and source_name.missing_member_count = 0
              ))
        )
      )
    )
  ), page_plus_one as materialized (
    select scoped_event.*
    from scoped_events scoped_event
    where scoped_event.starts_at is not null
      and scoped_event.ends_at is not null
      and scoped_event.starts_at < p_window_end
      and scoped_event.ends_at > p_window_start
      and (
        p_cursor_start is null
        or (scoped_event.starts_at, scoped_event.event_id) > (p_cursor_start, p_cursor_event_id)
      )
    order by scoped_event.starts_at, scoped_event.event_id
    limit p_limit + 1
  ), page_events as materialized (
    select page_event.*
    from page_plus_one page_event
    order by page_event.starts_at, page_event.event_id
    limit p_limit
  ), page_state as materialized (
    select exists(select 1 from page_plus_one offset p_limit) as has_more,
      (
        select jsonb_build_object(
          'startsAt', to_char(last_event.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'eventId', last_event.event_id
        )
        from (
          select page_event.starts_at, page_event.event_id
          from page_events page_event
          order by page_event.starts_at desc, page_event.event_id desc
          limit 1
        ) last_event
      ) as next_cursor
  ), event_rows as materialized (
    select page_event.event_id,
      page_event.source_date,
      page_event.starts_at,
      page_event.ends_at,
      page_event.course_name,
      page_event.source_teacher_id,
      page_event.source_teacher_label,
      case when p_scope = 'availability' then '[]'::jsonb else coalesce(participant_page.participants, '[]'::jsonb) end as participants,
      case when p_scope = 'availability' then false else coalesce(participant_page.truncated, false) end as members_truncated
    from page_events page_event
    left join lateral (
      select coalesce(jsonb_agg(jsonb_build_object(
          'memberId', member.member_id,
          'label', member.student_label
        ) order by coalesce(member.member_id, member.student_label)), '[]'::jsonb) as participants,
        count(*) > 100 as truncated
      from (
        select distinct on (coalesce(nullif(btrim(student_value ->> 'mem_id'), ''), btrim(student_value ->> 'name')))
          nullif(btrim(student_value ->> 'mem_id'), '') as member_id,
          nullif(btrim(student_value ->> 'name'), '') as student_label
        from jsonb_array_elements(case
          when jsonb_typeof(page_event.record -> 'stu_list') = 'array'
          then page_event.record -> 'stu_list'
          else '[]'::jsonb
        end) student_value
        where nullif(btrim(student_value ->> 'mem_id'), '') is not null
           or nullif(btrim(student_value ->> 'name'), '') is not null
        order by coalesce(nullif(btrim(student_value ->> 'mem_id'), ''), btrim(student_value ->> 'name')),
          nullif(btrim(student_value ->> 'name'), '')
        limit 101
      ) member
    ) participant_page on true
  )
  select coalesce(
      (select jsonb_agg(
        jsonb_build_object(
          'eventId', event_row.event_id,
          'sourceDate', event_row.source_date,
          'startsAt', event_row.starts_at,
          'endsAt', event_row.ends_at,
          'courseName', event_row.course_name,
          'sourceTeacherId', event_row.source_teacher_id,
          'sourceTeacherLabel', event_row.source_teacher_label,
          'sourceParticipants', event_row.participants,
          'sourceStudentsTruncated', event_row.members_truncated
        ) order by event_row.starts_at, event_row.event_id
      ) from event_rows event_row),
      '[]'::jsonb
    ),
    (select page_state.has_more from page_state),
    (select case when page_state.has_more then page_state.next_cursor else null end from page_state)
  into events, has_more, next_cursor;

  if p_cursor_start is null and p_scope <> 'availability' then
    with snapshot_items as materialized (
      select item_row.source_key as event_id, item_row.item -> 'record' as record
      from internal.jiaowubao_open_api_schedule_snapshot_ingest_items item_row
      where item_row.run_id = current_row.run_id
    ), invalid_scope as materialized (
      select snapshot_item.*,
        nullif(btrim(snapshot_item.record ->> 'dated'), '') as source_date,
        nullif(btrim(snapshot_item.record ->> 'time_start'), '') as start_text,
        nullif(btrim(snapshot_item.record ->> 'time_end'), '') as end_text,
        nullif(btrim(snapshot_item.record ->> 'teacher_title'), '') as source_teacher_label
      from snapshot_items snapshot_item
    ), invalid_name_keys as materialized (
      select name_key.value as name_key,
        count(distinct nullif(btrim(student_value ->> 'mem_id'), '')) as member_count,
        count(*) filter (where nullif(btrim(student_value ->> 'mem_id'), '') is null) as missing_member_count
      from snapshot_items snapshot_item
      cross join jsonb_array_elements(case
        when jsonb_typeof(snapshot_item.record -> 'stu_list') = 'array'
        then snapshot_item.record -> 'stu_list'
        else '[]'::jsonb
      end) student_value
      cross join lateral (values
        (internal.student_import_name_key(student_value ->> 'name')),
        (internal.student_import_jwb_auto_name_key(student_value ->> 'name'))
      ) name_key(value)
      where p_scope = 'student'
        and p_scope_student_name_keys is not null
        and name_key.value <> ''
        and name_key.value = any(p_scope_student_name_keys)
      group by name_key.value
    ), invalid_date_fields as materialized (
      select invalid_scope.*,
        case when invalid_scope.source_date ~ '^\d{4}-\d{2}-\d{2}$'
          then substring(invalid_scope.source_date from 1 for 4)::integer end as date_year,
        case when invalid_scope.source_date ~ '^\d{4}-\d{2}-\d{2}$'
          then substring(invalid_scope.source_date from 6 for 2)::integer end as date_month,
        case when invalid_scope.source_date ~ '^\d{4}-\d{2}-\d{2}$'
          then substring(invalid_scope.source_date from 9 for 2)::integer end as date_day
      from invalid_scope
    ), invalid_parsed as materialized (
      select invalid_date_field.*,
        case
          when invalid_date_field.source_date ~ '^\d{4}-\d{2}-\d{2}$'
          then case
            when invalid_date_field.date_year between 1 and 9999
              and invalid_date_field.date_month between 1 and 12
              and invalid_date_field.date_day between 1 and 31
            then to_char(to_date(invalid_date_field.source_date, 'YYYY-MM-DD'), 'YYYY-MM-DD') = invalid_date_field.source_date
            else false
          end
          else false
        end as valid_date,
        case when invalid_date_field.start_text ~ '^\d{2}:\d{2}$'
          then substring(invalid_date_field.start_text from 1 for 2)::integer end as start_hour,
        case when invalid_date_field.start_text ~ '^\d{2}:\d{2}$'
          then substring(invalid_date_field.start_text from 4 for 2)::integer end as start_minute,
        case when invalid_date_field.end_text ~ '^\d{2}:\d{2}$'
          then substring(invalid_date_field.end_text from 1 for 2)::integer end as end_hour,
        case when invalid_date_field.end_text ~ '^\d{2}:\d{2}$'
          then substring(invalid_date_field.end_text from 4 for 2)::integer end as end_minute
      from invalid_date_fields invalid_date_field
    )
    select count(*)::integer into invalid_time_event_count
    from invalid_parsed invalid_event
    where (
      not invalid_event.valid_date
      or invalid_event.start_hour is null or invalid_event.end_hour is null
      or invalid_event.start_minute is null or invalid_event.end_minute is null
      or invalid_event.start_hour not between 0 and 23
      or invalid_event.end_hour not between 0 and 23
      or invalid_event.start_minute not between 0 and 59
      or invalid_event.end_minute not between 0 and 59
      or (invalid_event.end_hour * 60 + invalid_event.end_minute)
        <= (invalid_event.start_hour * 60 + invalid_event.start_minute)
    )
    and (
      p_scope = 'all'
      or (p_scope = 'teacher' and exists (
        select 1 from unnest(p_scope_teacher_labels) teacher_label(value)
        where lower(regexp_replace(btrim(teacher_label.value), E'\\s+', '', 'g'))
          = lower(regexp_replace(coalesce(invalid_event.source_teacher_label, ''), E'\\s+', '', 'g'))
      ))
      or (p_scope = 'student' and exists (
        select 1
        from jsonb_array_elements(case when jsonb_typeof(invalid_event.record -> 'stu_list') = 'array'
          then invalid_event.record -> 'stu_list' else '[]'::jsonb end) student_value
        where (p_scope_student_member_ids is not null
          and btrim(student_value ->> 'mem_id') = any(p_scope_student_member_ids))
          or (p_scope_student_name_keys is not null
          and (
            internal.student_import_name_key(student_value ->> 'name')
              = any(p_scope_student_name_keys)
            or internal.student_import_jwb_auto_name_key(student_value ->> 'name')
              = any(p_scope_student_name_keys)
          )
          and exists (
            select 1 from invalid_name_keys source_name
            where source_name.name_key = any(p_scope_student_name_keys)
              and source_name.name_key in (
                internal.student_import_name_key(student_value ->> 'name'),
                internal.student_import_jwb_auto_name_key(student_value ->> 'name')
              )
              and source_name.member_count = 1
              and source_name.missing_member_count = 0
          ))
      ))
    );
  end if;

  return jsonb_build_object(
    'state', state_value,
    'events', events,
    'invalidTimeEventCount', invalid_time_event_count,
    'hasMore', has_more,
    'nextCursor', next_cursor,
    'revision', current_row.revision,
    'publishedAt', current_row.published_at,
    'sourceWindow', jsonb_build_object('start', source_start_date, 'end', source_end_date),
    'freshness', freshness_value,
    'empty', jsonb_array_length(events) = 0 and not has_more
  );
end;
$get_jiaowubao_open_api_schedule_snapshot_window$;

revoke all on function public.get_jiaowubao_open_api_schedule_snapshot_window(
  text, timestamptz, timestamptz, text, text[], text[], integer, timestamptz, text, text, text[]
) from public, anon, authenticated;
grant execute on function public.get_jiaowubao_open_api_schedule_snapshot_window(
  text, timestamptz, timestamptz, text, text[], text[], integer, timestamptz, text, text, text[]
) to anon, authenticated;

create index if not exists jwb_open_api_schedule_snapshot_reader_run_event_idx
  on internal.jiaowubao_open_api_schedule_snapshot_ingest_items (run_id, source_key);

comment on function public.get_jiaowubao_open_api_schedule_snapshot_window(
  text, timestamptz, timestamptz, text, text[], text[], integer, timestamptz, text, text, text[]
) is 'Secret-gated server-only read of the current immutable Open API schedule snapshot; no raw source payload is exposed.';
