import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  JiaowubaoScheduleMappingPriorityReviewPanel,
  parseJiaowubaoScheduleMappingPriorityReview,
  type JiaowubaoScheduleMappingPriorityReview,
} from "../app/jiaowubao-schedule-mapping-priority-review.tsx";

const mappingKey = `sha256:${"b".repeat(64)}`;

const payload: JiaowubaoScheduleMappingPriorityReview = {
  state: "complete",
  runToken: "opaque-priority-run-token",
  teachersVersion: 8,
  teachers: [{
    id: "teacher-1",
    name: "当前老师",
    subjectIds: ["高考英语", "雅思英语"],
  }],
  window: {
    startsAt: "2026-08-20T00:00:00.000Z",
    endsAt: "2026-10-22T00:00:00.000Z",
  },
  summary: { total: 1, unmapped: 1, authorityChanged: 0, revokedInWindow: 2 },
  candidates: [{
    mappingKey,
    teacherLabel: "教务宝老师",
    courseLabel: "教务宝课程",
    eventCount: 4,
    status: "unmapped",
    targetTeacherId: null,
    targetTeacherName: null,
    targetSubjectId: null,
    decidedAt: null,
    nextStartsAt: "2026-08-20T01:00:00.000Z",
    windowEventCount: 2,
  }],
  nextCursor: null,
};

function render(review: JiaowubaoScheduleMappingPriorityReview | null, isAdmin = true) {
  return renderToStaticMarkup(<JiaowubaoScheduleMappingPriorityReviewPanel
    review={review}
    loading={false}
    loadingMore={false}
    error={false}
    isAdmin={isAdmin}
    timezone="Australia/Melbourne"
    busyMappingKey={null}
    onConfirm={() => undefined}
    onLoadMore={() => undefined}
    onViewHistory={() => undefined}
  />);
}

test("renders only an explicit current/future action queue with absolute source time", () => {
  const html = render(payload);
  assert.match(html, /<h2 id="jiaowubao-schedule-mapping-priority-review-title">当前 63 天待核对<\/h2>/);
  assert.match(html, /人工确认/);
  assert.match(html, /教务宝老师/);
  assert.match(html, /教务宝课程/);
  assert.doesNotMatch(html, /<form|<select|请选择老师|确认映射/);
  assert.match(html, /查看全部历史组合/);
  assert.match(html, /aria-label="当前老师与课程映射待核对候选"/);
  assert.doesNotMatch(html, /opaque-priority-run-token|sha256:b{64}/);
});

test("hides priority labels, source details, and controls outside the high-tier admin surface", () => {
  const html = render(payload, false);
  assert.match(html, /仅管理员可查看和确认当前待核对队列/);
  assert.doesNotMatch(html, /<strong>教务宝老师<\/strong>|<small>教务宝课程<\/small>|<select|>确认映射<\/button>/);
});

test("rejects a non-actionable status, invalid window, and a target prefilled for an unmapped pair", () => {
  assert.throws(() => parseJiaowubaoScheduleMappingPriorityReview({
    ...payload,
    candidates: [{ ...payload.candidates[0]!, status: "confirmed" }],
  }), /状态无效/);
  assert.throws(() => parseJiaowubaoScheduleMappingPriorityReview({
    ...payload,
    window: { ...payload.window, endsAt: "2026-10-21T00:00:00.000Z" },
  }), /时间范围无效/);
  assert.throws(() => parseJiaowubaoScheduleMappingPriorityReview({
    ...payload,
    candidates: [{ ...payload.candidates[0]!, targetTeacherId: "teacher-1" }],
  }), /目标状态不一致/);
});

test("shows an authority-changed target only as stale evidence and retains blank confirmation selectors", () => {
  const review: JiaowubaoScheduleMappingPriorityReview = {
    ...payload,
    summary: { total: 1, unmapped: 0, authorityChanged: 1, revokedInWindow: 0 },
    candidates: [{
      ...payload.candidates[0]!,
      status: "authority_changed",
      targetTeacherId: "retired-teacher",
      targetTeacherName: null,
      targetSubjectId: "高考英语",
      decidedAt: "2026-08-19T00:00:00.000Z",
    }],
  };
  const html = render(review);
  assert.match(html, /老师资料已变更/);
  assert.doesNotMatch(html, /老师资料已变更，请重新选择后确认|<form|<select|请选择老师/);
  assert.doesNotMatch(html, /value="retired-teacher"/);
});
