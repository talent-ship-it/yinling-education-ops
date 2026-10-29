\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
alter table internal.app_account_credentials add column account_id uuid references internal.app_accounts(account_id);
