import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [client, route, canonical, forward] = await Promise.all([
  readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api/app-state/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/20260729031203_bind_ops_scope_versions.sql", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/20260815035000_lock_generic_booking_scope.sql", import.meta.url), "utf8"),
]);

function normalizedFunction(source) {
  const match = source.match(/create or replace function public\.put_scoped_ops_state\([\s\S]*?\n\$\$;/i);
  assert.ok(match, "put_scoped_ops_state definition must exist");
  return match[0].replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
}

test("generic booking saves carry the student and teacher versions captured by the UI", () => {
  assert.match(client, /const bookingScopeVersions = useMemo\(\(\) => \(\{[\s\S]*students: studentsShared\.version,[\s\S]*teachers: teachersShared\.version/);
  assert.match(client, /useSharedState\("bookings"[\s\S]*false, bookingScopeVersions\)/);
  const hook = client.slice(client.indexOf("function useSharedState"), client.indexOf("function nowLabel"));
  assert.match(hook, /scheduledScopeVersions = JSON\.parse\(scopeVersionsKey\)/);
  assert.match(hook, /scheduledScopeVersions \? \{ scopeVersions: scheduledScopeVersions \} : \{\}/);
});

test("app-state fails closed when a generic booking save omits either scope version", () => {
  assert.match(route, /body\.entity === "bookings"[\s\S]*bookingScopeVersions\(body\.scopeVersions\)/);
  assert.match(route, /Object\.keys\(scope\)\.length !== 2/);
  assert.match(route, /Number\.isSafeInteger\(scope\.students\)[\s\S]*Number\.isSafeInteger\(scope\.teachers\)/);
  assert.match(route, /body\.entity === "bookings" && !submittedBookingScopeVersions/);
  assert.match(route, /const scopeVersions = submittedBookingScopeVersions \?\? getAccessScopeVersions/);
});

test("app-state binds invariant validation to the just-read target and scope versions", () => {
  const targetVersion = route.indexOf("currentRow.version !== body.expectedVersion");
  const studentScope = route.indexOf("submittedBookingScopeVersions.students !== currentStudentsVersion");
  const teacherScope = route.indexOf("submittedBookingScopeVersions.teachers !== currentTeachersVersion");
  const transition = route.indexOf("assertOpsStateTransition({");
  const write = route.indexOf("const saved = await putOpsState");
  assert.ok(targetVersion >= 0 && studentScope > targetVersion && teacherScope > studentScope);
  assert.ok(transition > teacherScope && write > transition, "snapshot equality must be checked before validation and the locked write");
  assert.match(route, /throw new OpsStoreError\("version_conflict", "40001"\)/);
  assert.match(route, /throw new OpsStoreError\("access_scope_changed", "40001"\)/);
});

test("booking conflicts re-evaluate scope drift before the client may merge", () => {
  assert.match(route, /const accessChanged = error\.message === "access_scope_changed"[\s\S]*submittedBookingScopeVersions\.students !== currentStudentsVersion[\s\S]*submittedBookingScopeVersions\.teachers !== currentTeachersVersion/);
  const hook = client.slice(client.indexOf("function useSharedState"), client.indexOf("function nowLabel"));
  assert.match(hook, /if \(body\.accessChanged \|\| current\.version <= versionRef\.current\) \{\s*throw new Error/);
  assert.ok(hook.indexOf("body.accessChanged") < hook.indexOf("mergeConcurrentPayload(JSON.parse(committedRef.current)"));
});

test("canonical and forward SQL lock bookings, students and teachers in the global order", () => {
  assert.equal(normalizedFunction(canonical), normalizedFunction(forward));
  for (const source of [canonical, forward]) {
    const definition = normalizedFunction(source);
    const bookingLock = definition.indexOf("where state.entity = 'bookings' for update");
    const studentLock = definition.indexOf("where state.entity = 'students' for update");
    const teacherLock = definition.indexOf("where state.entity = 'teachers' for update");
    const write = definition.indexOf("from public.put_ops_state(");
    assert.ok(bookingLock >= 0 && studentLock > bookingLock && teacherLock > studentLock && write > teacherLock);
    assert.match(definition, /if p_entity = 'bookings' then/);
    assert.match(definition, /p_scope_versions ->> 'students'[^;]*\^\[1-9\]\[0-9\]\*\$/);
    assert.match(definition, /p_scope_versions ->> 'teachers'[^;]*\^\[1-9\]\[0-9\]\*\$/);
    assert.match(definition, /booking_row\.version <> p_expected_version/);
    assert.match(definition, /elsif p_actor not in \('Nixon', 'Ops Admin'\) then/);
  }
});

test("scope version bounds use parenthesized CASE expressions accepted by PL/pgSQL", () => {
  for (const source of [canonical, forward]) {
    assert.doesNotMatch(source, /\bor\s+case\b/i);
    assert.equal((source.match(/\bor\s*\(\s*case\b/gi) ?? []).length, 2);
  }
});
