/** Bounded formatter cache. Cache format rules, never user data or UTC offsets:
 * offsets must be recomputed for each instant across daylight-saving changes. */
const formatters = new Map<string, Intl.DateTimeFormat>();
const MAX_FORMATTERS = 64;

export function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify([locale, Object.entries(options).sort(([a], [b]) => a.localeCompare(b))]);
  const existing = formatters.get(key);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat(locale, options);
  if (formatters.size >= MAX_FORMATTERS) formatters.delete(formatters.keys().next().value!);
  formatters.set(key, formatter);
  return formatter;
}
