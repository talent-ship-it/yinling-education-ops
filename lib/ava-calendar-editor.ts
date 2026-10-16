import { DateTime } from "luxon";

export function calendarEditorOffsets(value: string, zone: string) {
  const date = DateTime.fromISO(value, { zone });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !date.isValid || date.toFormat("yyyy-MM-dd'T'HH:mm") !== value) throw new Error("这个本地时间不存在，请重新选择。");
  return date.getPossibleOffsets().sort((left, right) => left.toMillis() - right.toMillis());
}
export function calendarEditorInstant(value: string, zone: string, offset?: "earlier" | "later") {
  const dates = calendarEditorOffsets(value, zone);
  if (dates.length > 1 && !offset) throw new Error("这个时间重复出现，请选择 UTC 偏移。");
  return dates[offset === "later" ? dates.length - 1 : 0]!.toUTC().toISO()!;
}
