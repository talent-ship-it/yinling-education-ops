-- The production API role intentionally has a short general statement timeout,
-- while the administrator-only student reconciliation performs one larger,
-- atomic projection and validation. Scope the exception to that single RPC so
-- ordinary anon/authenticated queries keep the role-wide guardrail.

begin;

do $student_import_commit_timeout_contract$
begin
  if to_regprocedure(
    'public.commit_student_import_plan_atomic(text,text,bigint,jsonb,jsonb,text)'
  ) is null then
    raise exception 'student_import_commit_rpc_missing';
  end if;
end;
$student_import_commit_timeout_contract$;

alter function public.commit_student_import_plan_atomic(
  text, text, bigint, jsonb, jsonb, text
)
  security definer;

alter function public.commit_student_import_plan_atomic(
  text, text, bigint, jsonb, jsonb, text
)
  set search_path = '';

alter function public.commit_student_import_plan_atomic(
  text, text, bigint, jsonb, jsonb, text
)
  set statement_timeout = '30s';

revoke all on function public.commit_student_import_plan_atomic(
  text, text, bigint, jsonb, jsonb, text
)
  from public, anon, authenticated;
grant execute on function public.commit_student_import_plan_atomic(
  text, text, bigint, jsonb, jsonb, text
)
  to anon, authenticated;

commit;
