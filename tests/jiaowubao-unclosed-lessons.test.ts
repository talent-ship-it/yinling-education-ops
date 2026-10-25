import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createJiaowubaoScheduleReader } from "../lib/jiaowubao-schedule-provider-node";
import { runInNewContext } from "node:vm";
import { timingSafeEqual } from "node:crypto";
import ts from "typescript";
import { statusForDueAt } from "../lib/ops-tasks";

import { reconcileUnclosedLessons, unclosedCollectionWindows, unclosedLessonOwners, unclosedTargetDate, unclosedTask, type UnclosedLesson } from "../lib/jiaowubao-unclosed-lessons";

const { collectUnclosedLessons } = load("../lib/jiaowubao-unclosed-collector.ts", {
  "./jiaowubao-schedule-provider-node": { createJiaowubaoScheduleReader: () => { throw new Error("Unexpected source access"); } },
  "./ops-store": {},
  "./jiaowubao-unclosed-lessons": { reconcileUnclosedLessons, unclosedCollectionWindows, unclosedTargetDate },
}) as unknown as Pick<typeof import("../lib/jiaowubao-unclosed-collector"), "collectUnclosedLessons">;

const now = new Date("2026-10-26T00:00:00.000Z");
const lesson = (id = "1", date = "2026-10-24"): UnclosedLesson => ({ eventId: `jwb-open-api:schedule:${id}`, date, courseName: "English", participants: [{ memberId: "11", name: "Alice陈一" }], firstDetectedAt: "2026-10-24T00:00:00.000Z", lastSeenAt: "2026-10-24T00:00:00.000Z" });
const source = (id: number, over = 0) => ({ cal_id: id, dated: "2026-10-24", over, course_title: "English", stu_list: [{ mem_id: 11, name: "Alice陈一" }] });
const students = [{ id: "S1", name: "Alice陈一", owner: "Ella", jwbSourceRow: "11" }, { id: "S2", name: "Bob王二", owner: "Molly", jwbSourceRow: "22" }];

function load(path: string, dependencies: Record<string, unknown>, env: Record<string, string> = {}) {
  const exports: Record<string, unknown> = {};
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, require: (id: string) => { if (!(id in dependencies)) throw new Error(`Unexpected dependency ${id}`); return dependencies[id]; }, process: { env }, Buffer, Date, console });
  return exports as Record<string, (...args: unknown[]) => Promise<unknown>>;
}

test("D-2 uses Melbourne dates and retains earlier dates in bounded collection windows", () => {
  assert.equal(unclosedTargetDate(new Date("2026-10-25T13:01:00Z")), "2026-10-24");
  assert.equal(unclosedTargetDate(new Date("2026-10-25T16:01:00Z")), "2026-10-24");
  assert.deepEqual(unclosedCollectionWindows([lesson("old", "2026-08-01")], now), [{ start: "2026-08-01", end: "2026-08-01" }, { start: "2026-10-24", end: "2026-10-24" }]);
  assert.throws(() => unclosedCollectionWindows(Array.from({ length: 9 }, (_, i) => lesson(String(i), `${2010 + i}-01-01`)), now), /window_limit/);
});

test("missing or cancelled source rows never close reminders; explicit completed evidence does", () => {
  const previous = [lesson("old", "2026-08-01"), lesson()];
  assert.deepEqual(reconcileUnclosedLessons(previous, [], new Set()), previous);
  assert.deepEqual(reconcileUnclosedLessons(previous, [], new Set([lesson().eventId])), [previous[0]]);
  const fresh = { ...lesson(), firstDetectedAt: now.toISOString(), lastSeenAt: now.toISOString() };
  assert.equal(reconcileUnclosedLessons([lesson()], [fresh], new Set())[0]!.firstDetectedAt, lesson().firstDetectedAt);
  assert.throws(() => reconcileUnclosedLessons([], [fresh], new Set([fresh.eventId])), /source_changed/);
});

test("collector fully paginates an unfiltered window before projecting explicit completion states", async () => {
  const queries: unknown[] = [];
  const result = await collectUnclosedLessons([lesson("old", "2026-10-20")], now, async (q) => {
    queries.push(q);
    return { lists: q.page === 1 ? Array.from({ length: 100 }, (_, i) => source(i + 1)) : [source(101)] };
  });
  assert.equal(result.lessons.length, 102);
  assert.equal(result.calls, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(queries)), [{ start: "2026-10-20", end: "2026-10-24", page: 1, limit: 100, order: "asc" }, { start: "2026-10-20", end: "2026-10-24", page: 2, limit: 100, order: "asc" }]);
});

