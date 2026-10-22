set local lock_timeout = '3s';
set local statement_timeout = '30s';

create or replace function internal.wecom_lp_explicit_types(p_body text)
returns text[] language sql immutable strict set search_path = '' as $$
  with lines as (
    select line, regexp_replace(regexp_replace(line,'\[Rose\]|\[玫瑰\]|🌹','','gi'),'[[:space:]【】\[\]]','','g') as heading
    from regexp_split_to_table(pg_catalog.normalize(p_body,'NFKC'), E'\n') line
  ), labels as (
    select upper(regexp_replace(coalesce(
      (regexp_match(heading,'^(.*?)信息交接(表|单)?$'))[1],
      (regexp_match(line,'^[[:space:]【\[]*(LP类型|业务类型)[】\]]*[[:space:]]*[:：][[:space:]]*(.*?)[[:space:]]*$'))[2]
    ),'[[:space:]【】\[\]]','','g')) as label from lines
  ), types as (
    select case label
      when '试听LP' then '试听 LP'
      when '老生新LP' then '老师新 LP'
      when '老生加课LP' then '老师新 LP'
      when '老师新LP' then '老师新 LP'
      when '二次试听' then '试听 LP'
      when '换老师试听' then '换老师试听'
      when '老生LP修改' then '老师 LP 修改'
      when '老师LP修改' then '老师 LP 修改'
    end as kind from labels
  )
  select coalesce(array_agg(distinct kind order by kind) filter (where kind is not null),array[]::text[]) from types;
$$;
revoke all on function internal.wecom_lp_explicit_types(text) from public, anon, authenticated, service_role;


do $repeat_trial_contracts$
declare definition text; signature text; old_fragment text; new_fragment text;
begin
  signature := 'internal.wecom_is_lp_template(text)';
  definition := pg_catalog.pg_get_functiondef(signature::pg_catalog.regprocedure);
  old_fragment := $old$('换老师试听' = any(internal.wecom_lp_explicit_types(p_body)) and$old$;
  new_fragment := $new$(internal.wecom_lp_explicit_types(p_body) && array['试听 LP','换老师试听']::text[] and$new$;
  if strpos(definition,old_fragment) = 0 then raise exception 'wecom_repeat_template_contract_drift'; end if;
  execute replace(definition,old_fragment,new_fragment);

  signature := 'internal.resolve_wecom_lp_business_identity()';
  definition := pg_catalog.pg_get_functiondef(signature::pg_catalog.regprocedure);
  old_fragment := $old$     or internal.wecom_lp_template_type(new.body) = '试听 LP'$old$;
  if strpos(definition,old_fragment) = 0 then raise exception 'wecom_repeat_identity_contract_drift'; end if;
  execute replace(definition,old_fragment,'');

  old_fragment := $old$array['老师新 LP','老师 LP 修改','换老师试听']::text[]$old$;
  new_fragment := $new$array['试听 LP','老师新 LP','老师 LP 修改','换老师试听']::text[]$new$;
  foreach signature in array array[
    'internal.capture_wecom_lp_business_source()',
    'internal.wecom_lp_draft_source(text)',
    'public.read_wecom_lp_drafts(text,text,boolean,text,integer)',
    'public.read_wecom_lp_drafts_in_range(text,text,boolean,text,integer,timestamptz,timestamptz)'
  ] loop
    definition := pg_catalog.pg_get_functiondef(signature::pg_catalog.regprocedure);
    if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment) <> (case when signature like 'public.read_wecom_lp_drafts_in_range(%' then 2 else 1 end) then
      raise exception 'wecom_repeat_source_contract_drift: %',signature;
    end if;
    execute replace(definition,old_fragment,new_fragment);
  end loop;
end;
$repeat_trial_contracts$;

update internal.wecom_handover_schedule_epoch set revision = revision + 1 where singleton;
