alter table internal.student_fu_attachments
  drop constraint if exists student_fu_attachments_content_type_check;

alter table internal.student_fu_attachments
  add constraint student_fu_attachments_content_type_check
  check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'));

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
  perform internal.verify_ops_secret(p_secret);

  if p_content_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') then
    raise exception 'unsupported_attachment_type';
  end if;

  decoded := decode(p_content_base64, 'base64');
  if octet_length(decoded) < 1 or octet_length(decoded) > 4194304 then
    raise exception 'attachment_size_out_of_range';
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

revoke all on function public.put_student_fu_attachment(text, text, text, text, text, text) from public;
grant execute on function public.put_student_fu_attachment(text, text, text, text, text, text) to anon, authenticated;
