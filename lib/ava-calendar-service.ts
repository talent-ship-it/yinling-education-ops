import type { DemoSessionIdentity } from "./demo-session-token";
import type { OpsStateRow, OpsVersionRow } from "./ops-store";
import type { AvaCalendarProjection, AvaCoordinatorAccount } from "./ava-calendar-projection";
import type { AvaCalendarSnapshot, AvaCalendarWindow } from "./ava-calendar-snapshot";
import { AvaCalendarReadError, validateAvaCalendarWindow } from "./ava-calendar-snapshot";
import { withAvaCalendarReadAuthority } from "./ava-calendar-read-authority";
import { buildOpsAccessContext, canReadOpsEntity } from "./ops-access";
import { projectAvaCalendarEvents } from "./ava-calendar-projection";
import { authorizeAvaCalendarMachineRequest, type AvaCalendarMachineCapability } from "./ava-calendar-machine-auth";
import { mapJiaowubaoSnapshotParticipant } from "./jiaowubao-open-api-schedule-reader";
import { normalizeStudentImportName, studentImportAutomaticJwbNameKey } from "./student-import";
import { TRIAL_OPERATIONS } from "./lp-workflows";
import { isJiaowubaoSharedTrialAccountLabel } from "./trial-operations";
import type { AvaCalendarPublicationComposition } from "./ava-calendar-server-composition";
export { createAvaCalendarRouteComposition } from "./ava-calendar-server-composition";

export type AvaCalendarDependencies = {
  readSession: () => Promise<{ session: DemoSessionIdentity; fullAdmin: boolean } | { error: string; status: number }>;
  readRows: () => Promise<OpsStateRow[]>;
  readVersions: () => Promise<OpsVersionRow[]>;
  readAccounts: () => Promise<readonly AvaCoordinatorAccount[]>;
  readSnapshot: (window: AvaCalendarWindow) => Promise<AvaCalendarSnapshot>;
  strictSourceIdentity?: boolean;
  publication?: AvaCalendarPublicationComposition;
};
type CalendarReadDependencies = Omit<AvaCalendarDependencies, "readSession">;
type CalendarDenial = { error: string; status: number };

class CalendarAuthorityDenied extends Error {
  constructor(readonly denial: CalendarDenial) {
    super("calendar_authority_denied");
  }
}

const ENTITIES = ["students", "teachers", "bookings", "lpItems"];
const HEADERS = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };

function json(body: unknown, status = 200, vary = "Cookie") {
  return Response.json(body, { status, headers: { ...HEADERS, Vary: vary } });
}

function versions(rows: OpsVersionRow[]) {
  return ENTITIES.map((entity) => {
    const matches = rows.filter((row) => row.entity === entity);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0]!.version) || matches[0]!.version < 0) throw new AvaCalendarReadError("source_unavailable");
    return matches[0]!.version;
  });
}

