\set ON_ERROR_STOP on
\ir assert-disposable-database.sql

create table internal.app_accounts (
  account_id uuid primary key,
  identity_key text not null unique,
  account_name text not null,
  account_role text not null,
  status text not null,
  created_by text not null,
  updated_by text not null
);
