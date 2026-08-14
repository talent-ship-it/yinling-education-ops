create table if not exists internal.student_fu_attachments (
  id uuid primary key default gen_random_uuid(),
  student_id text not null check (length(student_id) between 1 and 120),
  file_name text not null check (length(file_name) between 1 and 180),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null check (byte_size between 1 and 4194304),
  content bytea not null,
  uploaded_by text not null,
  uploaded_at timestamptz not null default now()
);

alter table internal.student_fu_attachments enable row level security;
revoke all on table internal.student_fu_attachments from anon, authenticated;

create index if not exists student_fu_attachments_student_time_idx
  on internal.student_fu_attachments (student_id, uploaded_at desc);

create or replace function public.put_student_fu_attachment(
  p_secret text,
  p_student_id text,
  p_file_name text,
  p_content_type text,
  p_content_base64 text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  decoded bytea;
  saved internal.student_fu_attachments;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  if p_content_type not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'unsupported_image_type';
  end if;

  decoded := decode(p_content_base64, 'base64');
  if octet_length(decoded) < 1 or octet_length(decoded) > 4194304 then
    raise exception 'image_size_out_of_range';
  end if;

  insert into internal.student_fu_attachments (
    student_id,
    file_name,
    content_type,
    byte_size,
    content,
    uploaded_by
  ) values (
    left(trim(p_student_id), 120),
    left(trim(p_file_name), 180),
    p_content_type,
    octet_length(decoded),
    decoded,
    left(coalesce(nullif(trim(p_actor), ''), 'unknown'), 120)
  )
  returning * into saved;

  return jsonb_build_object(
    'id', saved.id,
    'student_id', saved.student_id,
    'file_name', saved.file_name,
    'content_type', saved.content_type,
    'byte_size', saved.byte_size,
    'uploaded_by', saved.uploaded_by,
    'uploaded_at', saved.uploaded_at
  );
end;
$$;

create or replace function public.get_student_fu_attachment(
  p_secret text,
  p_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved internal.student_fu_attachments;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  select * into saved
  from internal.student_fu_attachments
  where id = p_id;

  if saved.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'id', saved.id,
    'student_id', saved.student_id,
    'file_name', saved.file_name,
    'content_type', saved.content_type,
    'byte_size', saved.byte_size,
    'uploaded_by', saved.uploaded_by,
    'uploaded_at', saved.uploaded_at,
    'content_base64', encode(saved.content, 'base64')
  );
end;
$$;

revoke all on function public.put_student_fu_attachment(text, text, text, text, text, text) from public;
revoke all on function public.get_student_fu_attachment(text, uuid) from public;
grant execute on function public.put_student_fu_attachment(text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.get_student_fu_attachment(text, uuid) to anon, authenticated;
