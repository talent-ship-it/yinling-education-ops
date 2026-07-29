import assert from "node:assert/strict";
import test from "node:test";

import { cleanTimezone, DEFAULT_TIMEZONE } from "../lib/timezone";

test("keeps valid imported IANA zones and safely falls back from malformed zones", () => {
  assert.equal(cleanTimezone("Australia/Hobart · UTC+10"), "Australia/Hobart");
  assert.equal(cleanTimezone("Pacific/Auckland"), "Pacific/Auckland");
  assert.equal(cleanTimezone("Not/A-Real-Timezone"), DEFAULT_TIMEZONE);
  assert.equal(cleanTimezone(null), DEFAULT_TIMEZONE);
});
