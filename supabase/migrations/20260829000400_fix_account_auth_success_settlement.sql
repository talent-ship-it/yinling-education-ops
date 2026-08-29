-- Successful logins settle their pre-verification admission. PostgreSQL
-- rejects ORDER BY expressions that are not projected by SELECT DISTINCT, so
-- deduplicate in a subquery before applying the deterministic lock order.
create or replace function public.record_account_auth_attempt(
  p_secret text,
  p_throttle_keys text[],
  p_succeeded boolean
)
returns table (
  blocked boolean,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  recorded_at timestamptz := clock_timestamp();
  throttle_key_value text;
  throttle internal.app_account_auth_throttles%rowtype;
  next_attempts integer;
  next_window timestamptz;
  candidate_block timestamptz;
  latest_block timestamptz;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_succeeded is null or p_throttle_keys is null or cardinality(p_throttle_keys) not between 1 and 4
     or exists (
       select 1 from unnest(p_throttle_keys) key
       where key is null or key !~ '^[ni]:[a-f0-9]{64}$'
     ) then
    raise exception using errcode = '22023', message = 'invalid_auth_throttle_attempt';
  end if;

  if p_succeeded then
    if cardinality(p_throttle_keys) not between 1 and 2
       or (select count(*) from unnest(p_throttle_keys) key where key like 'n:%') <> 1
       or (select count(*) from unnest(p_throttle_keys) key where key like 'i:%') > 1 then
      raise exception using errcode = '22023', message = 'invalid_auth_throttle_settlement';
    end if;
    -- Admission increments before verification so concurrent requests cannot
    -- overrun a threshold. A success reverses only its own increment; it must
    -- never delete failures belonging to another request on the same network
    -- or identity. Locks follow the same network-first order as admission.
    for throttle_key_value in
      select keys.key
      from (
        select distinct supplied.key
        from unnest(p_throttle_keys) as supplied(key)
      ) keys
      order by case when keys.key like 'n:%' then 0 else 1 end, keys.key
    loop
      select * into throttle
      from internal.app_account_auth_throttles t
      where t.throttle_key = throttle_key_value
      for update;
      if throttle.throttle_key is null then continue; end if;
      if throttle.window_started_at < recorded_at - interval '15 minutes' then
        delete from internal.app_account_auth_throttles t
        where t.throttle_key = throttle_key_value;
        continue;
      end if;

      next_attempts := greatest(0, throttle.failed_attempts - 1);
      if next_attempts = 0 then
        delete from internal.app_account_auth_throttles t
        where t.throttle_key = throttle_key_value;
        continue;
      end if;
      candidate_block := case
        when throttle_key_value like 'n:%' and next_attempts >= 500 then recorded_at + interval '5 minutes'
        when throttle_key_value like 'n:%' and next_attempts >= 250 then recorded_at + interval '2 minutes'
        when throttle_key_value like 'n:%' and next_attempts >= 100 then recorded_at + interval '30 seconds'
        when throttle_key_value like 'i:%' and next_attempts >= 10 then recorded_at + interval '1 hour'
        when throttle_key_value like 'i:%' and next_attempts >= 7 then recorded_at + interval '15 minutes'
        when throttle_key_value like 'i:%' and next_attempts >= 5 then recorded_at + interval '2 minutes'
        else null
      end;
      update internal.app_account_auth_throttles t
      set failed_attempts = next_attempts,
          blocked_until = candidate_block,
          updated_at = recorded_at
      where t.throttle_key = throttle_key_value;
    end loop;
    return query select false, 0;
    return;
  end if;

  for throttle_key_value in
    select keys.key
    from (
      select distinct supplied.key
      from unnest(p_throttle_keys) as supplied(key)
    ) keys
    order by case when keys.key like 'n:%' then 0 else 1 end, keys.key
  loop
    insert into internal.app_account_auth_throttles(throttle_key, failed_attempts, window_started_at, updated_at)
    values (throttle_key_value, 0, recorded_at, recorded_at)
    on conflict (throttle_key) do nothing;

    select * into throttle
    from internal.app_account_auth_throttles t
    where t.throttle_key = throttle_key_value
    for update;

    if throttle.window_started_at < recorded_at - interval '15 minutes' then
      next_attempts := 1;
      next_window := recorded_at;
    else
      next_attempts := throttle.failed_attempts + 1;
      next_window := throttle.window_started_at;
    end if;

    candidate_block := case
      when throttle_key_value like 'n:%' and next_attempts >= 500 then recorded_at + interval '5 minutes'
      when throttle_key_value like 'n:%' and next_attempts >= 250 then recorded_at + interval '2 minutes'
      when throttle_key_value like 'n:%' and next_attempts >= 100 then recorded_at + interval '30 seconds'
      when throttle_key_value like 'i:%' and next_attempts >= 10 then recorded_at + interval '1 hour'
      when throttle_key_value like 'i:%' and next_attempts >= 7 then recorded_at + interval '15 minutes'
      when throttle_key_value like 'i:%' and next_attempts >= 5 then recorded_at + interval '2 minutes'
      else null
    end;

    update internal.app_account_auth_throttles t
    set failed_attempts = next_attempts,
        window_started_at = next_window,
        blocked_until = case
          when candidate_block is null then throttle.blocked_until
          else greatest(coalesce(throttle.blocked_until, candidate_block), candidate_block)
        end,
        updated_at = recorded_at
    where t.throttle_key = throttle_key_value;
  end loop;

  select max(t.blocked_until) into latest_block
  from internal.app_account_auth_throttles t
  where t.throttle_key = any(p_throttle_keys)
    and t.blocked_until > recorded_at;

  return query select latest_block is not null,
    case when latest_block is null then 0
      else greatest(1, ceil(extract(epoch from latest_block - recorded_at))::integer)
    end;
end;
$$;

revoke all on function public.record_account_auth_attempt(text, text[], boolean)
  from public, anon, authenticated;
grant execute on function public.record_account_auth_attempt(text, text[], boolean)
  to anon, authenticated;
