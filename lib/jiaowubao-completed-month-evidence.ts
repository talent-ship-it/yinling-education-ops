import { createHash } from "node:crypto";

import {
  JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_SOURCE_KEY,
  assertJiaowubaoCompletedLessonSnapshotIntegrity,
  collectJiaowubaoCompletedLessonSnapshot,
  type JiaowubaoCompletedLessonSnapshot,
} from "@/lib/jiaowubao-completed-lessons";
import {
  assertJiaowubaoCompletedScheduleSnapshotIntegrity,
  collectJiaowubaoCompletedScheduleSnapshot,
  type JiaowubaoCompletedScheduleSnapshot,
} from "@/lib/jiaowubao-completed-schedule";

/**
 * One immutable revision binds completed learner rows and completed
 * teacher-role schedule rows together. Neither source can update payroll
 * evidence independently of the other.
 */
export const JIAOWUBAO_COMPLETED_MONTH_EVIDENCE_FORMAT = "jiaowubao-completed-month-evidence/v1";
export const JIAOWUBAO_COMPLETED_MONTH_EVIDENCE_JOIN_RULE = "schedule-cal-id-v1";

export type JiaowubaoCompletedMonthEvidenceSnapshot = Readonly<{
  manifest: Readonly<{
    format: typeof JIAOWUBAO_COMPLETED_MONTH_EVIDENCE_FORMAT;
    source: "jiaowubao-open-api";
    period: Readonly<{ start: string; end: string }>;
    joinRule: typeof JIAOWUBAO_COMPLETED_MONTH_EVIDENCE_JOIN_RULE;
    lessons: Readonly<{
      pageCount: number;
      recordCount: number;
      manifestSha256: string;
      recordsSha256: string;
      query: JiaowubaoCompletedLessonSnapshot["manifest"]["query"];
    }>;
    schedules: Readonly<{
      pageCount: number;
      recordCount: number;
      manifestSha256: string;
      recordsSha256: string;
      query: JiaowubaoCompletedScheduleSnapshot["manifest"]["query"];
    }>;
    manifestSha256: string;
    revision: string;
  }>;
  lessons: JiaowubaoCompletedLessonSnapshot;
  schedules: JiaowubaoCompletedScheduleSnapshot;
}>;

function fail(message: string): never {
  throw new Error(message);
}

function sha256Tag(value: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validRevision(value: string) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) fail("教务宝完成月度来源版本无效。");
  return value;
}

/**
 * Both documented `over=1` feeds are collected before any staging write. The
 * gateway's quota is documented per interface, and each collector enforces a
 * bounded, explicit-empty-page termination rule.
 */
export async function collectJiaowubaoCompletedMonthEvidence(
  window: Readonly<{ start: string; end: string }>,
): Promise<JiaowubaoCompletedMonthEvidenceSnapshot> {
  const [lessons, schedules] = await Promise.all([
    collectJiaowubaoCompletedLessonSnapshot(window),
    collectJiaowubaoCompletedScheduleSnapshot(window),
  ]);
  const lessonManifest = lessons.manifest;
  const scheduleManifest = schedules.manifest;
  if (lessonManifest.query.start !== scheduleManifest.query.start || lessonManifest.query.end !== scheduleManifest.query.end) {
    fail("教务宝完成月度来源日期范围不一致。");
  }
  const payload = {
    format: JIAOWUBAO_COMPLETED_MONTH_EVIDENCE_FORMAT as typeof JIAOWUBAO_COMPLETED_MONTH_EVIDENCE_FORMAT,
    source: "jiaowubao-open-api" as const,
    period: { start: lessonManifest.query.start, end: lessonManifest.query.end },
    joinRule: JIAOWUBAO_COMPLETED_MONTH_EVIDENCE_JOIN_RULE as typeof JIAOWUBAO_COMPLETED_MONTH_EVIDENCE_JOIN_RULE,
    lessons: {
      pageCount: lessonManifest.pageCount,
      recordCount: lessonManifest.recordCount,
      manifestSha256: validRevision(lessonManifest.manifestSha256),
      recordsSha256: validRevision(lessonManifest.recordsSha256),
      query: lessonManifest.query,
    },
    schedules: {
      pageCount: scheduleManifest.pageCount,
      recordCount: scheduleManifest.recordCount,
      manifestSha256: validRevision(scheduleManifest.manifestSha256),
      recordsSha256: validRevision(scheduleManifest.recordsSha256),
      query: scheduleManifest.query,
    },
  };
  const manifestSha256 = sha256Tag(JSON.stringify(payload));
  return Object.freeze({
    manifest: Object.freeze({ ...payload, manifestSha256, revision: manifestSha256 }),
    lessons,
    schedules,
  });
}

