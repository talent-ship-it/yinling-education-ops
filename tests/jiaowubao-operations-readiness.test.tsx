import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  JiaowubaoOperationsReadinessPanel,
  parseJiaowubaoOperationsReadiness,
  type JiaowubaoOperationsReadiness,
} from "../app/jiaowubao-operations-readiness.tsx";

const payload: JiaowubaoOperationsReadiness = {
  state: "complete",
  runToken: "opaque-run-token",
  window: { startsAt: "2026-08-19T00:00:00.000Z", endsAt: "2026-08-26T00:00:00.000Z" },
  schedule: {
    summary: { windowEvents: 5, needsTeacherMapping: 1, needsCourseMapping: 2, readyForAvaReview: 3, invalidTime: 0 },
    rows: [{
      eventId: "opaque-event", sourceDate: "2026-08-20", startsAt: "2026-08-20T00:00:00.000Z", endsAt: "2026-08-20T01:00:00.000Z",
      courseName: "Course A", teacherId: "opaque-teacher", teacherLabel: "Teacher A",
      teacherResolution: "exact_name", subjectResolution: "unresolved", availabilityEffect: "blocks_teacher_ava",
      attachedParticipantCount: 2, needsTeacherMapping: false, needsCourseMapping: true, readyForAvaReview: true,
    }],
    truncated: false,
  },
  leaveMakeups: {
    summary: { attached: 49, leave: 31, makeup: 18, unknown: 0 },
    rows: [{
      incidentId: "opaque-incident", studentId: "opaque-student", kind: "leave", sourceDate: "2026-08-21", timeText: "10:00",
      courseName: "Course B", className: "Class C", teacherLabel: "Teacher B",
    }],
    truncated: false,
  },
  renewalEvidence: {
    summary: { candidates: 4, withContract: 3, withHourBalance: 4 },
    rows: [{ studentId: "opaque-student-2", courseName: "Course C", hasContractEvidence: true, hasHourBalanceEvidence: true, totalHours: "20", usedHours: "15", remainingHours: "5" }],
    truncated: false,
  },
};

function render(readiness: JiaowubaoOperationsReadiness | null, isAdmin = true) {
  return renderToStaticMarkup(<JiaowubaoOperationsReadinessPanel
    readiness={readiness}
    loading={false}
    error={false}
    timezone="Australia/Melbourne"
    isAdmin={isAdmin}
  />);
}

test("renders dense admin-only source evidence without executable controls or opaque identifiers", () => {
  const html = render(payload);
  assert.match(html, /运营核对/);
  assert.match(html, /aria-labelledby="jiaowubao-operations-readiness-title"/);
  assert.match(html, /排课映射与 AVA/);
  assert.match(html, /<p>5 节<\/p>/);
  assert.match(html, /请假与补课核对/);
  assert.match(html, /续课依据/);
  assert.match(html, />49</);
  assert.match(html, /已关联候选/);
  assert.match(html, /Course A/);
  assert.match(html, /Teacher A/);
  assert.match(html, /2026\/8\/20/);
  assert.doesNotMatch(html, /opaque-(?:run-token|event|teacher|incident|student)/);
  assert.doesNotMatch(html, /<button/);
});

test("keeps the queue hidden from non-admin viewers even if a payload is supplied", () => {
  const html = render(payload, false);
  assert.match(html, /仅管理员可查看运营核对资料/);
  assert.doesNotMatch(html, /Course A|Teacher A|49/);
});

test("renders separate renewal evidence rows for one student across distinct courses", () => {
  const html = render({
    ...payload,
    renewalEvidence: {
      ...payload.renewalEvidence,
      rows: [
        ...payload.renewalEvidence.rows,
        { ...payload.renewalEvidence.rows[0]!, courseName: "Course D", remainingHours: "2" },
      ],
    },
  });
  assert.match(html, /Course C/);
  assert.match(html, /Course D/);
  assert.equal((html.match(/已关联学员/g) ?? []).length, 0);
});

test("shows a truthful absent state and rejects malformed or partial source data", () => {
  assert.match(render(null), /当前没有可用于运营核对的资料/);
  assert.throws(() => parseJiaowubaoOperationsReadiness({ ...payload, state: "complete", runToken: null }), /批次无效/);
  assert.throws(() => parseJiaowubaoOperationsReadiness({ ...payload, window: { ...payload.window, startsAt: "2026-08-19T00:00:00+00:00" } }), /开始时间格式无效/);
  assert.throws(() => parseJiaowubaoOperationsReadiness({ ...payload, schedule: { ...payload.schedule, truncated: "no" } }), /截断状态格式无效/);
  assert.throws(() => parseJiaowubaoOperationsReadiness({ ...payload, leaveMakeups: { ...payload.leaveMakeups, rows: [{ ...payload.leaveMakeups.rows[0], kind: "other" }] } }), /类型无效/);
});
