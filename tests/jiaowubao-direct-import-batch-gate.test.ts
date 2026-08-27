import assert from "node:assert/strict";
import test from "node:test";

import {
  assertJiaowubao20260818BatchReport,
  assertJiaowubao20260818CompiledBatch,
  JIAOWUBAO_2026_08_18_BATCH_LOCK,
} from "../lib/jiaowubao-direct-import-batch-gate.ts";
import type {
  JiaowubaoDirectCompiledImport,
  JiaowubaoDirectProjectionReport,
  JiaowubaoDirectQuarantineReason,
} from "../lib/jiaowubao-direct-import-projection.ts";

const zeroReasons = () => ({
  unmatched_tencent_student: 0,
  ambiguous_tencent_student: 0,
  excluded_tencent_student: 0,
  empty_name: 0,
  missing_phone: 0,
  duplicate_identity: 0,
  review_required: 0,
  class_not_resolved: 0,
  invalid_source_value: 0,
}) satisfies Record<JiaowubaoDirectQuarantineReason, number>;

function validReport(): JiaowubaoDirectProjectionReport {
  const locked = JIAOWUBAO_2026_08_18_BATCH_LOCK;
  return {
    format: "jiaowubao-direct-import-v1",
    revision: locked.revision,
    authority: {
      masterRows: locked.masterRows,
      activeMasterRows: locked.activeMasterRows,
      currentStudentCandidates: locked.activeMasterRows,
      currentMasterStudents: locked.activeMasterRows,
      currentExplicitMasterStudents: locked.activeMasterRows,
      currentLegacyMasterStudents: 0,
      currentTeachers: locked.currentTeachers,
    },
    expectedCounts: {
      supplementalRecords: locked.supplementalRecords,
      scheduleEvents: locked.scheduleEvents,
      scheduleParticipants: locked.scheduleParticipants,
      leaveMakeups: locked.leaveMakeups,
    },
    supplemental: {
      attached: locked.supplementalAttached,
      quarantined: locked.supplementalQuarantined,
      identityProofs: locked.supplementalIdentityProofs,
      quarantinedByReason: {
        ...zeroReasons(),
        unmatched_tencent_student: locked.supplementalQuarantined,
      },
    },
    schedule: {
      events: locked.scheduleEvents,
      blocksTeacherAva: locked.scheduleBlocksTeacherAva,
      displayOnly: locked.scheduleDisplayOnly,
      exactTeachers: locked.scheduleExactTeachers,
      unresolvedTeachers: locked.scheduleUnresolvedTeachers,
      ambiguousTeachers: locked.scheduleAmbiguousTeachers,
      missingTeachers: locked.scheduleMissingTeachers,
      subjectResolution: { unresolved: locked.scheduleEvents, sourceCourseMissing: 0 },
      nonOperationalByReason: { refund: 0, transfer: 0, consumption: 0, test: 0 },
      participants: locked.scheduleParticipants,
      attachedParticipants: locked.scheduleAttachedParticipants,
      quarantinedParticipants: locked.scheduleQuarantinedParticipants,
      quarantinedByReason: {
        ...zeroReasons(),
        unmatched_tencent_student: locked.scheduleQuarantinedParticipants,
      },
    },
    leaveMakeups: {
      leave: locked.leaveMakeups,
      makeup: 0,
      unknown: 0,
      attached: locked.leaveMakeupsAttached,
      quarantined: locked.leaveMakeupsQuarantined,
      quarantinedByReason: {
        ...zeroReasons(),
        unmatched_tencent_student: locked.leaveMakeupsQuarantined,
      },
    },
  };
}

function cloneReport(report: JiaowubaoDirectProjectionReport) {
  return structuredClone(report) as JiaowubaoDirectProjectionReport;
}

