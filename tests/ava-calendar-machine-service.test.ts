import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as rpcBudget from "../lib/ops-rpc-budget";
import { TRIAL_OPERATIONS } from "../lib/lp-workflows";
import * as service from "../lib/ava-calendar-service";
import { authorizeAvaCalendarMachineRequest } from "../lib/ava-calendar-machine-auth";
import { buildOpsAccessContext } from "../lib/ops-access";
import { projectAvaCalendarEvents, type AvaCoordinatorAccount } from "../lib/ava-calendar-projection";
import { readAvaCalendarSnapshot } from "../lib/ava-calendar-snapshot";
import type { OpsStateRow, JiaowubaoOpenApiScheduleSnapshotWindow } from "../lib/ops-store";

// Synthetic fixtures only; these values are never configured or published.
const token = "a1".repeat(32);
const digest = createHash("sha256").update(token).digest("hex");
const row = (entity: string, payload: unknown): OpsStateRow => ({ entity, payload, version: 1, updated_at: "2026-10-11T00:00:00Z", updated_by: "synthetic-fixture" });
const rows = [
  row("students", [{ id: "S1", name: "Synthetic One", jwbSourceRow: "101", owner: "Tiffany", planner: "Tara" }, { id: "S2", name: "Synthetic Two", jwbSourceRow: "102", owner: "Ella", planner: "Abby" }]),
  row("teachers", [{ id: "T1", name: "Synthetic Teacher" }]), row("bookings", []), row("lpItems", []),
];
const accounts = ["Tiffany", "Ella"].map((name) => ({ account_id: `staff-${name.toLowerCase()}`, account_name: name, account_role: "staff" as const, status: "active" as const }));
const event: JiaowubaoOpenApiScheduleSnapshotWindow["events"][number] = { eventId: "event-1", sourceDate: "2026-10-11", startsAt: "2026-10-11T04:00:00Z", endsAt: "2026-10-11T05:00:00Z", courseName: "Private source title", sourceTeacherId: "900", sourceTeacherLabel: "Synthetic Teacher", sourceStudentsTruncated: false, sourceParticipants: [{ memberId: "101", label: "Synthetic One" }, { memberId: "102", label: "Synthetic Two" }] };
const page: JiaowubaoOpenApiScheduleSnapshotWindow = { state: "complete", freshness: "fresh", revision: `sha256:${"b".repeat(64)}`, publishedAt: "2026-10-11T00:00:00Z", sourceWindow: { start: "2026-10-10", end: "2027-01-10" }, invalidTimeEventCount: 0, hasMore: false, nextCursor: null, empty: false, events: [event] };
const dependencies = {
  readTokenSha256: () => digest,
  readRows: async () => rows,
  readVersions: async () => rows.map(({ entity, version, updated_at, updated_by }) => ({ entity, version, updated_at, updated_by })),
  readAccounts: async () => accounts,
  readSnapshot: (window: { start: string; end: string }) => readAvaCalendarSnapshot(window, async () => page),
};
const machineRequest = (authorization = `Bearer ${token}`) => new Request("https://example.test/api/ava-calendar/service?start=2026-10-11T00:00:00.000Z&end=2026-10-18T00:00:00.000Z", { headers: { Authorization: authorization, Cookie: "demo_session=synthetic-cookie-only" } });

const request = () => new Request("https://example.test/api/ava-calendar/service?start=2026-10-11T00:00:00.000Z&end=2026-10-18T00:00:00.000Z", { headers: { Cookie: "demo_session=synthetic-cookie-only" } });

test("a machine calendar endpoint rejects cookie-only callers before every data read", async () => {
  assert.equal(typeof service.createAvaCalendarMachineHandler, "function", "a dedicated machine-only calendar handler is required");
  const unexpectedRead = async () => assert.fail("unauthorized business-data read");
  const response = await service.createAvaCalendarMachineHandler({
    readTokenSha256: () => "a".repeat(64),
    readRows: unexpectedRead,
    readVersions: unexpectedRead,
    readAccounts: unexpectedRead,
    readSnapshot: unexpectedRead,
  })(request());
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("Vary"), "Authorization");
  assert.deepEqual(await response.json(), { error: "请提供有效的课表服务凭据。" });
});

test("disabled, missing, malformed, or unreadable digest configuration fails closed before reading data", async () => {
  const unexpectedRead = async () => assert.fail("unconfigured business-data read");
  for (const digest of [undefined, "", "disabled", "a".repeat(63), "A".repeat(64), "g".repeat(64), ` ${"a".repeat(64)}`, `${"a".repeat(64)}\n`, `sha256:${"a".repeat(64)}`]) {
    const response = await service.createAvaCalendarMachineHandler({ readTokenSha256: () => digest, readRows: unexpectedRead, readVersions: unexpectedRead, readAccounts: unexpectedRead, readSnapshot: unexpectedRead })(request());
    assert.equal(response.status, 503, `must fail closed for configuration ${JSON.stringify(digest)}`);
    assert.equal(response.headers.get("Vary"), "Authorization");
    assert.deepEqual(await response.json(), { error: "课表服务暂不可用。" });
  }
  const response = await service.createAvaCalendarMachineHandler({ readTokenSha256: () => { throw new Error("private-config-diagnostic"); }, readRows: unexpectedRead, readVersions: unexpectedRead, readAccounts: unexpectedRead, readSnapshot: unexpectedRead })(request());
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private-config-diagnostic|events|students/);
});

