import { DateTime } from "luxon";
import { displayTimezoneOptions } from "./display-preferences";
import { LpAtomicError } from "./lp-atomic-service";
import { WECOM_HANDOVER_TIMEZONE } from "./wecom-lp-draft-timezone";

export type WecomLpDraftQuery = Readonly<{ cursor: string | null; from: string | null; before: string | null }>;

function invalid(message: string): never { throw new LpAtomicError("invalid_command", message); }

function boundary(date: string | null, timezone: string, nextDay: boolean) {
  if (!date) return null;
  const day = DateTime.fromISO(date, { zone: timezone }).startOf("day");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !day.isValid || day.year < 1900 || day.toISODate() !== date) invalid("请选择有效的交接日期。");
  const bound = nextDay ? day.plus({ days: 1 }).startOf("day") : day;
  const iso = bound.toUTC().toISO();
  if (!iso || bound.year > 9999) invalid("请选择有效的交接日期。");
  return iso;
}

export function parseWecomLpDraftQuery(params: URLSearchParams): WecomLpDraftQuery {
  const allowed = ["cursor", "from", "to", "timezone"];
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid("交接筛选参数无效。");
  }
  const cursor = params.get("cursor") || null;
  if (cursor && !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,239}$/u.test(cursor)) invalid("分页参数无效。");
  const timezone = params.get("timezone") ?? WECOM_HANDOVER_TIMEZONE;
  if (!displayTimezoneOptions.some((option) => option.id === timezone)) invalid("请选择有效的交接时间时区。");
  const from = params.get("from") || null;
  const to = params.get("to") || null;
  if (from && to && from > to) invalid("结束日期不能早于开始日期。");
  return { cursor, from: boundary(from, timezone, false), before: boundary(to, timezone, true) };
}
