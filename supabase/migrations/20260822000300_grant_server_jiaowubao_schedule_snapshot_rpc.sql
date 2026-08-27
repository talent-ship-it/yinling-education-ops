-- The production sync runs in a Next.js server route through PostgREST.
-- These four public wrappers remain secret-gated SECURITY DEFINER functions:
-- browser callers have no OPS_API_SECRET, and direct source tables remain
-- private. Granting only the exact ingest sequence lets the server publish an
-- immutable, fully staged snapshot without exposing status, abort, or data
-- readers to the browser role.

grant execute on function public.get_jiaowubao_open_api_schedule_snapshot_preflight(text,text,text) to anon, authenticated;
grant execute on function public.begin_jiaowubao_open_api_schedule_snapshot_ingest(text,jsonb,text) to anon, authenticated;
grant execute on function public.stage_jiaowubao_open_api_schedule_snapshot_page(text,uuid,integer,jsonb,text) to anon, authenticated;
grant execute on function public.complete_jiaowubao_open_api_schedule_snapshot_ingest(text,uuid,text) to anon, authenticated;

comment on function public.get_jiaowubao_open_api_schedule_snapshot_preflight(text,text,text) is
  'Server-only JWB schedule snapshot preflight. Requires OPS_API_SECRET; no source records returned.';
