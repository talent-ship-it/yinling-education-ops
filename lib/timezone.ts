export const DEFAULT_TIMEZONE = "Australia/Melbourne";

// Validation depends on the zone name, never on an occurrence or UTC offset.
const validatedTimezones = new Map<string, string>();
const MAX_VALIDATED_TIMEZONES = 128;

/**
 * Import sources can contain legacy labels or invalid IANA zone names. Keep the
 * original valid zone, but always return a known-safe fallback for malformed values.
 */
export function cleanTimezone(value: unknown) {
  const timezone = typeof value === "string" ? value.split(" · ")[0].trim() : "";
  if (!timezone) return DEFAULT_TIMEZONE;

  const cached = validatedTimezones.get(timezone);
  if (cached) return cached;
  let result = DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    result = timezone;
  } catch {
    // Invalid legacy names retain the existing fallback.
  }
  if (validatedTimezones.size >= MAX_VALIDATED_TIMEZONES) validatedTimezones.delete(validatedTimezones.keys().next().value!);
  validatedTimezones.set(timezone, result);
  return result;
}
