do $repost_identity_prefilter$
declare definition text; old_fragment text; new_fragment text;
begin
  definition := pg_catalog.pg_get_functiondef('internal.wecom_lp_superseded_by(text)'::regprocedure);
  old_fragment := $old$    and (m.sent_at, m.message_id) > (source.sent_at, source.message_id)
    and internal.wecom_lp_repost_key(m) = source_key$old$;
  new_fragment := $new$    and (m.sent_at, m.message_id) > (source.sent_at, source.message_id)
    and m.trial_handover_id is not distinct from source.trial_handover_id
    and internal.wecom_lp_repost_key(m) = source_key$new$;
  if (length(definition) - length(replace(definition, old_fragment, ''))) / length(old_fragment) <> 1 then
    raise exception 'wecom_lp_repost_identity_prefilter_drift';
  end if;
  execute replace(definition, old_fragment, new_fragment);
end;
$repost_identity_prefilter$;
