create table if not exists internal.teacher_departure_creation_commands (
  command_key text primary key
    check (command_key ~ '^teacher-departure-create:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  source_teacher_id text not null check (length(source_teacher_id) between 1 and 120),
  effective_date date not null,
  operation_ids jsonb not null check (jsonb_typeof(operation_ids) = 'array'),
  affected_student_ids jsonb not null check (jsonb_typeof(affected_student_ids) = 'array'),
  affected_groups jsonb not null check (jsonb_typeof(affected_groups) = 'array'),
  booking_version bigint not null check (booking_version > 0),
  operation_version bigint not null check (operation_version > 0),
  student_version bigint not null check (student_version > 0),
  task_version bigint not null check (task_version > 0),
  teacher_version bigint not null check (teacher_version > 0),
  actor text not null check (length(actor) between 1 and 120),
  applied_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);

alter table internal.teacher_departure_creation_commands enable row level security;
revoke all on table internal.teacher_departure_creation_commands from public, anon, authenticated, service_role;
