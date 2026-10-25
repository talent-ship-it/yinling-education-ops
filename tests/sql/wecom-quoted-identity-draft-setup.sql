\ir assert-disposable-database.sql
alter function internal.wecom_lp_draft_source(text) rename to wecom_lp_trial_draft_source;
create function internal.wecom_is_trial_lp_template(p_body text)
returns boolean language sql immutable strict set search_path = '' as $$ select internal.wecom_is_lp_template(p_body) $$;
