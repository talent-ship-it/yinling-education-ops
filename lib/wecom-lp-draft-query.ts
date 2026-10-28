import { DateTime } from "luxon";
import { displayTimezoneOptions } from "./display-preferences";
import { LpAtomicError } from "./lp-atomic-service";
import { WECOM_HANDOVER_TIMEZONE } from "./wecom-lp-draft-timezone";

export type WecomLpDraftQuery = Readonly<{
  cursor: string | null;
  from: string | null;
  before: string | null;
  query?: string;
  scheduleMatch?: "matched" | "unmatched";
}>;

function invalid(message: string): never { throw new LpAtomicError("invalid_command", message); }

function parseBoundary(date: string, timezone: string) {
  const minute = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(date);
  if (!minute && !/^\d{4}-\d{2}-\d{2}$/u.test(date)) invalid("请选择有效的交接日期。");
  const instant = DateTime.fromISO(date, { zone: timezone });
  const canonical = minute ? instant.toFormat("yyyy-MM-dd'T'HH:mm") : instant.toISODate();
  if (!instant.isValid || instant.year < 1900 || canonical !== date) invalid("请选择有效的交接日期。");
  return { instant, minute };
}

function boundary(date: string | null, timezone: string, exclusiveEnd: boolean) {
  if (!date) return null;
  const { instant, minute } = parseBoundary(date, timezone);
  const bound = exclusiveEnd ? minute ? instant.plus({ minutes: 1 }) : instant.plus({ days: 1 }).startOf("day") : instant;
  const iso = bound.toUTC().toISO();
  if (!iso || bound.year > 9999) invalid("请选择有效的交接日期。");
  return iso;
}

export function parseWecomLpDraftQuery(params: URLSearchParams): WecomLpDraftQuery {
  const allowed = ["cursor", "from", "to", "timezone", "query", "scheduleMatch"];
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid("交接筛选参数无效。");
  }
  const cursor = params.get("cursor") || null;
  if (cursor && !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,239}$/u.test(cursor)) invalid("分页参数无效。");
  const timezone = params.get("timezone") ?? WECOM_HANDOVER_TIMEZONE;
  if (!displayTimezoneOptions.some((option) => option.id === timezone)) invalid("请选择有效的交接时间时区。");
  const from = boundary(params.get("from") || null, timezone, false);
  const before = boundary(params.get("to") || null, timezone, true);
  if (from && before && from >= before) invalid("结束日期不能早于开始日期。");
  const query = (params.get("query") ?? "").trim();
  if (query.length > 240 || /[\u0000-\u001f\u007f]/u.test(query)) invalid("请输入有效的交接搜索内容。");
  const scheduleMatch = params.get("scheduleMatch") ?? "all";
  if (!["all", "matched", "unmatched"].includes(scheduleMatch)) invalid("请选择有效的课表匹配状态。");
  return { cursor, from, before, ...(query ? { query } : {}), ...(scheduleMatch !== "all" ? { scheduleMatch: scheduleMatch as "matched" | "unmatched" } : {}) };
}
