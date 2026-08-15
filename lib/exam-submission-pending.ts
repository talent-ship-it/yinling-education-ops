type RecordValue = Record<string, unknown>;

const COMMAND_KEY_PATTERN = /^exam-submit:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type PendingExamSubmission = Readonly<{
  intent: string;
  commandKey: string;
  examId: string;
}>;

export type PendingExamRecoveryCommand = Readonly<{
  commandKey: string;
  studentId: string;
  exam: Readonly<RecordValue>;
}>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function pendingExamRecoveryCommand(
  pending: PendingExamSubmission,
): PendingExamRecoveryCommand | null {
  try {
    const parsed = JSON.parse(pending.intent) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2
      || typeof parsed[0] !== "string" || !parsed[0].trim()
      || !isRecord(parsed[1])
      || typeof parsed[1].id !== "string"
      || parsed[1].id !== pending.examId) return null;
    return {
      commandKey: pending.commandKey,
      studentId: parsed[0],
      exam: parsed[1],
    };
  } catch {
    return null;
  }
}

export function parsePendingExamSubmission(value: unknown): PendingExamSubmission | null {
  if (!isRecord(value)
    || typeof value.intent !== "string"
    || typeof value.examId !== "string"
    || typeof value.commandKey !== "string"
    || !COMMAND_KEY_PATTERN.test(value.commandKey)) return null;
  const pending = value as PendingExamSubmission;
  return pendingExamRecoveryCommand(pending) ? pending : null;
}

export function pendingExamMatchesDraft(
  pending: PendingExamSubmission | null,
  studentId: string,
  draft: Readonly<RecordValue>,
) {
  if (!pending) return false;
  const recovery = pendingExamRecoveryCommand(pending);
  if (!recovery || recovery.studentId !== studentId) return false;
  const { id: storedExamId, ...storedDraft } = recovery.exam;
  return storedExamId === pending.examId && JSON.stringify(storedDraft) === JSON.stringify(draft);
}