function accountVersions(accounts: readonly AvaCoordinatorAccount[]) {
  return JSON.stringify(accounts.map((account) => [account.account_id, account.account_name, account.account_role, account.status]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

function requestWindow(request: Request) {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => !["start", "end"].includes(key)) || params.getAll("start").length !== 1 || params.getAll("end").length !== 1) throw new AvaCalendarReadError("invalid_window");
  const window = { start: params.get("start")!, end: params.get("end")! };
  validateAvaCalendarWindow(window);
  return window;
}

function validateRowPayloads(rows: OpsStateRow[]) {
  if (ENTITIES.some((entity) => !Array.isArray(rows.find((row) => row.entity === entity)?.payload))) throw new AvaCalendarReadError("source_unavailable");
}

type CalendarAuthority = {
  identity: unknown;
  accounts: readonly AvaCoordinatorAccount[];
};

function validateCurrentAuthority(initial: CalendarAuthority & { versions: number[] }, current: CalendarAuthority & { versions: OpsVersionRow[] }) {
  if (JSON.stringify(initial.versions) !== JSON.stringify(versions(current.versions)) || JSON.stringify(initial.identity) !== JSON.stringify(current.identity)
    || accountVersions(initial.accounts) !== accountVersions(current.accounts)) throw new AvaCalendarReadError("source_changed");
}

function errorResponse(error: unknown, vary = "Cookie") {
  if (error instanceof AvaCalendarReadError && error.code === "invalid_window") return json({ error: "请选择有效的日期范围。" }, 400, vary);
  if (error instanceof AvaCalendarReadError && error.code === "source_changed") return json({ error: "课表或身份已更新，请刷新。" }, 409, vary);
  return json({ error: "课表暂时无法完整读取，请稍后重试。" }, 503, vary);
}

async function readCalendarPublication<Authority extends object>(dependencies: CalendarReadDependencies, rows: OpsStateRow[], window: AvaCalendarWindow, initialVersions: number[], initial: Authority, readAuthority: () => Promise<Authority | CalendarDenial>, project: (snapshot: AvaCalendarSnapshot, accounts: readonly AvaCoordinatorAccount[]) => AvaCalendarProjection, guard?: () => CalendarDenial | undefined) {
  const check = guard ?? (() => undefined);
  const denied = check();
  if (denied) return denied;
  const [snapshot, accounts] = await Promise.all([dependencies.readSnapshot(window), dependencies.readAccounts()]);
  const revoked = check();
  if (revoked) return revoked;
  await dependencies.publication?.readMetadata(snapshot, async () => {
    if (guard) {
      const denied = guard();
      if (denied) throw new CalendarAuthorityDenied(denied);
      return;
    }
    const current = await readAuthority();
    if ("error" in current) throw new CalendarAuthorityDenied(current);
    if (JSON.stringify(current) !== JSON.stringify(initial)) throw new AvaCalendarReadError("source_changed");
  });
  const metadataRevoked = check();
  if (metadataRevoked) return metadataRevoked;
  const [currentVersions, currentIdentity, currentAccounts] = await Promise.all([dependencies.readVersions(), readAuthority(), dependencies.readAccounts()]);
  if ("error" in currentIdentity) return currentIdentity;
  validateCurrentAuthority({ versions: initialVersions, identity: initial, accounts }, { versions: currentVersions, identity: currentIdentity, accounts: currentAccounts });
  const projection = project(snapshot, accounts);
  const publication = { ...projection, source: { revision: snapshot.revision, publishedAt: snapshot.publishedAt, freshness: snapshot.freshness, coverage: snapshot.coverage },
    ...dependencies.publication?.compose({ snapshot, rows, window, accounts, identity: initial, currentVersions, projection }) };
  return check() ?? publication;
}

function calendarText(value: unknown) {
  return typeof value === "string" && value.trim().length <= 240 ? value.trim() : "";
}

function calendarIdentityKey(value: unknown) {
  return calendarText(value).normalize("NFKC").toLocaleLowerCase("en-AU");
}

function machineRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AvaCalendarReadError("source_unavailable");
  return value as Record<string, unknown>;
}

function validMachineRecordId(id: unknown, seen: ReadonlyMap<string, unknown>): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 240 && id === id.trim() && !seen.has(id);
}

function machineRecords(rows: OpsStateRow[], entity: string) {
  const result = new Map<string, Record<string, unknown>>();
  for (const value of rows.find((row) => row.entity === entity)!.payload as unknown[]) {
    const item = machineRecord(value);
    if (!validMachineRecordId(item.id, result)) throw new AvaCalendarReadError("source_unavailable");
    result.set(item.id, item);
  }
  return result;
}

function machineCandidates(records: ReadonlyMap<string, Record<string, unknown>>, keys: (item: Record<string, unknown>) => string[]) {
  const result = new Map<string, string[]>();
  records.forEach((item, id) => {
    new Set(keys(item).filter(Boolean)).forEach((key) => result.set(key, [...(result.get(key) ?? []), id]));
  });
  return result;
}

function machineStudentLookup(students: ReadonlyMap<string, Record<string, unknown>>) {
  const memberCandidates = machineCandidates(students, (student) => {
    const value = student.jwbSourceRow;
    const key = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(key) ? [key] : [];
  });
  const nameCandidates = machineCandidates(students, (student) => [normalizeStudentImportName(calendarText(student.name)), studentImportAutomaticJwbNameKey(calendarText(student.name))]);
  const unique = (candidates: Map<string, string[]>) => new Map([...candidates].filter(([, ids]) => ids.length === 1).map(([key, ids]) => [key, ids[0]!]));
  return { memberCandidates, nameCandidates, internalByMember: unique(memberCandidates), internalByNameKey: unique(nameCandidates) };
}

