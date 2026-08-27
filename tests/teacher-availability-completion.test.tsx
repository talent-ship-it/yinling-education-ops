import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  parseTeacherAvailabilityCompletionInbox,
  TeacherAvailabilityCompletionPanel,
  type TeacherAvailabilityCompletionInbox,
} from "../app/teacher-availability-completion.tsx";

const payload: TeacherAvailabilityCompletionInbox = {
  month: "2026-08",
  teacherVersion: 7,
  summary: {
    teachers: 4,
    currentStructured: 1,
    missing: 2,
    invalid: 1,
    pendingReview: 1,
  },
  items: [
    { teacherId: "opaque-teacher-1", teacherName: "待审核老师", issue: "missing", pendingSubmission: true },
    { teacherId: "opaque-teacher-2", teacherName: "待修正老师", issue: "invalid", pendingSubmission: false },
    { teacherId: "opaque-teacher-3", teacherName: "待提交老师", issue: "missing", pendingSubmission: false },
  ],
};

function render(input: {
  inbox?: TeacherAvailabilityCompletionInbox | null;
  loading?: boolean;
  error?: boolean;
  isAdmin?: boolean;
  action?: boolean;
} = {}) {
  return renderToStaticMarkup(<TeacherAvailabilityCompletionPanel
    inbox={input.inbox === undefined ? payload : input.inbox}
    loading={input.loading ?? false}
    error={input.error ?? false}
    isAdmin={input.isAdmin ?? true}
    onOpenTeacher={input.action ? () => undefined : undefined}
  />);
}

test("renders an admin-only, factual AVA completion queue without automatic notifications", () => {
  const html = render();
  assert.match(html, /月度 AVA 完整度/);
  assert.match(html, /aria-labelledby="teacher-availability-completion-title"/);
  assert.match(html, /role="list" aria-label="待补齐老师 AVA"/);
  assert.match(html, /待审核老师/);
  assert.match(html, /待修正老师/);
  assert.match(html, /老师已提交，等待教务审核/);
  assert.match(html, /AVA 需要修正/);
  assert.doesNotMatch(html, /opaque-teacher-[123]/);
  assert.doesNotMatch(html, /<button/);
});

test("keeps the queue and teacher names hidden from a non-admin viewer", () => {
  const html = render({ isAdmin: false });
  assert.match(html, /仅管理员可查看老师 AVA 完整度/);
  assert.doesNotMatch(html, /待审核老师|待修正老师|待提交老师|老师已提交，等待教务审核/);
});

test("offers only host-owned navigation when an embedding workspace supplies it", () => {
  const html = render({ action: true });
  assert.match(html, /打开审核资料/);
  assert.match(html, /查看老师资料/);
  assert.doesNotMatch(html, /<button[^>]*>发送提醒|<button[^>]*>保存 AVA|<button[^>]*>确认排课/);
});

test("renders truthful loading, error and complete states and rejects inconsistent responses", () => {
  assert.match(render({ loading: true }), /正在读取老师 AVA 完整度/);
  assert.match(render({ error: true }), /老师 AVA 完整度暂时无法读取/);
  assert.match(render({ inbox: {
    ...payload,
    summary: { teachers: 1, currentStructured: 1, missing: 0, invalid: 0, pendingReview: 0 },
    items: [],
  } }), /2026-08 AVA 已齐全/);
  assert.throws(() => parseTeacherAvailabilityCompletionInbox({
    ...payload,
    summary: { ...payload.summary, teachers: 5 },
  }), /汇总不一致/);
  assert.throws(() => parseTeacherAvailabilityCompletionInbox({
    ...payload,
    items: [{ ...payload.items[0]!, issue: "future" }],
  }), /状态无效/);
});
