import "server-only";

import {
  attendanceEvidenceFromBbb,
  bbbEvidenceReference,
  bbbMeetingBindings,
  bbbNonceSha256,
  meetingIdForOccurrenceValue,
  type BbbAnalyticsPayload,
} from "@/lib/bbb-analytics";
import {
  parseCompleteLessonOccurrenceRequest,
  prepareLessonOccurrenceSettlement,
} from "@/lib/lesson-occurrence-service";
import {
  completeLessonOccurrenceAtomic,
  getOpsState,
  OpsStoreError,
  putLessonAttendanceEvidence,
} from "@/lib/ops-store";

const BBB_SETTLEMENT_MAX_ATTEMPTS = 3;

function isRetryableSettlementConflict(error: unknown) {
  return error instanceof OpsStoreError
    && (error.code === "40001" || error.message === "version_conflict");
}

export type BbbAnalyticsProcessingResult = Readonly<{
  occurrenceId: string;
  evidenceReference: string;
  applied: boolean;
  disposition: "completed" | "abnormal";
  version: number;
  auditEntryId?: string;
}>;

/**
 * The callback is a trusted provider command: it has no demo cookie and all
 * identities/amounts are re-derived from the current server-owned booking.
 */
export async function processBbbAnalyticsCallback(input: {
  payload: BbbAnalyticsPayload;
  callbackNonce: string;
}): Promise<BbbAnalyticsProcessingResult> {
  const bindings = bbbMeetingBindings(input.payload);
  if (input.payload.meetingId !== meetingIdForOccurrenceValue(bindings.occurrenceId)) {
    throw new Error("bbb_meeting_id_mismatch");
  }
  const finishedAt = Date.parse(input.payload.finishedAt);
  const startedAt = Date.parse(input.payload.startedAt);
  if (finishedAt - startedAt > 24 * 60 * 60 * 1_000 || input.payload.durationSeconds > 24 * 60 * 60) {
    throw new Error("bbb_meeting_duration_invalid");
  }
  const evidenceReference = bbbEvidenceReference(input.payload.internalMeetingId);
  const evidence = attendanceEvidenceFromBbb(input.payload);
  const prepareCurrent = async () => {
    const rows = await getOpsState(["students", "teachers", "bookings", "payroll"]);
    const bookingsVersion = rows.find((row) => row.entity === "bookings")?.version;
    if (!Number.isSafeInteger(bookingsVersion) || (bookingsVersion as number) < 1) {
      throw new Error("bookings_state_unavailable");
    }
    const request = parseCompleteLessonOccurrenceRequest({
      occurrenceId: bindings.occurrenceId,
      expectedVersion: bookingsVersion,
      attendanceEvidenceReference: evidenceReference,
    });
    const prepared = prepareLessonOccurrenceSettlement({
      request,
      rows,
      actor: "BigBlueButton",
      fullAdmin: false,
      trustedProvider: "bbb",
      attendance: evidence,
      completedAt: input.payload.finishedAt,
    });
    if (prepared.occurrence.studentId !== bindings.studentId || prepared.occurrence.teacherId !== bindings.teacherId) {
      throw new Error("bbb_party_binding_mismatch");
    }
    return { request, prepared };
  };
  let current = await prepareCurrent();
  const savedEvidence = await putLessonAttendanceEvidence({
    reference: evidenceReference,
    occurrenceId: bindings.occurrenceId,
    capturedAt: input.payload.finishedAt,
    evidence,
    provider: "bbb",
    actor: "BigBlueButton",
  });
  let saved: Awaited<ReturnType<typeof completeLessonOccurrenceAtomic>> | undefined;
  for (let attempt = 0; attempt < BBB_SETTLEMENT_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) current = await prepareCurrent();
    try {
      saved = await completeLessonOccurrenceAtomic({
        occurrenceId: current.prepared.occurrence.occurrenceId,
        expectedVersion: current.request.expectedVersion,
        stateVersions: current.prepared.stateVersions,
        idempotencyKey: current.prepared.idempotencyKey,
        settlement: current.prepared.settlement,
        attendanceReference: savedEvidence.reference,
        actor: "BigBlueButton",
        callbackNonceSha256: bbbNonceSha256(input.callbackNonce),
      });
      break;
    } catch (error) {
      if (!isRetryableSettlementConflict(error) || attempt + 1 >= BBB_SETTLEMENT_MAX_ATTEMPTS) throw error;
    }
  }
  const result = saved?.[0];
  if (!result) throw new Error("bbb_settlement_result_missing");
  return {
    occurrenceId: result.occurrence_id,
    evidenceReference,
    applied: result.applied,
    disposition: result.disposition as "completed" | "abnormal",
    version: result.version,
    ...(result.audit_entry_id ? { auditEntryId: result.audit_entry_id } : {}),
  };
}
