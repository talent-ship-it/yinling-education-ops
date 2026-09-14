\set ON_ERROR_STOP on

-- Database owners must explicitly mark a disposable test database. The name
-- and marker are both checked on the primary connection and every dblink.
create or replace function pg_temp.disposable_database_assertion_sql()
returns text language sql as $function$
  select $statement$do $guard$
  begin
    if current_database() !~ '^il_fixture_[a-z0-9_]+$'
       or coalesce((select pg_catalog.shobj_description(oid, 'pg_database')
                    from pg_catalog.pg_database where datname = current_database()), '')
          <> 'insiderleads-disposable-fixture' then
      raise exception 'Refusing fixture: database must be named il_fixture_* and marked insiderleads-disposable-fixture';
    end if;
  end;
  $guard$;$statement$;
$function$;
do $local_guard$
begin
  execute pg_temp.disposable_database_assertion_sql();
end;
$local_guard$;
