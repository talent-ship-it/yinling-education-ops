import {
  JIAOWUBAO_DIRECT_IMPORT_FORMAT,
  JIAOWUBAO_DIRECT_IMPORT_SOURCE_ID,
  type JiaowubaoDirectCompiledImport,
  type JiaowubaoDirectProjectionReport,
  type JiaowubaoDirectQuarantineReason,
} from "./jiaowubao-direct-import-projection";

/**
 * Immutable review facts for the seven owner-provided 2026-08-18 exports.
 *
 * The production writer is intentionally not a general uploader. If any
 * workbook, Tencent authority snapshot, or compiler aggregate stops matching
 * these reviewed facts, it must fail before producing transaction SQL.
 */
export const JIAOWUBAO_2026_08_18_BATCH_LOCK = Object.freeze({
  revision: "sha256:8dfaf97a639cf4c2a43e145858187df3648a7679bdcd896f35e18c96cb5d806b",
  masterRows: 543,
  activeMasterRows: 393,
  excludedMasterRows: 150,
  currentTeachers: 253,
  supplementalRecords: 9_144,
  supplementalAttached: 62,
  supplementalQuarantined: 9_082,
  supplementalIdentityProofs: 9,
  scheduleEvents: 39_743,
  scheduleBlocksTeacherAva: 136,
  scheduleDisplayOnly: 39_607,
  scheduleExactTeachers: 27_011,
  scheduleUnresolvedTeachers: 16,
  scheduleAmbiguousTeachers: 0,
  scheduleMissingTeachers: 12_716,
  scheduleParticipants: 39_875,
  scheduleAttachedParticipants: 325,
  scheduleQuarantinedParticipants: 39_550,
  leaveMakeups: 49,
  leaveMakeupsAttached: 1,
  leaveMakeupsQuarantined: 48,
  workbookCount: 7,
  chunkCount: 86,
});

const QUARANTINE_REASONS: readonly JiaowubaoDirectQuarantineReason[] = [
  "unmatched_tencent_student",
  "ambiguous_tencent_student",
  "excluded_tencent_student",
  "empty_name",
  "missing_phone",
  "duplicate_identity",
  "review_required",
  "class_not_resolved",
  "invalid_source_value",
] as const;

const SUPPLEMENTAL_RECORD_KINDS = [
  "student_snapshot",
  "quick_list",
  "contract_history",
  "hour_balance",
  "class_membership",
] as const;

function fail(reason: string): never {
  throw new Error(`The reviewed Jiaowubao batch gate rejected the import: ${reason}.`);
}