test("collector rejects duplicates, wrong status, out-of-window rows and partial source failure", async () => {
  await assert.rejects(collectUnclosedLessons([], now, async () => ({ lists: [source(1), source(1)] })), /duplicate/);
  await assert.rejects(collectUnclosedLessons([], now, async () => ({ lists: [source(1, 2)] })), /status_invalid/);
  await assert.rejects(collectUnclosedLessons([], now, async () => ({ lists: [{ ...source(1), dated: "2026-10-25" }] })), /window_invalid/);
  await assert.rejects(collectUnclosedLessons([], now, async (q) => { if (q.page === 2) throw new Error("synthetic failure"); return { lists: Array.from({ length: 100 }, (_, index) => source(index + 1)) }; }), /synthetic failure/);
  await assert.rejects(collectUnclosedLessons([], now, async (q) => ({ lists: Array.from({ length: 100 }, (_, i) => source((q.page! - 1) * 100 + i + 1)) })), /request_limit/);
});

test("collector rechecks old reminders and only removes explicitly completed IDs", async () => {
  const previous = [lesson("old", "2026-08-01"), lesson()];
  const result = await collectUnclosedLessons(previous, now, async (q) => ({ lists: q.start === "2026-10-24" ? [source(1, 1)] : [] }));
  assert.deepEqual(result.lessons, [previous[0]]);
});

test("ownership uses unique verified identity and fails closed for conflicting or shared identities", () => {
  assert.deepEqual(unclosedLessonOwners(lesson(), students, []), [{ owner: "Ella", studentIds: ["S1"] }]);
  assert.deepEqual(unclosedLessonOwners({ ...lesson(), participants: [{ memberId: "11", name: "Bob王二" }] }, students, []), [{ owner: null, studentIds: [] }]);
  assert.deepEqual(unclosedLessonOwners(lesson(), [...students, { id: "S3", name: "Alice陈一", owner: "Molly" }], []), [{ owner: null, studentIds: [] }]);
  assert.deepEqual(unclosedLessonOwners({ ...lesson(), participants: [{ memberId: "11", name: "试听学员A" }], courseName: "English" }, students, []), [{ owner: null, studentIds: [] }]);
  assert.deepEqual(unclosedLessonOwners({ ...lesson(), participants: [] }, students, [{ studentId: "S1", trialSchedule: { eventId: lesson().eventId, source: "manual" } }]), [{ owner: null, studentIds: [] }]);
  assert.deepEqual(unclosedLessonOwners({ ...lesson(), participants: [] }, students, [{ studentId: "S1", trialSchedule: { eventId: lesson().eventId, source: "jiaowubao-open-api" } }]), [{ owner: "Ella", studentIds: ["S1"] }]);
  const group = { ...lesson(), participants: [{ memberId: "11", name: "Alice陈一" }, { memberId: "22", name: "Bob王二" }] };
  assert.equal(unclosedLessonOwners(group, students, []).length, 2);
});

test("aggregates expose dates and source lesson IDs without participant or course names", () => {
  const task = unclosedTask({ owner: "Ella", lessons: [lesson()], checkedAt: now.toISOString() });
  assert.equal(task.id, "JWB-UNCLOSED:Ella");
  assert.equal(task.dueAt, "2026-10-26T12:59:59.999Z");
  assert.equal(task.trigger, "2026-10-24 · 1");
  assert.doesNotMatch(JSON.stringify(task), /Alice|English/);
});