test("the production batch lock pins the reviewed revision, authority, resolution, and ledger facts", () => {
  assert.deepEqual(JIAOWUBAO_2026_08_18_BATCH_LOCK, {
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
});

test("the reviewed batch report gate locks Tencent authority and all seven-file counts", () => {
  const report = validReport();
  assert.doesNotThrow(() => assertJiaowubao20260818BatchReport(report));

  const incompleteAuthority = cloneReport(report) as WritableReport;
  incompleteAuthority.authority.currentMasterStudents -= 1;
  incompleteAuthority.authority.currentExplicitMasterStudents -= 1;
  assert.throws(
    () => assertJiaowubao20260818BatchReport(incompleteAuthority),
    /current Tencent student coverage does not match/u,
  );

  const legacyAuthority = cloneReport(report) as WritableReport;
  legacyAuthority.authority.currentExplicitMasterStudents -= 1;
  legacyAuthority.authority.currentLegacyMasterStudents += 1;
  assert.throws(
    () => assertJiaowubao20260818BatchReport(legacyAuthority),
    /current explicit Tencent master student count does not match/u,
  );

  const unexpectedLegacyAuthority = cloneReport(report) as WritableReport;
  unexpectedLegacyAuthority.authority.currentLegacyMasterStudents = 1;
  assert.throws(
    () => assertJiaowubao20260818BatchReport(unexpectedLegacyAuthority),
    /current legacy Tencent master student count does not match/u,
  );

  const wrongParticipantCount = cloneReport(report) as WritableReport;
  wrongParticipantCount.expectedCounts.scheduleParticipants -= 1;
  assert.throws(
    () => assertJiaowubao20260818BatchReport(wrongParticipantCount),
    /schedule participant count does not match/u,
  );

  const wrongRevision = cloneReport(report) as WritableReport;
  wrongRevision.revision = `${JIAOWUBAO_2026_08_18_BATCH_LOCK.revision}-changed`;
  assert.throws(() => assertJiaowubao20260818BatchReport(wrongRevision), /report revision does not match/u);

  const wrongTeacherAuthority = cloneReport(report) as WritableReport;
  wrongTeacherAuthority.authority.currentTeachers -= 1;
  assert.throws(
    () => assertJiaowubao20260818BatchReport(wrongTeacherAuthority),
    /current teacher authority count does not match/u,
  );
});

test("the reviewed batch report gate locks every reviewed resolution aggregate", () => {
  const noSupplementalAttachment = cloneReport(validReport()) as WritableReport;
  noSupplementalAttachment.supplemental.attached = 0;
  noSupplementalAttachment.supplemental.quarantined = JIAOWUBAO_2026_08_18_BATCH_LOCK.supplementalRecords;
  noSupplementalAttachment.supplemental.quarantinedByReason.unmatched_tencent_student
    = JIAOWUBAO_2026_08_18_BATCH_LOCK.supplementalRecords;
  assert.throws(
    () => assertJiaowubao20260818BatchReport(noSupplementalAttachment),
    /supplemental attached count does not match/u,
  );

  const wrongIdentityProofs = cloneReport(validReport()) as WritableReport;
  wrongIdentityProofs.supplemental.identityProofs -= 1;
  assert.throws(
    () => assertJiaowubao20260818BatchReport(wrongIdentityProofs),
    /supplemental identity proof count does not match/u,
  );

  const noAvaBlocks = cloneReport(validReport()) as WritableReport;
  noAvaBlocks.schedule.displayOnly = noAvaBlocks.schedule.events;
  noAvaBlocks.schedule.blocksTeacherAva = 0;
  assert.throws(
    () => assertJiaowubao20260818BatchReport(noAvaBlocks),
    /AVA-blocking schedule event count does not match/u,
  );

  const noExactTeachers = cloneReport(validReport()) as WritableReport;
  noExactTeachers.schedule.unresolvedTeachers += noExactTeachers.schedule.exactTeachers;
  noExactTeachers.schedule.exactTeachers = 0;
  assert.throws(
    () => assertJiaowubao20260818BatchReport(noExactTeachers),
    /exact schedule teacher count does not match/u,
  );

  const noAttachedParticipants = cloneReport(validReport()) as WritableReport;
  noAttachedParticipants.schedule.quarantinedParticipants += noAttachedParticipants.schedule.attachedParticipants;
  noAttachedParticipants.schedule.quarantinedByReason.unmatched_tencent_student
    += noAttachedParticipants.schedule.attachedParticipants;
  noAttachedParticipants.schedule.attachedParticipants = 0;
  assert.throws(
    () => assertJiaowubao20260818BatchReport(noAttachedParticipants),
    /attached schedule participant count does not match/u,
  );

  const noAttachedLeaveMakeups = cloneReport(validReport()) as WritableReport;
  noAttachedLeaveMakeups.leaveMakeups.quarantined += noAttachedLeaveMakeups.leaveMakeups.attached;
  noAttachedLeaveMakeups.leaveMakeups.quarantinedByReason.unmatched_tencent_student
    += noAttachedLeaveMakeups.leaveMakeups.attached;
  noAttachedLeaveMakeups.leaveMakeups.attached = 0;
  assert.throws(
    () => assertJiaowubao20260818BatchReport(noAttachedLeaveMakeups),
    /attached leave\/makeup count does not match/u,
  );
});

type WritableReport = {
  -readonly [K in keyof JiaowubaoDirectProjectionReport]: JiaowubaoDirectProjectionReport[K] extends object
    ? { -readonly [P in keyof JiaowubaoDirectProjectionReport[K]]: JiaowubaoDirectProjectionReport[K][P] }
    : JiaowubaoDirectProjectionReport[K]
};

function validCompiledBatch(): JiaowubaoDirectCompiledImport {
  const locked = JIAOWUBAO_2026_08_18_BATCH_LOCK;
  const attachedResolution = {
    state: "attached" as const,
    studentId: "current-student",
    masterSourceRow: "1",
    reason: null,
  };
  const quarantinedResolution = {
    state: "quarantined" as const,
    studentId: null,
    masterSourceRow: null,
    reason: "unmatched_tencent_student" as const,
  };
  const attachedParticipant = {
    participantKey: "participant",
    sourceDisplayName: "display",
    identitySupplementalSourceKey: null,
    resolution: { state: "attached" as const, reason: null },
  };
  const quarantinedParticipant = {
    participantKey: "participant",
    sourceDisplayName: "display",
    identitySupplementalSourceKey: null,
    resolution: { state: "quarantined" as const, reason: "unmatched_tencent_student" as const },
  };
  const scheduleEvents = Array.from({ length: locked.scheduleEvents }, (_, index) => {
    const teacherResolution = index < locked.scheduleExactTeachers
      ? "exact_name" as const
      : index < locked.scheduleExactTeachers + locked.scheduleUnresolvedTeachers
        ? "unresolved" as const
        : "not_found" as const;
    const participants = index === 0
      ? Array.from({ length: 133 }, () => attachedParticipant)
      : index < 193
        ? [attachedParticipant]
        : [quarantinedParticipant];
    return {
      sourceKey: `schedule-${index}`,
      teacherResolution,
      teacherId: teacherResolution === "exact_name" ? "current-teacher" : null,
      availabilityEffect: index < locked.scheduleBlocksTeacherAva
        ? "blocks_teacher_ava" as const
        : "display_only" as const,
      participants,
    };
  });
  const projection = {
    supplemental: Array.from({ length: locked.supplementalRecords }, (_, index) => ({
      sourceKey: `supplemental-${index}`,
      resolution: index < locked.supplementalAttached ? attachedResolution : quarantinedResolution,
      identityProof: index < locked.supplementalIdentityProofs,
    })),
    scheduleEvents,
    leaveMakeups: Array.from({ length: locked.leaveMakeups }, (_, index) => ({
      sourceKey: `leave-${index}`,
      incidentKind: "leave" as const,
      resolution: index < locked.leaveMakeupsAttached ? attachedResolution : quarantinedResolution,
    })),
  };
  const emptyProjection = { supplemental: [], scheduleEvents: [], leaveMakeups: [] };
  return {
    envelope: {
      format: "jiaowubao-direct-import-v1",
      sourceId: "jiaowubao-static-excel",
      revision: locked.revision,
      sourceTimezone: "Australia/Melbourne",
      sourceTimezoneBasis: "fixture",
      masterSource: { sourceId: "master", revision: "master-revision", rowsSha256: "0".repeat(64) },
      workbooks: Array.from({ length: locked.workbookCount }, (_, index) => ({
        kind: "students",
        workbookName: `fixture-${index}`,
        workbookSha256: "0".repeat(64),
        sheetName: "Sheet1",
        sourceRecordCount: 0,
      })),
      recordCounts: {
        student_snapshot: locked.supplementalRecords,
        quick_list: 0,
        contract_history: 0,
        hour_balance: 0,
        class_membership: 0,
        schedule_event: locked.scheduleEvents,
        leave_makeup: locked.leaveMakeups,
      },
      expectedCounts: validReport().expectedCounts,
      chunkCount: locked.chunkCount,
    },
    chunks: Array.from({ length: locked.chunkCount }, (_, index) => ({
      chunk: { revision: locked.revision } as never,
      projection: index === 0 ? projection : emptyProjection,
      projectionSha256: "0".repeat(64),
    })),
    report: validReport(),
  };
}

test("the compiled batch gate reconciles every projected collection before SQL is created", () => {
  const compiled = validCompiledBatch();
  assert.doesNotThrow(() => assertJiaowubao20260818CompiledBatch(compiled));

  const truncated = {
    ...compiled,
    chunks: [{
      ...compiled.chunks[0],
      projection: {
        ...compiled.chunks[0].projection,
        supplemental: compiled.chunks[0].projection.supplemental.slice(1),
      },
    }, ...compiled.chunks.slice(1)],
  } satisfies JiaowubaoDirectCompiledImport;
  assert.throws(
    () => assertJiaowubao20260818CompiledBatch(truncated),
    /projected supplemental record count does not match/u,
  );
});

test("the compiled production gate pins envelope, report, chunk revision, and 86-chunk shape", () => {
  const compiled = validCompiledBatch();
  const wrongEnvelopeRevision = {
    ...compiled,
    envelope: { ...compiled.envelope, revision: `${compiled.envelope.revision}-changed` },
  } satisfies JiaowubaoDirectCompiledImport;
  assert.throws(
    () => assertJiaowubao20260818CompiledBatch(wrongEnvelopeRevision),
    /envelope revision does not match/u,
  );

  const wrongReportRevision = {
    ...compiled,
    report: { ...compiled.report, revision: `${compiled.report.revision}-changed` },
  } satisfies JiaowubaoDirectCompiledImport;
  assert.throws(
    () => assertJiaowubao20260818CompiledBatch(wrongReportRevision),
    /report revision does not match/u,
  );

  const wrongChunkCount = {
    ...compiled,
    envelope: { ...compiled.envelope, chunkCount: compiled.envelope.chunkCount - 1 },
  } satisfies JiaowubaoDirectCompiledImport;
  assert.throws(
    () => assertJiaowubao20260818CompiledBatch(wrongChunkCount),
    /reviewed chunk count does not match/u,
  );

  const wrongChunkRevision = {
    ...compiled,
    chunks: compiled.chunks.map((entry, index) => index === 0
      ? { ...entry, chunk: { ...entry.chunk, revision: `${compiled.envelope.revision}-changed` } }
      : entry),
  } satisfies JiaowubaoDirectCompiledImport;
  assert.throws(
    () => assertJiaowubao20260818CompiledBatch(wrongChunkRevision),
    /compiled chunk revision does not match/u,
  );
});
