import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TrialScreenshotImport, type TrialScreenshotCandidate, type TrialScreenshotTarget } from "../app/trial-screenshot-import";
import {
  TrialScreenshotImportFlow,
  confirmableScreenshotCandidate,
  proposedScreenshotFields,
  requestTrialScreenshotMatch,
  screenshotCandidateKey,
  screenshotMelbourneTime,
  selectedScreenshotFields,
  type TrialScreenshotMatch,
} from "../app/trial-screenshot-import-state";

const target: TrialScreenshotTarget = { lpItemId: "LP-SYNTHETIC-1" };
const text = `上课 09:00-10:00
2026-10-20
课程：English - Casey示例试听
班级：试听学员A2026
老师：Synthetic Teacher`;
const candidate: TrialScreenshotCandidate = {
  eventId: "synthetic-event-1", sourceRevision: `sha256:${"a".repeat(64)}`, sourceDate: "2026-10-20",
  startsAt: "2026-10-19T22:00:00Z", endsAt: "2026-10-19T23:00:00Z", teacherName: "Synthetic Teacher",
  courseName: "English - Casey示例试听", studentNameHint: "Casey示例", sharedAccountLabel: "试听学员A2026", sharedAccountLetter: "a", durationMinutes: 60,
};
function matched(overrides: Partial<TrialScreenshotMatch> = {}): TrialScreenshotMatch {
  return {
    candidates: [candidate], ambiguous: false, hasMore: false,
    coverage: { state: "complete", freshness: "fresh", timeZone: "Australia/Melbourne", complete: true, sourceRevision: candidate.sourceRevision },
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function file(type = "image/png", bytes = 1) {
  return new File([new Uint8Array(bytes)], "synthetic.png", { type });
}
async function ready(result = matched()) {
  const flow = new TrialScreenshotImportFlow(target, { recognize: async () => text, match: async () => result });
  flow.setText(text);
  await flow.parseAndMatch();
  return flow;
}

test("upload accepts only nonempty PNG/JPG/WebP up to 3 MB before invoking OCR", async () => {
  let calls = 0;
  const flow = new TrialScreenshotImportFlow(target, { recognize: async () => { calls++; return text; }, match: async () => matched() });
  for (const invalid of [file("application/pdf"), file("image/png", 0), file("image/jpeg", 3 * 1024 * 1024 + 1)]) {
    await flow.upload(invalid);
    assert.match(flow.getSnapshot().error!, /3 MB/);
  }
  assert.equal(calls, 0);
  for (const type of ["image/png", "image/jpeg", "image/webp"]) await flow.upload(file(type));
  assert.equal(calls, 3);
});

test("OCR is local, progress is visible, and text remains editable before a separate match request", async () => {
  let matches = 0;
  const flow = new TrialScreenshotImportFlow(target, {
    recognize: async (source, progress) => { assert.equal(source.type, "image/png"); progress(42); assert.equal(flow.getSnapshot().progress, 42); return text; },
    match: async () => { matches++; return matched(); },
  });
  await flow.upload(file());
  assert.equal(matches, 0);
  assert.equal(flow.getSnapshot().text, text);
  assert.equal(flow.getSnapshot().extraction, null);
  flow.setText(text.replace("Synthetic Teacher", "Corrected Teacher"));
  await flow.parseAndMatch();
  assert.equal(matches, 1);
  assert.equal(flow.getSnapshot().extraction?.teacherName, "Corrected Teacher");
  assert.equal(Object.hasOwn(flow.getSnapshot(), "file"), false);
});

test("replacing an upload aborts the first recognizer and discards its late text and progress", async () => {
  const first = deferred<string>();
  let oldSignal!: AbortSignal;
  let oldProgress!: (value: number) => void;
  let count = 0;
  const flow = new TrialScreenshotImportFlow(target, {
    recognize: async (_file, progress, signal) => { if (++count > 1) return "new upload"; oldSignal = signal; oldProgress = progress; return first.promise; },
    match: async () => matched(),
  });
  const pending = flow.upload(file());
  await flow.upload(file("image/webp"));
  assert.equal(oldSignal.aborted, true);
  oldProgress(12);
  first.resolve("stale upload");
  await pending;
  assert.equal(flow.getSnapshot().text, "new upload");
  assert.equal(flow.getSnapshot().progress, 100);
});

test("cancel or unmount cleanup aborts OCR and ignores an eventual worker error", async () => {
  const pending = deferred<string>();
  let signal!: AbortSignal;
  const flow = new TrialScreenshotImportFlow(target, { recognize: async (_file, _progress, value) => { signal = value; return pending.promise; }, match: async () => matched() });
  const upload = flow.upload(file());
  flow.cancel();
  pending.reject(new Error("worker terminated"));
  await upload;
  assert.equal(signal.aborted, true);
  assert.equal(flow.getSnapshot().phase, "idle");
  assert.equal(flow.getSnapshot().error, null);
  assert.equal(flow.getSnapshot().text, "");
});

test("a failed local recognizer returns a retryable status without leaking worker details", async () => {
  const flow = new TrialScreenshotImportFlow(target, { recognize: async () => { throw new Error("private worker payload"); }, match: async () => matched() });
  await flow.upload(file());
  assert.match(flow.getSnapshot().error!, /截图识别失败/);
  assert.doesNotMatch(flow.getSnapshot().error!, /private/);
  flow.setText(text);
  await flow.parseAndMatch();
  assert.equal(flow.getSnapshot().error, null);
});

test("match requests send only the authorized target and parsed matching evidence", async (context) => {
  let sent: RequestInit | undefined;
  context.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "/api/operations/trial-screenshot-match"); sent = init;
    return Response.json(matched());
  });
  const handover = { caseId: "synthetic-case", sourceMessageId: "synthetic-message", sourceRevision: "b".repeat(64) };
  const flow = new TrialScreenshotImportFlow(handover, { recognize: async () => text, match: requestTrialScreenshotMatch });
  flow.setText(`${text}\n备注：private synthetic raw text`);
  await flow.parseAndMatch();
  assert.deepEqual(JSON.parse(String(sent?.body)), {
    target: handover, evidence: { sourceDate: "2026-10-20", startTime: "09:00", endTime: "10:00", teacherName: "Synthetic Teacher", courseName: "English - Casey示例试听", sharedAccountLetter: "a" },
  });
  assert.equal(sent?.signal?.aborted, false);
  assert.equal(sent?.cache, "no-store");
  assert.doesNotMatch(String(sent?.body), /private|synthetic\.png|image\//);
});

