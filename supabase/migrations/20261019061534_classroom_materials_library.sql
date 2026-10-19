set local lock_timeout = '1s';

create table internal.classroom_material_folders (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references internal.classroom_material_folders(id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 160 and name !~ E'[\\x00-\\x1f\\x7f/\\\\]' and name not in ('.', '..')),
  created_by uuid not null references internal.app_accounts(account_id) on delete restrict,
  created_at timestamptz not null default now()
);
create unique index classroom_material_folders_siblings on internal.classroom_material_folders(coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
create index classroom_material_folders_parent on internal.classroom_material_folders(parent_id, name, id);

create table internal.classroom_materials (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid references internal.classroom_material_folders(id) on delete restrict,
  title text not null check (length(trim(title)) between 1 and 240),
  kind text not null check (kind in ('file', 'link')),
  file_name text,
  mime_type text,
  byte_size bigint,
  bucket_id text,
  object_path text unique,
  source_url text,
  status text not null check (status in ('uploading', 'ready')),
  upload_request_key uuid unique,
  created_by uuid not null references internal.app_accounts(account_id) on delete restrict,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  check ((kind = 'file' and file_name is not null and mime_type is not null and byte_size is not null and byte_size between 1 and 5368709120
    and bucket_id is not null and object_path is not null and bucket_id = 'classroom-materials' and object_path = 'materials/' || id::text || '/source.' || lower(substring(file_name from '[^.]+$'))
    and source_url is null and upload_request_key is not null)
    or (kind = 'link' and file_name is null and mime_type is null and byte_size is null and bucket_id is null
      and object_path is null and source_url is not null and source_url ~ '^https://[^/@[:space:]]+([/?#]|$)' and upload_request_key is null and status = 'ready'))
);
create index classroom_materials_folder on internal.classroom_materials(folder_id, title, id);

create table internal.classroom_material_grants (
  teacher_id text not null check (length(trim(teacher_id)) between 1 and 180),
  folder_id uuid references internal.classroom_material_folders(id) on delete restrict,
  material_id uuid references internal.classroom_materials(id) on delete restrict,
  can_download boolean not null default false,
  created_by uuid not null references internal.app_accounts(account_id) on delete restrict,
  created_at timestamptz not null default now(),
  check ((folder_id is null) <> (material_id is null))
);
create unique index classroom_material_folder_grants on internal.classroom_material_grants(teacher_id, folder_id) where folder_id is not null;
create unique index classroom_material_file_grants on internal.classroom_material_grants(teacher_id, material_id) where material_id is not null;
create index classroom_material_grants_folder on internal.classroom_material_grants(folder_id);
create index classroom_material_grants_material on internal.classroom_material_grants(material_id);

alter table internal.classroom_material_folders enable row level security;
alter table internal.classroom_materials enable row level security;
alter table internal.classroom_material_grants enable row level security;
revoke all on internal.classroom_material_folders, internal.classroom_materials, internal.classroom_material_grants from public, anon, authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('classroom-materials', 'classroom-materials', false, 268435456, array[
  'application/pdf', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg', 'video/mp4'
]) on conflict (id) do nothing;

create function internal.classroom_material_access(p_teacher_id text, p_folder_id uuid, p_material_id uuid, p_download boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  with recursive ancestors(id, parent_id, depth) as (
    select f.id, f.parent_id, 1 from internal.classroom_material_folders f where f.id = p_folder_id
    union all
    select f.id, f.parent_id, a.depth + 1 from internal.classroom_material_folders f join ancestors a on f.id = a.parent_id where a.depth < 32
  )
  select exists (
    select 1 from internal.classroom_material_grants g
    where g.teacher_id = p_teacher_id and (not p_download or g.can_download)
      and (g.material_id = p_material_id or g.folder_id in (select id from ancestors))
  );
$$;

create function internal.classroom_material_folder_visible(p_teacher_id text, p_folder_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  with recursive navigation(id, parent_id, depth) as (
    select f.id, f.parent_id, 1 from internal.classroom_material_folders f
    where f.id in (
      select g.folder_id from internal.classroom_material_grants g where g.teacher_id = p_teacher_id
      union
      select m.folder_id from internal.classroom_material_grants g join internal.classroom_materials m on m.id = g.material_id where g.teacher_id = p_teacher_id
    )
    union
    select f.id, f.parent_id, n.depth + 1 from internal.classroom_material_folders f join navigation n on f.id = n.parent_id where n.depth < 32
  )
  select internal.classroom_material_access(p_teacher_id, p_folder_id, null)
    or exists (select 1 from navigation where id = p_folder_id);
$$;

create function internal.classroom_material_json(p_material internal.classroom_materials, p_can_download boolean)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_material.id, 'folderId', p_material.folder_id, 'title', p_material.title, 'kind', p_material.kind,
    'fileName', p_material.file_name, 'mimeType', p_material.mime_type, 'byteSize', p_material.byte_size,
    'sourceUrl', p_material.source_url, 'status', p_material.status, 'createdAt', p_material.created_at, 'canDownload', p_can_download
  );
$$;

create function public.classroom_materials_request(p_secret text, p_account_id uuid, p_operation text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor internal.app_accounts;
  permissions text[];
  scopes jsonb;
  actor_teacher_id text;
  teacher_count integer;
  global_scope boolean;
  can_manage boolean;
  can_read boolean;
  v_folder_id uuid;
  target_id uuid;
  material_id uuid;
  request_key uuid;
  folder_depth integer;
  target_type text;
  title text;
  item internal.classroom_materials;
  folder internal.classroom_material_folders;
  result jsonb;
  candidates jsonb;
  offset_value integer;
  limit_value integer;
  query_value text;
  display_ids text[];
  download_ids text[];
  roster jsonb;
  permission_value text;
begin
  if internal.verify_ops_secret(p_secret) is distinct from true then raise exception using errcode = '42501', message = 'materials_forbidden'; end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then raise exception 'materials_invalid_input'; end if;
  select * into actor from internal.app_accounts a where a.account_id = p_account_id and a.status = 'active';
  if not found or actor.account_role not in ('admin', 'limited-admin', 'teacher') then raise exception 'materials_forbidden'; end if;
  permissions := internal.app_account_effective_permissions(actor.account_id, actor.account_role, actor.super_admin);
  scopes := internal.app_account_effective_scope(actor.account_id, actor.account_role, actor.super_admin);
  global_scope := scopes @> '[{"kind":"all","key":"*"}]'::jsonb;
  can_manage := actor.account_role in ('admin', 'limited-admin') and global_scope and ('*' = any(permissions) or 'operations.write' = any(permissions));
  can_read := actor.account_role in ('admin', 'limited-admin') and global_scope and ('*' = any(permissions) or 'operations.read' = any(permissions));
  select coalesce(s.payload, '[]'::jsonb) into roster from public.ops_state s where s.entity = 'teachers';
  roster := coalesce(roster, '[]'::jsonb);
  if actor.account_role = 'teacher' then
    select count(*), min(t->>'id') into teacher_count, actor_teacher_id from jsonb_array_elements(roster) t
      where lower(trim(t->>'name')) = lower(trim(actor.account_name)) and coalesce(t->>'id', '') <> '';
    if teacher_count <> 1 or not ('*' = any(permissions) or 'bookings.read.assigned' = any(permissions)) then raise exception 'materials_forbidden'; end if;
    can_read := true;
  end if;
  if not can_read and not can_manage then raise exception 'materials_forbidden'; end if;
  if p_operation not in ('list', 'authorize') and not can_manage then raise exception 'materials_forbidden'; end if;

  if p_operation = 'list' then
    v_folder_id := nullif(p_payload->>'folderId', '')::uuid;
    if v_folder_id is not null and (not exists(select 1 from internal.classroom_material_folders f where f.id = v_folder_id)
      or (not can_read and not can_manage) or (actor.account_role = 'teacher' and not internal.classroom_material_folder_visible(actor_teacher_id, v_folder_id))) then
      raise exception 'materials_not_found';
    end if;
    offset_value := coalesce((p_payload->>'offset')::integer, 0);
    limit_value := coalesce((p_payload->>'limit')::integer, 100);
    query_value := coalesce(p_payload->>'q', '');
    if offset_value not between 0 and 1000000 or limit_value not between 1 and 200 or length(query_value) > 160 then raise exception 'materials_invalid_input'; end if;
    with recursive navigation(id, parent_id, depth) as (
      select f.id, f.parent_id, 1 from internal.classroom_material_folders f
      where f.id in (
        select g.folder_id from internal.classroom_material_grants g where g.teacher_id = actor_teacher_id
        union select m.folder_id from internal.classroom_material_grants g join internal.classroom_materials m on m.id = g.material_id where g.teacher_id = actor_teacher_id
      )
      union select f.id, f.parent_id, n.depth + 1 from internal.classroom_material_folders f join navigation n on f.id = n.parent_id where n.depth < 32
    ), navigation_ids as materialized (select distinct id from navigation), entries as (
      select f.name as sort_name, f.id, 'folder' as entry_type,
        jsonb_build_object('id', f.id, 'parentId', f.parent_id, 'name', f.name) as data
      from internal.classroom_material_folders f where f.parent_id is not distinct from v_folder_id
        and (query_value = '' or position(lower(query_value) in lower(f.name)) > 0)
        and (actor.account_role <> 'teacher' or f.id in (select id from navigation_ids) or internal.classroom_material_access(actor_teacher_id, f.id, null))
      union all
      select m.title, m.id, 'material', internal.classroom_material_json(m,
        can_manage or (m.kind = 'file' and internal.classroom_material_access(actor_teacher_id, m.folder_id, m.id, true)))
      from internal.classroom_materials m where m.folder_id is not distinct from v_folder_id
        and (query_value = '' or position(lower(query_value) in lower(m.title)) > 0)
        and (actor.account_role <> 'teacher' or (m.status = 'ready' and internal.classroom_material_access(actor_teacher_id, m.folder_id, m.id)))
    ), page as (select * from entries order by entry_type, lower(sort_name), id offset offset_value limit limit_value + 1)
    select coalesce(jsonb_agg(jsonb_build_object('type', entry_type, 'data', data) order by entry_type, lower(sort_name), id), '[]'::jsonb) into candidates from page;
    result := jsonb_build_object('canManage', can_manage, 'nextOffset', case when jsonb_array_length(candidates) > limit_value then to_jsonb(offset_value + limit_value) else 'null'::jsonb end);
    select result || jsonb_build_object(
      'folders', coalesce(jsonb_agg(x.value->'data' order by x.ordinality) filter(where x.value->>'type' = 'folder'), '[]'::jsonb),
      'materials', coalesce(jsonb_agg(x.value->'data' order by x.ordinality) filter(where x.value->>'type' = 'material'), '[]'::jsonb)) into result
      from jsonb_array_elements(candidates) with ordinality x where x.ordinality <= limit_value;
    with recursive ancestors(id, parent_id, name, depth) as (
      select f.id, f.parent_id, f.name, 1 from internal.classroom_material_folders f where f.id = v_folder_id
      union all select f.id, f.parent_id, f.name, a.depth + 1 from internal.classroom_material_folders f join ancestors a on f.id = a.parent_id where a.depth < 32
    ) select result || jsonb_build_object('breadcrumbs', coalesce(jsonb_agg(jsonb_build_object('id', id, 'parentId', parent_id, 'name', name) order by depth desc), '[]'::jsonb)) into result from ancestors;
    return result;
  end if;

  if p_operation = 'create-folder' then
    v_folder_id := nullif(p_payload->>'parentId', '')::uuid;
    title := trim(p_payload->>'name');
    if title is null or length(title) not between 1 and 160 or title ~ E'[\\x00-\\x1f\\x7f/\\\\]' or title in ('.', '..') then raise exception 'materials_invalid_input'; end if;
    if v_folder_id is not null then
      if not exists(select 1 from internal.classroom_material_folders f where f.id = v_folder_id) then raise exception 'materials_not_found'; end if;
      with recursive ancestors(id, parent_id, depth) as (
        select f.id, f.parent_id, 1 from internal.classroom_material_folders f where f.id = v_folder_id
        union all select f.id, f.parent_id, a.depth + 1 from internal.classroom_material_folders f join ancestors a on f.id = a.parent_id where a.depth < 32
      ) select max(depth) into folder_depth from ancestors;
      if folder_depth >= 32 then raise exception 'materials_invalid_input'; end if;
    end if;
    insert into internal.classroom_material_folders(parent_id, name, created_by) values(v_folder_id, title, actor.account_id)
      on conflict (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name) do update set name = excluded.name returning * into folder;
    perform internal.append_operational_contract_audit('classroom.material_folder_created', actor.account_name, 'classroom_material_folder', folder.id::text, '{}'::jsonb);
    return jsonb_build_object('folder', jsonb_build_object('id', folder.id, 'parentId', folder.parent_id, 'name', folder.name));
  end if;

  if p_operation in ('create-link', 'upload-start') then
    v_folder_id := nullif(p_payload->>'folderId', '')::uuid;
    title := trim(p_payload->>'title');
    if title is null or length(title) not between 1 and 240 then raise exception 'materials_invalid_input'; end if;
    if v_folder_id is not null and not exists(select 1 from internal.classroom_material_folders f where f.id = v_folder_id) then raise exception 'materials_not_found'; end if;
    if p_operation = 'create-link' then
      if length(p_payload->>'sourceUrl') > 2048 or p_payload->>'sourceUrl' !~ '^https://[^/@[:space:]]+([/?#]|$)' then raise exception 'materials_invalid_input'; end if;
      insert into internal.classroom_materials(folder_id, title, kind, source_url, status, created_by, ready_at)
        values(v_folder_id, title, 'link', p_payload->>'sourceUrl', 'ready', actor.account_id, now()) returning * into item;
    else
      request_key := (p_payload->>'requestKey')::uuid;
      if request_key is null or length(p_payload->>'fileName') not between 1 and 240 or p_payload->>'fileName' ~ E'[\\x00-\\x1f\\x7f/\\\\]'
        or p_payload->>'mimeType' not in ('application/pdf', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg', 'video/mp4')
        or (p_payload->>'byteSize')::bigint not between 1 and 5368709120 then raise exception 'materials_invalid_input'; end if;
      material_id := gen_random_uuid();
      insert into internal.classroom_materials(id, folder_id, title, kind, file_name, mime_type, byte_size, bucket_id, object_path, status, upload_request_key, created_by)
        values(material_id, v_folder_id, title, 'file', p_payload->>'fileName', p_payload->>'mimeType', (p_payload->>'byteSize')::bigint,
          'classroom-materials', 'materials/' || material_id::text || '/source.' || lower(substring(p_payload->>'fileName' from '[^.]+$')), 'uploading', request_key, actor.account_id)
        on conflict(upload_request_key) do nothing;
      select * into item from internal.classroom_materials m where m.upload_request_key = request_key;
      if item.created_by <> actor.account_id or item.folder_id is distinct from v_folder_id or item.title <> title or item.file_name <> p_payload->>'fileName'
        or item.mime_type <> p_payload->>'mimeType' or item.byte_size <> (p_payload->>'byteSize')::bigint then raise exception 'materials_conflict'; end if;
    end if;
    perform internal.append_operational_contract_audit('classroom.material_registered', actor.account_name, 'classroom_material', item.id::text, jsonb_build_object('kind', item.kind, 'status', item.status));
    result := internal.classroom_material_json(item, true);
    if p_operation = 'upload-start' then result := result || jsonb_build_object('bucketId', item.bucket_id, 'objectPath', item.object_path); end if;
    return jsonb_build_object('material', result);
  end if;

  if p_operation in ('authorize', 'upload-complete') then
    select * into item from internal.classroom_materials m where m.id = (p_payload->>'id')::uuid;
    if not found then raise exception 'materials_not_found'; end if;
    if p_operation = 'authorize' then
      permission_value := p_payload->>'permission';
      if permission_value not in ('display', 'download', 'complete') or permission_value is null then raise exception 'materials_invalid_input'; end if;
      if permission_value = 'complete' then
        if not can_manage or item.kind <> 'file' then raise exception 'materials_forbidden'; end if;
      elsif permission_value = 'download' and item.kind = 'file' and actor.account_role <> 'teacher' and not can_manage then
        raise exception 'materials_forbidden';
      elsif item.status <> 'ready' or (actor.account_role = 'teacher' and not internal.classroom_material_access(actor_teacher_id, item.folder_id, item.id, permission_value = 'download' and item.kind = 'file')) then
        raise exception 'materials_not_found';
      end if;
      return jsonb_build_object('material', internal.classroom_material_json(item, can_manage or internal.classroom_material_access(actor_teacher_id, item.folder_id, item.id, true))
        || jsonb_build_object('bucketId', item.bucket_id, 'objectPath', item.object_path));
    end if;
    if item.kind <> 'file' then raise exception 'materials_invalid_input'; end if;
    update internal.classroom_materials m set status = 'ready', ready_at = coalesce(m.ready_at, now()) where m.id = item.id returning * into item;
    perform internal.append_operational_contract_audit('classroom.material_upload_completed', actor.account_name, 'classroom_material', item.id::text, jsonb_build_object('byteSize', item.byte_size));
    return jsonb_build_object('material', internal.classroom_material_json(item, true));
  end if;

  if p_operation in ('grants-read', 'grants-replace') then
    target_type := p_payload->>'targetType';
    target_id := (p_payload->>'targetId')::uuid;
    if target_type = 'folder' then
      if not exists(select 1 from internal.classroom_material_folders f where f.id = target_id) then raise exception 'materials_not_found'; end if;
    elsif target_type = 'material' then
      if not exists(select 1 from internal.classroom_materials m where m.id = target_id) then raise exception 'materials_not_found'; end if;
    else raise exception 'materials_invalid_input'; end if;
    if p_operation = 'grants-replace' then
      if jsonb_typeof(p_payload->'teacherIds') <> 'array' or jsonb_array_length(p_payload->'teacherIds') > 1000
        or jsonb_typeof(coalesce(p_payload->'downloadTeacherIds', '[]'::jsonb)) <> 'array' then raise exception 'materials_invalid_input'; end if;
      select coalesce(array_agg(distinct v), '{}'::text[]) into display_ids from jsonb_array_elements_text(p_payload->'teacherIds') v;
      select coalesce(array_agg(distinct v), '{}'::text[]) into download_ids from jsonb_array_elements_text(coalesce(p_payload->'downloadTeacherIds', '[]'::jsonb)) v;
      if not download_ids <@ display_ids or cardinality(download_ids) > 1000 or exists(
        select 1 from unnest(display_ids) d where not exists(select 1 from jsonb_array_elements(roster) t where t->>'id' = d)
      ) then raise exception 'materials_invalid_input'; end if;
      perform pg_advisory_xact_lock(hashtextextended('classroom-material-grants:' || target_type || ':' || target_id::text, 0));
      delete from internal.classroom_material_grants g where (target_type = 'folder' and g.folder_id = target_id) or (target_type = 'material' and g.material_id = target_id);
      insert into internal.classroom_material_grants(teacher_id, folder_id, material_id, can_download, created_by)
        select d, case when target_type = 'folder' then target_id end, case when target_type = 'material' then target_id end, d = any(download_ids), actor.account_id from unnest(display_ids) d;
      perform internal.append_operational_contract_audit('classroom.material_grants_replaced', actor.account_name, 'classroom_material_' || target_type, target_id::text, jsonb_build_object('displayCount', cardinality(display_ids), 'downloadCount', cardinality(download_ids)));
    end if;
    select jsonb_build_object('teacherIds', coalesce(jsonb_agg(g.teacher_id order by g.teacher_id), '[]'::jsonb),
      'downloadTeacherIds', coalesce(jsonb_agg(g.teacher_id order by g.teacher_id) filter(where g.can_download), '[]'::jsonb)) into result
      from internal.classroom_material_grants g where (target_type = 'folder' and g.folder_id = target_id) or (target_type = 'material' and g.material_id = target_id);
    if target_type = 'folder' then
      select f.parent_id into v_folder_id from internal.classroom_material_folders f where f.id = target_id;
    else
      select m.folder_id into v_folder_id from internal.classroom_materials m where m.id = target_id;
    end if;
    with recursive ancestors(id, parent_id, depth) as (
      select f.id, f.parent_id, 1 from internal.classroom_material_folders f where f.id = v_folder_id
      union all select f.id, f.parent_id, a.depth + 1 from internal.classroom_material_folders f join ancestors a on f.id = a.parent_id where a.depth < 32
    ) select result || jsonb_build_object(
      'inheritedTeacherIds', coalesce(jsonb_agg(distinct g.teacher_id) filter(where g.teacher_id is not null), '[]'::jsonb),
      'inheritedDownloadTeacherIds', coalesce(jsonb_agg(distinct g.teacher_id) filter(where g.can_download), '[]'::jsonb)
    ) into result from internal.classroom_material_grants g where g.folder_id in (select id from ancestors);
    return result;
  end if;
  raise exception 'materials_invalid_input';
end;
$$;

revoke all on function internal.classroom_material_access(text, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function internal.classroom_material_folder_visible(text, uuid) from public, anon, authenticated;
revoke all on function internal.classroom_material_json(internal.classroom_materials, boolean) from public, anon, authenticated;
revoke all on function public.classroom_materials_request(text, uuid, text, jsonb) from public;
grant execute on function public.classroom_materials_request(text, uuid, text, jsonb) to anon, authenticated;
