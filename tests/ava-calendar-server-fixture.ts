import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as service from "../lib/ava-calendar-service";
import * as sessionTokens from "../lib/demo-session-token";
import * as teacherLogin from "../lib/demo-teacher-login";

import { readAvaCalendarSnapshot } from "../lib/ava-calendar-snapshot";
import { TRIAL_OPERATIONS } from "../lib/lp-workflows";
import type { DemoSessionIdentity } from "../lib/demo-session-token";
import type { JiaowubaoOpenApiScheduleSnapshotWindow, OpsStateRow } from "../lib/ops-store";

export const revision = `sha256:${"a".repeat(64)}`;
export const publishedAt = "2026-10-12T00:00:00.123456+00:00";
export const sourceWindow = { start: "2026-10-01", end: "2026-11-30" };
const row = (entity: string, payload: unknown): OpsStateRow => ({ entity, payload, version: 1, updated_at: "2026-10-12T00:00:00Z", updated_by: "private synthetic actor" });
export const student = { id: "S1", name: "Synthetic Student", jwbSourceRow: "101", owner: "Tiffany", teacher: "Synthetic Teacher" };
export const teacher = { id: "T1", name: "Synthetic Teacher", timezone: "UTC", jiaowubaoOpenApi: { sourceId: "901", snapshotRevision: revision, resolution: "stable_source_id", confidence: "exact" }, availabilityWindows: [{ id: "AVA1", teacherId: "T1", day: 1, start: "01:00", end: "06:00", timezone: "UTC", validFrom: "2026-10-01", validTo: "2026-11-30", excludedDates: [], overrides: [], source: "manual" }] };
export const event: JiaowubaoOpenApiScheduleSnapshotWindow["events"][number] = { eventId: "event-1", sourceDate: "2026-10-12", startsAt: "2026-10-12T02:00:00.123001+00:00", endsAt: "2026-10-12T03:00:00.123002+00:00", sourceTeacherId: "901", sourceTeacherLabel: "Synthetic Teacher", courseName: "private synthetic course", sourceParticipants: [{ memberId: "101", label: student.name }], sourceStudentsTruncated: false };
export const page: JiaowubaoOpenApiScheduleSnapshotWindow = { state: "complete", freshness: "fresh", revision, publishedAt, sourceWindow, invalidTimeEventCount: 0, hasMore: false, nextCursor: null, empty: false, events: [event] };
export const window = { start: "2026-10-12T01:00:00.000Z", end: "2026-10-12T06:00:00.000Z" };
const token = "d4".repeat(32);
const digest = createHash("sha256").update(token).digest("hex");
const projectionRunId = "8d3184a3-c2f6-4092-9be2-0c6afba2682a";
export function fixture() {
  const stats = { total: 0, matched: 0, unmatched: 0, conflict: 0, sourceOnly: 0, matchRate: 0 };
  const checkedAt = "2026-10-12T00:00:00.000Z";
  const nativeStateVersions = { students: 1, teachers: 1, courses: 1, bookings: 1 };
  return {
    rows: [row("students", [student]), row("teachers", [teacher]), row("bookings", []), row("lpItems", [])],
    versions: Object.entries({ ...nativeStateVersions, lpItems: 1 }).map(([entity, version]) => ({ entity, version, updated_at: checkedAt, updated_by: "synthetic" })),
    accounts: TRIAL_OPERATIONS.map((name) => ({ account_id: `staff-${name.toLowerCase()}`, account_name: name, account_role: "staff" as const, status: "active" as const })),
    page: structuredClone(page),
    target: { state: "ready", revision, rowCount: 1, projectionState: "complete", window: sourceWindow, publishedAt },
    sources: [{ source_id: "jiaowubao-open-api-schedule", status: "synced", synced_at: checkedAt, row_count: 1, payload: {
      schemaVersion: 1, authorityMode: "one_of_multiple", tool: "query_schedule_list", cadenceMinutes: 30,
      snapshotRevision: revision, projectionRunId, snapshotPublishedAt: publishedAt, snapshotChangedAt: checkedAt, checkedAt, projectedAt: checkedAt, sourceWindow,
      matches: { schedule: stats, student: stats, teacher: stats, course: stats, class: stats, room: stats },
      anomalies: { duplicateScheduleIds: 0, missingScheduleIds: 0, invalidTimeRecords: 0, missingStudentIds: 0, missingTeacherIds: 0, missingCourseIds: 0, identityConflicts: 0, identityVariantConflicts: 0 },
      prices: { present: false, schedulePriceRecords: 0, studentPriceRecords: 0, persistedPrivately: true, browserExposed: false }, fields: { topLevelFields: [], studentFields: [] },
      coverage: { snapshotRows: 1, normalizedEntityRows: 0, matchedEntityRows: 0, sourceOnlyEntityRows: 0, sourceSnapshotPersisted: true, normalizedProjectionPersisted: true, nativeRecordsSynchronized: true, connectedTools: ["query_schedule_list"] },
      nativeApply: { schemaVersion: 1, snapshotRevision: revision, projectionRunId, nativeStateVersions }, privateSyntheticPayload: "never expose this value",
    } }],
    session: { user: "Synthetic Administrator", role: "admin", permissions: ["*"] } as DemoSessionIdentity,
    fullAdmin: true,
    now: Date.parse(checkedAt),
  };
}
export type ServerFixture = ReturnType<typeof fixture>;
function rpcRequest(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], origin: string) {
  const url = new URL(String(input));
  assert.equal(url.origin, origin);
  assert.equal(init?.method, "POST");
  assert.equal(init?.cache, "no-store");
  return { rpc: url.pathname.split("/").at(-1)!, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
}
function snapshotResponse(state: ServerFixture, body: Record<string, unknown>) {
  const selected = state.page.events.filter((item) => Date.parse(item.startsAt) < Date.parse(String(body.p_window_end)) && Date.parse(item.endsAt) > Date.parse(String(body.p_window_start)));
  const cursor = body.p_cursor_event_id;
  const start = cursor === null ? 0 : selected.findIndex((item) => item.eventId === cursor) + 1;
  const events = selected.slice(start, start + 250);
  const hasMore = start + 250 < selected.length;
  const last = events.at(-1);
  return Response.json({ ...state.page, events, hasMore, empty: events.length === 0 && !hasMore, nextCursor: hasMore && last ? { startsAt: last.startsAt, eventId: last.eventId } : null });
}
const requireNode = createRequire(import.meta.url);
function load(relative: string, imports: Record<string, unknown>, environment: Record<string, string>, fixtureFetch: typeof fetch, now: () => number, warnings: string[] = []) {
  const exports: Record<string, unknown> = {};
  const compiled = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const require = (id: string) => {
    if (id === "server-only") return {};
    if (Object.hasOwn(imports, id)) return imports[id];
    assert.ok(id.startsWith("node:"), `unbound offline server import: ${id}`);
    return requireNode(id);
  };
  class FixtureDate extends Date { static now() { return now(); } }
  runInNewContext(compiled, { exports, require, Buffer, process: { env: environment }, Date: FixtureDate, fetch: fixtureFetch, Response, Request, URL, AbortController, setTimeout, clearTimeout, console: { warn: (value: string) => warnings.push(value) } });
  return exports;
}
export function serverFixture(state = fixture(), hook: (rpc: string, body: Record<string, unknown>, environment: Record<string, string>, init?: RequestInit) => void | Response | Promise<void | Response> = () => {}, useServerSession = false) {
  const warnings: string[] = [];
  const sessionToken = sessionTokens.createServerSessionToken();
  assert.ok(sessionToken);
  const { sessionId } = sessionToken;
  const environment: Record<string, string> = { AVA_CALENDAR_SERVICE_TOKEN_SHA256: digest, NEXT_PUBLIC_SUPABASE_URL: "https://offline.synthetic.test", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable", OPS_API_SECRET: "synthetic-rpc" };
  const credentials = load("../lib/account-credentials.ts", {}, environment, async () => assert.fail("unexpected fetch"), () => state.now) as typeof import("../lib/account-credentials");
  const calls: { rpc: string; body: Record<string, unknown>; signal?: AbortSignal | null }[] = [];
  const sessionResponse = () => Response.json([{ session_id: sessionId, account_id: "synthetic-account", account_name: state.session.user,
    account_role: state.session.role, access_version: 1, role_version: 1, scope_version: 1, credential_version: 2,
    mfa_verified: true, permissions: state.session.permissions ?? [], scope_members: state.session.scopeMembers ?? [], must_change_password: false }]);
  const defaultResponse = (rpc: string, body: Record<string, unknown>) => {
    switch (rpc) {
      case "read_account_session": return sessionResponse();
      case "get_ops_state": return Response.json(state.rows);
      case "get_ops_versions": return Response.json(state.versions);
      case "read_account_by_identity": return Response.json(state.accounts.filter((account) => credentials.accountIdentityKey(account.account_name, "staff") === body.p_identity_key));
      case "get_ops_sources": return Response.json(state.sources);
      case "get_jiaowubao_open_api_schedule_projection_target": return Response.json(state.target);
      case "get_jiaowubao_open_api_schedule_snapshot_window": return snapshotResponse(state, body);
      default: return assert.fail(`non-read RPC: ${rpc}`);
    }
  };
  const fixtureFetch: typeof fetch = async (input, init) => {
    const { rpc, body } = rpcRequest(input, init, environment.NEXT_PUBLIC_SUPABASE_URL!);
    calls.push({ rpc, body, signal: init?.signal });
    return await hook(rpc, body, environment, init) || defaultResponse(rpc, body);
  };
  const rpcBudget = load("../lib/ops-rpc-budget.ts", {}, environment, fixtureFetch, () => state.now);
  const store = load("../lib/ops-store.ts", { "@/lib/ops-rpc-budget": rpcBudget }, environment, fixtureFetch, () => state.now);
  const diagnostics = load("../lib/ava-calendar-read-diagnostics.ts", {}, environment, fixtureFetch, () => state.now, warnings);
  const auth = useServerSession ? load("../lib/demo-auth.ts", {
    "@/lib/nixon-auth": {}, "@/lib/demo-users": {}, "@/lib/demo-session-token": sessionTokens,
    "@/lib/demo-teacher-login": teacherLogin, "@/lib/account-credentials": credentials, "@/lib/ops-store": store,
  }, environment, fixtureFetch, () => state.now) as typeof import("../lib/demo-auth") : null;
  let sessionReads = 0;
  const imports = {
    "@/lib/account-credentials": credentials, "@/lib/ops-store": store, "@/lib/lp-workflows": { TRIAL_OPERATIONS },
    "@/lib/ava-calendar-service": service, "@/lib/ava-calendar-snapshot": { readAvaCalendarSnapshot },
    "@/lib/ava-calendar-read-diagnostics": diagnostics,
    "next/headers": { cookies: async () => ({ get: () => ({ value: useServerSession ? sessionToken.token : "synthetic-cookie" }) }) },
    "@/lib/demo-auth": { DEMO_COOKIE_NAME: "demo", getCurrentDemoSession: async (...args: Parameters<typeof import("../lib/demo-auth").getCurrentDemoSession>) => { sessionReads++; return auth ? auth.getCurrentDemoSession(...args) : { session: state.session }; } },
    "@/lib/nixon-auth": { NIXON_COOKIE_NAME: "full", hasFullAdminAccess: () => state.fullAdmin },
  };
  const human = load("../app/api/ava-calendar/route.ts", imports, environment, fixtureFetch, () => state.now, warnings) as typeof import("../app/api/ava-calendar/route");
  const machine = load("../app/api/ava-calendar/service/route.ts", imports, environment, fixtureFetch, () => state.now, warnings) as typeof import("../app/api/ava-calendar/service/route");
  const get = (kind: "human" | "machine", range = window, init: RequestInit = {}) => (kind === "human" ? human : machine).GET(new Request(`https://example.test/api/ava-calendar${kind === "machine" ? "/service" : ""}?${new URLSearchParams(range)}`, { ...init, headers: { ...(kind === "machine" ? { Authorization: `Bearer ${token}` } : { Cookie: "synthetic-cookie" }), ...Object.fromEntries(new Headers(init.headers)) } }));
  const getRange = (range: { start: string; end: string }, init: RequestInit = {}) => human.GET(new Request(`https://example.test/api/ava-calendar/range?${new URLSearchParams(range)}`, { ...init, headers: { Cookie: "synthetic-cookie", ...Object.fromEntries(new Headers(init.headers)) } }));
  return { get, getRange, calls, environment, warnings, sessionReads: () => sessionReads };
}
