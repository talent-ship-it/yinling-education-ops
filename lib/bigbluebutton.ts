import "server-only";

import { createHash, createHmac, randomUUID } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { classroomMeetingDurationMinutes } from "./classroom-duration";
import { claimClassroomCreation, releaseClassroomCreation } from "@/lib/ops-store";

import {
  bbbCallbackNonce,
  bbbCallbackSignature,
  meetingIdForOccurrenceValue,
} from "@/lib/bbb-analytics";

type BbbRecord = Record<string, unknown>;

export type BbbRecording = {
  id: string;
  name: string;
  state: string;
  startTime?: string;
  endTime?: string;
  playbackUrl?: string;
};

export class BigBlueButtonError extends Error {
  constructor(
    message: string,
    readonly code = "bbb_error",
    readonly status = 502,
  ) {
    super(message);
  }
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
});

/** BBB is an external boundary: never let a provider request hold a server
 * request open indefinitely (or leave the UI waiting forever). */
export const BBB_REQUEST_TIMEOUT_MS = 15_000;

function configuration() {
  const rawUrl = process.env.BBB_API_URL?.trim();
  const secret = process.env.BBB_API_SECRET?.trim();
  if (!rawUrl || !secret) {
    throw new BigBlueButtonError("在线教室环境变量尚未配置。", "missing_configuration", 503);
  }

  const withoutSlash = rawUrl.replace(/\/+$/, "");
  const apiUrl = withoutSlash.endsWith("/bigbluebutton/api")
    ? withoutSlash
    : withoutSlash.endsWith("/bigbluebutton")
      ? `${withoutSlash}/api`
      : `${withoutSlash}/bigbluebutton/api`;
  return { apiUrl, secret };
}

function text(value: unknown) {
  return value === undefined || value === null ? "" : String(value);
}

function record(value: unknown): BbbRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as BbbRecord : {};
}

function list(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function normalizeMeetingId(value: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 220);
  if (normalized.length < 2) throw new BigBlueButtonError("会议 ID 无效。", "invalid_meeting_id", 400);
  return normalized;
}

export function meetingIdForOccurrence(occurrenceId: string) {
  return normalizeMeetingId(meetingIdForOccurrenceValue(occurrenceId));
}

function callbackOrigin() {
  const configured = process.env.APP_ORIGIN?.trim();
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim();
  const raw = configured || (vercelHost ? `https://${vercelHost}` : "");
  if (!raw) {
    throw new BigBlueButtonError("在线教室回调域名尚未配置。", "missing_callback_origin", 503);
  }
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    throw new BigBlueButtonError("在线教室回调域名无效。", "invalid_callback_origin", 503);
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && local)) {
    throw new BigBlueButtonError("在线教室回调必须使用 HTTPS。", "invalid_callback_origin", 503);
  }
  return origin.origin;
}

function analyticsCallbackUrl(occurrenceId: string, meetingId: string) {
  const { secret } = configuration();
  const nonce = bbbCallbackNonce();
  const issuedAt = Math.floor(Date.now() / 1_000);
  const signature = bbbCallbackSignature(secret, occurrenceId, meetingId, nonce, issuedAt);
  const url = new URL("/api/classroom/analytics", callbackOrigin());
  url.searchParams.set("occurrenceId", occurrenceId);
  url.searchParams.set("meetingId", meetingId);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("issuedAt", String(issuedAt));
  url.searchParams.set("signature", signature);
  return url.toString();
}

export function buildBigBlueButtonUrl(action: string, params: Record<string, string | number | boolean | undefined>) {
  const { apiUrl, secret } = configuration();
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) query.set(key, String(value));
  });
  const queryString = query.toString();
  const checksum = createHash("sha1").update(`${action}${queryString}${secret}`).digest("hex");
  return `${apiUrl}/${action}?${queryString}&checksum=${checksum}`;
}

function meetingPassword(meetingId: string, role: "moderator" | "viewer") {
  const { secret } = configuration();
  return createHmac("sha256", secret)
    .update(`${role}:${meetingId}`)
    .digest("base64url")
    .slice(0, 30);
}

async function call(action: string, params: Record<string, string | number | boolean | undefined>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BBB_REQUEST_TIMEOUT_MS);
  let response: Response;
  let raw = "";
  try {
    response = await fetch(buildBigBlueButtonUrl(action, params), {
      headers: { Accept: "application/xml,text/xml" },
      cache: "no-store",
      signal: controller.signal,
    });
    raw = await response.text();
  } catch (error) {
    if (error instanceof BigBlueButtonError) throw error;
    if (controller.signal.aborted) {
      throw new BigBlueButtonError("在线教室服务请求超时，请稍后重试。", "timeout", 504);
    }
    throw new BigBlueButtonError("无法连接在线教室服务，请稍后重试。", "network_error", 502);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new BigBlueButtonError(`在线教室服务请求失败（${response.status}）。`, "http_error", 502);
  }

  let parsed: BbbRecord;
  try {
    parsed = record(xmlParser.parse(raw).response);
  } catch {
    throw new BigBlueButtonError("在线教室服务返回了无法识别的内容。", "invalid_response", 502);
  }

  if (text(parsed.returncode).toUpperCase() !== "SUCCESS") {
    throw new BigBlueButtonError(
      text(parsed.message) || "在线教室服务未完成请求。",
      text(parsed.messageKey) || "api_error",
      502,
    );
  }
  return parsed;
}

