import { createHash } from "node:crypto";
import type { DemoSessionIdentity } from "./demo-session-token";
import { hasDemoSessionPermission } from "./demo-session-token";
import type { OpsStateRow } from "./ops-store";
import { parseAvaCalendarInstant } from "./ava-calendar-health";
import { assertValidTeacherAvailability, deleteAvailabilityDate, expandTeacherAvailability, type TeacherAvailabilityWindow } from "./teacher-availability";

type RecordValue = Record<string, unknown>;
type Dependencies = {
  readSession: () => Promise<{ session: DemoSessionIdentity } | { error: string; status: number }>;
  readRows: () => Promise<OpsStateRow[]>;
  save: (input: { payload: unknown; expectedVersion: number; actor: string; scopeVersions: Record<string, number> }) => Promise<OpsStateRow[]>;
};
type CommandBase = { commandKey: string; expectedVersion: number };
type IntervalInput = { startsAt: string; endsAt: string; timezone: string };
type Command = CommandBase & (({ action: "create" } & IntervalInput) | ({ action: "update"; windowId: string; date: string } & IntervalInput) | { action: "delete"; windowId: string; date: string });
class SelfAvailabilityError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function fail(status: number, message: string): never { throw new SelfAvailabilityError(status, message); }
function record(value: unknown): value is RecordValue { return !!value && typeof value === "object" && !Array.isArray(value); }
function json(body: unknown, status = 200) { return Response.json(body, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } }); }
function authorize(session: DemoSessionIdentity) {
  if (session.role !== "teacher" || !hasDemoSessionPermission(session, "availability.write.self")) fail(403, "当前账号无权修改本人开放时段。");
}
async function sessionIdentity(dependencies: Dependencies) {
  const resolved = await dependencies.readSession();
  if (!("session" in resolved)) fail(resolved.status, resolved.error);
  authorize(resolved.session);
  return resolved.session;
}
function scopedRows(rows: OpsStateRow[]) {
  return Object.fromEntries(["teachers", "students", "bookings"].map((entity) => {
    const matches = rows.filter((row) => row.entity === entity);
    if (matches.length !== 1) fail(503, "老师资料暂不可用。");
    const row = matches[0]!;
    if (!Number.isSafeInteger(row.version) || row.version < 1 || !Array.isArray(row.payload)) fail(503, "老师资料暂不可用。");
    return [entity, row];
  }));
}
function ownTeacher(payload: unknown, actor: string) {
  if (!Array.isArray(payload) || !payload.every(record)) fail(503, "老师资料暂不可用。");
  const teachers = payload as RecordValue[];
  const matches = teachers.filter((teacher) => typeof teacher.name === "string" && teacher.name.trim().toLowerCase() === actor.trim().toLowerCase());
  if (matches.length !== 1) fail(403, "当前老师身份无法唯一关联。");
  const teacher = matches[0]!;
  if (typeof teacher.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(teacher.id) || teachers.filter((item) => item.id === teacher.id).length !== 1) fail(503, "老师资料暂不可用。");
  return { teachers, teacher };
}
function ownWindows(teacher: RecordValue) {
  const windows = teacher.availabilityWindows ?? [];
  if (!Array.isArray(windows) || windows.length > 64 || windows.some((item) => !record(item) || item.teacherId !== teacher.id)) fail(503, "开放时段资料无效。");
  assertValidTeacherAvailability(windows as TeacherAvailabilityWindow[]);
  return windows as TeacherAvailabilityWindow[];
}
function selfState(rows: OpsStateRow[], actor: string) {
  const scopes = scopedRows(rows);
  const row = scopes.teachers!;
  const { teachers, teacher } = ownTeacher(row.payload, actor);
  return { row, teachers, teacher, windows: ownWindows(teacher), scopeVersions: Object.fromEntries(Object.entries(scopes).map(([entity, row]) => [entity, row.version])) };
}
function commandBase(value: RecordValue): CommandBase {
  if (typeof value.commandKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.commandKey)
    || !Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 1) fail(422, "开放时段命令无效。");
  return { commandKey: value.commandKey, expectedVersion: value.expectedVersion as number };
}
function commandTarget(value: RecordValue) {
  if (typeof value.windowId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value.windowId) || typeof value.date !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || !parseAvaCalendarInstant(`${value.date}T00:00:00Z`)) fail(422, "开放时段日期无效。");
  return { windowId: value.windowId, date: value.date };
}
function minuteInstant(value: unknown) {
  const parsed = parseAvaCalendarInstant(value);
  if (!parsed || parsed.floor % 60000 || parsed.microseconds !== BigInt(parsed.floor) * BigInt(1000)) fail(422, "请选择分钟精度的时间。");
  return parsed.floor;
}
function commandInterval(value: RecordValue): IntervalInput {
  const start = minuteInstant(value.startsAt);
  const end = minuteInstant(value.endsAt);
  if (end - start < 900000 || end - start >= 86400000) fail(422, "请选择 15 分钟至不足 24 小时的完整时段。");
  if (typeof value.timezone !== "string" || value.timezone.length > 100 || value.timezone !== value.timezone.trim()) fail(422, "时区无效。");
  try { new Intl.DateTimeFormat("en", { timeZone: value.timezone }).format(0); } catch { fail(422, "时区无效。"); }
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), timezone: value.timezone };
}
function parseCommand(value: unknown): Command {
  if (!record(value) || !["create", "update", "delete"].includes(value.action as string)) fail(422, "开放时段命令无效。");
  const fields = ["commandKey", "expectedVersion", "action", ...(value.action === "create" ? [] : ["windowId", "date"]), ...(value.action === "delete" ? [] : ["startsAt", "endsAt", "timezone"])];
  if (Object.keys(value).some((key) => !fields.includes(key))) fail(422, "开放时段命令无效。");
  const base = commandBase(value);
  if (value.action === "create") return { ...base, action: "create", ...commandInterval(value) };
  const target = commandTarget(value);
  if (value.action === "delete") return { ...base, action: "delete", ...target };
  return { ...base, action: "update", ...target, ...commandInterval(value) };
}
function datedWindow(command: CommandBase & IntervalInput, teacherId: string): TeacherAvailabilityWindow {
  const start = new Date(command.startsAt);
  return { id: `self:${command.commandKey}`, teacherId, day: start.getUTCDay(), start: command.startsAt.slice(11, 16), end: command.endsAt.slice(11, 16), timezone: "UTC", validFrom: command.startsAt.slice(0, 10), validTo: command.startsAt.slice(0, 10), excludedDates: [], overrides: [], source: "manual" };
}
type SelfState = ReturnType<typeof selfState>;
function outward(state: SelfState) { return { teacherId: state.teacher.id, version: state.row.version, windows: state.windows }; }
function commandReceipts(teacher: RecordValue) {
  const receipts = teacher.availabilityCalendarCommands ?? [];
  if (!Array.isArray(receipts) || receipts.length > 64 || !receipts.every(record)) fail(503, "保存记录暂不可用。");
  return receipts as RecordValue[];
}
function replayed(receipts: RecordValue[], command: Command, digest: string) {
  const prior = receipts.find((receipt) => receipt.key === command.commandKey);
  if (!prior) return false;
  if (prior.digest !== digest) fail(409, "同一命令不能用于不同的开放时段。");
  return true;
}
function removeOccurrence(windows: TeacherAvailabilityWindow[], command: Extract<Command, { action: "update" | "delete" }>) {
  const target = windows.find((item) => item.id === command.windowId);
  if (!target) fail(403, "只能修改本人的开放时段。");
  if (!expandTeacherAvailability([target], { from: command.date, to: command.date, displayTimezone: "UTC" }).length) fail(409, "开放时段已变化，请刷新。");
  if (target.validFrom === target.validTo) return windows.filter((item) => item.id !== target.id);
  return deleteAvailabilityDate(windows, { windowId: target.id, date: command.date });
}
function changedWindows(state: SelfState, command: Command) {
  let windows = command.action === "create" ? state.windows : removeOccurrence(state.windows, command);
  if (command.action !== "delete") windows = [...windows, datedWindow(command, state.teacher.id as string)];
  if (windows.length > 64) fail(422, "开放时段数量已达上限。");
  assertValidTeacherAvailability(windows);
  return windows;
}
async function readCommand(request: Request) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) fail(403, "请求来源无效。");
  const body = await request.text();
  if (body.length > 8192) fail(422, "开放时段命令过大。");
  return parseCommand(JSON.parse(body));
}
async function saveCommand(dependencies: Dependencies, session: DemoSessionIdentity, state: SelfState, command: Command) {
  const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
  const receipts = commandReceipts(state.teacher);
  if (replayed(receipts, command, digest)) return json({ ...outward(state), replayed: true });
  if (command.expectedVersion !== state.row.version) fail(409, "老师资料已变化，请刷新后重试。");
  const windows = changedWindows(state, command);
  const current = await sessionIdentity(dependencies);
  if (JSON.stringify(current) !== JSON.stringify(session)) fail(409, "账号权限已变化，请刷新。");
  const receipt = { key: command.commandKey, digest, ...(command.action === "delete" ? {} : { timezone: command.timezone }) };
  const replacement = { ...state.teacher, availabilityWindows: windows, availabilityCalendarCommands: [...receipts.slice(-63), receipt] };
  const payload = state.teachers.map((teacher) => teacher === state.teacher ? replacement : teacher);
  const saved = await dependencies.save({ payload, expectedVersion: command.expectedVersion, actor: session.user, scopeVersions: state.scopeVersions });
  if (saved.length !== 1 || saved[0]!.entity !== "teachers" || saved[0]!.version !== command.expectedVersion + 1) fail(503, "保存结果无效，请重试。");
  return json(outward(selfState(await dependencies.readRows(), session.user)));
}
function failureResponse(error: unknown) {
  if (error instanceof SelfAvailabilityError) return json({ error: error.message }, error.status);
  if (record(error) && (error.code === "40001" || error.message === "version_conflict")) return json({ error: "老师资料已变化，请刷新后重试。" }, 409);
  if (error instanceof Error && (error.name === "TeacherAvailabilityValidationError" || error instanceof SyntaxError)) return json({ error: "开放时段无效或重叠。" }, 422);
  return json({ error: "开放时段暂时无法保存，请重试。" }, 503);
}
export function createTeacherSelfAvailabilityHandler(dependencies: Dependencies) {
  return async (request: Request) => {
    try {
      const session = await sessionIdentity(dependencies);
      const state = selfState(await dependencies.readRows(), session.user);
      if (request.method === "GET") return json(outward(state));
      if (request.method !== "POST") return json({ error: "不支持的操作。" }, 405);
      return await saveCommand(dependencies, session, state, await readCommand(request));
    } catch (error) { return failureResponse(error); }
  };
}