function machineTrialStudent(event: AvaCalendarSnapshot["events"][number], teacherId: string | null, revision: string, lpItems: ReadonlyMap<string, Record<string, unknown>>, students: ReadonlyMap<string, Record<string, unknown>>) {
  const linked = [...lpItems.values()].filter((item) => {
    const link = item.trialSchedule as Record<string, unknown> | null;
    return ["试听 LP", "换老师试听"].includes(calendarText(item.workflowType)) && link?.source === "jiaowubao-open-api" && link.sourceRevision === revision
      && link.eventId === event.eventId && link.startsAt === event.startsAt && link.endsAt === event.endsAt && teacherId !== null && link.teacherId === teacherId;
  });
  const studentId = linked.length === 1 ? calendarText(linked[0]!.studentId) : "";
  return students.has(studentId) ? studentId : null;
}

function machineCalendarStudent(studentId: string, students: ReadonlyMap<string, Record<string, unknown>>, accounts: readonly AvaCoordinatorAccount[]) {
  const student = students.get(studentId)!;
  const index = TRIAL_OPERATIONS.findIndex((owner) => calendarIdentityKey(owner) === calendarIdentityKey(student.owner));
  const owner = TRIAL_OPERATIONS[index] ?? null;
  const matches = owner === null ? [] : accounts.filter((account) => account.account_role === "staff" && account.status === "active" && calendarIdentityKey(account.account_name) === calendarIdentityKey(owner));
  const assigned = matches.length === 1;
  return { studentId, studentName: calendarText(student.name), owner: assigned ? owner : null, ownerId: assigned ? matches[0]!.account_id : null, color: assigned ? `owner-${index + 1}` : "owner-unassigned" };
}

type MachineProjectionContext = {
  students: ReadonlyMap<string, Record<string, unknown>>;
  teachers: ReadonlyMap<string, Record<string, unknown>>;
  lpItems: ReadonlyMap<string, Record<string, unknown>>;
  teacherCandidates: Map<string, string[]>;
  lookup: ReturnType<typeof machineStudentLookup>;
  revision: string;
  accounts: readonly AvaCoordinatorAccount[];
};

function machineEventIdentity(event: AvaCalendarSnapshot["events"][number], context: MachineProjectionContext) {
  const candidates = context.teacherCandidates.get(calendarIdentityKey(event.sourceTeacherLabel)) ?? [];
  const teacherId = candidates.length === 1 ? candidates[0]! : null;
  const shared = event.sourceParticipants.some((participant) => isJiaowubaoSharedTrialAccountLabel(participant.label));
  const participants = event.sourceParticipants.filter((participant) => !isJiaowubaoSharedTrialAccountLabel(participant.label));
  const ids = [...new Set(participants.map((participant) => mapJiaowubaoSnapshotParticipant(participant, context.lookup)).filter((id): id is string => id !== null))];
  const linkedId = machineTrialStudent(event, teacherId, context.revision, context.lpItems, context.students);
  if (shared && participants.length === 0 && linkedId !== null) ids.push(linkedId);
  const trialResolved = linkedId !== null && ids.length === 1 && ids[0] === linkedId;
  return { teacherId, shared, participants, ids, trialResolved };
}

function machineIdentityPending(event: AvaCalendarSnapshot["events"][number], identity: ReturnType<typeof machineEventIdentity>) {
  return identity.teacherId === null || event.sourceStudentsTruncated || (identity.shared ? !identity.trialResolved : identity.ids.length !== identity.participants.length);
}

function machineCalendarEvent(event: AvaCalendarSnapshot["events"][number], context: MachineProjectionContext) {
  const identity = machineEventIdentity(event, context);
  return { eventId: event.eventId, startsAt: event.startsAt, endsAt: event.endsAt, teacherId: identity.teacherId,
    teacherName: identity.teacherId ? calendarText(context.teachers.get(identity.teacherId)?.name) : null,
    students: identity.ids.map((id) => machineCalendarStudent(id, context.students, context.accounts)), trial: identity.shared || identity.trialResolved,
    identityPending: machineIdentityPending(event, identity) };
}

