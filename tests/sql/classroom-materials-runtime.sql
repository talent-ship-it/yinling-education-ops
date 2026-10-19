\set ON_ERROR_STOP on
\ir assert-disposable-database.sql

insert into internal.app_accounts(account_id,identity_key,account_name,account_role,created_by,updated_by) values
('11111111-1111-4111-8111-111111111111',repeat('1',64),'Manager','limited-admin','fixture','fixture'),
('22222222-2222-4222-8222-222222222222',repeat('2',64),'Teacher A','teacher','fixture','fixture'),
('33333333-3333-4333-8333-333333333333',repeat('3',64),'Teacher B','teacher','fixture','fixture'),
('44444444-4444-4444-8444-444444444444',repeat('4',64),'Staff','staff','fixture','fixture'),
('55555555-5555-4555-8555-555555555555',repeat('5',64),'Scoped Manager','limited-admin','fixture','fixture'),
('66666666-6666-4666-8666-666666666666',repeat('6',64),'Manager Two','limited-admin','fixture','fixture');
insert into internal.app_account_scope_members(account_id,scope_kind,scope_key,updated_by) values('55555555-5555-4555-8555-555555555555','student','student-a','fixture');
insert into public.ops_state(entity,payload) values('teachers','[{"id":"teacher-a","name":"Teacher A"},{"id":"teacher-b","name":"Teacher B"}]');