test("a valid dedicated credential returns the company calendar DTO across owners without a human session", async () => {
  const response = await service.createAvaCalendarMachineHandler(dependencies)(machineRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("Vary"), "Authorization");
  assert.deepEqual(await response.json(), {
    events: [{ eventId: "event-1", startsAt: "2026-10-11T04:00:00.000Z", endsAt: "2026-10-11T05:00:00.000Z", teacherId: "T1", teacherName: "Synthetic Teacher", students: [
      { studentId: "S1", studentName: "Synthetic One", owner: "Tiffany", ownerId: "staff-tiffany", color: "owner-1" },
      { studentId: "S2", studentName: "Synthetic Two", owner: "Ella", ownerId: "staff-ella", color: "owner-2" },
    ], trial: false, identityPending: false }],
    teachers: [{ id: "T1", name: "Synthetic Teacher" }],
    source: { revision: page.revision, publishedAt: "2026-10-11T00:00:00.000Z", freshness: "fresh", coverage: "complete" },
  });
});

test("rotation while the roster is pending prevents snapshot and coordinator reads", async () => {
  for (const replacement of [createHash("sha256").update("b2".repeat(32)).digest("hex"), undefined]) {
    let current: string | undefined = digest;
    const reads: string[] = [];
    const response = await service.createAvaCalendarMachineHandler({ ...dependencies, readTokenSha256: () => current,
      readRows: async () => { reads.push("rows"); current = replacement; return rows; },
      readSnapshot: async () => { reads.push("snapshot"); return dependencies.readSnapshot({ start: "2026-10-11T00:00:00Z", end: "2026-10-18T00:00:00Z" }); },
      readAccounts: async () => { reads.push("accounts"); return accounts; },
      readVersions: async () => { reads.push("versions"); return dependencies.readVersions(); },
    })(machineRequest());
    assert.equal(response.status, replacement ? 401 : 503);
    assert.deepEqual(reads, ["rows"], "rotation must be noticed before the next read batch");
    assert.doesNotMatch(await response.text(), /Synthetic|events|students|tokenSha256/);
  }
});

test("revocation during snapshot pagination prevents the final metadata read batch", async () => {
  let current: string | undefined = digest;
  let accountCalls = 0;
  let versionCalls = 0;
  const response = await service.createAvaCalendarMachineHandler({ ...dependencies, readTokenSha256: () => current,
    readSnapshot: async (window) => { const snapshot = await dependencies.readSnapshot(window); current = undefined; return snapshot; },
    readAccounts: async () => { accountCalls++; return accounts; },
    readVersions: async () => { versionCalls++; return dependencies.readVersions(); },
  })(machineRequest());
  assert.equal(response.status, 503);
  assert.equal(accountCalls, 1, "must not start the fresh coordinator read after revocation");
  assert.equal(versionCalls, 0, "must not start a versions read after revocation");
  assert.doesNotMatch(await response.text(), /Synthetic|events|students/);
});

test("a digest rotated after the concurrent authority check is revalidated before serialization", async () => {
  for (const replacement of [createHash("sha256").update("b2".repeat(32)).digest("hex"), undefined, "malformed"]) {
    let current: string | undefined = digest;
    let calls = 0;
    const response = await service.createAvaCalendarMachineHandler({ ...dependencies, readTokenSha256: () => current,
      readAccounts: async () => { calls++; if (calls === 2) { await Promise.resolve(); current = replacement; } return accounts; },
    })(machineRequest());
    assert.equal(response.status, replacement?.length === 64 ? 401 : 503, "late rotation must not release a DTO");
    assert.doesNotMatch(await response.text(), /Synthetic|events|students|tokenSha256/);
  }
});

const requireNode = createRequire(import.meta.url);
// Only Next's server-only import marker and external HTTP are substituted.
function loadOfflineServerModule(relative: string, imports: Record<string, unknown>, environment: Record<string, string> = {}, fixtureFetch?: typeof fetch) {
  const exports: Record<string, unknown> = {};
  const compiled = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const require = (id: string) => {
    if (id === "server-only") return {};
    if (id === "@/lib/ava-calendar-read-diagnostics") return loadOfflineServerModule("../lib/ava-calendar-read-diagnostics.ts", {});
    if (Object.hasOwn(imports, id)) return imports[id];
    assert.ok(id.startsWith("node:"), `unbound offline server import: ${id}`);
    return requireNode(id);
  };
  runInNewContext(compiled, { exports, require, Buffer, process: { env: environment }, fetch: fixtureFetch, Response, Request, URL, AbortController, setTimeout, clearTimeout });
  return exports;
}

