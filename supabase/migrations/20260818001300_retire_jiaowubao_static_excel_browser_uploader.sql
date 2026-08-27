-- Retire the rejected browser-based Jiaowubao Excel uploader.
--
-- The 011 ledger tables are deliberately left untouched and inert: this
-- forward migration neither reads, writes, deletes, nor changes them.  It
-- only removes the two public RPC entry points that exposed the uploader's
-- server-side path.  A future reviewed one-off import can use a separate,
-- explicitly approved database operation instead of restoring a browser
-- upload surface.

set local lock_timeout = '1s';

do $retire_jiaowubao_static_excel_browser_uploader$
begin
  if to_regprocedure('public.get_current_student_import_master_source(text)') is not null then
    revoke all on function public.get_current_student_import_master_source(text)
      from public, anon, authenticated;
  end if;
  -- Intentionally RESTRICT: an unexpected dependency stops the migration
  -- instead of changing another database object.
  drop function if exists public.get_current_student_import_master_source(text);

  if to_regprocedure('public.put_jiaowubao_static_excel_supplement(text,text,text,jsonb,text)') is not null then
    revoke all on function public.put_jiaowubao_static_excel_supplement(text, text, text, jsonb, text)
      from public, anon, authenticated;
  end if;
  -- Intentionally RESTRICT.
  drop function if exists public.put_jiaowubao_static_excel_supplement(text, text, text, jsonb, text);
end;
$retire_jiaowubao_static_excel_browser_uploader$;
