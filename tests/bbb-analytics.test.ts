import assert from "node:assert/strict";
import test from "node:test";

import {
  attendanceEvidenceFromBbb,
  bbbCallbackNonce,
  bbbCallbackSignature,
  bbbEvidenceReference,
  meetingIdForOccurrenceValue,
  parseBbbAnalyticsPayload,
  verifyBbbCallbackSignature,
} from "../lib/bbb-analytics.ts";

const occurrenceId = "BOOK-A:2026-09-07";

function analyticsPayload(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.0",
    meeting_id: meetingIdForOccurrenceValue(occurrenceId),
    internal_meeting_id: "internal-meeting-1",
    data: {
      metadata: {
        "occurrence-id": occurrenceId,
        "booking-id": "BOOK-A",
        "student-id": "STUDENT-A",
        "teacher-id": "TEACHER-A",
        is_breakout: "false",
      },
      duration: 3_600,
      start: "2026-09-07T10:00:00.000Z",
      finish: "2026-09-07T11:00:00.000Z",
      attendees: [
        {
          ext_user_id: "STUDENT-A",
          name: "Student",
          moderator: false,
          joins: ["2026-09-07T10:00:00.000Z"],
          leaves: ["2026-09-07T11:00:00.000Z"],
          duration: 3_600,
        },
        {
          ext_user_id: "TEACHER-A",
          name: "Teacher",
          moderator: true,
          joins: ["2026-09-07T10:00:00.000Z"],
          leaves: ["2026-09-07T11:00:00.000Z"],
          duration: 3_600,
        },
      ],
    },
    ...overrides,
  };
}

test("strictly parses Learning Analytics and binds provider IDs to attendance", () => {
  const payload = parseBbbAnalyticsPayload(analyticsPayload());
  assert.equal(payload.meetingId, meetingIdForOccurrenceValue(occurrenceId));
  assert.deepEqual(attendanceEvidenceFromBbb(payload), {
    student: {
      userId: "STUDENT-A",
      accumulatedSeconds: 3_600,
    },
    teacher: {
      userId: "TEACHER-A",
      accumulatedSeconds: 3_600,
    },
  });
  assert.match(bbbEvidenceReference(payload.internalMeetingId), /^bbb:[a-f0-9]{64}$/);
});

test("missing teacher remains missing evidence so it cannot silently complete", () => {
  const input = analyticsPayload();
  (input.data.attendees as unknown[]).pop();
  const evidence = attendanceEvidenceFromBbb(parseBbbAnalyticsPayload(input));
  assert.equal(evidence.teacher, undefined);
  assert.equal(evidence.student?.accumulatedSeconds, 3_600);
});

test("rejects malformed sessions, breakout callbacks and metadata/booking mismatches", () => {
  const malformed = analyticsPayload();
  (malformed.data.attendees[0] as { leaves: string[] }).leaves = [];
  assert.throws(() => parseBbbAnalyticsPayload(malformed), /join\/leave pairs/);

  const breakout = analyticsPayload();
  breakout.data.metadata.is_breakout = "true";
  assert.throws(() => parseBbbAnalyticsPayload(breakout), /Breakout analytics/);

  const mismatch = analyticsPayload();
  mismatch.data.metadata["booking-id"] = "BOOK-B";
  assert.throws(() => attendanceEvidenceFromBbb(parseBbbAnalyticsPayload(mismatch)), /does not match/);

  const duplicate = analyticsPayload();
  duplicate.data.attendees.push({ ...duplicate.data.attendees[0] });
  assert.throws(() => parseBbbAnalyticsPayload(duplicate), /duplicate external user IDs/);
});

test("callback URL credentials are random, expiring, timing-safe, and bound to meeting + occurrence", () => {
  const secret = "bbb-shared-secret";
  const meetingId = meetingIdForOccurrenceValue(occurrenceId);
  const now = new Date("2026-09-07T09:55:00.000Z");
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const nonce = bbbCallbackNonce();
  const signature = bbbCallbackSignature(secret, occurrenceId, meetingId, nonce, issuedAt);
  assert.notEqual(nonce, bbbCallbackNonce());
  assert.equal(verifyBbbCallbackSignature({ secret, occurrenceId, meetingId, nonce, issuedAt, signature }, now), true);
  assert.equal(verifyBbbCallbackSignature({ secret, occurrenceId, meetingId: `${meetingId}-other`, nonce, issuedAt, signature }, now), false);
  assert.equal(verifyBbbCallbackSignature({ secret, occurrenceId: "BOOK-B:2026-09-07", meetingId, nonce, issuedAt, signature }, now), false);
  assert.equal(verifyBbbCallbackSignature({ secret: "wrong", occurrenceId, meetingId, nonce, issuedAt, signature }, now), false);
  assert.equal(verifyBbbCallbackSignature(
    { secret, occurrenceId, meetingId, nonce, issuedAt, signature },
    new Date("2026-09-08T00:00:00.000Z"),
  ), false);
});

test("rejects attendee duration that is not supported by join and leave evidence", () => {
  const forged = analyticsPayload();
  forged.data.attendees[0].duration = 3_590;
  assert.throws(() => parseBbbAnalyticsPayload(forged), /does not match join\/leave evidence/);
});

test("meeting IDs differ for weekly occurrences in the same booking", () => {
  assert.notEqual(
    meetingIdForOccurrenceValue("BOOK-A:2026-09-07"),
    meetingIdForOccurrenceValue("BOOK-A:2026-09-14"),
  );
});
