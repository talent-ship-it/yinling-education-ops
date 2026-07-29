export const DEFAULT_TIMEZONE = "Australia/Melbourne";

/**
 * Import sources can contain legacy labels or invalid IANA zone names. Keep the
 * original valid zone, but always return a known-safe fallback for malformed values.
 */
export function cleanTimezone(value: unknown) {
  const timezone = typeof value === "string" ? value.split(" · ")[0].trim() : "";
  if (!timezone) return DEFAULT_TIMEZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}