test("the actual GET route binds only existing getters and traverses PostgreSQL microsecond pages", async () => {
  assert.ok(existsSync(new URL("../app/api/ava-calendar/service/route.ts", import.meta.url)), "a real GET route is required");
  const environment: Record<string, string> = { AVA_CALENDAR_SERVICE_TOKEN_SHA256: digest, NEXT_PUBLIC_SUPABASE_URL: "https://offline.synthetic.test", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable-fixture", OPS_API_SECRET: "synthetic-rpc-fixture" };
  const credentials = loadOfflineServerModule("../lib/account-credentials.ts", {}) as typeof import("../lib/account-credentials");
  const calls: { rpc: string; body: Record<string, unknown> }[] = [];
  const firstEvents = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}`, startsAt: "2026-10-11T04:00:00.123456+00:00", endsAt: "2026-10-11T05:00:00.123456+00:00" }));
  const cursor = { startsAt: "2026-10-11T04:00:00.123456Z", eventId: firstEvents.at(-1)!.eventId };
  const fixtureFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, environment.NEXT_PUBLIC_SUPABASE_URL, "all HTTP calls must remain inside the offline fetch fixture");
    assert.equal(init?.method, "POST");
    assert.equal(init?.cache, "no-store");
    const rpc = url.pathname.split("/").at(-1)!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ rpc, body });
    if (rpc === "get_ops_state") return Response.json(rows);
    if (rpc === "get_ops_versions") return Response.json(await dependencies.readVersions());
    if (rpc === "read_account_by_identity") return Response.json(accounts.filter((account) => credentials.accountIdentityKey(account.account_name, "staff") === body.p_identity_key));
    if (rpc === "get_jiaowubao_open_api_schedule_snapshot_window") return Response.json(body.p_cursor_start === null ? { ...page, events: firstEvents, hasMore: true, nextCursor: cursor } : { ...page, events: [{ ...event, eventId: "event-999", startsAt: "2026-10-11T04:00:00.124456+00:00" }] });
    return assert.fail(`a non-read getter was called: ${rpc}`);
  };
  const store = loadOfflineServerModule("../lib/ops-store.ts", { "@/lib/ops-rpc-budget": rpcBudget }, environment, fixtureFetch);
  const route = loadOfflineServerModule("../app/api/ava-calendar/service/route.ts", {
    "@/lib/account-credentials": credentials, "@/lib/ops-store": store, "@/lib/lp-workflows": { TRIAL_OPERATIONS },
    "@/lib/ava-calendar-service": service, "@/lib/ava-calendar-snapshot": { readAvaCalendarSnapshot },
  }, environment) as typeof import("../app/api/ava-calendar/service/route");
  assert.deepEqual(Object.keys(route).sort(), ["GET", "dynamic", "maxDuration", "runtime"]);
  assert.equal(route.dynamic, "force-dynamic");
  assert.equal(route.runtime, "nodejs");
  const denied = await route.GET(request());
  assert.equal(denied.status, 401);
  assert.deepEqual([...calls], [], "the real route must authorize before any getter");
  const response = await route.GET(machineRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Vary"), "Authorization");
  const data = await response.json();
  assert.equal(data.events.length, 251);
  assert.equal(data.events[0].startsAt, "2026-10-11T04:00:00.123Z");
  assert.equal(data.events.at(-1).startsAt, "2026-10-11T04:00:00.124Z");
  assert.deepEqual(calls.filter((call) => call.rpc === "get_ops_state").map((call) => call.body.p_entities), [["students", "teachers", "bookings", "lpItems"]]);
  assert.equal(calls.filter((call) => call.rpc === "get_ops_versions").length, 1);
  assert.equal(calls.filter((call) => call.rpc === "read_account_by_identity").length, TRIAL_OPERATIONS.length * 2);
  const pages = calls.filter((call) => call.rpc === "get_jiaowubao_open_api_schedule_snapshot_window").map((call) => call.body);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((body) => [body.p_cursor_start, body.p_cursor_event_id, body.p_snapshot_revision, body.p_limit]), [[null, null, null, 250], [cursor.startsAt, cursor.eventId, page.revision, 250]]);
  assert.ok(pages.every((body) => body.p_scope === "all" && body.p_scope_teacher_labels === null && body.p_scope_student_member_ids === null && body.p_scope_student_name_keys === null));
  assert.doesNotMatch(JSON.stringify(data), /sourceParticipants|sourceTeacherId|jwbSourceRow|updated_by|Private source title|synthetic-rpc-fixture|tokenSha256/);
});

test("the machine authority is frozen, calendar-only, and contains no human session", () => {
  const authority = authorizeAvaCalendarMachineRequest(machineRequest(), () => digest);
  assert.deepEqual(authority, { kind: "machine", subject: "ava-calendar-service", permission: "calendar:read", scope: "company", tokenSha256: digest });
  assert.ok(Object.isFrozen(authority));
  assert.doesNotMatch(JSON.stringify(authority), /fullAdmin|limitedAdmin|operations\.read|session|user|Nixon/);
});

test("successful and mismatched well-formed tokens both use a fixed-width constant-time digest comparison", () => {
  const crypto = requireNode("node:crypto") as typeof import("node:crypto");
  const lengths: number[][] = [];
  const auth = loadOfflineServerModule("../lib/ava-calendar-machine-auth.ts", { "node:crypto": { ...crypto,
    timingSafeEqual: (left: Buffer, right: Buffer) => { lengths.push([left.length, right.length]); return crypto.timingSafeEqual(left, right); },
  } }) as typeof import("../lib/ava-calendar-machine-auth");
  assert.equal("error" in auth.authorizeAvaCalendarMachineRequest(machineRequest(), () => digest), false);
  assert.deepEqual({ ...auth.authorizeAvaCalendarMachineRequest(machineRequest(`Bearer ${"b2".repeat(32)}`), () => digest) }, { error: "请提供有效的课表服务凭据。", status: 401 });
  assert.deepEqual(lengths, [[32, 32], [32, 32]]);
});

test("malformed Bearer, duplicate authorization, and query-only credentials never read business data", async () => {
  const unexpectedRead = async () => assert.fail("malformed credential business-data read");
  const handler = service.createAvaCalendarMachineHandler({ ...dependencies, readRows: unexpectedRead, readSnapshot: unexpectedRead, readVersions: unexpectedRead, readAccounts: unexpectedRead });
  const invalid = ["", `Basic ${token}`, `bearer ${token}`, `Bearer ${token.toUpperCase()}`, `Bearer ${token.slice(1)}`, `Bearer ${token}0`, `Bearer ${"g".repeat(64)}`, `Bearer  ${token}`, `Bearer ${token} suffix`, `Bearer ${token}, Bearer ${token}`, `Bearer ${digest}`, `Bearer ${"b2".repeat(32)}`];
  for (const header of invalid) {
    const response = await handler(machineRequest(header));
    assert.equal(response.status, 401, `invalid Authorization: ${header}`);
    assert.equal(response.headers.get("Vary"), "Authorization");
    assert.doesNotMatch(await response.text(), /events|students|Synthetic|tokenSha256/);
  }
  const response = await handler(new Request(`${request().url}&token=${token}`, { headers: { Cookie: "demo_session=synthetic-cookie-only" } }));
  assert.equal(response.status, 401);
});

test("machine windows accept only one start/end pair and at most ten UTC days before data reads", async () => {
  const invalid = ["", "start=invalid&end=invalid", "start=2026-10-11&end=2026-10-18", "start=2026-02-30T00:00:00Z&end=2026-03-02T00:00:00Z", "start=2026-10-18T00:00:00Z&end=2026-10-11T00:00:00Z", "start=2026-10-11T00:00:00Z&end=2026-10-11T00:00:00Z", "start=2026-10-11T00:00:00Z&end=2026-10-21T00:00:00.001Z", "start=2026-10-11T00:00:00%2B00:00&end=2026-10-18T00:00:00Z", "start=2026-10-11T00:00:00.123456Z&end=2026-10-18T00:00:00Z", "start=2026-10-11T00:00:00Z&start=2026-10-12T00:00:00Z&end=2026-10-18T00:00:00Z", "start=2026-10-11T00:00:00Z&end=2026-10-18T00:00:00Z&end=2026-10-19T00:00:00Z", `start=2026-10-11T00:00:00Z&end=2026-10-18T00:00:00Z&token=${token}`, "start=2026-10-11T00:00:00Z&end=2026-10-18T00:00:00Z&scope=all", "start=2026-10-11T00:00:00Z&end=2026-10-18T00:00:00Z&teacher=private"];
  for (const query of invalid) {
    const response = await service.createAvaCalendarMachineHandler({ ...dependencies, readRows: async () => assert.fail("invalid window business-data read") })(new Request(`https://example.test/api/ava-calendar/service?${query}`, { headers: { Authorization: `Bearer ${token}` } }));
    assert.equal(response.status, 400, query);
    assert.doesNotMatch(await response.text(), /events|students|Synthetic/);
  }
  const response = await service.createAvaCalendarMachineHandler(dependencies)(new Request("https://example.test/api/ava-calendar/service?start=2026-10-11T00:00:00Z&end=2026-10-21T00:00:00Z", { headers: { Authorization: `Bearer ${token}` } }));
  assert.equal(response.status, 200);
});

