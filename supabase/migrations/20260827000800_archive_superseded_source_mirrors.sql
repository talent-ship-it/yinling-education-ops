-- These nine rows are retained historical evidence from the July read-only
-- mirror. Current students/teachers use reviewed import staging, and current
-- Jiaowubao schedules use the Open API snapshot pipeline. Do not manufacture a
-- fresh synced_at value for records that are no longer an active sync source.
update public.ops_source_snapshots as source
set status = 'archived',
    payload = case
      when jsonb_typeof(source.payload) = 'object' then source.payload || jsonb_build_object(
        'lifecycle', jsonb_build_object(
          'state', 'archived',
          'reasonCode', 'superseded_by_current_import_pipeline',
          'archivedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
      )
      else source.payload
    end
where source.source_id = any(array[
  'jwb_courses_current',
  'jwb_students_current',
  'jwb_schedule_2026_w30',
  'tencent_teacher_ava',
  'tencent_renewals',
  'tencent_lp_tasks',
  'tencent_teachers_uni',
  'tencent_teachers_k12',
  'tencent_students_master'
]::text[])
  and source.status <> 'archived';
