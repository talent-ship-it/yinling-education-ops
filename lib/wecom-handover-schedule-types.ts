import type { JiaowubaoOpenApiScheduleSnapshotWindow, OpsStateRow } from "./ops-store";
import type { TrialScheduleLink } from "./trial-operations";
import type { WecomLpDraftRawSource } from "./wecom-lp-intake";

export const WECOM_HANDOVER_SCHEDULE_ALGORITHM_VERSION = "2";

export type WecomHandoverScheduleEvent = JiaowubaoOpenApiScheduleSnapshotWindow["events"][number] & Readonly<{
  sourceRevision: string;
  sourceRunId: string;
  historical: boolean;
}>;

export type WecomHandoverScheduleInput = Readonly<{
  snapshotRevision: string;
  inputRevision: string;
  targetSourceMessageIds: readonly string[];
  sources: readonly WecomLpDraftRawSource[];
  rows: readonly OpsStateRow[];
  coverage: readonly Readonly<{ startsAt: string; endsAt: string; historical: boolean }>[];
  events: readonly WecomHandoverScheduleEvent[];
  checkedAt?: Date | string;
}>;

export type WecomHandoverScheduleCandidate = Readonly<{
  studentId: string | null;
  studentName: string;
  schedule: TrialScheduleLink;
  sourceRunId: string;
}>;

export type WecomHandoverScheduleEvidence = Readonly<{
  algorithmVersion: typeof WECOM_HANDOVER_SCHEDULE_ALGORITHM_VERSION;
  sourceMessageId: string;
  sourceRevision: string;
  snapshotRevision: string;
  checkedAt: string;
  status: "matched" | "candidate" | "ambiguous" | "needs_identity" | "outside_window" | "no_match" | "identity_conflict";
  matchedStudentId: string | null;
  candidates: readonly WecomHandoverScheduleCandidate[];
}>;