test("every company identity and schedule version change prevents publication", async () => {
  for (const entity of ["students", "teachers", "bookings", "lpItems"]) {
    const response = await service.createAvaCalendarMachineHandler({ ...dependencies, readVersions: async () => rows.map((item) => ({ ...item, version: item.entity === entity ? 2 : 1 })) })(machineRequest());
    assert.equal(response.status, 409, entity);
    assert.doesNotMatch(await response.text(), /Synthetic|events|students|staff-tiffany/);
  }
});

test("all coordinator identity, role, and lifecycle fields are pinned across a read", async () => {
  const updates = [{ account_id: "changed" }, { account_name: "changed" }, { account_role: "teacher" as const }, { status: "disabled" as const }];
  for (const update of updates) {
    let calls = 0;
    const response = await service.createAvaCalendarMachineHandler({ ...dependencies, readAccounts: async () => ++calls === 1 ? accounts : [{ ...accounts[0]!, ...update }, accounts[1]!] })(machineRequest());
    assert.equal(response.status, 409);
    assert.doesNotMatch(await response.text(), /Synthetic|events|students|staff-tiffany/);
  }
  let calls = 0;
  const response = await service.createAvaCalendarMachineHandler({ ...dependencies, readAccounts: async () => ++calls === 1 ? accounts : [...accounts].reverse() })(machineRequest());
  assert.equal(response.status, 200, "coordinator order is not an identity change");
});