test("missing and invalid evidence never sends a partial lookup or creates a confirmable candidate", async () => {
  let count = 0;
  const flow = new TrialScreenshotImportFlow(target, { recognize: async () => text, match: async () => { count++; return matched(); } });
  flow.setText("老师：Synthetic Teacher");
  await flow.parseAndMatch();
  assert.match(flow.getSnapshot().error!, /补齐日期/);
  assert.deepEqual(proposedScreenshotFields(flow.getSnapshot()), { assignedTeacher: "Synthetic Teacher" });
  flow.setText("\u0000");
  await flow.parseAndMatch();
  assert.match(flow.getSnapshot().error!, /文字无效/);
  assert.equal(count, 0);
  assert.equal(confirmableScreenshotCandidate(flow.getSnapshot()), null);
});

test("editing text aborts lookup and prevents a stale candidate response from restoring old results", async () => {
  const response = deferred<TrialScreenshotMatch>();
  let signal!: AbortSignal;
  const flow = new TrialScreenshotImportFlow(target, { recognize: async () => text, match: async (_target, _evidence, value) => { signal = value; return response.promise; } });
  flow.setText(text);
  const lookup = flow.parseAndMatch();
  assert.equal(flow.getSnapshot().phase, "matching");
  flow.setText("corrected text");
  response.resolve(matched());
  await lookup;
  assert.equal(signal.aborted, true);
  assert.equal(flow.getSnapshot().match, null);
  assert.equal(flow.getSnapshot().extraction, null);
});

test("even one candidate requires a manual radio choice and ambiguous candidates remain unselected", async () => {
  const one = await ready();
  assert.equal(one.getSnapshot().selectedCandidate, null);
  assert.equal(confirmableScreenshotCandidate(one.getSnapshot()), null);
  const second = { ...candidate, eventId: "synthetic-event-2" };
  const multiple = await ready(matched({ candidates: [candidate, second], ambiguous: true }));
  assert.equal(multiple.getSnapshot().selectedCandidate, null);
  multiple.selectCandidate(screenshotCandidateKey(second));
  assert.deepEqual(confirmableScreenshotCandidate(multiple.getSnapshot()), second);
  multiple.selectCandidate("not-in-response");
  assert.deepEqual(confirmableScreenshotCandidate(multiple.getSnapshot()), second);
});

test("confirmation rejects stale, absent, incomplete, wrong-timezone, and mismatched-revision coverage", async () => {
  const complete = matched().coverage!;
  const invalid = [null, { ...complete, complete: false }, { ...complete, state: "stale" }, { ...complete, freshness: "stale" }, { ...complete, freshness: "absent" }, { ...complete, timeZone: "Asia/Shanghai" }, { ...complete, sourceRevision: "different-revision" }];
  for (const coverage of invalid) {
    const flow = await ready(matched({ coverage }));
    flow.selectCandidate(screenshotCandidateKey(candidate));
    assert.equal(confirmableScreenshotCandidate(flow.getSnapshot()), null);
  }
});

