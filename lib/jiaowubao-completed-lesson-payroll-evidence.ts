/**
 * Display-only merger for a saved payroll row and the newest immutable
 * 教务宝 `over=1` evidence.  Rates, payment details, amounts and approval
 * state stay with the saved payroll record; only source reconciliation fields
 * and student evidence are refreshed for review and export.
 */

export type JiaowubaoPayrollEvidenceSource<Line> = Readonly<{
  /** Null means the immutable source evidence is incomplete or unresolved. */
  sourceHours: number | null;
  sourceLessonCount: number | null;
  sourceNoShowHours: number | null;
  lines: readonly Line[];
}>;

/**
 * Monthly student grouping key for completed-lesson evidence.
 *
 * Shared trial A/B/C accounts deliberately reuse one supplier member ID for
 * many real learners, so an unmatched shared account must never group on that
 * ID. A safely parsed display name keeps those learners separate; if even that
 * is unavailable, retain each immutable source row independently for review.
 */
export function jiaowubaoPayrollStudentAggregationKey(input: Readonly<{
  studentId: string | null;
  displayStudentName: string | null;
  branchId: string;
  memberId: string;
  sourceKey: string;
}>) {
  if (input.studentId) return `internal:${input.studentId}`;
  if (input.displayStudentName) {
    const name = input.displayStudentName.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-AU");
    if (name) return `display:${name}`;
  }
  return `source:${input.branchId}:${input.memberId}:${input.sourceKey}`;
}

type PersistedPayrollWithEvidenceFields<Line> = Readonly<{
  lessons: number;
  trialLessons: number;
  amount?: number;
  teacherTotalAmount?: number;
  lineAmount?: number;
  rateRange?: number[];
  status?: string;
  note?: string;
  paymentNote?: string;
  bankName?: string;
  bankAccount?: string;
  lockedBy?: string;
  lockedAt?: string;
  teacherTotalHours?: number;
  sourceHours?: number | null;
  sourceLessonCount?: number | null;
  sourceNoShowHours?: number | null;
  hourVariance?: number | null;
  lineCount?: number;
  lines?: Line[];
}>;

export function overlayPersistedPayrollWithJiaowubaoEvidence<
  Line extends object,
  Row extends PersistedPayrollWithEvidenceFields<Line>,
>(persisted: Row, source: JiaowubaoPayrollEvidenceSource<Line>) {
  const payrollHours = persisted.teacherTotalHours ?? persisted.lessons + persisted.trialLessons;
  return {
    ...persisted,
    sourceHours: source.sourceHours,
    sourceLessonCount: source.sourceLessonCount,
    sourceNoShowHours: source.sourceNoShowHours,
    hourVariance: source.sourceHours === null
      ? null
      : Number((payrollHours - source.sourceHours).toFixed(4)),
    // Clone so a render/export consumer cannot mutate the immutable source
    // snapshot through the display row.
    lines: source.lines.map((line) => ({ ...line })),
    lineCount: source.lines.length,
  };
}

/**
 * Produces a review-only view when the current immutable source cannot safely
 * generate payroll. The saved row remains untouched, while every field that
 * could be mistaken for a payment instruction is removed from the derived
 * display/export row.
 */
export function reviewOnlyPersistedPayrollWithJiaowubaoEvidence<
  Line extends object,
  Row extends PersistedPayrollWithEvidenceFields<Line>,
>(
  persisted: Row,
  source: JiaowubaoPayrollEvidenceSource<Line>,
  options: Readonly<{ reviewReason: string }>,
) {
  const reviewNote = `仅保留教务宝 over=1 双源资料：${options.reviewReason}，不会写入薪资或付款资料。`;
  return {
    ...persisted,
    lessons: 0,
    trialLessons: 0,
    teacherTotalHours: 0,
    teacherTotalAmount: 0,
    lineAmount: undefined,
    amount: 0,
    rateRange: [],
    status: "需核对" as const,
    paymentReviewOnly: true as const,
    note: reviewNote,
    paymentNote: reviewNote,
    bankName: undefined,
    bankAccount: undefined,
    lockedBy: undefined,
    lockedAt: undefined,
    sourceHours: source.sourceHours,
    sourceLessonCount: source.sourceLessonCount,
    sourceNoShowHours: source.sourceNoShowHours,
    hourVariance: null,
    lines: source.lines.map((line) => ({ ...line })),
    lineCount: source.lines.length,
  };
}