test("cron stays disabled without activation and rejects Unicode byte-length mismatch safely", async () => {
  let writes = 0;
  const dependencies = { "node:crypto": { timingSafeEqual }, "next/server": { NextResponse: { json: (body: unknown, options: unknown) => ({ body, options }) } }, "@/lib/jiaowubao-unclosed-sync": { syncJiaowubaoUnclosedLessons: async () => { writes++; return { rowCount: 0 }; } } };
  const disabled = load("../app/api/cron/jiaowubao-unclosed-lessons/route.ts", dependencies);
  assert.equal((await disabled.GET!(new Request("http://localhost")) as { options: { status: number } }).options.status, 404);
  const active = load("../app/api/cron/jiaowubao-unclosed-lessons/route.ts", dependencies, { JIAOWUBAO_UNCLOSED_TASKS_ENABLED: "true", JIAOWUBAO_UNCLOSED_SYNC_TOKEN: "a".repeat(32) });
  const invalid = await active.GET!(new Request("http://localhost", { headers: { authorization: `Bearer ${"é".repeat(32)}` } })) as { options: { status: number } };
  assert.equal(invalid.options.status, 404);
  await active.GET!(new Request("http://localhost", { headers: { authorization: `Bearer ${"a".repeat(32)}` } }));
  assert.equal(writes, 1);
});

test("publication starts only after complete collection and aborts failed unpublished pages", async () => {
  const events: string[] = [];
  const dependencies = { "node:crypto": { randomUUID: () => "synthetic-run" }, "./ops-store": { readJiaowubaoUnclosedSnapshot: async () => ({ lessons: [], revision: null }), beginJiaowubaoUnclosedSnapshot: async () => events.push("begin"), stageJiaowubaoUnclosedSnapshot: async () => { events.push("stage"); throw new Error("stage failed"); }, completeJiaowubaoUnclosedSnapshot: async () => events.push("complete"), abortJiaowubaoUnclosedSnapshot: async () => events.push("abort") }, "./jiaowubao-unclosed-collector": { unclosedPageReader: () => null, collectUnclosedLessons: async () => { events.push("collect"); return { lessons: [lesson()], calls: 2 }; } } };
  const sync = load("../lib/jiaowubao-unclosed-sync.ts", dependencies);
  await assert.rejects(sync.syncJiaowubaoUnclosedLessons!(), /stage failed/);
  assert.deepEqual(events, ["collect", "begin", "stage", "abort"]);
  events.length = 0;
  dependencies["./jiaowubao-unclosed-collector"].collectUnclosedLessons = async () => { throw new Error("source failed"); };
  await assert.rejects(load("../lib/jiaowubao-unclosed-sync.ts", dependencies).syncJiaowubaoUnclosedLessons!(), /source failed/);
  assert.deepEqual(events, []);
});


test("unclosed task API restricts each lesson to its responsible staff and protects unknown ownership", async () => {
  let context = { actor: "Ella", staff: true, fullAdmin: false, limitedAdmin: false, restrictedStudentScope: false };
  let role = "staff";
  let authenticated = true;
  let cacheRead = 0;
  const unknown = { ...lesson("unknown"), participants: [{ memberId: "99", name: "Unknown" }] };
  const dependencies = {
    "next/headers": { cookies: async () => ({ get: () => ({ value: "synthetic" }) }) },
    "next/server": { NextResponse: { json: (body: unknown, options: unknown) => ({ body, options }) } },
    "@/lib/demo-auth": { DEMO_COOKIE_NAME: "auth", getCurrentDemoSession: async () => authenticated ? { session: { user: context.actor, role } } : { error: "Unauthenticated", status: 401 } },
    "@/lib/nixon-auth": { hasFullAdminAccess: () => context.fullAdmin, NIXON_COOKIE_NAME: "admin" },
    "@/lib/ops-access": { buildOpsAccessContext: () => context, canReadOpsEntity: () => true, canAccessStudent: (_: unknown, id: string) => context.fullAdmin || context.limitedAdmin || students.find((s) => s.id === id)?.owner === context.actor },
    "@/lib/ops-store": { getOpsState: async () => [{ entity: "students", payload: students }, { entity: "lpItems", payload: [] }], readJiaowubaoUnclosedSnapshot: async () => { cacheRead++; return { revision: "synthetic", checkedAt: now.toISOString(), lessons: [lesson(), { ...lesson("2"), participants: [{ memberId: "22", name: "Bob王二" }] }, unknown] }; } },
    "@/lib/jiaowubao-unclosed-lessons": { unclosedLessonOwners, unclosedTask },
  };
  const route = load("../app/api/jiaowubao-open-api/unclosed-tasks/route.ts", dependencies, { JIAOWUBAO_UNCLOSED_TASKS_ENABLED: "true" });
  type Reply = { body: { tasks: { owner: string; trigger: string }[] }; options: { status: number } };
  assert.equal(JSON.stringify((await route.GET!() as Reply).body.tasks.map((t) => t.owner)), JSON.stringify(["Ella"]));
  role = "teacher";
  assert.equal((await route.GET!() as Reply).options.status, 403);
  assert.equal(cacheRead, 1);
  role = "admin";
  context = { actor: "Nixon", staff: false, fullAdmin: true, limitedAdmin: false, restrictedStudentScope: false };
  assert.equal((await route.GET!() as Reply).body.tasks.length, 3);
  context.restrictedStudentScope = true;
  assert.equal((await route.GET!() as Reply).body.tasks.length, 2);
  authenticated = false;
  assert.equal((await route.GET!() as Reply).options.status, 401);
});