test("prefill is opt-in, keeps the current subject, and pairs a selected student name with known=true", async () => {
  const flow = await ready(matched({ candidates: [], coverage: null }));
  assert.deepEqual(selectedScreenshotFields(flow.getSnapshot()), {});
  flow.toggleField("subject");
  flow.toggleField("requestSentAt");
  flow.toggleField("preferredTime");
  flow.toggleField("locationTimezone");
  flow.toggleField("paid");
  flow.toggleField("assignedTeacher");
  assert.deepEqual(selectedScreenshotFields(flow.getSnapshot()), { assignedTeacher: "Synthetic Teacher" });
  flow.toggleField("studentName");
  flow.toggleField("trialDurationMinutes");
  const fields = selectedScreenshotFields(flow.getSnapshot());
  assert.deepEqual(fields, { assignedTeacher: "Synthetic Teacher", studentName: "Casey示例", studentNameKnown: true, trialDurationMinutes: 60 });
  const current = { subject: "Y8 English", requestSentAt: "2026-10-18T00:00:00Z", paid: false };
  assert.deepEqual({ ...current, ...fields }, { ...current, ...fields, subject: "Y8 English" });
  flow.toggleField("studentName");
  assert.equal(Object.hasOwn(selectedScreenshotFields(flow.getSnapshot()), "studentNameKnown"), false);
});

test("choosing a candidate uses verified field values and resets previous OCR field choices", async () => {
  const verified = { ...candidate, teacherName: "Verified Teacher", studentNameHint: "Avery示例", durationMinutes: 45 };
  const flow = await ready(matched({ candidates: [verified] }));
  flow.toggleField("assignedTeacher");
  flow.selectCandidate(screenshotCandidateKey(verified));
  assert.deepEqual(selectedScreenshotFields(flow.getSnapshot()), {});
  assert.deepEqual(proposedScreenshotFields(flow.getSnapshot()), { assignedTeacher: "Verified Teacher", studentName: "Avery示例", trialDurationMinutes: 45 });
});

test("unsupported duration and course title never become trial duration or subject fields", async () => {
  const flow = new TrialScreenshotImportFlow(target, { recognize: async () => text, match: async () => matched() });
  flow.setText(text.replace("09:00-10:00", "09:00-10:30"));
  await flow.parseAndMatch();
  assert.equal(flow.getSnapshot().extraction?.durationMinutes, 90);
  assert.equal(Object.hasOwn(proposedScreenshotFields(flow.getSnapshot()), "trialDurationMinutes"), false);
  assert.equal(Object.hasOwn(proposedScreenshotFields(flow.getSnapshot()), "subject"), false);
});

test("new upload and reparse discard prior candidate and checked-field authorization", async () => {
  const flow = await ready();
  flow.selectCandidate(screenshotCandidateKey(candidate));
  flow.toggleField("assignedTeacher");
  await flow.parseAndMatch();
  assert.equal(flow.getSnapshot().selectedCandidate, null);
  assert.deepEqual(flow.getSnapshot().selectedFields, []);
  flow.toggleField("assignedTeacher");
  await flow.upload(file());
  assert.equal(flow.getSnapshot().match, null);
  assert.deepEqual(selectedScreenshotFields(flow.getSnapshot()), {});
});

test("backend errors retain editable OCR and allow an explicit fresh lookup retry", async () => {
  let count = 0;
  const flow = new TrialScreenshotImportFlow(target, { recognize: async () => text, match: async () => { if (++count === 1) throw new Error("交接来源已变化，请刷新后重试。"); return matched(); } });
  flow.setText(text);
  await flow.parseAndMatch();
  assert.match(flow.getSnapshot().error!, /交接来源已变化/);
  assert.equal(flow.getSnapshot().text, text);
  assert.equal(confirmableScreenshotCandidate(flow.getSnapshot()), null);
  await flow.parseAndMatch();
  assert.equal(flow.getSnapshot().error, null);
  assert.equal(flow.getSnapshot().match?.candidates.length, 1);
});

test("initial client markup exposes labeled local upload and correction without submitting screenshot text in the parent form", () => {
  const html = renderToStaticMarkup(<TrialScreenshotImport target={target} currentFields={{ subject: "Y8 English" }} onApply={() => undefined} />);
  assert.match(html, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(html, /本地识别，最多 3 MB/);
  assert.match(html, /识别文字（可修正）/);
  assert.match(html, /disabled="">解析并核对教务宝/);
  assert.match(html, /disabled="">填入待核对表单/);
  assert.doesNotMatch(html, /<form|name="attachment"|name="text"|确认补全交接与排课/);
  const confirm = renderToStaticMarkup(<TrialScreenshotImport target={target} currentFields={{}} mode="confirm" disabled onApply={() => undefined} />);
  assert.match(confirm, /disabled="">确认补全交接与排课/);
  assert.doesNotMatch(confirm, /填入待核对表单/);
});

test("candidate times use Melbourne calendar time across DST and never the browser's local zone", () => {
  assert.match(screenshotMelbourneTime("2026-10-19T22:00:00Z"), /2026\/10\/20.*09:00/);
  assert.match(screenshotMelbourneTime("2026-07-19T23:00:00Z"), /2026\/07\/20.*09:00/);
  assert.equal(screenshotMelbourneTime("invalid"), "时间无效");
});
