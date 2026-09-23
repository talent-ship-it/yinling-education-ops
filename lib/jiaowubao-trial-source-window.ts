import {
  getJiaowubaoOpenApiScheduleSnapshotWindow,
  type OpsRpcOptions,
} from "./ops-store";
import { acceptsJiaowubaoTrialSourcePage } from "./jiaowubao-trial-source-contract";
import { JiaowubaoTrialSyncProjectionError } from "./jiaowubao-trial-sync-projection";

type RecordValue = Record<string, unknown>;
type PinnedSourceWindow = Readonly<{ start: string; end: string }>;

function record(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalInstant(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

export function normalizeJiaowubaoTrialSourceEvent(value: unknown) {
  if (!record(value) || typeof value.eventId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.eventId.trim())) return null;
  const startsAt = canonicalInstant(value.startsAt);
  const endsAt = canonicalInstant(value.endsAt);
  if (!startsAt || !endsAt || new Date(endsAt).valueOf() <= new Date(startsAt).valueOf()
    || typeof value.sourceDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.sourceDate)
    || (value.courseName !== null && (typeof value.courseName !== "string" || !value.courseName.trim() || value.courseName.trim().length > 240))
    || (value.sourceTeacherId !== null && (typeof value.sourceTeacherId !== "string" || !value.sourceTeacherId.trim() || value.sourceTeacherId.trim().length > 240))
    || (value.sourceTeacherLabel !== null && (typeof value.sourceTeacherLabel !== "string" || !value.sourceTeacherLabel.trim() || value.sourceTeacherLabel.trim().length > 240))
    || !Array.isArray(value.sourceParticipants)
    || value.sourceParticipants.length > 101
    || !value.sourceParticipants.every((participant) => record(participant)
      && (participant.memberId === null || typeof participant.memberId === "string" && Boolean(participant.memberId.trim()))
      && (participant.label === null || typeof participant.label === "string" && Boolean(participant.label.trim()))
      && (participant.memberId !== null || participant.label !== null))
    || typeof value.sourceStudentsTruncated !== "boolean") return null;
  return {
    eventId: value.eventId.trim(),
    sourceDate: value.sourceDate,
    startsAt,
    endsAt,
    courseName: value.courseName === null ? null : value.courseName.trim(),
    sourceTeacherId: value.sourceTeacherId === null ? null : value.sourceTeacherId.trim(),
    sourceTeacherLabel: value.sourceTeacherLabel === null ? null : value.sourceTeacherLabel.trim(),
    sourceParticipants: value.sourceParticipants.map((participant) => {
      const source = participant as RecordValue;
      return {
        memberId: source.memberId === null ? null : (source.memberId as string).trim(),
        label: source.label === null ? null : (source.label as string).trim(),
      };
    }),
    sourceStudentsTruncated: value.sourceStudentsTruncated,
  };
}

/** Reads one complete immutable source revision without exposing raw rows to a browser. */
export async function readJiaowubaoTrialSourceWindow(
  snapshotRevision: string,
  window: Readonly<{ startsAt: string; endsAt: string }>,
  rpcOptions: OpsRpcOptions | (() => OpsRpcOptions) = {},
  stalePinnedSourceWindow: PinnedSourceWindow | null = null,
) {
  const events: NonNullable<ReturnType<typeof normalizeJiaowubaoTrialSourceEvent>>[] = [];
  const seenCursors = new Set<string>();
  let cursor: Readonly<{ startsAt: string; eventId: string }> | null = null;
  for (let pageIndex = 0; pageIndex < 800; pageIndex += 1) {
    const page = await getJiaowubaoOpenApiScheduleSnapshotWindow({
      windowStart: window.startsAt,
      windowEnd: window.endsAt,
      scope: "all",
      teacherLabels: null,
      studentMemberIds: null,
      studentNameKeys: null,
      limit: 250,
      cursor,
      revision: snapshotRevision,
    }, typeof rpcOptions === "function" ? rpcOptions() : rpcOptions);
    if (!acceptsJiaowubaoTrialSourcePage(
      page,
      snapshotRevision,
      window,
      stalePinnedSourceWindow,
    )) {
      throw new JiaowubaoTrialSyncProjectionError("source_changed", "教务宝课表快照已变化或过期，请刷新后重试。");
    }
    const normalized = Array.isArray(page.events) ? page.events.map(normalizeJiaowubaoTrialSourceEvent) : [];
    if (normalized.some((event) => event === null)) {
      throw new JiaowubaoTrialSyncProjectionError("source_changed", "教务宝试听排课资料格式已变化，请刷新后重试。");
    }
    events.push(...normalized as NonNullable<(typeof normalized)[number]>[]);
    if (!page.hasMore) {
      if (new Set(events.map((event) => event.eventId)).size !== events.length) {
        throw new JiaowubaoTrialSyncProjectionError("source_changed", "教务宝试听排课身份重复，请刷新后重试。");
      }
      return events;
    }
    if (!page.nextCursor) {
      throw new JiaowubaoTrialSyncProjectionError("source_changed", "教务宝试听排课分页不完整，请刷新后重试。");
    }
    const cursorKey = `${page.nextCursor.startsAt}\u0000${page.nextCursor.eventId}`;
    if (seenCursors.has(cursorKey)) {
      throw new JiaowubaoTrialSyncProjectionError("source_changed", "教务宝试听排课分页重复，请刷新后重试。");
    }
    seenCursors.add(cursorKey);
    cursor = page.nextCursor;
  }
  throw new JiaowubaoTrialSyncProjectionError("source_changed", "教务宝试听排课超过安全分页上限。");
}
