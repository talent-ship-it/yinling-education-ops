import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { expandTeacherAvailability } from "../lib/teacher-availability";
import type { DemoSessionIdentity } from "../lib/demo-session-token";
import type { OpsStateRow } from "../lib/ops-store";

export function selfFixture() {
  let rows: OpsStateRow[] = [
    { entity: "teachers", version: 7, payload: [{ id: "T1", name: "Synthetic Teacher", capacity: 10, availabilitySubmissions: [{ id: "PENDING", status: "pending" }] }, { id: "T2", name: "Synthetic Other", availabilityWindows: [] }], updated_at: "", updated_by: "" },
    { entity: "students", version: 4, payload: [], updated_at: "", updated_by: "" },
    { entity: "bookings", version: 5, payload: [{ id: "B1" }], updated_at: "", updated_by: "" },
  ];
  let session: DemoSessionIdentity = { user: "Synthetic Teacher", role: "teacher", permissions: ["availability.write.self"] };
  const writes: unknown[] = [];
  const deps = {
    readSession: async () => ({ session }),
    readRows: async () => structuredClone(rows),
    save: async (input: { payload: unknown; expectedVersion: number; actor: string; scopeVersions: Record<string, number> }) => {
      if (JSON.stringify(input.scopeVersions) !== JSON.stringify(Object.fromEntries(rows.map(({ entity, version }) => [entity, version]))) || input.expectedVersion !== rows[0]!.version) throw Object.assign(new Error("version_conflict"), { code: "40001" });
      writes.push(input);
      rows = [{ ...rows[0]!, payload: input.payload, version: rows[0]!.version + 1, updated_by: input.actor }, ...rows.slice(1)];
      return structuredClone([rows[0]!]);
    },
  };
  return { deps, writes, rows: () => rows, session: (next: DemoSessionIdentity) => { session = next; } };
}

export const createCommand = {
  commandKey: "19b65143-b20d-43ab-9eb2-62bce33ef35a", expectedVersion: 7, action: "create",
  startsAt: "2026-10-16T23:30:00+11:00", endsAt: "2026-10-17T01:00:00+11:00", timezone: "Australia/Melbourne",
};
export const selfRequest = (body?: unknown) => new Request("https://synthetic.test/api/teacher-availability/self", body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function selfService() {
  const implementation = await import("../lib/teacher-availability-self-service").catch(() => null);
  assert.ok(implementation?.createTeacherSelfAvailabilityHandler, "a narrow immediate self-availability command is required");
  return implementation.createTeacherSelfAvailabilityHandler;
}

test("teacher creates dated AVA immediately without changing pending submissions or other entities", async () => {
  const create = await selfService();
  const f = selfFixture();
  const before = structuredClone(f.rows());
  const response = await create(f.deps)(selfRequest(createCommand));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.teacherId, "T1");
  assert.equal(data.version, 8);
  assert.equal(data.windows.length, 1);
  assert.equal(data.windows[0].validFrom, data.windows[0].validTo);
  assert.deepEqual((f.rows()[0]!.payload as Record<string, unknown>[])[0]!.availabilitySubmissions, (before[0]!.payload as Record<string, unknown>[])[0]!.availabilitySubmissions);
  assert.deepEqual((f.rows()[0]!.payload as unknown[])[1], (before[0]!.payload as unknown[])[1]);
  assert.deepEqual(f.rows().slice(1), before.slice(1));
  assert.equal(f.writes.length, 1);
  assert.match(response.headers.get("Cache-Control")!, /private.*no-store/);
});

test("uncertain-response replay keeps the command key and writes once even after OCC advances", async () => {
  const create = await selfService();
  const f = selfFixture();
  const handler = create(f.deps);
  assert.equal((await handler(selfRequest(createCommand))).status, 200);
  const replay = await handler(selfRequest(createCommand));
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(f.writes.length, 1);
  assert.equal((await handler(selfRequest({ ...createCommand, endsAt: "2026-10-17T02:00:00+11:00" }))).status, 409);
});

test("teacher moves and deletes only their dated AVA while keeping lessons intact", async () => {
  const create = await selfService();
  const f = selfFixture();
  const handler = create(f.deps);
  const first = await (await handler(selfRequest(createCommand))).json();
  const update = { ...createCommand, action: "update", commandKey: "29b65143-b20d-43ab-9eb2-62bce33ef35a", expectedVersion: 8, windowId: first.windows[0].id, date: first.windows[0].validFrom, startsAt: "2026-10-17T00:00:00+11:00" };
  const response = await handler(selfRequest(update));
  assert.equal(response.status, 200);
  const changed = await response.json();
  const occurrences = expandTeacherAvailability(changed.windows, { from: "2026-10-16", to: "2026-10-18", displayTimezone: "Australia/Melbourne" });
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0]!.startsAt, "2026-10-16T13:00:00.000Z");
  assert.equal(occurrences[0]!.endsAt, "2026-10-16T14:00:00.000Z");
  const remove = { action: "delete", commandKey: "39b65143-b20d-43ab-9eb2-62bce33ef35a", expectedVersion: 9, windowId: changed.windows[0].id, date: changed.windows[0].validFrom };
  assert.equal((await handler(selfRequest(remove))).status, 200);
  assert.equal((await (await handler(selfRequest())).json()).windows.length, 0);
  assert.deepEqual(f.rows()[2]!.payload, [{ id: "B1" }]);
  assert.equal((await handler(selfRequest(remove))).status, 200);
  assert.equal(f.writes.length, 3);
});

