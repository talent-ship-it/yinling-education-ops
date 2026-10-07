export function melbourneHourDate(now = new Date()) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function monthlyHourCoverage(month: string, dataThrough?: string | null, provisional?: boolean) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) throw new Error("课时月份无效。");
  const start = `${month}-01`;
  const last = new Date(`${start}T00:00:00.000Z`);
  last.setUTCMonth(last.getUTCMonth() + 1);
  last.setUTCDate(0);
  const monthEnd = last.toISOString().slice(0, 10);
  const end = dataThrough ?? monthEnd;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(end) || end < start || end > monthEnd
    || new Date(`${end}T00:00:00.000Z`).toISOString().slice(0, 10) !== end
    || (provisional !== undefined && provisional !== (end < monthEnd))) throw new Error("课时截止日期无效。");
  return Object.freeze({ month, start, end, monthEnd, provisional: end < monthEnd });
}

export function monthlyHourCollectionPeriod(month: string, now = new Date(), pinnedEnd?: string) {
  const today = melbourneHourDate(now);
  const yesterday = new Date(`${today}T00:00:00.000Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const cutoff = yesterday.toISOString().slice(0, 10);
  const full = monthlyHourCoverage(month);
  const period = monthlyHourCoverage(month, pinnedEnd ?? (full.monthEnd < cutoff ? full.monthEnd : cutoff));
  if (period.end > cutoff) throw new Error("只能采集截至墨尔本昨日的已消课资料。");
  return period;
}

export function monthlyHourRefreshDue(input: Readonly<{
  month: string; dataThrough: string; publishedAt: string | null; now: Date;
}>) {
  const desired = monthlyHourCollectionPeriod(input.month, input.now);
  if (input.dataThrough < desired.end) return true;
  if (input.publishedAt === null) return true;
  const published = Date.parse(input.publishedAt);
  if (!Number.isFinite(published) || published > input.now.valueOf()) throw new Error("课时发布时间无效。");
  const previous = new Date(`${melbourneHourDate(input.now).slice(0, 7)}-01T00:00:00.000Z`);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  const interval = input.month >= previous.toISOString().slice(0, 7) ? 86_400_000 : 7 * 86_400_000;
  return input.now.valueOf() - published >= interval;
}
