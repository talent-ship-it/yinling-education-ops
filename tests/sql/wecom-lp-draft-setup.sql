\set ON_ERROR_STOP on
\ir wecom-trial-handover-identity-runtime.sql

create table public.ops_mutation_log (entity text not null, version bigint not null, actor text not null);
create table internal.legacy_task_deadline_freezes (task_id text primary key);
\ir ../../supabase/migrations/20260819101600_lp_create_revision_atomic.sql
\ir ../../supabase/migrations/20260827000200_enforce_complete_lp_submission.sql
\ir ../../supabase/migrations/20260828000200_trial_manual_tasks_atomic.sql
\ir ../../supabase/migrations/20260828000300_preserve_trial_legacy_evidence.sql
\ir ../../supabase/migrations/20260828000400_align_trial_handbook_task_titles.sql
\ir ../../supabase/migrations/20260821191021_student_creation_students_tasks_atomic.sql
\ir ../../supabase/migrations/20261020091722_wecom_lp_draft_confirmation.sql

insert into public.ops_state(entity, payload, version, updated_by) values
  ('students', '[{"id":"STU-DRAFT-1","name":"Draft Student","guardianWechat":"Draft Parent","owner":"Abby","planner":"Tara","files":0},{"id":"STU-OTHER","name":"Other Student","guardianWechat":"Other Parent","owner":"Ella","planner":"Tara","files":0}]', 1, 'fixture'),
  ('lpItems', '[]', 1, 'fixture'), ('tasks', '[]', 1, 'fixture'), ('files', '[]', 1, 'fixture');

\ir ../../supabase/migrations/20260831000100_trial_scheduling_policy.sql
\ir ../../supabase/migrations/20260831000300_trial_handover_task_retirement.sql
\ir ../../supabase/migrations/20260831001100_restore_trial_scheduling_feedback_chain.sql
\ir ../../supabase/migrations/20260831001200_preserve_trial_handover_retirement.sql

insert into internal.wecom_archive_messages(message_id, content_sha256, chat_id, sender_id, sent_at,
  message_type, body, classification, student_name_hint, guardian_wechat_hint,
  operations_owner_hint, course_planner_hint, student_id, match_status, ingested_by) values
  ('bot:lp-draft:one', repeat('a',64), 'draft-room', 'fixture-sales', '2099-01-01T00:00:00Z', 'text',
   E'【安排教师】：Grace\n【安排科目】：English\n【微信名】：Draft Parent\n【教务老师】：Abby', 'handover', null, 'Draft Parent', 'Abby', 'Tara', null, 'pending', 'WeCom Bot Receiver'),
  ('bot:lp-draft:identity', repeat('b',64), 'draft-room', 'fixture-sales', '2099-01-01T01:00:00Z', 'text',
   E'【学生姓名】：Draft Student\n【微信名】：Draft Parent', 'handover', 'Draft Student', 'Draft Parent', null, null, null, 'pending', 'WeCom Bot Receiver'),
  ('bot:lp-draft:two', repeat('c',64), 'draft-room', 'fixture-sales', '2099-01-02T00:00:00Z', 'text',
   E'【安排教师】：Tynan\n【安排科目】：Maths\n【微信名】：Draft Parent\n【学生姓名】：Draft Student', 'handover', 'Draft Student', 'Draft Parent', 'Abby', 'Tara', null, 'pending', 'WeCom Bot Receiver'),
  ('bot:lp-draft:new', repeat('d',64), 'draft-new-room', 'fixture-sales', '2099-01-01T00:00:00Z', 'text',
   E'[安排老师]: Grace\n[试听科目]: English\n【微信名】：New Draft Parent\n【学生姓名】：New Draft Student', 'handover', 'New Draft Student', 'New Draft Parent', 'Abby', 'Abby', null, 'pending', 'WeCom Bot Receiver'),
  ('bot:lp-draft:other', repeat('e',64), 'draft-other-room', 'fixture-sales', '2099-01-01T00:00:00Z', 'text',
   E'【安排教师】：Grace\n【安排科目】：English\n【微信名】：Other Parent', 'handover', 'Other Student', 'Other Parent', 'Ella', 'Tara', null, 'pending', 'WeCom Bot Receiver');

create function internal.fixture_wecom_lp_fields(p_name text default 'Draft Student')
returns jsonb language sql as $$
  select jsonb_build_object(
    'responsibleOperations','Abby','specifiedContentStatus','需教务跟进','specialNotes','',
    'preparationFollowUp','否','isUniversityStudent',false,'universityMajor','','universityYear','',
    'assignedTeacher','Grace','subject','English','oneSentenceDescription','Synthetic draft trial',
    'locationTimezone','VIC','contactPerson','家长','timeMentioned',false,'preferredTime','',
    'studentNameKnown',true,'trialPaymentMethod','免费试听','planner','Tara',
    'requestSentAt','2099-01-01T00:00:00.000Z','contactParents',true,'contactStudent',false,
    'contactNote','','writingRequired',false,'writingNote','','paperRequired',false,'paperNote','',
    'preparationNote','','studentName',p_name,'trialDurationMinutes',60,'trialDurationNote',''
  );
$$;
create function internal.fixture_wecom_lp_versions()
returns jsonb language sql as $$
  select jsonb_object_agg(entity, version) from public.ops_state where entity in ('students','lpItems','tasks','files');
$$;