test("missing, duplicate, malformed, or invalid-version authority rows cannot reach the source snapshot", async () => {
  const invalidStates = [rows.slice(1), [...rows, rows[0]!], rows.map((item) => ({ ...item, payload: null })), rows.map((item) => ({ ...item, version: -1 })), rows.map((item) => ({ ...item, version: 1.5 })), rows.map((item) => ({ ...item, version: NaN }))];
  for (const state of invalidStates) {
    let snapshotCalls = 0;
    const response = await service.createAvaCalendarMachineHandler({ ...dependencies, readRows: async () => state, readSnapshot: async (window) => { snapshotCalls++; return dependencies.readSnapshot(window); } })(machineRequest());
    assert.equal(response.status, 503);
    assert.equal(snapshotCalls, 0);
    assert.doesNotMatch(await response.text(), /Synthetic|events|students/);
  }
});

function fixtureDependencies(state = rows, source = page, directory: readonly AvaCoordinatorAccount[] = accounts) {
  return { ...dependencies, readRows: async () => state, readVersions: async () => state.map(({ entity, version, updated_at, updated_by }) => ({ entity, version, updated_at, updated_by })), readAccounts: async () => directory,
    readSnapshot: (window: { start: string; end: string }) => readAvaCalendarSnapshot(window, async () => source) };
}

test("source receipts and all event-time gates remain fail-closed on the machine endpoint", async () => {
  const invalidSources = [{ ...page, state: "absent" }, { ...page, state: "building" }, { ...page, revision: "invalid" }, { ...page, publishedAt: "invalid" }, { ...page, invalidTimeEventCount: 1 }, { ...page, freshness: "stale" }, { ...page, nextCursor: { startsAt: event.startsAt, eventId: event.eventId } }, { ...page, events: [{ ...event, startsAt: "invalid" }] }, { ...page, events: [{ ...event, endsAt: event.startsAt }] }, { ...page, events: [{ ...event, startsAt: "2026-10-21T00:00:00Z", endsAt: "2026-10-21T01:00:00Z" }] }, { ...page, events: [{ ...event, sourceParticipants: [{ memberId: " 101 ", label: "Synthetic One" }] }] }];
  for (const source of invalidSources) {
    const response = await service.createAvaCalendarMachineHandler(fixtureDependencies(rows, source as JiaowubaoOpenApiScheduleSnapshotWindow))(machineRequest());
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /Synthetic|events|students|sourceParticipants/);
  }
});

test("truthful empty, stale, and partial source states are retained instead of manufactured freshness", async () => {
  const cases: [JiaowubaoOpenApiScheduleSnapshotWindow, string, string, number][] = [
    [{ ...page, events: [], empty: true }, "fresh", "complete", 0],
    [{ ...page, state: "stale", freshness: "stale" }, "stale", "complete", 1],
    [{ ...page, sourceWindow: { start: "2026-10-12", end: "2026-10-17" } }, "fresh", "partial", 1],
  ];
  for (const [source, freshness, coverage, count] of cases) {
    const response = await service.createAvaCalendarMachineHandler(fixtureDependencies(rows, source))(machineRequest());
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.source.freshness, freshness);
    assert.equal(data.source.coverage, coverage);
    assert.equal(data.events.length, count);
  }
});

test("provider failures never include a raw record, service credential, or internal diagnostic", async () => {
  for (const key of ["readRows", "readVersions", "readSnapshot", "readAccounts"] as const) {
    const response = await service.createAvaCalendarMachineHandler({ ...dependencies, [key]: async () => { throw new Error(`private-diagnostic Synthetic One ${token} ${digest}`); } })(machineRequest());
    assert.equal(response.status, 503, key);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
    assert.equal(response.headers.get("Vary"), "Authorization");
    assert.deepEqual(await response.json(), { error: "课表暂时无法完整读取，请稍后重试。" });
  }
});