create function pg_temp.call_materials(actor uuid, operation text, payload jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select public.classroom_materials_request('materials-fixture-secret', actor, operation, payload);
$$;
create function pg_temp.expect_failure(actor uuid, operation text, payload jsonb, expected text) returns void language plpgsql as $$
begin
  begin perform pg_temp.call_materials(actor, operation, payload);
  exception when others then if sqlerrm = expected then return; else raise; end if; end;
  raise exception 'Expected failure % for %', expected, operation;
end $$;

do $$
declare
  manager uuid := '11111111-1111-4111-8111-111111111111';
  teacher_a uuid := '22222222-2222-4222-8222-222222222222';
  teacher_b uuid := '33333333-3333-4333-8333-333333333333';
  folder uuid;
  child uuid;
  sibling uuid;
  material uuid;
  result jsonb;
  input jsonb;
begin
  begin perform public.classroom_materials_request(null, manager, 'list'); raise exception 'null secret accepted';
  exception when insufficient_privilege then null; end;
  begin perform public.classroom_materials_request('wrong', manager, 'list'); raise exception 'wrong secret accepted';
  exception when insufficient_privilege then null; end;
  perform pg_temp.expect_failure('44444444-4444-4444-8444-444444444444', 'list', '{}', 'materials_forbidden');
  perform pg_temp.expect_failure('55555555-5555-4555-8555-555555555555', 'create-folder', '{"name":"Denied"}', 'materials_forbidden');
  folder := (pg_temp.call_materials(manager,'create-folder','{"name":"English"}')->'folder'->>'id')::uuid;
  if (pg_temp.call_materials(manager,'create-folder','{"name":"English"}')->'folder'->>'id')::uuid <> folder then raise exception 'folder retry duplicated'; end if;
  child := (pg_temp.call_materials(manager,'create-folder',jsonb_build_object('parentId',folder,'name','Year 7'))->'folder'->>'id')::uuid;
  sibling := (pg_temp.call_materials(manager,'create-folder','{"name":"Unrelated"}')->'folder'->>'id')::uuid;
  input := jsonb_build_object('folderId',child,'title','Lesson','fileName','lesson.pdf','mimeType','application/pdf','byteSize',12,'requestKey','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  result := pg_temp.call_materials(manager,'upload-start',input);
  material := (result->'material'->>'id')::uuid;
  if result->'material'->>'objectPath' <> 'materials/' || material::text || '/source.pdf' then raise exception 'noncanonical object path'; end if;
  if (pg_temp.call_materials(manager,'upload-start',input)->'material'->>'id')::uuid <> material then raise exception 'upload retry duplicated'; end if;
  perform pg_temp.expect_failure(manager,'upload-start',input || '{"byteSize":13}','materials_conflict');
  perform pg_temp.expect_failure(teacher_b,'upload-start',input,'materials_forbidden');
  perform pg_temp.expect_failure('66666666-6666-4666-8666-666666666666','upload-start',input,'materials_conflict');
  perform pg_temp.call_materials(manager,'grants-replace',jsonb_build_object('targetType','folder','targetId',folder,'teacherIds',jsonb_build_array('teacher-a')));
  if jsonb_array_length(pg_temp.call_materials(teacher_a,'list',jsonb_build_object('folderId',child))->'materials') <> 0 then raise exception 'teacher sees incomplete upload'; end if;
  perform pg_temp.call_materials(manager,'upload-complete',jsonb_build_object('id',material));
  result := pg_temp.call_materials(teacher_a,'list');
  if jsonb_array_length(result->'folders') <> 1 or result->'folders'->0->>'id' <> folder::text then raise exception 'teacher navigation leaks unrelated folders'; end if;
  result := pg_temp.call_materials(teacher_a,'list',jsonb_build_object('folderId',child));
  if jsonb_array_length(result->'materials') <> 1 or result->'materials'->0->>'canDownload' <> 'false' then raise exception 'inherited display grant missing'; end if;
  result := pg_temp.call_materials(manager,'grants-read',jsonb_build_object('targetType','material','targetId',material));
  if not result->'inheritedTeacherIds' @> '["teacher-a"]'::jsonb or jsonb_array_length(result->'teacherIds') <> 0 then raise exception 'inherited grants misreported as direct'; end if;
  perform pg_temp.call_materials(teacher_a,'authorize',jsonb_build_object('id',material,'permission','display'));
  perform pg_temp.expect_failure(teacher_a,'authorize',jsonb_build_object('id',material,'permission','download'),'materials_not_found');
  perform pg_temp.expect_failure(teacher_b,'authorize',jsonb_build_object('id',material,'permission','display'),'materials_not_found');
  perform pg_temp.expect_failure(teacher_a,'authorize',jsonb_build_object('id',material,'permission','complete'),'materials_forbidden');
  perform pg_temp.expect_failure(manager,'grants-replace',jsonb_build_object('targetType','material','targetId',material,'teacherIds','["not-a-teacher"]'::jsonb),'materials_invalid_input');
  perform pg_temp.expect_failure(manager,'grants-replace',jsonb_build_object('targetType','material','targetId',material,'teacherIds','["teacher-a"]'::jsonb,'downloadTeacherIds','["teacher-b"]'::jsonb),'materials_invalid_input');
  perform pg_temp.call_materials(manager,'grants-replace',jsonb_build_object('targetType','material','targetId',material,'teacherIds','["teacher-b"]'::jsonb,'downloadTeacherIds','["teacher-b"]'::jsonb));
  perform pg_temp.call_materials(teacher_b,'authorize',jsonb_build_object('id',material,'permission','download'));
  result := pg_temp.call_materials(teacher_b,'list');
  if jsonb_array_length(result->'folders') <> 1 then raise exception 'file grant navigation missing'; end if;
  perform pg_temp.call_materials(manager,'grants-replace',jsonb_build_object('targetType','folder','targetId',folder,'teacherIds','[]'::jsonb));
  perform pg_temp.expect_failure(teacher_a,'authorize',jsonb_build_object('id',material,'permission','display'),'materials_not_found');
  update internal.app_accounts set status='disabled' where account_id=teacher_b;
  perform pg_temp.expect_failure(teacher_b,'list','{}','materials_forbidden');
  update internal.app_accounts set status='active' where account_id=teacher_b;
  insert into public.ops_state(entity,payload) values('unused','[]');
  update public.ops_state set payload=payload || '[{"id":"duplicate","name":"Teacher B"}]'::jsonb where entity='teachers';
  perform pg_temp.expect_failure(teacher_b,'list','{}','materials_forbidden');
  result := pg_temp.call_materials(manager,'list','{"limit":1}');
  if result->>'nextOffset' <> '1' then raise exception 'pagination cursor missing'; end if;
  if (select public from storage.buckets where id='classroom-materials') is distinct from false then raise exception 'bucket not private'; end if;
  if has_table_privilege('anon','internal.classroom_materials','select') or has_table_privilege('authenticated','internal.classroom_materials','insert') then raise exception 'direct metadata access allowed'; end if;
  if not exists(select 1 from internal.operational_contract_audit where action='classroom.material_grants_replaced') then raise exception 'grant audit missing'; end if;
  insert into internal.app_account_permission_overrides(account_id,permission,allowed,updated_by) values(manager,'operations.write',false,'fixture');
  perform pg_temp.expect_failure(manager,'create-folder','{"name":"No write"}','materials_forbidden');
  perform pg_temp.expect_failure(manager,'authorize',jsonb_build_object('id',material,'permission','download'),'materials_forbidden');
  result := pg_temp.call_materials(manager,'list');
  if result->>'canManage' <> 'false' then raise exception 'write override not enforced'; end if;
end $$;