export async function createMeeting(input: {
  meetingId: string;
  name: string;
  durationMinutes: number;
  scheduledStartsAt: number;
  logoutUrl: string;
  occurrenceId: string;
  bookingId: string;
  studentId: string;
  teacherId: string;
  /** Server-owned immutable claim from the recorded temporary-classroom saga. */
  temporaryRequestIdentity?: string;
}) {
  const meetingId = normalizeMeetingId(input.meetingId);
  const leaseId = randomUUID();
  if (!await claimClassroomCreation(input.occurrenceId, meetingId, leaseId, input.temporaryRequestIdentity)) {
    throw new BigBlueButtonError("这节课正在结束或已经结束，不能重新开课。", "classroom_closing", 409);
  }
  // A timeout retains the short-lived lease: the provider may still complete
  // the request. End recovery cannot declare success while that lease is live.
  const result = await call("create", {
    name: input.name.slice(0, 180),
    meetingID: meetingId,
    moderatorPW: meetingPassword(meetingId, "moderator"),
    attendeePW: meetingPassword(meetingId, "viewer"),
    record: true,
    autoStartRecording: true,
    allowStartStopRecording: true,
    // Duplicate creates keep the original provider timer. The first create
    // must already cover the full scheduled end, including pre-class time.
    duration: classroomMeetingDurationMinutes(input.scheduledStartsAt, input.durationMinutes),
    logoutURL: input.logoutUrl,
    meetingExpireIfNoUserJoinedInMinutes: 45,
    meetingExpireWhenLastUserLeftInMinutes: 10,
    "meta_analytics-callback-url": analyticsCallbackUrl(input.occurrenceId, meetingId),
    "meta_occurrence-id": input.occurrenceId,
    "meta_booking-id": input.bookingId,
    "meta_student-id": input.studentId,
    "meta_teacher-id": input.teacherId,
    "meta_course-source": "yinling-education-ops",
  });
  if (!await releaseClassroomCreation(input.occurrenceId, leaseId)) {
    // An end intent won the race while BBB was creating the room. Never issue
    // a join URL; the persisted intent also lets cron retry a failed close.
    await endMeeting(meetingId).catch(() => undefined);
    throw new BigBlueButtonError("这节课正在结束或已经结束，不能重新开课。", "classroom_closing", 409);
  }
  return {
    meetingId: text(result.meetingID) || meetingId,
    internalMeetingId: text(result.internalMeetingID),
    createTime: text(result.createTime),
    duplicate: text(result.messageKey) === "duplicateWarning",
  };
}

/**
 * Creates a short-lived BBB room for product checks only.  It deliberately
 * has no lesson, student, teacher, analytics callback or recording metadata:
 * a temporary test must never be mistaken for a delivered class.
 */
export async function createTemporaryTestMeeting(input: {
  meetingId: string;
  logoutUrl: string;
  durationMinutes?: number;
}) {
  const meetingId = normalizeMeetingId(input.meetingId);
  const result = await call("create", {
    name: "吟领教育 · 临时课堂",
    meetingID: meetingId,
    moderatorPW: meetingPassword(meetingId, "moderator"),
    attendeePW: meetingPassword(meetingId, "viewer"),
    record: false,
    autoStartRecording: false,
    allowStartStopRecording: false,
    duration: Math.max(15, Math.min(360, Math.ceil(input.durationMinutes ?? 60))),
    logoutURL: input.logoutUrl,
    meetingExpireIfNoUserJoinedInMinutes: 45,
    meetingExpireWhenLastUserLeftInMinutes: 10,
  });
  return {
    meetingId: text(result.meetingID) || meetingId,
    duplicate: text(result.messageKey) === "duplicateWarning",
  };
}

export function createJoinUrl(input: {
  meetingId: string;
  fullName: string;
  role: "MODERATOR" | "VIEWER";
  userId: string;
}) {
  const meetingId = normalizeMeetingId(input.meetingId);
  const password = input.role === "MODERATOR"
    ? meetingPassword(meetingId, "moderator")
    : meetingPassword(meetingId, "viewer");
  return buildBigBlueButtonUrl("join", {
    meetingID: meetingId,
    fullName: input.fullName.slice(0, 120),
    role: input.role,
    password,
    userID: input.userId.slice(0, 120),
    redirect: true,
  });
}

export async function meetingStatus(meetingIdInput: string) {
  const meetingId = normalizeMeetingId(meetingIdInput);
  const runningResult = await call("isMeetingRunning", { meetingID: meetingId });
  const running = text(runningResult.running).toLowerCase() === "true";
  if (!running) return { meetingId, running: false, participantCount: 0, moderatorCount: 0 };

  const info = await call("getMeetingInfo", {
    meetingID: meetingId,
    password: meetingPassword(meetingId, "moderator"),
  });
  return {
    meetingId,
    running: true,
    participantCount: Number(text(info.participantCount) || 0),
    moderatorCount: Number(text(info.moderatorCount) || 0),
    startTime: text(info.startTime) || undefined,
    recording: text(info.recording).toLowerCase() === "true",
  };
}

export async function endMeeting(meetingIdInput: string) {
  const meetingId = normalizeMeetingId(meetingIdInput);
  await call("end", {
    meetingID: meetingId,
    password: meetingPassword(meetingId, "moderator"),
  });
  return { meetingId, ended: true };
}

export async function getRecordings(meetingIdInput: string): Promise<BbbRecording[]> {
  const meetingId = normalizeMeetingId(meetingIdInput);
  const result = await call("getRecordings", { meetingID: meetingId });
  const recordings = record(result.recordings);
  return list(recordings.recording).map((item) => {
    const recording = record(item);
    const playback = record(recording.playback);
    const firstFormat = Array.isArray(playback.format) ? record(playback.format[0]) : record(playback.format);
    return {
      id: text(recording.recordID),
      name: text(recording.name) || "课堂录播",
      state: text(recording.state) || "processing",
      startTime: text(recording.startTime) || undefined,
      endTime: text(recording.endTime) || undefined,
      playbackUrl: text(firstFormat.url) || undefined,
    };
  }).filter((recording) => recording.id);
}
