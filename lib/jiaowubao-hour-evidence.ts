export type JiaowubaoHourIssue = "missing" | "non_numeric" | "out_of_range";

export type JiaowubaoHourEvidence = Readonly<{
  hours: number | null;
  hoursIssue?: JiaowubaoHourIssue;
}>;

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

export function sourceJiaowubaoHour(value: unknown): JiaowubaoHourEvidence {
  if (value === null || value === undefined || value === "" || (typeof value === "string" && !value.trim())) {
    return { hours: null, hoursIssue: "missing" };
  }
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && DECIMAL.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isFinite(parsed)) return { hours: null, hoursIssue: "non_numeric" };
  if (parsed < 0 || parsed > 24) return { hours: parsed, hoursIssue: "out_of_range" };
  return { hours: Number(parsed.toFixed(4)) };
}

export function snapshotJiaowubaoHour(value: unknown, issue: unknown): JiaowubaoHourEvidence {
  if (issue === "missing" || issue === "non_numeric") {
    if (value !== null) throw new Error("教务宝来源异常课时格式无效。");
    return { hours: null, hoursIssue: issue };
  }
  if (issue === "out_of_range") {
    if (typeof value !== "number" || !Number.isFinite(value) || (value >= 0 && value <= 24)) {
      throw new Error("教务宝来源异常课时格式无效。");
    }
    return { hours: value, hoursIssue: issue };
  }
  if (issue !== undefined) throw new Error("教务宝来源异常课时格式无效。");
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 24
    || Number(value.toFixed(4)) !== value) {
    throw new Error("教务宝来源课时格式无效。");
  }
  return { hours: value };
}

export function snapshotJiaowubaoOptionalHour(value: unknown, issue: unknown): JiaowubaoHourEvidence {
  if (value === null && issue === undefined) return { hours: null };
  return snapshotJiaowubaoHour(value, issue);
}
