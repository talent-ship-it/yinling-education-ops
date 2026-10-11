import type { AccountDirectoryRow, JiaowubaoOpenApiScheduleSnapshotWindow, OpsStateRow } from "./ops-store";
import type { OpsAccessContext } from "./ops-access";
import { canReadOpsEntity, canReadUnrestrictedOpsData, filterOpsStateRows } from "./ops-access";
import { mapJiaowubaoSnapshotParticipant, type JiaowubaoSnapshotStudentLookup } from "./jiaowubao-open-api-schedule-reader";
import { normalizeStudentImportName, studentImportAutomaticJwbNameKey } from "./student-import";
import { TRIAL_OPERATIONS } from "./lp-workflows";
import { isJiaowubaoSharedTrialAccountLabel } from "./trial-operations";
import { AvaCalendarReadError } from "./ava-calendar-snapshot";

export type AvaCoordinatorAccount = Pick<AccountDirectoryRow, "account_id" | "account_name" | "account_role" | "status">;
export type AvaCalendarStudent = { studentId: string; studentName: string; owner: string | null; ownerId: string | null; color: string };
export type AvaCalendarEvent = { eventId: string; startsAt: string; endsAt: string; teacherId: string | null; teacherName: string | null; students: AvaCalendarStudent[]; trial: boolean; identityPending: boolean };
export type AvaCalendarProjection = { events: AvaCalendarEvent[]; teachers: { id: string; name: string }[] };
export type AvaCalendarProjectionInput = {
  rows: OpsStateRow[];
  events: JiaowubaoOpenApiScheduleSnapshotWindow["events"];
  access: OpsAccessContext;
  accounts: readonly AvaCoordinatorAccount[];
  revision?: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim().length <= 240 ? value.trim() : "";
}

function key(value: unknown) {
  return text(value).normalize("NFKC").toLocaleLowerCase("en-AU");
}

function records(rows: OpsStateRow[], entity: string) {
  return parseCalendarRecords(rows.find((row) => row.entity === entity)?.payload);
}

function parseCalendarRecords(payload: unknown) {
  if (!Array.isArray(payload)) return [];
  const seen = new Set<string>();
  return payload.map((value) => {
    const item = record(value);
    if (!item || typeof item.id !== "string" || !item.id || item.id.length > 240 || item.id !== item.id.trim() || seen.has(item.id)) throw new AvaCalendarReadError("source_unavailable");
    seen.add(item.id);
    return item;
  });
}

function sourceKey(value: unknown) {
  const candidate = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(candidate) ? candidate : "";
}

function candidateMap(items: Record<string, unknown>[], keys: (item: Record<string, unknown>) => string[]) {
  const candidates = new Map<string, string[]>();
  for (const item of items) {
    const id = text(item.id);
    if (!id) continue;
    for (const name of new Set(keys(item).filter(Boolean))) {
      candidates.set(name, [...(candidates.get(name) ?? []), id]);
    }
  }
  return candidates;
}

type SnapshotEvent = JiaowubaoOpenApiScheduleSnapshotWindow["events"][number];
type EventProjectionContext = {
  access: OpsAccessContext;
  accounts: readonly AvaCoordinatorAccount[];
  revision?: string;
  lookup: JiaowubaoSnapshotStudentLookup;
  lpItems: Record<string, unknown>[];
  studentById: Map<string, Record<string, unknown>>;
  teacherById: Map<string, Record<string, unknown>>;
  teacherCandidates: Map<string, string[]>;
  visibleTeacherIds: Set<string>;
};

function resolveTeacherId(event: SnapshotEvent, candidates: Map<string, string[]>) {
  const ids = candidates.get(key(event.sourceTeacherLabel)) ?? [];
  return ids.length === 1 ? ids[0]! : null;
}

function currentTrialRevision(link: Record<string, unknown> | null, revision: string | undefined): link is Record<string, unknown> {
  return link?.source === "jiaowubao-open-api" && /^sha256:[a-f0-9]{64}$/.test(revision ?? "") && link.sourceRevision === revision;
}

function exactTrialLink(item: Record<string, unknown>, event: SnapshotEvent, teacherId: string | null, revision: string | undefined) {
  const link = record(item.trialSchedule);
  return ["试听 LP", "换老师试听"].includes(text(item.workflowType)) && currentTrialRevision(link, revision)
    && link.eventId === event.eventId && link.startsAt === event.startsAt && link.endsAt === event.endsAt
    && teacherId !== null && link.teacherId === teacherId;
}

function resolveTrialStudent(event: SnapshotEvent, teacherId: string | null, context: EventProjectionContext) {
  const trialLinks = context.lpItems.filter((item) => exactTrialLink(item, event, teacherId, context.revision));
  return trialLinks.length === 1 && context.studentById.has(text(trialLinks[0]!.studentId))
    && context.access.activeStudentIds.has(text(trialLinks[0]!.studentId)) ? text(trialLinks[0]!.studentId) : null;
}