test("production self route uses authenticated narrow store operation, not generic teacher permission", () => {
  const path = new URL("../app/api/teacher-availability/self/route.ts", import.meta.url);
  assert.equal(existsSync(path), true, "self-service HTTP route must exist");
  const route = readFileSync(path, "utf8");
  assert.match(route, /getCurrentDemoSession/);
  assert.match(route, /createTeacherSelfAvailabilityHandler/);
  assert.match(route, /putTeacherSelfAvailabilityState/);
  assert.doesNotMatch(route, /putOpsState|proof|Receipt|Jiaowubao/);
});

for (const session of [
  { user: "Synthetic Teacher", role: "teacher", permissions: [] },
  { user: "Synthetic Other", role: "teacher", permissions: ["availability.write.self"] },
  { user: "Synthetic Administrator", role: "admin", permissions: ["*"] },
] as const) {
  test(`self write rejects unauthorized actor ${session.user} / ${session.role}`, async () => {
    const create = await selfService();
    const f = selfFixture();
    if (session.user === "Synthetic Other") {
      const first = await (await create(f.deps)(selfRequest(createCommand))).json();
      f.session(session);
      assert.equal((await create(f.deps)(selfRequest({ action: "delete", expectedVersion: 8, commandKey: "49b65143-b20d-43ab-9eb2-62bce33ef35a", windowId: first.windows[0].id, date: first.windows[0].validFrom }))).status, 403);
      assert.equal(f.writes.length, 1);
    } else {
      f.session(session);
      assert.equal((await create(f.deps)(selfRequest(createCommand))).status, 403);
      assert.equal(f.writes.length, 0);
    }
  });
}

test("self commands reject caller identities, lesson targets, malformed tokens and overlapping windows", async () => {
  const create = await selfService();
  const f = selfFixture();
  const handler = create(f.deps);
  for (const extra of [{ teacherId: "T2" }, { capacity: 900 }, { commandKey: ` ${createCommand.commandKey}` }, { timezone: "Mars/Test" }]) {
    assert.equal((await handler(selfRequest({ ...createCommand, ...extra }))).status, 422);
  }
  assert.equal((await handler(selfRequest({ action: "delete", commandKey: createCommand.commandKey, expectedVersion: 7, windowId: "B1", date: "2026-10-16" }))).status, 403);
  await handler(selfRequest(createCommand));
  assert.equal((await handler(selfRequest({ ...createCommand, expectedVersion: 8, commandKey: "49b65143-b20d-43ab-9eb2-62bce33ef35a" }))).status, 422);
  assert.equal(f.writes.length, 1);
});

for (const [zone, start, end] of [
  ["America/New_York", "2026-11-01T01:30:00-04:00", "2026-11-01T01:45:00-05:00"],
  ["Australia/Melbourne", "2026-10-04T01:30:00+10:00", "2026-10-04T03:30:00+11:00"],
  ["Asia/Shanghai", "2026-12-31T23:30:00+08:00", "2027-01-01T01:30:00+08:00"],
]) {
  test(`self AVA preserves exact instants through DST or date boundary in ${zone}`, async () => {
    const create = await selfService();
    const response = await create(selfFixture().deps)(selfRequest({ ...createCommand, startsAt: start, endsAt: end, timezone: zone }));
    assert.equal(response.status, 200);
    const data = await response.json();
    const occurrences = expandTeacherAvailability(data.windows, { from: "2026-01-01", to: "2027-01-02", displayTimezone: zone! });
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0]!.startsAt, new Date(start!).toISOString());
    assert.equal(occurrences[0]!.endsAt, new Date(end!).toISOString());
  });
}

test("two writers with one version cannot overwrite each other", async () => {
  const create = await selfService();
  const f = selfFixture();
  const handler = create(f.deps);
  const statuses = await Promise.all([createCommand, { ...createCommand, commandKey: "49b65143-b20d-43ab-9eb2-62bce33ef35a", startsAt: "2026-10-18T02:00:00Z", endsAt: "2026-10-18T03:00:00Z" }].map(async (command) => (await handler(selfRequest(command))).status));
  assert.deepEqual(statuses.sort(), [200, 409]);
  assert.equal(f.writes.length, 1);
});
