import assert from "node:assert/strict";
import test from "node:test";
import { createAvaCalendarHandler } from "../lib/ava-calendar-service";
import { readAvaCalendarSnapshot } from "../lib/ava-calendar-snapshot";
import { fetchAvaCalendarWindow } from "../lib/ava-calendar-live-client";
import { nameLinebreakFixture } from "./ava-calendar-name-linebreak-fixture";
import { avaCalendarSourceStudentName } from "../lib/ava-calendar-source-name";
import { projectAvaCalendarEvents } from "../lib/ava-calendar-projection";
import { buildOpsAccessContext } from "../lib/ops-access";
import { fixture, serverFixture } from "./ava-calendar-server-fixture";

const dayWindow = { start: "2026-10-17T00:00:00.000Z", end: "2026-10-18T00:00:00.000Z" };
test("three lessons sharing an ambiguous member retain LF-normalized display names through the actual API and decoder", async () => {
  const { rows, events, revision, student, sourceLabel, accounts } = nameLinebreakFixture();
  assert.equal(sourceLabel.length, 14);
  assert.equal(sourceLabel.indexOf("\n"), 9);
  const response = await createAvaCalendarHandler({
    strictSourceIdentity: true,
    readSession: async () => ({ session: { user: "Synthetic Admin", role: "admin", permissions: ["*"] }, fullAdmin: true }),
    readRows: async () => rows,
    readVersions: async () => rows,
    readAccounts: async () => accounts,
    readSnapshot: (window) => readAvaCalendarSnapshot(window, async () => ({ state: "complete", freshness: "fresh", revision, publishedAt: "2026-10-17T00:00:00Z", sourceWindow: { start: "2026-10-01", end: "2027-01-01" }, invalidTimeEventCount: 0, hasMore: false, nextCursor: null, empty: false, events })),
  })(new Request(`http://127.0.0.1/api/ava-calendar?${new URLSearchParams(dayWindow)}`));
  assert.equal(response.status, 200);
  const result = await fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => response);
  assert.equal(result.events.length, 3);
  for (const [index, event] of result.events.entries()) {
    assert.deepEqual(event.unresolvedSourceStudents, [{ studentName: student.name, owner: null }]);
    assert.deepEqual(event.students, []);
    assert.equal(event.identityPending, true);
    assert.equal(event.trial, false);
    assert.deepEqual([event.eventId, event.startsAt, event.endsAt], [events[index]!.eventId, events[index]!.startsAt, events[index]!.endsAt]);
  }
});

const linebreak = nameLinebreakFixture();
function projectLinebreak(session = { user: "Synthetic Admin", role: "admin" as const, permissions: ["*"] }, students?: unknown[], participants = linebreak.events[0]!.sourceParticipants) {
  const rows = linebreak.rows.map((row) => row.entity === "students" && students ? { ...row, payload: students } : row);
  const access = buildOpsAccessContext(rows, session.user, true, session);
  const events = [{ ...linebreak.events[0]!, sourceParticipants: participants }];
  return projectAvaCalendarEvents({ rows, events, sourceEvents: events, access, accounts: linebreak.accounts, revision: linebreak.revision, strictSourceIdentity: true }).events[0]!;
}

for (const separator of ["\r", "\n", "\r\n", "\n\r", "\r\n\n\r"]) {
  test(`display normalization replaces ${JSON.stringify(separator)} with a space without joining name parts`, () => {
    assert.equal(avaCalendarSourceStudentName(`SynthName${separator}测试学生`), "SynthName 测试学生");
  });
}

test("mixed multiline names normalize every CR/LF run while preserving other ordinary spaces", () => {
  assert.equal(avaCalendarSourceStudentName("\r\nSynth\rName\n合成\r\n学生\n\r"), "Synth Name 合成 学生");
  assert.equal(avaCalendarSourceStudentName("  Synth  Name  "), "Synth  Name");
  assert.equal(avaCalendarSourceStudentName("\r\n \n\r"), null);
});

test("decorated shared aliases stay hidden across token splits, repeated CRLF and ordinary spaces", () => {
  const alias = "试听学员A(Tara龙) 2026";
  for (let split = 0; split <= alias.length; split++) {
    for (const separator of [" ", "  ", "\r", "\n", "\r\n", "\r\n\r\n", "\n\r\n\r"]) {
      const value = `${alias.slice(0, split)}${separator}${alias.slice(split)}`;
      assert.equal(avaCalendarSourceStudentName(value), null, JSON.stringify(value));
    }
  }
  assert.equal(avaCalendarSourceStudentName([...alias].join("\r\n\r\n")), null);
  assert.equal(avaCalendarSourceStudentName([...alias].join(" ")), null);
});

test("Unicode separators with CRLF cannot turn a decorated shared alias into a display name", () => {
  const separators = [0x20, 0xa0, 0x1680, ...Array.from({ length: 11 }, (_, index) => 0x2000 + index), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000].map((code) => String.fromCodePoint(code));
  for (const alias of ["试听学员A(Tara龙) 2026", "试听学员Ａ（Ｔａｒａ龙） ２０２６"]) {
    for (const separator of separators) {
      for (let split = 1; split < alias.length; split++) {
        const raw = `${alias.slice(0, split)}${separator}\r\n${alias.slice(split)}`;
        assert.equal(avaCalendarSourceStudentName(raw), null, JSON.stringify(raw));
        assert.equal(avaCalendarSourceStudentName(`${raw}陈`), `${raw.replace(/[\r\n]+/g, " ")}陈`);
      }
      const multiple = [...alias].join(`${separator}\r\n${separator}`);
      assert.equal(avaCalendarSourceStudentName(multiple), null, JSON.stringify(multiple));
    }
  }
});

