import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TrialScheduleDetails } from "../app/trial-schedule-details";
import type { TrialScheduleLink } from "../lib/trial-operations";

const schedule: TrialScheduleLink = {
  source: "jiaowubao-open-api", eventId: "synthetic-schedule-1", sourceRevision: `sha256:${"a".repeat(64)}`,
  startsAt: "2026-10-22T08:05:00.000Z", endsAt: "2026-10-22T09:05:00.000Z",
  courseName: "English - Synthetic Student试听完整课程", studentName: "Synthetic Student",
  teacherId: "SYNTHETIC-TEACHER", teacherName: "Synthetic API Teacher", plannerHint: "Eileen", matchedAt: "2026-10-21T00:00:00Z",
  durationMinutes: 60, sharedAccountLabel: "试听学员B(校长号1)2026", sharedAccountLetter: "b",
};

function render(overrides: Partial<TrialScheduleLink> = {}) {
  return renderToStaticMarkup(<TrialScheduleDetails schedule={{ ...schedule, ...overrides }} />);
}

test("trusted API metadata renders full course, teacher, both Melbourne times, duration and account", () => {
  const html = render();
  for (const value of ["教务宝小课表", "Synthetic API Teacher", "English - Synthetic Student试听完整课程", "2026-10-22", "19:05 – 20:05", "60 分钟", "试听学员B(校长号1)2026", "上课时间（墨尔本）"]) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /<(input|button|select|textarea)\b/);
});

test("legacy links derive legitimate schedule minutes without inventing a shared account from plannerHint", () => {
  const html = render({ durationMinutes: undefined, sharedAccountLabel: undefined, sharedAccountLetter: undefined });
  assert.match(html, /60 分钟/);
  assert.match(html, /共享试听账号<\/span><strong>未关联/);
  assert.doesNotMatch(html, /试听账号 [ABC]|Eileen/);
});

test("the stored API duration is displayed independently of a legacy elapsed-minute fallback", () => {
  assert.match(render({ durationMinutes: 45 }), /排课时长<\/span><strong>45 分钟/);
  const html = render({ durationMinutes: undefined, endsAt: "2026-10-22T09:35:00.000Z" });
  assert.match(html, /90 分钟/);
});

test("explicit source account letters can render without a raw account label", () => {
  assert.match(render({ sharedAccountLabel: null, sharedAccountLetter: "c" }), /试听账号 C/);
  assert.match(render({ sharedAccountLabel: " ", sharedAccountLetter: "unknown" }), /共享试听账号<\/span><strong>未关联/);
});

test("Melbourne rendering follows daylight saving and retains dates for lessons crossing midnight", () => {
  assert.match(render({ startsAt: "2026-07-22T08:05:00Z", endsAt: "2026-07-22T09:05:00Z" }), /18:05 – 19:05/);
  const html = render({ startsAt: "2026-10-22T12:30:00Z", endsAt: "2026-10-22T13:30:00Z" });
  assert.match(html, /2026-10-22 – 2026-10-23/);
  assert.match(html, /23:30 – 00:30/);
});

test("missing links and invalid legacy intervals stay explicitly incomplete", () => {
  assert.match(renderToStaticMarkup(<TrialScheduleDetails />), /未关联/);
  for (const endsAt of ["invalid", schedule.startsAt, "2026-10-22T08:00:00Z"]) {
    const html = render({ endsAt, durationMinutes: undefined });
    assert.match(html, /上课时间（墨尔本）<\/span><strong>未记录/);
    assert.match(html, /排课时长<\/span><strong>未记录/);
  }
  assert.match(render({ durationMinutes: undefined, endsAt: "2026-10-22T09:05:30Z" }), /排课时长<\/span><strong>未记录/);
});
