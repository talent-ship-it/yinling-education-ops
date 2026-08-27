import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  JiaowubaoImportedStudentHistoryPanel,
  parseJiaowubaoImportedStudentHistory,
} from "../app/jiaowubao-imported-student-history.tsx";

const history = {
  state: "complete" as const,
  supplemental: {
    items: [{
      kind: "hour_balance" as const,
      courseName: "高考中文",
      className: null,
      classType: null,
      studentType: "正式学员",
      totalHours: "40",
      usedHours: "12",
      remainingHours: "28",
    }, {
      kind: "contract" as const,
      courseName: "高考数学",
      className: null,
      classType: null,
      studentType: null,
      totalHours: "20",
      usedHours: null,
      remainingHours: null,
    }],
    truncated: false,
  },
  leaveMakeups: {
    items: [{
      date: "2026-08-18",
      timeText: "18:00-19:00",
      kind: "makeup" as const,
      courseName: "高考中文",
    }],
    truncated: true,
  },
};

test("renders concise student history without source metadata or write controls", () => {
  const html = renderToStaticMarkup(<JiaowubaoImportedStudentHistoryPanel
    history={history}
    loading={false}
    error={false}
  />);

  assert.match(html, /<h2 id="jiaowubao-imported-student-history-title">历史资料<\/h2>/);
  assert.doesNotMatch(html, /教务宝|只读|jiaowubao-imported-student-history-readonly/);
  assert.match(html, /aria-labelledby="jiaowubao-imported-student-history-title"/);
  assert.match(html, /课时、合约与班级资料/);
  assert.match(html, /高考中文/);
  assert.match(html, /总课时 40 · 已消 12 · 剩余 28/);
  assert.match(html, /请假与补课记录/);
  assert.match(html, /补课/);
  assert.match(html, /仅显示每类前 200 条记录/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /STU-/);
});

test("keeps absent imports and failed reads as concise states without source actions", () => {
  const absent = renderToStaticMarkup(<JiaowubaoImportedStudentHistoryPanel
    history={{
      state: "absent",
      supplemental: { items: [], truncated: false },
      leaveMakeups: { items: [], truncated: false },
    }}
    loading={false}
    error={false}
  />);
  const failed = renderToStaticMarkup(<JiaowubaoImportedStudentHistoryPanel
    history={null}
    loading={false}
    error
  />);

  assert.match(absent, /暂无历史资料/);
  assert.match(failed, /历史资料暂时无法读取/);
  assert.doesNotMatch(absent, /<button/);
  assert.doesNotMatch(failed, /<button/);
});

test("validates the curated history response and normalizes omitted null fields", () => {
  const parsed = parseJiaowubaoImportedStudentHistory({
    state: "complete",
    supplemental: {
      items: [{ kind: "class_membership", className: "周三中文班" }],
      truncated: false,
    },
    leaveMakeups: {
      items: [{ kind: "leave", date: "2026-08-19" }],
      truncated: false,
    },
  });

  assert.deepEqual(parsed.supplemental.items[0], {
    kind: "class_membership",
    courseName: null,
    className: "周三中文班",
    classType: null,
    studentType: null,
    totalHours: null,
    usedHours: null,
    remainingHours: null,
  });
  assert.deepEqual(parsed.leaveMakeups.items[0], {
    kind: "leave",
    date: "2026-08-19",
    timeText: null,
    courseName: null,
  });
  assert.throws(() => parseJiaowubaoImportedStudentHistory({
    state: "complete",
    supplemental: { items: [{ kind: "raw_workbook" }], truncated: false },
    leaveMakeups: { items: [], truncated: false },
  }), /类型无效/);
});