test("nearby real names retain their exact display spacing rather than broad alias-like filtering", () => {
  for (const value of ["试听\r\n学员B(Tara龙) 2026", "试听 学员A(Tara龙) 2025", "试听\n学员A(Tara王) 2026", "试听 学员A(Tara龙) 2026陈", "陈试听\r\n学员A(Tara龙) 2026", "Tara\r\n龙", "试听\r\n学员Alice", "Tara  龙"]) {
    assert.equal(avaCalendarSourceStudentName(value), value.replace(/[\r\n]+/g, " "));
  }
});

test("the 240-character limit applies before linebreak runs can shrink the raw name", () => {
  for (const length of [239, 240]) {
    const raw = `${"x".repeat(length - 2)}\nY`;
    assert.equal(raw.length, length);
    assert.equal(avaCalendarSourceStudentName(raw), raw.replace("\n", " "));
  }
  const boundary = `A${"\r\n".repeat(119)}B`;
  assert.equal(boundary.length, 240);
  assert.equal(avaCalendarSourceStudentName(boundary), "A B");
  assert.equal(avaCalendarSourceStudentName(`${boundary}C`), null);
  assert.equal(avaCalendarSourceStudentName("x".repeat(241)), null);
});

test("CR/LF normalization never permits other Cc/Cf controls even at trimmed boundaries", () => {
  const cc = Array.from({ length: 160 }, (_, code) => code).filter((code) => code !== 10 && code !== 13 && (code < 32 || code >= 127));
  const cf = [0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff];
  for (const code of [...cc, ...cf]) {
    const control = String.fromCodePoint(code);
    for (const name of [`${control}Synth\nName`, `Synth\r${control}\nName`, `Synth\nName${control}`]) assert.equal(avaCalendarSourceStudentName(name), null, `U+${code.toString(16)}`);
  }
});

test("normalization retains HTML, type, empty and shared-trial-alias rejection", () => {
  for (const value of [null, undefined, 1, {}, [], "", "\n\r", "<img\nsrc=x>", "Synth\n>Name", "试听\n学员A", "试听学员A\r\n", "trial\r\naccount C", "\r试听学员A(Tara龙)\n2026"]) assert.equal(avaCalendarSourceStudentName(value), null);
});

test("the route and decoder hide decorated alias variants but preserve neighboring display-only names", async () => {
  const cases = [
    ["试\r\n听学员A(Tara龙) 2026", null],
    ["试听 学 员 A( T a r a 龙 ) 2 0 2 6", null],
    ["试听学员A(Ta\r\n\r\nra龙) 2026", null],
    ["试听学员A(Tara龙) 20\n26", null],
    ["试听\r\n学员B(Tara龙) 2026", "试听 学员B(Tara龙) 2026"],
    ["试听学员A(Tara龙)\r\n2025", "试听学员A(Tara龙) 2025"],
    ["Tara  \r\n龙", "Tara   龙"],
  ];
  for (const [label, studentName] of cases) {
    const state = fixture();
    state.rows = linebreak.rows;
    state.page = { ...state.page, revision: linebreak.revision, events: [{ ...linebreak.events[0]!, sourceParticipants: [{ memberId: "never-bound-member", label: label! }] }] };
    const response = await serverFixture(state, () => {}, true).get("human", dayWindow);
    assert.equal(response.status, 200);
    const live = await fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => response);
    const event = live.events[0]!;
    assert.deepEqual(event.students, []);
    assert.equal(event.identityPending, true);
    assert.deepEqual(event.unresolvedSourceStudents, studentName ? [{ studentName, owner: null }] : undefined);
  }
});

test("an unambiguous LF source still resolves to its exact Native ID and existing owner", () => {
  const result = projectLinebreak(undefined, [linebreak.student]);
  assert.deepEqual(result.students, [{ studentId: linebreak.student.id, studentName: linebreak.student.name, owner: "Tiffany", ownerId: "staff-tiffany", color: "owner-1" }]);
  assert.equal(result.unresolvedSourceStudents, undefined);
  assert.equal(result.identityPending, false);
});

test("linebreak source display cannot widen a teacher-scoped administrator's permission", () => {
  const session = { user: "Synthetic Admin", role: "admin" as const, permissions: ["*"], scopeMembers: [{ kind: "teacher" as const, key: linebreak.teacher.id }] };
  const result = projectLinebreak(session);
  assert.deepEqual(result?.students ?? [], []);
  assert.equal(result?.unresolvedSourceStudents, undefined);
  assert.doesNotMatch(JSON.stringify(result ?? null), /SynthName|测试学生/);
  if (result) assert.equal(result.identityPending, true);
});

test("unknown-member LF names remain display-only under strict identity", () => {
  const result = projectLinebreak(undefined, [linebreak.student], [{ memberId: "never-bound-member", label: linebreak.sourceLabel }]);
  assert.deepEqual(result.students, []);
  assert.deepEqual(result.unresolvedSourceStudents, [{ studentName: linebreak.student.name, owner: null }]);
  assert.equal(result.identityPending, true);
});

test("the wire decoder rejects noncanonical CR/LF DTOs rather than silently normalizing them", async () => {
  const state = fixture();
  state.rows = linebreak.rows;
  state.page = { ...state.page, revision: linebreak.revision, events: linebreak.events };
  const response = await serverFixture(state, () => {}, true).get("human", dayWindow);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.events[0].unresolvedSourceStudents, [{ studentName: linebreak.student.name, owner: null }]);
  for (const separator of ["\r", "\n", "\r\n"]) {
    const body = structuredClone(data);
    body.events[0].unresolvedSourceStudents[0].studentName = `SynthName${separator}测试学生`;
    await assert.rejects(() => fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => Response.json(body)), /课表暂时无法读取/);
  }
});