/** Verifies that the composite envelope is derived from the exact two feeds. */
export function assertJiaowubaoCompletedMonthEvidenceSnapshotIntegrity(snapshot: JiaowubaoCompletedMonthEvidenceSnapshot) {
  assertJiaowubaoCompletedLessonSnapshotIntegrity(snapshot.lessons);
  assertJiaowubaoCompletedScheduleSnapshotIntegrity(snapshot.schedules);
  const lessonManifest = snapshot.lessons.manifest;
  const scheduleManifest = snapshot.schedules.manifest;
  const payload = {
    format: JIAOWUBAO_COMPLETED_MONTH_EVIDENCE_FORMAT as typeof JIAOWUBAO_COMPLETED_MONTH_EVIDENCE_FORMAT,
    source: "jiaowubao-open-api" as const,
    period: { start: lessonManifest.query.start, end: lessonManifest.query.end },
    joinRule: JIAOWUBAO_COMPLETED_MONTH_EVIDENCE_JOIN_RULE as typeof JIAOWUBAO_COMPLETED_MONTH_EVIDENCE_JOIN_RULE,
    lessons: {
      pageCount: lessonManifest.pageCount,
      recordCount: lessonManifest.recordCount,
      manifestSha256: lessonManifest.manifestSha256,
      recordsSha256: lessonManifest.recordsSha256,
      query: lessonManifest.query,
    },
    schedules: {
      pageCount: scheduleManifest.pageCount,
      recordCount: scheduleManifest.recordCount,
      manifestSha256: scheduleManifest.manifestSha256,
      recordsSha256: scheduleManifest.recordsSha256,
      query: scheduleManifest.query,
    },
  };
  if (lessonManifest.query.start !== scheduleManifest.query.start || lessonManifest.query.end !== scheduleManifest.query.end
    || snapshot.manifest.format !== payload.format || snapshot.manifest.source !== payload.source
    || snapshot.manifest.period.start !== payload.period.start || snapshot.manifest.period.end !== payload.period.end
    || snapshot.manifest.joinRule !== payload.joinRule
    || JSON.stringify(snapshot.manifest.lessons) !== JSON.stringify(payload.lessons)
    || JSON.stringify(snapshot.manifest.schedules) !== JSON.stringify(payload.schedules)) {
    fail("教务宝完成月度双源清单不一致。");
  }
  const manifestSha256 = sha256Tag(JSON.stringify(payload));
  if (snapshot.manifest.manifestSha256 !== manifestSha256 || snapshot.manifest.revision !== manifestSha256) {
    fail("教务宝完成月度双源清单散列不一致。");
  }
}

export function buildJiaowubaoCompletedMonthEvidenceEnvelope(
  snapshot: JiaowubaoCompletedMonthEvidenceSnapshot,
  expectedCurrentRevision: string | null,
) {
  if (expectedCurrentRevision !== null) validRevision(expectedCurrentRevision);
  assertJiaowubaoCompletedMonthEvidenceSnapshotIntegrity(snapshot);
  return Object.freeze({
    apiSourceKey: JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_SOURCE_KEY,
    month: snapshot.manifest.period.start.slice(0, 7),
    revision: snapshot.manifest.revision,
    query: {
      lessons: snapshot.manifest.lessons.query,
      schedules: snapshot.manifest.schedules.query,
    },
    expectedPageCount: snapshot.manifest.lessons.pageCount,
    expectedRowCount: snapshot.manifest.lessons.recordCount,
    expectedSchedulePageCount: snapshot.manifest.schedules.pageCount,
    expectedScheduleRowCount: snapshot.manifest.schedules.recordCount,
    expectedCurrentRevision,
    externalManifestSha256: snapshot.manifest.manifestSha256,
    sourceMetadata: {
      exportFormat: snapshot.manifest.format,
      manifestSha256: snapshot.manifest.manifestSha256,
      lessonManifestSha256: snapshot.manifest.lessons.manifestSha256,
      lessonRecordsSha256: snapshot.manifest.lessons.recordsSha256,
      scheduleManifestSha256: snapshot.manifest.schedules.manifestSha256,
      scheduleRecordsSha256: snapshot.manifest.schedules.recordsSha256,
      joinRule: snapshot.manifest.joinRule,
    },
  });
}
