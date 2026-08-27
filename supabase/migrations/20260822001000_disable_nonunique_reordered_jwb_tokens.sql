-- 220009's token experiment found no complete token-set pairs in the current
-- source and only created extra collision diagnostics. Keep its private
-- helper harmlessly available, but restore the reviewed canonical behavior:
-- only exact names and unique Chinese cores attach JWB enrichment.
do $student_import_reordered_token_revert$
declare
  definition text;
  anchor text;
  replacement text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection_170008_base(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_projection_base_missing_for_token_revert';
  end if;

  anchor := $match$    elsif not linked and master_jwb_member_id_safe then
      master_name_count := coalesce((master_auto_name_counts ->> name_key)::integer, 0);
      jwb_name_count := coalesce(
        ((jwb_auto_name_entries -> name_key) ->> 'count')::integer, 0
      );
      if master_name_count = 1 and jwb_name_count = 1 then
        matched_jwb := (jwb_auto_name_entries -> name_key) -> 'row';
      elsif name_token_key <> '' then
        master_name_count := coalesce((master_auto_name_token_counts ->> name_token_key)::integer, 0);
        jwb_name_count := coalesce(
          ((jwb_auto_name_token_entries -> name_token_key) ->> 'count')::integer, 0
        );
        if master_name_count = 1 and jwb_name_count = 1 then
          matched_jwb := (jwb_auto_name_token_entries -> name_token_key) -> 'row';
        end if;
      end if;$match$;
  replacement := $match$    elsif not linked and master_jwb_member_id_safe then
      master_name_count := coalesce((master_auto_name_counts ->> name_key)::integer, 0);
      jwb_name_count := coalesce(
        ((jwb_auto_name_entries -> name_key) ->> 'count')::integer, 0
      );
      if master_name_count = 1 and jwb_name_count = 1 then
        matched_jwb := (jwb_auto_name_entries -> name_key) -> 'row';
      end if;$match$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_reordered_token_revert_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);
  execute definition;
end;
$student_import_reordered_token_revert$;

revoke all on function internal.student_import_canonical_projection_170008_base(
  text, jsonb, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;
