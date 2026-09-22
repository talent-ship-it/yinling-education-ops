import assert from "node:assert/strict";
import test from "node:test";
import { reconcileClassroomEnd, type ClassroomClosingRecord } from "../lib/classroom-end-recovery.ts";

const closing: ClassroomClosingRecord = { occurrence_id: "B1:2026-09-22", meeting_id: "synthetic", status: "closing" };

test("an already stopped provider is finalized without requiring another external end", async () => {
  let finalized = 0;
  const result = await reconcileClassroomEnd(closing, {
    status: async () => ({ running: false }), end: async () => { throw new Error("should not end twice"); },
    finish: async (_, stopped) => { assert.equal(stopped, true); finalized++; return { ...closing, status: "ended" }; },
  });
  assert.equal(result.status, "ended");
  assert.equal(finalized, 1);
});

test("a provider end acknowledgement is not mistaken for confirmed stopped state", async () => {
  let endCalls = 0;
  const result = await reconcileClassroomEnd(closing, {
    status: async () => ({ running: true }), end: async () => { endCalls++; },
    finish: async (_, stopped) => { assert.equal(stopped, false); return closing; },
  });
  assert.equal(endCalls, 1);
  assert.equal(result.status, "closing");
});

test("a lost provider response leaves durable pending work that a later cron pass recovers", async () => {
  let running = true;
  let endCalls = 0;
  const dependencies = {
    status: async () => ({ running }),
    end: async () => { running = false; endCalls++; throw new Error("response lost after end"); },
    finish: async (_: string, stopped: boolean): Promise<ClassroomClosingRecord> => ({ ...closing, status: stopped ? "ended" : "closing" }),
  };
  assert.equal((await reconcileClassroomEnd(closing, dependencies)).status, "closing");
  assert.equal((await reconcileClassroomEnd(closing, dependencies)).status, "ended");
  assert.equal(endCalls, 1);
});

test("database finalization failure leaves a saved intent that can recover a stopped provider", async () => {
  let running = true;
  let databaseAvailable = false;
  const dependencies = {
    status: async () => ({ running }), end: async () => { running = false; },
    finish: async (_: string, stopped: boolean): Promise<ClassroomClosingRecord> => {
      if (!databaseAvailable) throw new Error("database unavailable");
      assert.equal(stopped, true);
      return { ...closing, status: "ended" };
    },
  };
  await assert.rejects(reconcileClassroomEnd(closing, dependencies), /database unavailable/);
  databaseAvailable = true;
  assert.equal((await reconcileClassroomEnd(closing, dependencies)).status, "ended");
});

test("a live creation lease can keep closure pending even after the provider is stopped", async () => {
  const result = await reconcileClassroomEnd(closing, {
    status: async () => ({ running: false }), end: async () => {}, finish: async () => closing,
  });
  assert.equal(result.status, "closing");
});
