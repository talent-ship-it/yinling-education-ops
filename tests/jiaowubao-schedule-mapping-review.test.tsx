import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  JiaowubaoScheduleMappingReviewPanel,
  parseJiaowubaoScheduleMappingReview,
  type JiaowubaoScheduleMappingReview,
} from "../app/jiaowubao-schedule-mapping-review.tsx";

const mappingKey = `sha256:${"a".repeat(64)}`;

const payload: JiaowubaoScheduleMappingReview = {
  state: "complete",
  runToken: "opaque-run-token",
  teachersVersion: 7,
  teachers: [{
    id: "teacher-1",
    name: "当前老师",
    subjectIds: ["高考英语", "雅思英语"],
  }],
  summary: { total: 1, unmapped: 1, confirmed: 0, revoked: 0, authorityChanged: 0 },
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
  }],
  nextCursor: null,
};

function render(review: JiaowubaoScheduleMappingReview | null, isAdmin = true) {
  return renderToStaticMarkup(<JiaowubaoScheduleMappingReviewPanel
    review={review}
    loading={false}
    loadingMore={false}
    error={false}
    isAdmin={isAdmin}
    busyMappingKey={null}
    onConfirm={() => undefined}
    onRevoke={() => undefined}
    onLoadMore={() => undefined}
  />);
}

test("renders an explicit mapping decision without exposing opaque run or candidate values", () => {
  const html = render(payload);
  assert.match(html, /老师与课程映射确认/);
  assert.match(html, /可撤销/);
  assert.match(html, /教务宝老师/);
  assert.match(html, /教务宝课程/);
  assert.doesNotMatch(html, /<form|<select|请选择老师|确认映射/);
  assert.match(html, /aria-label="老师与课程映射候选"/);
  assert.doesNotMatch(html, /opaque-run-token|sha256:a{64}/);
});

test("hides source labels and controls from viewers outside the high-tier admin surface", () => {
  const html = render(payload, false);
  assert.match(html, /仅管理员可确认老师与课程映射/);
  assert.doesNotMatch(html, /<strong>教务宝老师<\/strong>|<small>教务宝课程<\/small>|<select|>确认映射<\/button>/);
});

test("accepts a revoked audit timestamp but rejects impossible target state", () => {
  const revoked = parseJiaowubaoScheduleMappingReview({
    ...payload,
    summary: { total: 1, unmapped: 0, confirmed: 0, revoked: 1, authorityChanged: 0 },
    candidates: [{
      ...payload.candidates[0]!,
      status: "revoked",
      decidedAt: "2026-08-19T00:00:00.000Z",
    }],
  });
  assert.equal(revoked.candidates[0]?.status, "revoked");
  assert.throws(() => parseJiaowubaoScheduleMappingReview({
    ...payload,
    candidates: [{ ...payload.candidates[0]!, status: "unmapped", decidedAt: "2026-08-19T00:00:00.000Z" }],
  }), /目标状态不一致/);
  assert.throws(() => parseJiaowubaoScheduleMappingReview({
    ...payload,
    candidates: [{ ...payload.candidates[0]!, mappingKey: "not-opaque" }],
  }), /令牌格式无效/);
});

test("renders an authority-changed decision as stale instead of silently applying it", () => {
  const review: JiaowubaoScheduleMappingReview = {
    ...payload,
    summary: { total: 1, unmapped: 0, confirmed: 0, revoked: 0, authorityChanged: 1 },
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
  assert.doesNotMatch(html, /当前老师资料已变更，请重新选择并确认|<form|<select|确认映射/);
});
