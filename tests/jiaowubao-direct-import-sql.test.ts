import assert from "node:assert/strict";
import test from "node:test";

import {
  buildJiaowubaoDirectImportResumableSql,
  buildJiaowubaoDirectImportTransactionSql,
} from "../lib/jiaowubao-direct-import-sql.ts";
import type { JiaowubaoDirectSequentialImportPlan } from "../lib/jiaowubao-direct-import-projection.ts";

const revision = `sha256:${"a".repeat(64)}`;

function plan(): JiaowubaoDirectSequentialImportPlan {
  const workbooks = ["quick_list", "students", "contracts", "hours", "class_members", "schedule", "leave_makeups"].map((kind) => ({
    kind,
    workbookName: `${kind}.xlsx`,
    workbookSha256: "b".repeat(64),
    sheetName: "Sheet1",
    sourceRecordCount: kind === "students" ? 1 : 0,
  }));
  const recordCounts = {
    student_snapshot: 1,
    quick_list: 0,
    contract_history: 0,
    hour_balance: 0,
    class_membership: 0,
    schedule_event: 0,
    leave_makeup: 0,
  };
  const chunk = {
    format: "jiaowubao-direct-staging-v1" as const,
    revision,
    contract: {
      studentAuthority: "tencent_master_only" as const,
      automaticStudentCreation: "forbidden" as const,
      automaticStudentAttachment: "forbidden" as const,
      scheduleProjection: "one_read_only_event_per_source_cell" as const,
      operationalBookingCreation: "forbidden" as const,
      leaveMakeupMutation: "forbidden" as const,
    },
    sourceTimezone: "Australia/Melbourne" as const,
    sourceTimezoneBasis: "fixture",
    workbooks,
    recordCounts,
    chunk: { index: 0, count: 1 },
    records: [{
      kind: "student_snapshot" as const,
      sourceKey: "jwb-static-v1:students:r2",
      sourceRefs: [{ workbook: "students", row: 2 }] as const,
      sourceDigest: "c".repeat(64),
      studentRelationship: { state: "pending_authoritative_tencent_match" as const, automaticAttachment: "forbidden" as const },
      payload: { source: { identity: { name: "Fixture", phone: "0400000000" } }, staging: {} },
    }],
  };
  return {
    begin: {
      actor: "Nixon",
      envelope: {
        format: "jiaowubao-direct-import-v1",
        sourceId: "jiaowubao-static-excel",
        revision,
        sourceTimezone: "Australia/Melbourne",
        sourceTimezoneBasis: "fixture",
        masterSource: { sourceId: "master", revision: "r1", rowsSha256: "d".repeat(64) },
        workbooks,
        recordCounts,
        expectedCounts: { supplementalRecords: 1, scheduleEvents: 0, scheduleParticipants: 0, leaveMakeups: 0 },
        chunkCount: 1,
      },
    },
    stages: [{
      chunk,
      projection: {
        supplemental: [{
          sourceKey: "jwb-static-v1:students:r2",
          resolution: { state: "quarantined", studentId: null, masterSourceRow: null, reason: "unmatched_tencent_student" },
          identityProof: false,
        }],
        scheduleEvents: [],
        leaveMakeups: [],
      },
    }],
    complete: { actor: "Nixon" },
  } as JiaowubaoDirectSequentialImportPlan;
}

test("builds one atomic client-owned transaction with source-safe postconditions", () => {
  const sql = buildJiaowubaoDirectImportTransactionSql(plan());
  assert.match(sql, /^\\set VERBOSITY verbose\nset session role postgres;\nbegin;/u);
  assert.match(sql, /session_user !~ '\^cli_login_/u);
  assert.match(sql, /current_user <> 'postgres'/u);
  assert.match(sql, /pg_has_role\(session_user, 'postgres', 'SET'\)/u);
  assert.match(sql, /jiaowubao_direct_import_transport_role_invalid/u);
  assert.equal((sql.match(/stage_jiaowubao_direct_import_chunk/g) ?? []).length, 1);
  assert.match(sql, /begin_jiaowubao_direct_import/u);
  assert.match(sql, /complete_jiaowubao_direct_import/u);
  assert.match(sql, /jiaowubao_direct_ops_sentinel/u);
  assert.match(sql, /jiaowubao_direct_import_changed_operational_state/u);
  assert.match(sql, /commit;/u);
  assert.match(sql, /import_receipt/u);
  assert.ok(sql.indexOf("import_receipt") < sql.lastIndexOf("commit;"));
  assert.doesNotMatch(sql, /update public\.ops_state|delete from public\.ops_state|insert into public\.ops_state/iu);
});

test("rejects a non-contiguous or mismatched production plan", () => {
  const invalid = plan();
  assert.throws(() => buildJiaowubaoDirectImportTransactionSql({
    ...invalid,
    stages: [{
      ...invalid.stages[0],
      chunk: { ...invalid.stages[0].chunk, chunk: { index: 1, count: 1 } },
    }],
  }), /chunk sequence/u);
});

test("builds a resumable committed-chunk protocol with post-commit progress only", () => {
  const sql = buildJiaowubaoDirectImportResumableSql(plan());
  assert.match(sql, /^\\set VERBOSITY verbose\nset session role postgres;/u);
  assert.equal((sql.match(/stage_jiaowubao_direct_import_chunk/g) ?? []).length, 1);
  assert.equal((sql.match(/\ncommit;/g) ?? []).length, 3);
  assert.match(sql, /begin_jiaowubao_direct_import[\s\S]*jiaowubao_direct_run_id \\gset/u);
  assert.match(sql, /'event', 'beginCommitted'/u);
  assert.match(sql, /'event', 'chunkCommitted'/u);
  assert.match(sql, /'event', 'complete'/u);
  assert.match(sql, /jiaowubao_direct_stage_receipt \\gset[\s\S]*commit;[\s\S]*'event', 'chunkCommitted'/u);
  assert.match(sql, /jiaowubao_direct_complete_receipt[\s\S]*\\gset[\s\S]*commit;[\s\S]*'event', 'complete'/u);
  assert.doesNotMatch(sql, /jiaowubao_direct_ops_sentinel/u);
  assert.doesNotMatch(sql, /source_id = 'jiaowubao-static-excel' and run_state\.revision = .*\)(?!.*state in)/u);
});