function requireCount(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} is not a non-negative integer`);
  return value as number;
}

function requireEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) fail(`${label} does not match the locked review`);
}

function sumReasons(
  reasons: Readonly<Record<JiaowubaoDirectQuarantineReason, number>>,
  label: string,
) {
  return QUARANTINE_REASONS.reduce(
    (total, reason) => total + requireCount(reasons?.[reason], `${label}.${reason}`),
    0,
  );
}

/** Validate aggregate reconciliation before looking at any source-bearing rows. */
export function assertJiaowubao20260818BatchReport(report: JiaowubaoDirectProjectionReport) {
  const locked = JIAOWUBAO_2026_08_18_BATCH_LOCK;
  requireEqual(report?.format, JIAOWUBAO_DIRECT_IMPORT_FORMAT, "report format");
  requireEqual(report.revision, locked.revision, "report revision");

  requireEqual(report.authority.masterRows, locked.masterRows, "Tencent master row count");
  requireEqual(report.authority.activeMasterRows, locked.activeMasterRows, "active Tencent master row count");
  requireEqual(
    report.authority.masterRows - report.authority.activeMasterRows,
    locked.excludedMasterRows,
    "excluded Tencent master row count",
  );
  requireEqual(
    report.authority.currentMasterStudents,
    report.authority.activeMasterRows,
    "current Tencent student coverage",
  );
  if (report.authority.currentMasterStudents <= 0) fail("current Tencent student coverage is empty");
  requireEqual(
    report.authority.currentExplicitMasterStudents,
    locked.activeMasterRows,
    "current explicit Tencent master student count",
  );
  requireEqual(
    report.authority.currentLegacyMasterStudents,
    0,
    "current legacy Tencent master student count",
  );
  requireEqual(
    report.authority.currentExplicitMasterStudents + report.authority.currentLegacyMasterStudents,
    report.authority.currentMasterStudents,
    "current Tencent authority-mode reconciliation",
  );
  if (report.authority.currentStudentCandidates < report.authority.currentMasterStudents) {
    fail("current student candidates are fewer than current Tencent students");
  }
  requireEqual(report.authority.currentTeachers, locked.currentTeachers, "current teacher authority count");

  requireEqual(report.expectedCounts.supplementalRecords, locked.supplementalRecords, "supplemental record count");
  requireEqual(report.expectedCounts.scheduleEvents, locked.scheduleEvents, "schedule event count");
  requireEqual(report.expectedCounts.scheduleParticipants, locked.scheduleParticipants, "schedule participant count");
  requireEqual(report.expectedCounts.leaveMakeups, locked.leaveMakeups, "leave/makeup count");

  requireEqual(
    requireCount(report.supplemental.attached, "supplemental attached")
      + requireCount(report.supplemental.quarantined, "supplemental quarantined"),
    locked.supplementalRecords,
    "supplemental reconciliation",
  );
  requireEqual(report.supplemental.attached, locked.supplementalAttached, "supplemental attached count");
  requireEqual(report.supplemental.quarantined, locked.supplementalQuarantined, "supplemental quarantined count");
  requireEqual(
    sumReasons(report.supplemental.quarantinedByReason, "supplemental quarantine reasons"),
    report.supplemental.quarantined,
    "supplemental quarantine reason reconciliation",
  );
  const identityProofs = requireCount(report.supplemental.identityProofs, "supplemental identity proofs");
  requireEqual(identityProofs, locked.supplementalIdentityProofs, "supplemental identity proof count");

  requireEqual(report.schedule.events, locked.scheduleEvents, "reported schedule event count");
  requireEqual(
    requireCount(report.schedule.blocksTeacherAva, "AVA-blocking schedule events")
      + requireCount(report.schedule.displayOnly, "display-only schedule events"),
    locked.scheduleEvents,
    "schedule availability-effect reconciliation",
  );
  requireEqual(
    report.schedule.blocksTeacherAva,
    locked.scheduleBlocksTeacherAva,
    "AVA-blocking schedule event count",
  );
  requireEqual(report.schedule.displayOnly, locked.scheduleDisplayOnly, "display-only schedule event count");
  requireEqual(
    requireCount(report.schedule.exactTeachers, "exact schedule teachers")
      + requireCount(report.schedule.unresolvedTeachers, "unresolved schedule teachers")
      + requireCount(report.schedule.ambiguousTeachers, "ambiguous schedule teachers")
      + requireCount(report.schedule.missingTeachers, "missing schedule teachers"),
    locked.scheduleEvents,
    "schedule teacher reconciliation",
  );
  requireEqual(report.schedule.exactTeachers, locked.scheduleExactTeachers, "exact schedule teacher count");
  requireEqual(
    report.schedule.unresolvedTeachers,
    locked.scheduleUnresolvedTeachers,
    "unresolved schedule teacher count",
  );
  requireEqual(
    report.schedule.ambiguousTeachers,
    locked.scheduleAmbiguousTeachers,
    "ambiguous schedule teacher count",
  );
  requireEqual(report.schedule.missingTeachers, locked.scheduleMissingTeachers, "missing schedule teacher count");
  requireEqual(report.schedule.subjectResolution.unresolved, locked.scheduleEvents, "unresolved subject count");
  const missingCourses = requireCount(report.schedule.subjectResolution.sourceCourseMissing, "missing source courses");
  if (missingCourses > locked.scheduleEvents) fail("missing source courses exceed schedule events");
  const nonOperational = Object.values(report.schedule.nonOperationalByReason).reduce(
    (total, count) => total + requireCount(count, "non-operational schedule reason"),
    0,
  );
  if (nonOperational > locked.scheduleEvents) fail("non-operational reasons exceed schedule events");

  requireEqual(report.schedule.participants, locked.scheduleParticipants, "reported schedule participant count");
  requireEqual(
    requireCount(report.schedule.attachedParticipants, "attached schedule participants")
      + requireCount(report.schedule.quarantinedParticipants, "quarantined schedule participants"),
    locked.scheduleParticipants,
    "schedule participant reconciliation",
  );
  requireEqual(
    report.schedule.attachedParticipants,
    locked.scheduleAttachedParticipants,
    "attached schedule participant count",
  );
  requireEqual(
    report.schedule.quarantinedParticipants,
    locked.scheduleQuarantinedParticipants,
    "quarantined schedule participant count",
  );
  requireEqual(
    sumReasons(report.schedule.quarantinedByReason, "schedule participant quarantine reasons"),
    report.schedule.quarantinedParticipants,
    "schedule participant quarantine reason reconciliation",
  );

  requireEqual(
    requireCount(report.leaveMakeups.leave, "leave incidents")
      + requireCount(report.leaveMakeups.makeup, "makeup incidents")
      + requireCount(report.leaveMakeups.unknown, "unknown leave/makeup incidents"),
    locked.leaveMakeups,
    "leave/makeup kind reconciliation",
  );
  requireEqual(
    requireCount(report.leaveMakeups.attached, "attached leave/makeup incidents")
      + requireCount(report.leaveMakeups.quarantined, "quarantined leave/makeup incidents"),
    locked.leaveMakeups,
    "leave/makeup attachment reconciliation",
  );
  requireEqual(
    sumReasons(report.leaveMakeups.quarantinedByReason, "leave/makeup quarantine reasons"),
    report.leaveMakeups.quarantined,
    "leave/makeup quarantine reason reconciliation",
  );
  requireEqual(report.leaveMakeups.attached, locked.leaveMakeupsAttached, "attached leave/makeup count");
  requireEqual(report.leaveMakeups.quarantined, locked.leaveMakeupsQuarantined, "quarantined leave/makeup count");
}

/**
 * Final local gate for the exact compiled payload. This runs before the owner-
 * only transaction file is created, so a partial or newly changed batch never
 * reaches Supabase.
 */
export function assertJiaowubao20260818CompiledBatch(compiled: JiaowubaoDirectCompiledImport) {
  assertJiaowubao20260818BatchReport(compiled.report);
  const locked = JIAOWUBAO_2026_08_18_BATCH_LOCK;
  const envelope = compiled.envelope;

  requireEqual(envelope.format, JIAOWUBAO_DIRECT_IMPORT_FORMAT, "envelope format");
  requireEqual(envelope.sourceId, JIAOWUBAO_DIRECT_IMPORT_SOURCE_ID, "envelope source");
  requireEqual(envelope.revision, locked.revision, "envelope revision");
  requireEqual(compiled.report.revision, envelope.revision, "envelope/report revision");
  requireEqual(envelope.sourceTimezone, "Australia/Melbourne", "source timezone");
  requireEqual(envelope.workbooks.length, locked.workbookCount, "workbook count");
  requireEqual(envelope.chunkCount, locked.chunkCount, "reviewed chunk count");
  requireEqual(compiled.chunks.length, envelope.chunkCount, "compiled chunk count");
  if (envelope.chunkCount <= 0) fail("compiled chunks are empty");

  const supplementalRecordCount = SUPPLEMENTAL_RECORD_KINDS.reduce(
    (total, kind) => total + requireCount(envelope.recordCounts[kind], `recordCounts.${kind}`),
    0,
  );
  requireEqual(supplementalRecordCount, locked.supplementalRecords, "envelope supplemental record reconciliation");
  requireEqual(envelope.recordCounts.schedule_event, locked.scheduleEvents, "envelope schedule event count");
  requireEqual(envelope.recordCounts.leave_makeup, locked.leaveMakeups, "envelope leave/makeup count");

  for (const key of ["supplementalRecords", "scheduleEvents", "scheduleParticipants", "leaveMakeups"] as const) {
    requireEqual(envelope.expectedCounts[key], compiled.report.expectedCounts[key], `envelope/report ${key}`);
  }

  let projectedSupplemental = 0;
  let projectedSupplementalAttached = 0;
  let projectedSupplementalQuarantined = 0;
  let projectedIdentityProofs = 0;
  let projectedSchedule = 0;
  let projectedBlocksTeacherAva = 0;
  let projectedDisplayOnly = 0;
  let projectedExactTeachers = 0;
  let projectedUnresolvedTeachers = 0;
  let projectedAmbiguousTeachers = 0;
  let projectedMissingTeachers = 0;
  let projectedParticipants = 0;
  let projectedAttachedParticipants = 0;
  let projectedQuarantinedParticipants = 0;
  let projectedLeaveMakeups = 0;
  let projectedLeave = 0;
  let projectedMakeup = 0;
  let projectedUnknownLeaveMakeup = 0;
  let projectedAttachedLeaveMakeups = 0;
  let projectedQuarantinedLeaveMakeups = 0;
  for (const entry of compiled.chunks) {
    requireEqual(entry.chunk.revision, locked.revision, "compiled chunk revision");
    projectedSupplemental += entry.projection.supplemental.length;
    projectedSchedule += entry.projection.scheduleEvents.length;
    projectedLeaveMakeups += entry.projection.leaveMakeups.length;
    for (const supplemental of entry.projection.supplemental) {
      if (supplemental.identityProof) projectedIdentityProofs += 1;
      if (supplemental.resolution.state === "attached") {
        projectedSupplementalAttached += 1;
        if (!supplemental.resolution.studentId || !supplemental.resolution.masterSourceRow
          || supplemental.resolution.reason !== null) {
          fail("an attached supplemental row lacks current Tencent authority evidence");
        }
      } else {
        projectedSupplementalQuarantined += 1;
        if (supplemental.resolution.studentId !== null || supplemental.resolution.masterSourceRow !== null
          || !supplemental.resolution.reason) {
          fail("a quarantined supplemental row carries attachment evidence");
        }
      }
    }
    for (const event of entry.projection.scheduleEvents) {
      projectedParticipants += event.participants.length;
      if (event.availabilityEffect === "blocks_teacher_ava") projectedBlocksTeacherAva += 1;
      else projectedDisplayOnly += 1;
      if (event.teacherResolution === "exact_name") projectedExactTeachers += 1;
      else if (event.teacherResolution === "unresolved") projectedUnresolvedTeachers += 1;
      else if (event.teacherResolution === "ambiguous") projectedAmbiguousTeachers += 1;
      else projectedMissingTeachers += 1;
      for (const participant of event.participants) {
        if (participant.resolution.state === "attached") {
          projectedAttachedParticipants += 1;
          if (participant.resolution.reason !== null) fail("an attached schedule participant carries a quarantine reason");
        } else {
          projectedQuarantinedParticipants += 1;
          if (!participant.resolution.reason) fail("a quarantined schedule participant lacks a reason");
        }
      }
      if (event.availabilityEffect === "blocks_teacher_ava") {
        if (event.teacherResolution !== "exact_name" || !event.teacherId) {
          fail("an AVA-blocking event lacks an exact current teacher");
        }
        if (!event.participants.some((participant) => participant.resolution.state === "attached")) {
          fail("an AVA-blocking event lacks an attached current Tencent student");
        }
      }
    }
    for (const incident of entry.projection.leaveMakeups) {
      if (incident.incidentKind === "leave") projectedLeave += 1;
      else if (incident.incidentKind === "makeup") projectedMakeup += 1;
      else projectedUnknownLeaveMakeup += 1;
      if (incident.resolution.state === "attached") {
        projectedAttachedLeaveMakeups += 1;
        if (!incident.resolution.studentId || !incident.resolution.masterSourceRow
          || incident.resolution.reason !== null) {
          fail("an attached leave/makeup row lacks current Tencent authority evidence");
        }
      } else {
        projectedQuarantinedLeaveMakeups += 1;
        if (incident.resolution.studentId !== null || incident.resolution.masterSourceRow !== null
          || !incident.resolution.reason) {
          fail("a quarantined leave/makeup row carries attachment evidence");
        }
      }
    }
  }
  requireEqual(projectedSupplemental, locked.supplementalRecords, "projected supplemental record count");
  requireEqual(projectedSchedule, locked.scheduleEvents, "projected schedule event count");
  requireEqual(projectedParticipants, locked.scheduleParticipants, "projected schedule participant count");
  requireEqual(projectedLeaveMakeups, locked.leaveMakeups, "projected leave/makeup count");
  requireEqual(projectedSupplementalAttached, compiled.report.supplemental.attached, "projected supplemental attachments");
  requireEqual(projectedSupplementalQuarantined, compiled.report.supplemental.quarantined, "projected supplemental quarantines");
  requireEqual(projectedIdentityProofs, compiled.report.supplemental.identityProofs, "projected supplemental identity proofs");
  requireEqual(projectedBlocksTeacherAva, compiled.report.schedule.blocksTeacherAva, "projected AVA-blocking events");
  requireEqual(projectedDisplayOnly, compiled.report.schedule.displayOnly, "projected display-only events");
  requireEqual(projectedExactTeachers, compiled.report.schedule.exactTeachers, "projected exact teachers");
  requireEqual(projectedUnresolvedTeachers, compiled.report.schedule.unresolvedTeachers, "projected unresolved teachers");
  requireEqual(projectedAmbiguousTeachers, compiled.report.schedule.ambiguousTeachers, "projected ambiguous teachers");
  requireEqual(projectedMissingTeachers, compiled.report.schedule.missingTeachers, "projected missing teachers");
  requireEqual(projectedAttachedParticipants, compiled.report.schedule.attachedParticipants, "projected attached participants");
  requireEqual(projectedQuarantinedParticipants, compiled.report.schedule.quarantinedParticipants, "projected quarantined participants");
  requireEqual(projectedLeave, compiled.report.leaveMakeups.leave, "projected leave incidents");
  requireEqual(projectedMakeup, compiled.report.leaveMakeups.makeup, "projected makeup incidents");
  requireEqual(projectedUnknownLeaveMakeup, compiled.report.leaveMakeups.unknown, "projected unknown incidents");
  requireEqual(projectedAttachedLeaveMakeups, compiled.report.leaveMakeups.attached, "projected attached leave/makeup incidents");
  requireEqual(projectedQuarantinedLeaveMakeups, compiled.report.leaveMakeups.quarantined, "projected quarantined leave/makeup incidents");
}