function projectMachineCalendar(rows: OpsStateRow[], capability: AvaCalendarMachineCapability, snapshot: AvaCalendarSnapshot, accounts: readonly AvaCoordinatorAccount[]): AvaCalendarProjection {
  if (capability.permission !== "calendar:read" || capability.scope !== "company") throw new AvaCalendarReadError("source_unavailable");
  const students = new Map([...machineRecords(rows, "students")].filter(([, student]) => calendarIdentityKey(String(student.importArchived ?? "false")) !== "true" && !isJiaowubaoSharedTrialAccountLabel(student.name)));
  const teachers = machineRecords(rows, "teachers");
  const lpItems = machineRecords(rows, "lpItems");
  const context: MachineProjectionContext = { students, teachers, lpItems, lookup: machineStudentLookup(students), teacherCandidates: machineCandidates(teachers, (teacher) => [calendarIdentityKey(teacher.name)]), revision: snapshot.revision, accounts };
  const publicTeachers = [...teachers].flatMap(([id, teacher]) => calendarText(teacher.name) ? [{ id, name: calendarText(teacher.name) }] : []);
  return { events: snapshot.events.map((event) => machineCalendarEvent(event, context)), teachers: publicTeachers };
}

export function createAvaCalendarMachineHandler(dependencies: CalendarReadDependencies & { readTokenSha256: () => string | undefined }) {
  return async (request: Request) => {
    try {
      const authorize = async () => authorizeAvaCalendarMachineRequest(request, dependencies.readTokenSha256);
      const capability = await authorize();
      if ("error" in capability) return json({ error: capability.error }, capability.status, "Authorization");
      const window = requestWindow(request);
      const guard = () => {
        const current = authorizeAvaCalendarMachineRequest(request, dependencies.readTokenSha256);
        return "error" in current ? current : current.tokenSha256 !== capability.tokenSha256 ? { error: "请提供有效的课表服务凭据。", status: 401 } : undefined;
      };
      const revoked = guard();
      if (revoked) return json({ error: revoked.error }, revoked.status, "Authorization");
      const rows = await dependencies.readRows();
      const initialVersions = versions(rows);
      validateRowPayloads(rows);
      const publication = await withAvaCalendarReadAuthority(() => {
        const denied = guard();
        if (denied) throw new CalendarAuthorityDenied(denied);
      }, () => readCalendarPublication(dependencies, rows, window, initialVersions, capability, authorize, (snapshot, accounts) => dependencies.strictSourceIdentity
        ? projectAvaCalendarEvents({ rows, access: capability, accounts, events: snapshot.events, revision: snapshot.revision, strictSourceIdentity: true, sourceEvents: dependencies.publication?.sourceEvents(snapshot) })
        : projectMachineCalendar(rows, capability, snapshot, accounts), guard));
      if ("error" in publication) return json({ error: publication.error }, publication.status, "Authorization");
      const denied = guard();
      return denied ? json({ error: denied.error }, denied.status, "Authorization") : json(publication, 200, "Authorization");
    } catch (error) {
      return error instanceof CalendarAuthorityDenied ? json({ error: error.denial.error }, error.denial.status, "Authorization") : errorResponse(error, "Authorization");
    }
  };
}

export function createAvaCalendarHandler(dependencies: AvaCalendarDependencies) {
  return async (request: Request) => {
    try {
      const resolved = await dependencies.readSession();
      if (!("session" in resolved)) return json({ error: resolved.error }, resolved.status);
      const window = requestWindow(request);
      const rows = await dependencies.readRows();
      const initialVersions = versions(rows);
      validateRowPayloads(rows);
      const access = buildOpsAccessContext(rows, resolved.session.user, resolved.fullAdmin, resolved.session);
      if (!["students", "teachers", "bookings"].every((entity) => canReadOpsEntity(access, entity))) return json({ error: "当前账号无权查看日历。" }, 403);
      const publication = await readCalendarPublication(dependencies, rows, window, initialVersions, resolved, dependencies.readSession, (snapshot, accounts) => projectAvaCalendarEvents({ rows, access, accounts, events: snapshot.events, revision: snapshot.revision, strictSourceIdentity: dependencies.strictSourceIdentity, sourceEvents: dependencies.publication?.sourceEvents(snapshot) }));
      return "error" in publication ? json({ error: publication.error }, publication.status) : json(publication);
    } catch (error) {
      return error instanceof CalendarAuthorityDenied ? json({ error: error.denial.error }, error.denial.status) : errorResponse(error);
    }
  };
}
