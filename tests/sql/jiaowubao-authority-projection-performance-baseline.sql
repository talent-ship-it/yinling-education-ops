\ir assert-disposable-database.sql
alter function public.project_jiaowubao_open_api_authority(text,text,text) set statement_timeout = '110s';
alter function public.project_jiaowubao_open_api_authority_read_model(text,text,text) set statement_timeout = '110s';
create table internal.fixture_authority_expected (result jsonb not null);
select internal.fixture_seed_authority(16, 20, 16, 16, 16);
select internal.fixture_authority_edges();
do $$
declare expected jsonb;
begin
  begin
    perform public.project_jiaowubao_open_api_authority('projection-job-fixture-secret', 'sha256:' || repeat('a', 64), 'Ops Admin');
    expected := internal.fixture_authority_result();
    raise exception using errcode = 'Z0001';
  exception when sqlstate 'Z0001' then null;
  end;
  insert into internal.fixture_authority_expected values (expected);
end;
$$;