test("a machine credential never upgrades the human cookie handler or its session permissions", async () => {
  const readDenied = async () => assert.fail("Bearer must not bypass human session authorization");
  const response = await service.createAvaCalendarHandler({ ...dependencies, readSession: async () => ({ error: "请先登录。", status: 401 }), readRows: readDenied })(machineRequest());
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Vary"), "Cookie");
  const limited = await service.createAvaCalendarHandler({ ...dependencies, readSession: async () => ({ session: { user: "Synthetic Staff", role: "staff", permissions: [] }, fullAdmin: false }), readSnapshot: readDenied })(machineRequest());
  assert.equal(limited.status, 403);
});

test("the calendar-only projection matches all existing global identity and trial gates without Ops authority", async () => {
  const firstStudent = (rows[0]!.payload as Record<string, unknown>[])[0]!;
  const secondStudent = (rows[0]!.payload as Record<string, unknown>[])[1]!;
  const normalizedEvent = { ...event, startsAt: "2026-10-11T04:00:00.000Z", endsAt: "2026-10-11T05:00:00.000Z" };
  const shared = { ...normalizedEvent, sourceParticipants: [{ memberId: "shared-A", label: "试听学员A" }] };
  const lp = { id: "LP1", workflowType: "试听 LP", studentId: "S1", trialSchedule: { source: "jiaowubao-open-api", sourceRevision: page.revision, eventId: event.eventId, startsAt: normalizedEvent.startsAt, endsAt: normalizedEvent.endsAt, teacherId: "T1" } };
  const cases = [
    { state: rows, event: normalizedEvent, directory: accounts },
    { state: rows, event: { ...normalizedEvent, sourceTeacherLabel: "Unknown source teacher", sourceParticipants: [{ memberId: "private-unknown", label: "Private Unknown" }] }, directory: accounts },
    { state: rows, event: { ...normalizedEvent, sourceParticipants: [{ memberId: "102", label: "Synthetic One" }] }, directory: accounts },
    { state: [row("students", [{ ...firstStudent, name: "Same Name" }, { ...secondStudent, name: "Same Name" }]), ...rows.slice(1)], event: { ...normalizedEvent, sourceParticipants: [{ memberId: null, label: "Same Name" }] }, directory: accounts },
    { state: [row("students", [{ ...firstStudent, jwbSourceRow: " 101 " }]), ...rows.slice(1)], event: { ...normalizedEvent, sourceParticipants: [{ memberId: "101", label: null }] }, directory: accounts },
    { state: [row("students", [{ ...firstStudent, importArchived: true }, secondStudent]), ...rows.slice(1)], event: normalizedEvent, directory: accounts },
    { state: [rows[0]!, row("teachers", [{ id: "T1", name: "Synthetic Teacher" }, { id: "T2", name: "Synthetic Teacher" }]), ...rows.slice(2)], event: normalizedEvent, directory: accounts },
    { state: rows, event: { ...normalizedEvent, sourceStudentsTruncated: true }, directory: accounts },
    { state: rows, event: shared, directory: accounts },
    { state: [...rows.slice(0, 3), row("lpItems", [lp])], event: shared, directory: accounts },
    { state: [...rows.slice(0, 3), row("lpItems", [{ ...lp, trialSchedule: { ...lp.trialSchedule, sourceRevision: `sha256:${"c".repeat(64)}` } }])], event: shared, directory: accounts },
    { state: [...rows.slice(0, 3), row("lpItems", [lp, { ...lp, id: "LP2", studentId: "S2" }])], event: shared, directory: accounts },
    { state: [...rows.slice(0, 3), row("lpItems", [lp])], event: { ...shared, sourceParticipants: [...shared.sourceParticipants, { memberId: "102", label: "Synthetic Two" }] }, directory: accounts },
    { state: rows, event: normalizedEvent, directory: [{ ...accounts[0]!, status: "disabled" as const }, accounts[1]!] },
    { state: rows, event: normalizedEvent, directory: [{ ...accounts[0]!, account_role: "teacher" as const }, accounts[1]!] },
    { state: rows, event: normalizedEvent, directory: [...accounts, { ...accounts[0]!, account_id: "duplicate" }] },
    { state: [row("students", [{ ...firstStudent, owner: "Tara" }, { ...secondStudent, owner: "待分配" }]), ...rows.slice(1)], event: normalizedEvent, directory: accounts },
  ];
  for (const fixture of cases) {
    const source = { ...page, events: [fixture.event] };
    const response = await service.createAvaCalendarMachineHandler(fixtureDependencies(fixture.state, source, fixture.directory))(machineRequest());
    assert.equal(response.status, 200);
    const data = await response.json();
    // A synthetic comparison authority exists only in this test, never in the machine implementation.
    const access = buildOpsAccessContext(fixture.state, "Synthetic Comparison Administrator", true, { user: "Synthetic Comparison Administrator", role: "admin", permissions: ["*"] });
    const expected = projectAvaCalendarEvents({ rows: fixture.state, events: [fixture.event], access, accounts: fixture.directory, revision: page.revision! });
    assert.deepEqual({ events: data.events, teachers: data.teachers }, expected);
    assert.doesNotMatch(JSON.stringify(data), /Private Unknown|private-unknown|Unknown source teacher|shared-A|试听学员A|Private source title|sourceParticipants|sourceTeacherId|jwbSourceRow|planner/);
  }
});

