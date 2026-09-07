begin;
create table internal.teacher_leave_requests (
 id uuid primary key,
 teacher_id text not null,
 actor text not null,
 start_date date not null,
 end_date date not null,
 reason text not null check (length(reason) between 8 and 1000),
 created_at timestamptz not null default now(),
 check (end_date >= start_date and end_date <= start_date + 366)
);
alter table internal.teacher_leave_requests enable row level security;
revoke all on internal.teacher_leave_requests from public, anon, authenticated, service_role;
create index teacher_leave_requests_teacher_created_idx on internal.teacher_leave_requests(teacher_id, created_at desc);
create function public.submit_teacher_leave_request(p_secret text, p_id uuid, p_teacher_id text, p_actor text, p_start date, p_end date, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare existing internal.teacher_leave_requests;
begin
 if internal.verify_ops_secret(p_secret) is not true then raise exception 'unauthorized'; end if;
 if p_start < (now() at time zone 'Australia/Melbourne')::date then raise exception 'past_leave_request'; end if;
 insert into internal.teacher_leave_requests(id,teacher_id,actor,start_date,end_date,reason)
 values(p_id,p_teacher_id,p_actor,p_start,p_end,p_reason) on conflict(id) do nothing;
 select * into existing from internal.teacher_leave_requests where id=p_id;
 if existing.teacher_id <> p_teacher_id or existing.actor <> p_actor or existing.start_date <> p_start or existing.end_date <> p_end or existing.reason <> p_reason then raise exception 'request_id_conflict'; end if;
 return p_id;
end; $$;
create function public.read_teacher_leave_requests(p_secret text, p_teacher_ids text[])
returns setof internal.teacher_leave_requests language plpgsql security definer set search_path = '' as $$
begin
 if internal.verify_ops_secret(p_secret) is not true then raise exception 'unauthorized'; end if;
 return query select * from internal.teacher_leave_requests where teacher_id=any(p_teacher_ids) order by created_at desc limit 100;
end; $$;
revoke all on function public.submit_teacher_leave_request(text,uuid,text,text,date,date,text) from public;
revoke all on function public.read_teacher_leave_requests(text,text[]) from public;
grant execute on function public.submit_teacher_leave_request(text,uuid,text,text,date,date,text) to anon,authenticated,service_role;
grant execute on function public.read_teacher_leave_requests(text,text[]) to anon,authenticated,service_role;
commit;
