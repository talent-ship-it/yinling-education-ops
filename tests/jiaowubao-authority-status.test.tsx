import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { JiaowubaoAuthorityStatusPanel } from "../app/jiaowubao-authority-status.tsx";
import {
  findJiaowubaoAuthorityStatus,
  jiaowubaoAuthorityCadenceHealthy,
  parseJiaowubaoAuthorityStatus,
  sanitizeJiaowubaoAuthoritySourceForBrowser,
} from "../lib/jiaowubao-authority-status.ts";

const source = {
  source_id: "jiaowubao-open-api-schedule",
  status: "synced",
  synced_at: "2026-08-31T04:30:00.000Z",
  row_count: 12,
  payload: {
    schemaVersion: 1,
    authorityMode: "one_of_multiple",
    tool: "query_schedule_list",
    cadenceMinutes: 30,
    snapshotRevision: `sha256:${"a".repeat(64)}`,
    projectionRunId: "8d3184a3-c2f6-4092-9be2-0c6afba2682a",
    snapshotPublishedAt: "2026-08-31T04:30:00.000Z",
    snapshotChangedAt: "2026-08-31T04:01:00.000Z",
    checkedAt: "2026-08-31T04:30:00.000Z",
    projectedAt: "2026-08-31T04:01:01.000Z",
    sourceWindow: { start: "2026-08-31", end: "2026-09-30" },
    matches: {
      schedule: { total: 12, matched: 5, unmatched: 7, conflict: 0, sourceOnly: 0, matchRate: 41.67 },
      student: { total: 10, matched: 8, unmatched: 1, conflict: 1, sourceOnly: 0, matchRate: 80 },
      teacher: { total: 4, matched: 3, unmatched: 1, conflict: 0, sourceOnly: 0, matchRate: 75 },
      course: { total: 3, matched: 3, unmatched: 0, conflict: 0, sourceOnly: 0, matchRate: 100 },
      class: { total: 2, matched: 0, unmatched: 0, conflict: 0, sourceOnly: 2, matchRate: 0 },
      room: { total: 1, matched: 0, unmatched: 0, conflict: 0, sourceOnly: 1, matchRate: 0 },
    },
    anomalies: {
      duplicateScheduleIds: 0,
      missingScheduleIds: 0,
      invalidTimeRecords: 1,
      missingStudentIds: 1,
      missingTeacherIds: 0,
      missingCourseIds: 0,
      identityConflicts: 1,
      identityVariantConflicts: 1,
    },
    prices: {
      present: true,
      schedulePriceRecords: 2,
      studentPriceRecords: 3,
      persistedPrivately: true,
      browserExposed: false,
    },
    fields: {
      topLevelFields: ["cal_id", "price_mem", "stu_list"],
      studentFields: ["mem_id", "name", "price"],
    },
    coverage: {
      snapshotRows: 12,
      normalizedEntityRows: 32,
      matchedEntityRows: 19,
      sourceOnlyEntityRows: 13,
      sourceSnapshotPersisted: true,
      normalizedProjectionPersisted: true,
      nativeRecordsOverwritten: true,
      nativeRecordsSynchronized: true,
      connectedTools: ["query_schedule_list"],
    },
  },
};

test("parses only aggregate Jiaowubao authority health and validates the 30-minute cadence", () => {
  const status = parseJiaowubaoAuthorityStatus(source);
  assert.ok(status);
  assert.equal(status.matches.student.matchRate, 80);
  assert.equal(status.prices.studentPriceRecords, 3);
  assert.equal(status.coverage.nativeRecordsSynchronized, true);
  assert.equal(jiaowubaoAuthorityCadenceHealthy(status, Date.parse("2026-08-31T05:40:00.000Z")), true);
  assert.equal(jiaowubaoAuthorityCadenceHealthy(status, Date.parse("2026-08-31T05:46:00.000Z")), false);
  assert.equal(findJiaowubaoAuthorityStatus([{ source_id: "other" }, source])?.snapshotRows, 12);
});

test("rejects inconsistent counts and strips any extra database payload before browser delivery", () => {
  const sanitized = sanitizeJiaowubaoAuthoritySourceForBrowser({
    ...source,
    payload: { ...source.payload, rawStudents: [{ name: "must not parse" }] },
  });
  assert.equal(sanitized?.row_count, 12);
  assert.equal("rawStudents" in (sanitized?.payload ?? {}), false);
  assert.equal(parseJiaowubaoAuthorityStatus({
    ...source,
    payload: {
      ...source.payload,
      coverage: { ...source.payload.coverage, matchedEntityRows: 20 },
    },
  }), null);
  assert.equal(parseJiaowubaoAuthorityStatus({ ...source, row_count: 13 }), null);
  const pendingNativeSync = parseJiaowubaoAuthorityStatus({
    ...source,
    payload: {
      ...source.payload,
      coverage: {
        ...source.payload.coverage,
        nativeRecordsOverwritten: false,
        nativeRecordsSynchronized: undefined,
      },
    },
  });
  assert.equal(pendingNativeSync?.coverage.nativeRecordsSynchronized, false);
  assert.equal("nativeRecordsOverwritten" in (pendingNativeSync?.coverage ?? {}), false);
});

test("renders sync health, match rates, anomaly counts and private price retention without values or IDs", () => {
  const status = parseJiaowubaoAuthorityStatus(source);
  assert.ok(status);
  const html = renderToStaticMarkup(<JiaowubaoAuthorityStatusPanel
    status={status}
    now={Date.parse("2026-08-31T05:00:00.000Z")}
  />);
  assert.match(html, /非唯一来源/);
  assert.match(html, /30 分钟同步正常/);
  assert.match(html, /学生/);
  assert.match(html, /80\.00%/);
  assert.match(html, /价格字段：已发现并私有保存/);
  assert.match(html, /5 条价格记录/);
  assert.match(html, /query_schedule_list/);
  assert.doesNotMatch(html, /8d3184a3|sha256:|price_mem|studentPriceRecords/);
});

test("renders a truthful waiting state before the projection migration is active", () => {
  const html = renderToStaticMarkup(<JiaowubaoAuthorityStatusPanel status={null} />);
  assert.match(html, /等待首次投影/);
  assert.match(html, /数据库投影尚未产生状态/);
});

test("keeps a legacy projection receipt visible while native synchronization is pending", () => {
  const legacySource = {
    ...source,
    payload: {
      ...source.payload,
      coverage: {
        ...source.payload.coverage,
        nativeRecordsOverwritten: false,
        nativeRecordsSynchronized: undefined,
      },
    },
  };
  const status = parseJiaowubaoAuthorityStatus(legacySource);
  assert.ok(status);
  const html = renderToStaticMarkup(<JiaowubaoAuthorityStatusPanel status={status} />);
  assert.match(html, /现有系统资料同步尚未完成/);
  assert.match(html, /现有系统资料同步待完成/);
});