test("duplicate or malformed internal identities cannot select a student or owner silently", async () => {
  const invalidStates = [
    [row("students", [{ id: "S1", name: "Synthetic One" }, { id: "S1", name: "Other Name" }]), ...rows.slice(1)],
    [rows[0]!, row("teachers", [{ id: "T1", name: "Synthetic Teacher" }, { id: "T1", name: "Other Teacher" }]), ...rows.slice(2)],
    [...rows.slice(0, 3), row("lpItems", [{ id: "LP1" }, { id: "LP1" }])],
    [row("students", [null]), ...rows.slice(1)], [row("students", [{ id: " S1 " }]), ...rows.slice(1)],
  ];
  for (const state of invalidStates) {
    const response = await service.createAvaCalendarMachineHandler(fixtureDependencies(state))(machineRequest());
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /Synthetic|events|students/);
  }
});

test("a failed or drifting later snapshot page never publishes the collected first page", async () => {
  const first = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}`, startsAt: "2026-10-11T04:00:00.123456+00:00" }));
  const cursor = { startsAt: "2026-10-11T04:00:00.123456Z", eventId: first.at(-1)!.eventId };
  for (const drift of [false, true]) {
    const response = await service.createAvaCalendarMachineHandler({ ...dependencies, readSnapshot: (window) => readAvaCalendarSnapshot(window, async (input) => {
      if (!input.cursor) return { ...page, events: first, hasMore: true, nextCursor: cursor };
      if (!drift) throw new Error("private-later-page-diagnostic Synthetic One");
      return { ...page, revision: `sha256:${"c".repeat(64)}`, events: [{ ...event, eventId: "event-999", startsAt: first[0]!.startsAt }] };
    }) })(machineRequest());
    assert.equal(response.status, drift ? 409 : 503);
    assert.doesNotMatch(await response.text(), /Synthetic|events|students|event-000|private-later-page/);
  }
});

test("pagination rejects non-equivalent microseconds, wrong cursor IDs, short pages, and duplicate events", async () => {
  const first = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}`, startsAt: "2026-10-11T04:00:00.123456+00:00" }));
  const cursor = { startsAt: "2026-10-11T04:00:00.123456Z", eventId: first.at(-1)!.eventId };
  const badPages = [
    { ...page, events: first, hasMore: true, nextCursor: { ...cursor, startsAt: "2026-10-11T04:00:00.123457Z" } },
    { ...page, events: first, hasMore: true, nextCursor: { ...cursor, eventId: "wrong-event" } },
    { ...page, events: first.slice(0, -1), hasMore: true, nextCursor: { ...cursor, eventId: first.at(-2)!.eventId } },
    { ...page, events: [event, event] },
  ];
  for (const source of badPages) {
    let calls = 0;
    const response = await service.createAvaCalendarMachineHandler({ ...dependencies, readSnapshot: (window) => readAvaCalendarSnapshot(window, async () => { calls++; return source; }) })(machineRequest());
    assert.equal(response.status, 503);
    assert.equal(calls, 1, "invalid cursors must not be sent to a second-page getter");
    assert.doesNotMatch(await response.text(), /Synthetic|events|students|event-000/);
  }
});

test("the forty-page guard stays fail-closed rather than returning a clipped calendar", async () => {
  let calls = 0;
  const response = await service.createAvaCalendarMachineHandler({ ...dependencies, readSnapshot: (window) => readAvaCalendarSnapshot(window, async () => {
    const events = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(calls * 250 + index).padStart(5, "0")}` }));
    calls++;
    return { ...page, events, hasMore: true, nextCursor: { startsAt: "2026-10-11T04:00:00.000000Z", eventId: events.at(-1)!.eventId } };
  }) })(machineRequest());
  assert.equal(response.status, 503);
  assert.equal(calls, 40);
  assert.doesNotMatch(await response.text(), /Synthetic|events|students|event-00000/);
});

test("queued initial revocation stops the first roster getter", async () => {
  let current: string | undefined = digest;
  let scheduled = false;
  const reads: string[] = [];
  const response = await service.createAvaCalendarMachineHandler({ ...dependencies,
    readTokenSha256: () => {
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => { current = undefined; });
      }
      return current;
    },
    readRows: async () => { reads.push("rows-after-revocation"); assert.equal(current, undefined); return rows; },
  })(machineRequest());
  assert.equal(response.status, 503);
  assert.deepEqual(reads, []);
  assert.doesNotMatch(await response.text(), /Synthetic|events|students|tokenSha256/);
});

test("collector revocation after the first page blocks every later source getter", async () => {
  let current: string | undefined = digest;
  const reads: number[] = [];
  const first = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}` }));
  const response = await service.createAvaCalendarMachineHandler({ ...dependencies,
    readTokenSha256: () => current,
    readSnapshot: (window) => readAvaCalendarSnapshot(window, async (input) => {
      reads.push(input.cursor ? 2 : 1);
      if (!input.cursor) {
        current = undefined;
        return { ...page, events: first, hasMore: true, nextCursor: { startsAt: event.startsAt, eventId: first.at(-1)!.eventId } };
      }
      return { ...page, events: [{ ...event, eventId: "event-999" }] };
    }),
  })(machineRequest());
  assert.equal(response.status, 503);
  assert.deepEqual(reads, [1]);
  assert.doesNotMatch(await response.text(), /Synthetic|events|students|event-000/);
});

