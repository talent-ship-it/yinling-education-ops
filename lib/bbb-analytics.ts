import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { LessonAttendanceEvidence } from "./lesson-occurrences";

type JsonRecord = Record<string, unknown>;

const OCCURRENCE_ID_PATTERN = /^.+:\d{4}-\d{2}-\d{2}$/;
const MAX_ATTENDEES = 1_000;
const MAX_SESSIONS_PER_ATTENDEE = 200;
const MAX_MEETING_SECONDS = 24 * 60 * 60;
const CALLBACK_MAX_AGE_SECONDS = 12 * 60 * 60;
const CALLBACK_FUTURE_TOLERANCE_SECONDS = 5 * 60;
const DURATION_TOLERANCE_SECONDS = 5;

export class BbbAnalyticsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "BbbAnalyticsError";
  }
}

export type BbbAnalyticsAttendee = Readonly<{
  userId: string;
  name: string;
  moderator: boolean;
  joins: readonly string[];
  leaves: readonly string[];
  durationSeconds: number;
}>;

export type BbbAnalyticsPayload = Readonly<{
  version: string;
  meetingId: string;
  internalMeetingId: string;
  metadata: Readonly<Record<string, string>>;
  durationSeconds: number;
  startedAt: string;
  finishedAt: string;
  attendees: readonly BbbAnalyticsAttendee[];
}>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, field: string, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new BbbAnalyticsError(`${field} is invalid.`, "invalid_payload");
  }
  return value.trim();
}

function timestamp(value: unknown, field: string) {
  const raw = requiredText(value, field, 80);
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) {
    throw new BbbAnalyticsError(`${field} is invalid.`, "invalid_payload");
  }
  return new Date(milliseconds).toISOString();
}

function integer(value: unknown, field: string, maximum = MAX_MEETING_SECONDS) {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new BbbAnalyticsError(`${field} is invalid.`, "invalid_payload");
  }
  return value as number;
}

function metadata(value: unknown) {
  if (!isRecord(value)) throw new BbbAnalyticsError("data.metadata is invalid.", "invalid_payload");
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 160 || (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean")) {
      throw new BbbAnalyticsError("data.metadata contains an invalid value.", "invalid_payload");
    }
    result[key] = String(item);
  }
  return result;
}

function timestamps(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length > MAX_SESSIONS_PER_ATTENDEE) {
    throw new BbbAnalyticsError(`${field} is invalid.`, "invalid_payload");
  }
  return value.map((item, index) => timestamp(item, `${field}[${index}]`));
}

function attendee(value: unknown, index: number): BbbAnalyticsAttendee {
  if (!isRecord(value)) throw new BbbAnalyticsError(`data.attendees[${index}] is invalid.`, "invalid_payload");
  const joins = timestamps(value.joins, `data.attendees[${index}].joins`);
  const leaves = timestamps(value.leaves, `data.attendees[${index}].leaves`);
  if (joins.length !== leaves.length || joins.some((joinedAt, session) => Date.parse(leaves[session]) < Date.parse(joinedAt))) {
    throw new BbbAnalyticsError(`data.attendees[${index}] has invalid join/leave pairs.`, "invalid_payload");
  }
  if (typeof value.moderator !== "boolean") {
    throw new BbbAnalyticsError(`data.attendees[${index}].moderator is invalid.`, "invalid_payload");
  }
  return {
    userId: requiredText(value.ext_user_id, `data.attendees[${index}].ext_user_id`, 160),
    name: requiredText(value.name, `data.attendees[${index}].name`, 240),
    moderator: value.moderator,
    joins,
    leaves,
    durationSeconds: integer(value.duration, `data.attendees[${index}].duration`),
  };
}

export function parseBbbAnalyticsPayload(value: unknown): BbbAnalyticsPayload {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new BbbAnalyticsError("Analytics payload is invalid.", "invalid_payload");
  }
  const attendeesValue = value.data.attendees;
  if (!Array.isArray(attendeesValue) || attendeesValue.length > MAX_ATTENDEES) {
    throw new BbbAnalyticsError("data.attendees is invalid.", "invalid_payload");
  }
  const startedAt = timestamp(value.data.start, "data.start");
  const finishedAt = timestamp(value.data.finish, "data.finish");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new BbbAnalyticsError("Meeting finish precedes its start.", "invalid_payload");
  }
  const parsed = {
    version: requiredText(value.version, "version", 20),
    meetingId: requiredText(value.meeting_id, "meeting_id", 240),
    internalMeetingId: requiredText(value.internal_meeting_id, "internal_meeting_id", 240),
    metadata: metadata(value.data.metadata),
    durationSeconds: integer(value.data.duration, "data.duration"),
    startedAt,
    finishedAt,
    attendees: attendeesValue.map(attendee),
  } satisfies BbbAnalyticsPayload;
  const meetingStart = Date.parse(parsed.startedAt);
  const meetingFinish = Date.parse(parsed.finishedAt);
  const meetingSeconds = Math.floor((meetingFinish - meetingStart) / 1_000);
  if (Math.abs(parsed.durationSeconds - meetingSeconds) > DURATION_TOLERANCE_SECONDS) {
    throw new BbbAnalyticsError("Meeting duration does not match its timestamps.", "invalid_payload");
  }
  const attendees = parsed.attendees.map((item, attendeeIndex) => {
    let accumulatedSeconds = 0;
    let previousLeave = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < item.joins.length; index += 1) {
      const joinedAt = Date.parse(item.joins[index]);
      const leftAt = Date.parse(item.leaves[index]);
      if (joinedAt < meetingStart || leftAt > meetingFinish || joinedAt < previousLeave) {
        throw new BbbAnalyticsError(
          `data.attendees[${attendeeIndex}] has sessions outside the meeting timeline.`,
          "invalid_payload",
        );
      }
      accumulatedSeconds += Math.floor((leftAt - joinedAt) / 1_000);
      previousLeave = leftAt;
    }
    if (Math.abs(item.durationSeconds - accumulatedSeconds) > DURATION_TOLERANCE_SECONDS) {
      throw new BbbAnalyticsError(
        `data.attendees[${attendeeIndex}].duration does not match join/leave evidence.`,
        "invalid_payload",
      );
    }
    return Object.freeze({ ...item, durationSeconds: accumulatedSeconds });
  });
  const validated = Object.freeze({ ...parsed, attendees }) satisfies BbbAnalyticsPayload;
  if (new Set(validated.attendees.map((item) => item.userId)).size !== validated.attendees.length) {
    throw new BbbAnalyticsError("data.attendees contains duplicate external user IDs.", "invalid_payload");
  }
  if (validated.metadata.is_breakout?.toLowerCase() === "true") {
    throw new BbbAnalyticsError("Breakout analytics cannot settle a lesson.", "breakout_forbidden", 422);
  }
  return validated;
}