function resolveEventStudents(event: SnapshotEvent, teacherId: string | null, context: EventProjectionContext) {
  const shared = event.sourceParticipants.some((participant) => isJiaowubaoSharedTrialAccountLabel(participant.label));
  const participants = event.sourceParticipants.filter((participant) => !isJiaowubaoSharedTrialAccountLabel(participant.label));
  const ids = [...new Set(participants.flatMap((participant) => {
    const id = mapJiaowubaoSnapshotParticipant(participant, context.lookup);
    return id ? [id] : [];
  }))];
  const linkedId = resolveTrialStudent(event, teacherId, context);
  if (shared && participants.length === 0 && linkedId) ids.push(linkedId);
  const trialResolved = linkedId !== null && ids.length === 1 && ids[0] === linkedId;
  return { shared, participants, ids, trialResolved };
}

function publicCalendarStudent(studentId: string, context: EventProjectionContext): AvaCalendarStudent {
  const student = context.studentById.get(studentId)!;
  const ownerIndex = TRIAL_OPERATIONS.findIndex((owner) => key(owner) === key(student.owner));
  const owner = ownerIndex >= 0 ? TRIAL_OPERATIONS[ownerIndex]! : null;
  const ownerAccounts = owner ? context.accounts.filter((account) => key(account.account_name) === key(owner) && account.account_role === "staff" && account.status === "active") : [];
  return { studentId, studentName: text(student.name), owner: ownerAccounts.length === 1 ? owner : null, ownerId: ownerAccounts.length === 1 ? ownerAccounts[0]!.account_id : null, color: ownerAccounts.length === 1 ? `owner-${ownerIndex + 1}` : "owner-unassigned" };
}

function publicCalendarEvent(event: SnapshotEvent, teacherId: string | null, identity: ReturnType<typeof resolveEventStudents>, context: EventProjectionContext): AvaCalendarEvent {
  const visibleStudents = identity.ids.map((studentId) => publicCalendarStudent(studentId, context));
  const publicTeacherId = teacherId && context.visibleTeacherIds.has(teacherId) ? teacherId : null;
  return {
    eventId: event.eventId, startsAt: event.startsAt, endsAt: event.endsAt, teacherId: publicTeacherId,
    teacherName: publicTeacherId ? text(context.teacherById.get(publicTeacherId)?.name) : null,
    students: visibleStudents, trial: identity.shared || identity.trialResolved,
    identityPending: !teacherId || event.sourceStudentsTruncated || (identity.shared ? !identity.trialResolved : identity.ids.length !== identity.participants.length),
  };
}

function projectCalendarEvent(event: SnapshotEvent, context: EventProjectionContext): AvaCalendarEvent[] {
  const teacherId = resolveTeacherId(event, context.teacherCandidates);
  if (context.access.teacher && (!teacherId || !context.access.teacherIds.has(teacherId))) return [];
  const identity = resolveEventStudents(event, teacherId, context);
  if (!context.access.teacher && !canReadUnrestrictedOpsData(context.access) && !identity.ids.length) return [];
  return [publicCalendarEvent(event, teacherId, identity, context)];
}

export function projectAvaCalendarEvents(input: AvaCalendarProjectionInput): AvaCalendarProjection {
  const { rows, access, accounts } = input;
  if (!["bookings", "teachers", "students"].every((entity) => canReadOpsEntity(access, entity))) {
    return { events: [], teachers: [] };
  }
  const students = records(rows, "students").filter((student) => key(String(student.importArchived ?? "false")) !== "true" && !isJiaowubaoSharedTrialAccountLabel(student.name));
  const memberCandidates = candidateMap(students, (item) => [sourceKey(item.jwbSourceRow)]);
  const nameCandidates = candidateMap(students, (item) => [normalizeStudentImportName(text(item.name)), studentImportAutomaticJwbNameKey(text(item.name))]);
  const allowed = (candidates: Map<string, string[]>) => new Map([...candidates].flatMap(([name, ids]) => ids.length === 1 && access.activeStudentIds.has(ids[0]!) ? [[name, ids[0]!] as const] : []));
  const lookup = { memberCandidates, nameCandidates, internalByMember: allowed(memberCandidates), internalByNameKey: allowed(nameCandidates) };
  const teachers = records(rows, "teachers");
  const teacherCandidates = candidateMap(teachers, (teacher) => [key(teacher.name)]);
  const studentById = new Map(students.map((student) => [text(student.id), student]));
  const teacherById = new Map(teachers.map((teacher) => [text(teacher.id), teacher]));
  const lpItems = records(rows, "lpItems");
  const visibleTeachers = records(filterOpsStateRows(rows, access), "teachers").flatMap((teacher) => text(teacher.id) && text(teacher.name) ? [{ id: text(teacher.id), name: text(teacher.name) }] : []);
  const visibleTeacherIds = new Set(visibleTeachers.map((teacher) => teacher.id));
  const context: EventProjectionContext = { access, accounts, revision: input.revision, lookup, lpItems, studentById, teacherById, teacherCandidates, visibleTeacherIds };
  const events = input.events.flatMap((event) => projectCalendarEvent(event, context));
  return { events, teachers: visibleTeachers };
}
