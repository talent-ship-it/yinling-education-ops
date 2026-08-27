-- Supabase CLI 2.75.0 mis-parses the token "atomic" when another SQL
-- statement follows it. Keep this legacy RPC revocation as one statement.
revoke all on function public.complete_trial_payment_task_atomic(
  text, text, jsonb, text, jsonb, text, text
) from public, anon, authenticated, service_role;