function metadataText(source: Readonly<Record<string, string>>, names: readonly string[]) {
  for (const name of names) {
    const value = source[name]?.trim();
    if (value) return value;
  }
  return "";
}

export function bbbMeetingBindings(payload: BbbAnalyticsPayload) {
  const occurrenceId = metadataText(payload.metadata, ["occurrence-id", "occurrence_id", "occurrenceId"]);
  const bookingId = metadataText(payload.metadata, ["booking-id", "booking_id", "bookingId"]);
  const studentId = metadataText(payload.metadata, ["student-id", "student_id", "studentId"]);
  const teacherId = metadataText(payload.metadata, ["teacher-id", "teacher_id", "teacherId"]);
  if (!OCCURRENCE_ID_PATTERN.test(occurrenceId) || !bookingId || !studentId || !teacherId) {
    throw new BbbAnalyticsError("Required lesson bindings are missing from meeting metadata.", "missing_bindings", 422);
  }
  if (!occurrenceId.startsWith(`${bookingId}:`)) {
    throw new BbbAnalyticsError("Meeting booking metadata does not match the occurrence.", "binding_mismatch", 422);
  }
  return { occurrenceId, bookingId, studentId, teacherId };
}

function partyEvidence(payload: BbbAnalyticsPayload, userId: string) {
  const match = payload.attendees.find((item) => item.userId === userId);
  if (!match) return undefined;
  return {
    userId,
    // The provider's duration is accepted only after it agrees with the
    // validated, non-overlapping join/leave timeline above.
    accumulatedSeconds: match.durationSeconds,
  };
}

/** Identity comes from server-created meeting metadata, never from a browser. */
export function attendanceEvidenceFromBbb(payload: BbbAnalyticsPayload): LessonAttendanceEvidence {
  const bindings = bbbMeetingBindings(payload);
  return {
    student: partyEvidence(payload, bindings.studentId),
    teacher: partyEvidence(payload, bindings.teacherId),
  };
}

export function meetingIdForOccurrenceValue(occurrenceId: string) {
  if (!OCCURRENCE_ID_PATTERN.test(occurrenceId)) {
    throw new BbbAnalyticsError("occurrenceId is invalid.", "invalid_occurrence_id");
  }
  return `yinling-occ-${createHash("sha256").update(occurrenceId).digest("hex").slice(0, 48)}`;
}

function callbackKey(secret: string) {
  if (!secret.trim()) throw new BbbAnalyticsError("Callback secret is unavailable.", "missing_configuration", 503);
  return createHmac("sha256", secret).update("yinling:bbb-analytics-callback:v2").digest();
}

export function bbbCallbackNonce() {
  return randomBytes(32).toString("base64url");
}

export function bbbCallbackSignature(
  secret: string,
  occurrenceId: string,
  meetingId: string,
  nonce: string,
  issuedAt: number,
) {
  return createHmac("sha256", callbackKey(secret))
    .update(`signature-v2\n${occurrenceId}\n${meetingId}\n${nonce}\n${issuedAt}`)
    .digest("base64url");
}

export function verifyBbbCallbackSignature(input: {
  secret: string;
  occurrenceId: string;
  meetingId: string;
  nonce: string;
  issuedAt: number;
  signature: string;
}, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(input.nonce) || !/^[A-Za-z0-9_-]{32,128}$/.test(input.signature)) return false;
  const current = Math.floor(now.getTime() / 1_000);
  if (!Number.isSafeInteger(input.issuedAt)
      || input.issuedAt > current + CALLBACK_FUTURE_TOLERANCE_SECONDS
      || input.issuedAt < current - CALLBACK_MAX_AGE_SECONDS) return false;
  const expectedSignature = bbbCallbackSignature(
    input.secret,
    input.occurrenceId,
    input.meetingId,
    input.nonce,
    input.issuedAt,
  );
  const signature = Buffer.from(input.signature);
  const signatureExpected = Buffer.from(expectedSignature);
  return signature.length === signatureExpected.length
    && timingSafeEqual(signature, signatureExpected);
}

export function bbbNonceSha256(nonce: string) {
  return createHash("sha256").update(nonce).digest("hex");
}

export function bbbEvidenceReference(internalMeetingId: string) {
  return `bbb:${createHash("sha256").update(internalMeetingId).digest("hex")}`;
}
