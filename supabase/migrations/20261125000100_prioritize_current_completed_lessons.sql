do $patch$
declare
  definition text;
  needle text := $needle$  order by case when state in ('collecting','ready') then 0 else 1 end,
    due_at, coalesce(started_at, '-infinity'::timestamptz), period_month$needle$;
  replacement text := $replacement$  order by case when state = 'ready' then 0
      when period_month = current_month then 1
      when period_month = cast(current_month - interval '1 month' as date) then 2
      else 3 end,
    case when state = 'collecting' then 0 else 1 end,
    due_at, coalesce(started_at, '-infinity'::timestamptz), period_month$replacement$;
begin
  definition := pg_get_functiondef('public.get_jiaowubao_completed_lesson_pending_month(text,text)'::regprocedure);
  if length(definition) - length(replace(definition, needle, '')) <> length(needle) then
    raise exception 'jiaowubao_completed_lesson_queue_anchor_missing';
  end if;
  execute replace(definition, needle, replacement);
end;
$patch$;
