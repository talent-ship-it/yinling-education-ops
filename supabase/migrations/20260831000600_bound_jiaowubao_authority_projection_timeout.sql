-- The first authority projection normalizes the complete 31-day JWB snapshot
-- and safely compares it with four native collections. Supabase's short
-- request-role timeout can cancel that bounded first pass before it finishes.
-- Keep the exception scoped to this one function; do not change any role,
-- database, or platform-wide timeout.

alter function public.project_jiaowubao_open_api_authority(text,text,text)
  set statement_timeout = '110s';