test("the real route stops its page getter after first-page revocation", async () => {
  const environment: Record<string, string> = { AVA_CALENDAR_SERVICE_TOKEN_SHA256: digest };
  const first = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}` }));
  const reads: number[] = [];
  const credentials = loadOfflineServerModule("../lib/account-credentials.ts", {}) as typeof import("../lib/account-credentials");
  const store = {
    getOpsState: dependencies.readRows,
    getOpsVersions: dependencies.readVersions,
    getAccountByIdentity: async () => accounts[0],
    getJiaowubaoOpenApiScheduleSnapshotWindow: async () => {
      reads.push(reads.length + 1);
      environment.AVA_CALENDAR_SERVICE_TOKEN_SHA256 = "";
      return { ...page, events: first, hasMore: true, nextCursor: { startsAt: event.startsAt, eventId: first.at(-1)!.eventId } };
    },
  };
  const route = loadOfflineServerModule("../app/api/ava-calendar/service/route.ts", {
    "@/lib/account-credentials": credentials, "@/lib/ops-store": store, "@/lib/lp-workflows": { TRIAL_OPERATIONS },
    "@/lib/ava-calendar-service": service, "@/lib/ava-calendar-snapshot": { readAvaCalendarSnapshot },
  }, environment) as typeof import("../app/api/ava-calendar/service/route");
  const response = await route.GET(machineRequest());
  assert.equal(response.status, 503);
  assert.deepEqual(reads, [1]);
  assert.doesNotMatch(await response.text(), /Synthetic|events|students|event-000/);
});

function authorityFixtureLatch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function parallelAuthoritySnapshot(reads: number[], entered: ReturnType<typeof authorityFixtureLatch>, resume: ReturnType<typeof authorityFixtureLatch>, firstRead: () => void) {
  const first = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}` }));
  return (window: { start: string; end: string }) => readAvaCalendarSnapshot(window, async (input) => {
    reads.push(input.cursor ? 2 : 1);
    if (input.cursor) return { ...page, events: [{ ...event, eventId: "event-999" }] };
    firstRead();
    entered.release();
    await resume.promise;
    return { ...page, events: first, hasMore: true, nextCursor: { startsAt: event.startsAt, eventId: first.at(-1)!.eventId } };
  });
}

test("parallel machine revocation cannot cancel another machine, cookie or unscoped snapshot read", async () => {
  const entered = Array.from({ length: 4 }, authorityFixtureLatch);
  const resume = authorityFixtureLatch();
  const reads = Array.from({ length: 4 }, () => [] as number[]);
  let current: string | undefined = digest;
  const revoked = service.createAvaCalendarMachineHandler({ ...dependencies, readTokenSha256: () => current,
    readSnapshot: parallelAuthoritySnapshot(reads[0]!, entered[0]!, resume, () => { current = undefined; }),
  })(machineRequest());
  const allowed = service.createAvaCalendarMachineHandler({ ...dependencies,
    readSnapshot: parallelAuthoritySnapshot(reads[1]!, entered[1]!, resume, () => {}),
  })(machineRequest());
  const human = service.createAvaCalendarHandler({ ...dependencies,
    readSession: async () => ({ session: { user: "Tiffany", role: "staff", permissions: ["operations.read"] }, fullAdmin: false }),
    readSnapshot: parallelAuthoritySnapshot(reads[2]!, entered[2]!, resume, () => {}),
  })(request());
  const unscoped = parallelAuthoritySnapshot(reads[3]!, entered[3]!, resume, () => {})({ start: "2026-10-11T00:00:00Z", end: "2026-10-18T00:00:00Z" });
  await Promise.all(entered.map((latch) => latch.promise));
  resume.release();
  const [denied, success, cookie, snapshot] = await Promise.all([revoked, allowed, human, unscoped]);
  assert.equal(denied.status, 503);
  assert.deepEqual(reads[0], [1]);
  assert.doesNotMatch(await denied.text(), /Synthetic|events|students/);
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("Vary"), "Authorization");
  assert.equal((await success.json()).events.length, 251);
  assert.deepEqual(reads[1], [1, 2]);
  assert.equal(cookie.status, 200);
  assert.equal(cookie.headers.get("Vary"), "Cookie");
  assert.equal((await cookie.json()).events.length, 251);
  assert.deepEqual(reads[2], [1, 2]);
  assert.equal(snapshot.events.length, 251);
  assert.deepEqual(reads[3], [1, 2]);
  assert.equal((await service.createAvaCalendarMachineHandler(dependencies)(machineRequest())).status, 200);
});
