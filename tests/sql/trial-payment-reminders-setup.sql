\set ON_ERROR_STOP on
\ir assert-disposable-database.sql

-- Compile the authoritative payment reminder migration against its real
-- booking projection seam before loading the current completion function.
\ir booking-projection-atomic-runtime.sql
\ir ../../supabase/migrations/20260819102000_trial_payment_reminders_authoritative.sql
