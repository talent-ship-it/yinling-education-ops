import type { MonthlyHourDiscrepancy } from "./jiaowubao-monthly-hour-discrepancies";

export function monthlyHourValuesDiffer(row: MonthlyHourDiscrepancy) {
  const { teacherHours, studentHours } = row;
  return row.sourceMatch !== "unlinked"
    && teacherHours !== null && Number.isFinite(teacherHours) && teacherHours >= 0 && teacherHours <= 24
    && studentHours !== null && Number.isFinite(studentHours) && studentHours >= 0
    && Math.round(teacherHours * 10_000) !== Math.round(studentHours * 10_000);
}
