import type { JiaowubaoOpenApiScheduleSnapshotWindow, OpsStateRow } from "./ops-store";
import type { TrialScheduleLink } from "./trial-operations";
import type { WecomLpDraftRawSource } from "./wecom-lp-intake";

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
  studentId: string;
  studentName: string;
  schedule: TrialScheduleLink;
  sourceRunId: string;
}>;

export type WecomHandoverScheduleEvidence = Readonly<{
  sourceMessageId: string;
  sourceRevision: string;
  snapshotRevision: string;
  checkedAt: string;
  status: "matched" | "candidate" | "ambiguous" | "needs_identity" | "outside_window" | "no_match" | "identity_conflict";
  matchedStudentId: string | null;
  candidates: readonly WecomHandoverScheduleCandidate[];
}>;
