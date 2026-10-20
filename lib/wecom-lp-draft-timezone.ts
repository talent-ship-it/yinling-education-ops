import { displayTimezoneOptions } from "./display-preferences";

export function wecomDraftTimezone(location: unknown) {
  if (typeof location !== "string") return "";
  const value = location.trim();
  if (displayTimezoneOptions.some((option) => option.id === value)) return value;
  return ({ VIC: "Australia/Melbourne", NSW: "Australia/Sydney", QLD: "Australia/Brisbane", WA: "Australia/Perth", SA: "Australia/Adelaide", NZ: "Pacific/Auckland", "国内": "Asia/Shanghai" } as Record<string, string>)[value.toUpperCase()] ?? "";
}
