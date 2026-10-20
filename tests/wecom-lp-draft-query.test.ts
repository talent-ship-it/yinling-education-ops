import assert from "node:assert/strict";
import test from "node:test";
import { parseWecomLpDraftQuery } from "../lib/wecom-lp-draft-query";
import { LpAtomicError } from "../lib/lp-atomic-service";

const query = (value: string) => parseWecomLpDraftQuery(new URLSearchParams(value));

test("handover date ranges include the whole selected local day", () => {
  assert.deepEqual(query("from=2026-10-20&to=2026-10-20&timezone=Asia/Shanghai&cursor=handover-31"), {
    cursor: "handover-31", from: "2026-10-19T16:00:00.000Z", before: "2026-10-20T16:00:00.000Z",
  });
  assert.deepEqual(query(""), { cursor: null, from: null, before: null });
  assert.deepEqual(query("from=2026-10-20"), { cursor: null, from: "2026-10-19T13:00:00.000Z", before: null });
  assert.deepEqual(query("to=2026-10-20"), { cursor: null, from: null, before: "2026-10-20T13:00:00.000Z" });
});

test("handover calendar bounds handle 23 and 25 hour days and half-hour offsets", () => {
  for (const [date, timezone, from, before, hours] of [
    ["2026-10-04", "Australia/Melbourne", "2026-10-03T14:00:00.000Z", "2026-10-04T13:00:00.000Z", 23],
    ["2026-04-05", "Australia/Melbourne", "2026-04-04T13:00:00.000Z", "2026-04-05T14:00:00.000Z", 25],
    ["2026-10-04", "Australia/Adelaide", "2026-10-03T14:30:00.000Z", "2026-10-04T13:30:00.000Z", 23],
    ["2007-12-30", "America/Argentina/Buenos_Aires", "2007-12-30T03:00:00.000Z", "2007-12-31T02:00:00.000Z", 23],
  ] as const) {
    const range = query(`from=${date}&to=${date}&timezone=${timezone}`);
    assert.equal(range.from, from); assert.equal(range.before, before);
    assert.equal((Date.parse(range.before!) - Date.parse(range.from!)) / 3_600_000, hours);
  }
});

test("invalid or ambiguous handover query values cannot broaden the range or scope", () => {
  for (const value of [
    "from=2026-10-21&to=2026-10-20", "from=2026-02-29", "to=2026-02-30", "from=2026-1-01",
    "from=2026-10-20T00:00:00Z", "from=%202026-10-20", "from=0000-01-01", "from=1899-12-31", "to=9999-12-31",
    "timezone=Invalid/Zone", "timezone=", "timezone=UTC", "cursor=bad%20cursor",
    "from=2026-10-20&from=2026-10-20", "to=&to=2026-10-20", "timezone=Asia/Shanghai&timezone=Asia/Shanghai",
    "cursor=one&cursor=two", "actor=Other", "fullAdmin=true",
  ]) assert.throws(() => query(value), LpAtomicError, value);
  assert.equal(query("from=2028-02-29&to=2028-02-29").from, "2028-02-28T13:00:00.000Z");
});