test("daily aggregates include old and new pending lessons on the complete snapshot day", () => {
  const lessons = [lesson("old", "2026-08-01"), lesson("new", "2026-10-24")];
  const task = unclosedTask({ owner: "Ella", lessons, checkedAt: now.toISOString() });
  assert.equal(task.dueAt, "2026-10-26T12:59:59.999Z");
  assert.equal(statusForDueAt(task.dueAt, now, "Australia/Melbourne"), "today");
  assert.match(task.trigger, /2026-08-01 · old/);
  assert.match(task.trigger, /2026-10-24 · new/);
  const tomorrow = new Date("2026-10-27T00:00:00.000Z");
  assert.equal(statusForDueAt(task.dueAt, tomorrow, "Australia/Melbourne"), "overdue");
  const refreshed = unclosedTask({ owner: "Ella", lessons, checkedAt: tomorrow.toISOString() });
  assert.equal(refreshed.dueAt, "2026-10-27T12:59:59.999Z");
  assert.equal(statusForDueAt(refreshed.dueAt, tomorrow, "Australia/Melbourne"), "today");
  assert.equal(refreshed.trigger, task.trigger);
});


function unclosedMcpPage(rows: Record<string, unknown>[], args: { start: string; end: string }, page: number) {
  const scopedRows = rows.filter((row) => String(row.dated) >= args.start && String(row.dated) <= args.end);
  const pageRows = scopedRows.slice((page - 1) * 100, page * 100);
  return { content: [{ type: "text", text: JSON.stringify({ total: String(scopedRows.length), is_more: page * 100 < scopedRows.length ? "1" : "0", lists: pageRows }) }] };
}

