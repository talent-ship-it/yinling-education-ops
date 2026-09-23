import assert from "node:assert/strict";
import test from "node:test";

import { acceptsJiaowubaoTrialSourcePage } from "../lib/jiaowubao-trial-source-contract";

const revision = `sha256:${"a".repeat(64)}`;
const sourceWindow = { start: "2026-09-23", end: "2026-12-24" };
const coveredWindow = {
  startsAt: "2026-09-22T14:00:00.000Z",
  endsAt: "2026-10-23T13:00:00.000Z",
};

test("fresh pinned source pages remain accepted", () => {
  assert.equal(acceptsJiaowubaoTrialSourcePage({
    state: "complete",
    freshness: "fresh",
    revision,
    sourceWindow,
  }, revision, coveredWindow, null), true);
});

test("stale recovery requires the exact revision, source horizon, and covered Melbourne interval", () => {
  const stalePage = { state: "stale", freshness: "stale", revision, sourceWindow };
  assert.equal(acceptsJiaowubaoTrialSourcePage(
    stalePage,
    revision,
    coveredWindow,
    sourceWindow,
  ), true);
  assert.equal(acceptsJiaowubaoTrialSourcePage(stalePage, revision, coveredWindow, null), false);
  assert.equal(acceptsJiaowubaoTrialSourcePage(
    stalePage,
    revision,
    { startsAt: "2026-12-24T13:00:00.000Z", endsAt: "2027-01-24T13:00:00.000Z" },
    sourceWindow,
  ), false);
  assert.equal(acceptsJiaowubaoTrialSourcePage(
    { ...stalePage, revision: `sha256:${"b".repeat(64)}` },
    revision,
    coveredWindow,
    sourceWindow,
  ), false);
});