async function unclosedMcpFixture(rows: Record<string, unknown>[], failedPage?: number) {
  const token = "SyntheticMCP-Unclosed-LocalOnly";
  const messages: { method: string; params?: { name: string; arguments: Record<string, unknown> } }[] = [];
  let reservations = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    messages.push(message);
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (message.method === "notifications/initialized") return response.writeHead(202).end();
    const page = Number(message.params?.arguments?.page ?? 1);
    if (message.method === "tools/call" && page === failedPage) return response.writeHead(503).end();
    const result = message.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }
      : unclosedMcpPage(rows, message.params.arguments, page);
    response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "synthetic-unclosed" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const nativeFetch = globalThis.fetch;
  const fetchImpl: typeof fetch = (url, options) => {
    assert.equal(String(url), "https://card.jwbpro.com/open/jwb/mcp");
    assert.equal(options?.redirect, "manual");
    return nativeFetch(`http://127.0.0.1:${address.port}/mcp`, options);
  };
  const collector = load("../lib/jiaowubao-unclosed-collector.ts", {
    "./jiaowubao-schedule-provider-node": { createJiaowubaoScheduleReader: () => createJiaowubaoScheduleReader({ env: { JIAOWUBAO_SCHEDULE_SOURCE: "mcp", INSIDERLEADS_JWB_MCP_TOKEN: token }, fetchImpl }) },
    "./ops-store": { reserveJiaowubaoOpenApiScheduleRequest: async () => { reservations++; return { notBefore: new Date(Date.now() - 1000).toISOString() }; } },
    "./jiaowubao-unclosed-lessons": { reconcileUnclosedLessons, unclosedCollectionWindows, unclosedTargetDate },
  }) as unknown as Pick<typeof import("../lib/jiaowubao-unclosed-collector"), "collectUnclosedLessons" | "unclosedPageReader">;
  return { collector, messages, reservations: () => reservations, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

function mcpSourceRows() {
  return Array.from({ length: 101 }, (_, index) => ({ ...source(index + 1), over: index < 2 ? String(index % 2) : index % 2, cal_id: String(index + 1) }));
}

test("unclosed collector traverses the actual MCP provider with unfiltered mixed-state pages", async () => {
  const fixture = await unclosedMcpFixture(mcpSourceRows());
  const previous = [lesson("2", "2026-10-20"), lesson("missing", "2026-10-20")];
  const before = JSON.stringify(previous);
  try {
    const result = await fixture.collector.collectUnclosedLessons(previous, now, fixture.collector.unclosedPageReader(Date.now() + 10000));
    assert.equal(result.calls, 2);
    assert.equal(fixture.reservations(), 2);
    assert.equal(result.lessons.length, 52);
    assert.equal(result.lessons.some((item) => item.eventId === lesson("2").eventId), false);
    assert.equal(result.lessons.some((item) => item.eventId === lesson("missing").eventId), true);
    assert.equal(JSON.stringify(previous), before);
    assert.deepEqual(fixture.messages.map((message) => message.method), ["initialize", "notifications/initialized", "tools/call", "tools/call"]);
    assert.deepEqual(fixture.messages.filter((message) => message.method === "tools/call").map((message) => message.params), [1, 2].map((page) => ({ name: "query_schedule_list", arguments: { start: "2026-10-20", end: "2026-10-24", page, limit: 100, order: "asc", detail: 1 } })));
  } finally { await fixture.close(); }
});

for (const over of [undefined, null, false, true, 2, "00", ""]) {
  test(`MCP collector rejects non-explicit completion state ${String(over)}`, async () => {
    const fixture = await unclosedMcpFixture([{ ...source(1), cal_id: "1", over }]);
    try {
      await assert.rejects(fixture.collector.collectUnclosedLessons([lesson()], now, fixture.collector.unclosedPageReader(Date.now() + 10000)), /unclosed_status_invalid/);
      assert.equal(fixture.messages.length, 3);
    } finally { await fixture.close(); }
  });
}

test("a later MCP page failure cannot publish closures already seen on an earlier page", async () => {
  const fixture = await unclosedMcpFixture(mcpSourceRows(), 2);
  const previous = { revision: `sha256:${"a".repeat(64)}`, lessons: [lesson("2", "2026-10-20"), lesson("missing", "2026-10-20")] };
  const before = JSON.stringify(previous);
  const writes: string[] = [];
  const sync = load("../lib/jiaowubao-unclosed-sync.ts", {
    "node:crypto": { randomUUID: () => "synthetic-mcp-run" },
    "./jiaowubao-unclosed-collector": fixture.collector,
    "./ops-store": { readJiaowubaoUnclosedSnapshot: async () => previous,
      beginJiaowubaoUnclosedSnapshot: async () => writes.push("begin"), stageJiaowubaoUnclosedSnapshot: async () => writes.push("stage"),
      completeJiaowubaoUnclosedSnapshot: async () => writes.push("complete"), abortJiaowubaoUnclosedSnapshot: async () => writes.push("abort") },
  });
  try {
    await assert.rejects(sync.syncJiaowubaoUnclosedLessons!(now), (error: unknown) => (error as { code: string }).code === "upstream_unavailable");
    assert.deepEqual(writes, []);
    assert.equal(JSON.stringify(previous), before);
    assert.equal(fixture.reservations(), 2);
    assert.equal(fixture.messages.filter((message) => message.method === "tools/call").length, 2);
  } finally { await fixture.close(); }
});


test("catch-up windows cover only dates after the last complete target and stay bounded", () => {
  assert.deepEqual(unclosedCollectionWindows([], now, null), [{ start: "2026-10-24", end: "2026-10-24" }]);
  assert.deepEqual(unclosedCollectionWindows([], now, "2026-10-24T00:00:00.000Z"), [{ start: "2026-10-23", end: "2026-10-24" }]);
  assert.deepEqual(unclosedCollectionWindows([lesson("old", "2026-08-01")], now, "2026-10-24T00:00:00.000Z"), [{ start: "2026-08-01", end: "2026-08-01" }, { start: "2026-10-23", end: "2026-10-24" }]);
  assert.throws(() => unclosedCollectionWindows([], now, "invalid"), /checkpoint_invalid/);
  assert.throws(() => unclosedCollectionWindows([], now, "2026-10-27T00:00:00.000Z"), /checkpoint_invalid/);
  assert.throws(() => unclosedCollectionWindows([], now, "2025-01-01T00:00:00.000Z"), /window_limit/);
});

test("a failed daily MCP collection cannot permanently skip that day's newly pending lessons", async () => {
  let published = { revision: `sha256:${"a".repeat(64)}`, checkedAt: "2026-10-24T00:00:00.000Z", lessons: [] as UnclosedLesson[] };
  const original = JSON.stringify(published);
  let manifest: { checkedAt: string } | undefined;
  const staged: UnclosedLesson[] = [];
  const writes: string[] = [];
  const store = {
    readJiaowubaoUnclosedSnapshot: async () => published,
    beginJiaowubaoUnclosedSnapshot: async (input: { checkedAt: string }) => { manifest = input; writes.push("begin"); },
    stageJiaowubaoUnclosedSnapshot: async (input: { rows: UnclosedLesson[] }) => { staged.push(...input.rows); writes.push("stage"); },
    completeJiaowubaoUnclosedSnapshot: async () => { published = { revision: `sha256:${"b".repeat(64)}`, checkedAt: manifest!.checkedAt, lessons: [...staged] }; writes.push("complete"); return { revision: published.revision, rowCount: staged.length }; },
    abortJiaowubaoUnclosedSnapshot: async () => { writes.push("abort"); },
  };
  const rows = [{ ...source(900), cal_id: "900", dated: "2026-10-23" }, { ...source(901), cal_id: "901", dated: "2026-10-24" }];
  const failed = await unclosedMcpFixture(rows.slice(0, 1), 1);
  try {
    const sync = load("../lib/jiaowubao-unclosed-sync.ts", { "node:crypto": { randomUUID: () => "synthetic-gap-failed" }, "./jiaowubao-unclosed-collector": failed.collector, "./ops-store": store });
    await assert.rejects(sync.syncJiaowubaoUnclosedLessons!(new Date("2026-10-25T00:00:00.000Z")), (error: unknown) => (error as { code: string }).code === "upstream_unavailable");
    assert.equal(JSON.stringify(published), original);
    assert.deepEqual(writes, []);
  } finally { await failed.close(); }
  const recovered = await unclosedMcpFixture(rows);
  try {
    const sync = load("../lib/jiaowubao-unclosed-sync.ts", { "node:crypto": { randomUUID: () => "synthetic-gap-recovered" }, "./jiaowubao-unclosed-collector": recovered.collector, "./ops-store": store });
    await sync.syncJiaowubaoUnclosedLessons!(now);
    assert.deepEqual(staged.map((item) => item.date), ["2026-10-23", "2026-10-24"]);
    assert.deepEqual(writes, ["begin", "stage", "complete"]);
    assert.equal(published.checkedAt, now.toISOString());
    assert.deepEqual(recovered.messages.find((message) => message.method === "tools/call")?.params?.arguments, { start: "2026-10-23", end: "2026-10-24", page: 1, limit: 100, order: "asc", detail: 1 });
  } finally { await recovered.close(); }
});


test("multi-month catch-up stays within the real MCP provider's 31-day request contract", async () => {
  const rows = ["2026-08-01", "2026-09-01", "2026-10-24"].map((dated, index) => ({ ...source(index + 911), cal_id: String(index + 911), dated }));
  const fixture = await unclosedMcpFixture(rows);
  try {
    const result = await fixture.collector.collectUnclosedLessons([], now, fixture.collector.unclosedPageReader(Date.now() + 10000), "2026-08-01T00:00:00.000Z");
    assert.deepEqual(result.lessons.map((item) => item.date), ["2026-08-01", "2026-09-01", "2026-10-24"]);
    assert.deepEqual(fixture.messages.filter((message) => message.method === "tools/call").map((message) => message.params?.arguments), [
      { start: "2026-07-31", end: "2026-08-30", page: 1, limit: 100, order: "asc", detail: 1 },
      { start: "2026-08-31", end: "2026-09-30", page: 1, limit: 100, order: "asc", detail: 1 },
      { start: "2026-10-01", end: "2026-10-24", page: 1, limit: 100, order: "asc", detail: 1 },
    ]);
  } finally { await fixture.close(); }
});
