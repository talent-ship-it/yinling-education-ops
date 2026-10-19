import test from "node:test";
import assert from "node:assert/strict";
import { NativeTimerController, changeTimerDigit, secondsFromDigits, timerDigits, type NativeTimerState, type TimerAction, type TimerVariables } from "../src/timer";
const initial: NativeTimerState = { active: false, running: false, stopwatch: true, time: 300000, accumulated: 0, elapsed: false, timePassed: 300000 };

test("waits for each native shared-state confirmation including BBB activation's stopwatch default", () => {
  const commands: { action: TimerAction; variables: TimerVariables }[] = [];
  const progress: unknown[] = [];
  const controller = new NativeTimerController((action, variables) => commands.push({ action, variables }), (value) => progress.push(value));
  controller.observe(initial);
  controller.startCountdown(300);
  assert.deepEqual(commands.map((command) => command.action), ["activate"]);
  assert.equal(controller.busy, true);
  controller.observe(initial);
  assert.equal(commands.length, 1);
  controller.observe({ ...initial, active: true });
  assert.deepEqual(commands.map((command) => command.action), ["activate", "mode"]);
  controller.observe({ ...initial, active: true, stopwatch: false });
  assert.deepEqual(commands.map((command) => command.action), ["activate", "mode", "start"]);
  assert.equal(controller.busy, true);
  controller.observe({ ...initial, active: true, stopwatch: false, running: true });
  assert.equal(controller.busy, false);
  assert.deepEqual(progress.at(-1), { busy: false, error: "" });
  controller.dispose();
});

test("reconfigures a running native timer in milliseconds and resets only after server confirmation", () => {
  const commands: string[] = [];
  const controller = new NativeTimerController((action) => commands.push(action), () => {});
  let state = { ...initial, active: true, stopwatch: false, running: true, accumulated: 10000 };
  controller.observe(state); controller.startCountdown(90);
  assert.deepEqual(commands, ["stop"]);
  state = { ...state, running: false }; controller.observe(state);
  assert.deepEqual(commands, ["stop", "time"]);
  state = { ...state, time: 90000 }; controller.observe(state);
  assert.deepEqual(commands, ["stop", "time", "reset"]);
  state = { ...state, accumulated: 0 }; controller.observe(state);
  assert.deepEqual(commands, ["stop", "time", "reset", "start"]);
  assert.equal(controller.busy, true);
  controller.observe({ ...state, running: true });
  assert.equal(controller.busy, false);
  controller.dispose();
});

test("does not claim success for unavailable, rejected or unconfirmed operations", async () => {
  let message = "";
  const controller = new NativeTimerController(() => {}, ({ error }) => { message = error; }, 5);
  assert.throws(() => controller.startCountdown(300), /读取/);
  controller.observe(initial); controller.startCountdown(300);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.match(message, /未确认/); assert.equal(controller.busy, false);
  controller.startCountdown(300); controller.fail("权限不足");
  assert.equal(message, "权限不足"); assert.equal(controller.busy, false);
  controller.dispose();
});

test("reads paused/rejoined native state instead of creating a local countdown", () => {
  const commands: string[] = [];
  const controller = new NativeTimerController((action) => commands.push(action), () => {});
  controller.observe({ ...initial, active: true, stopwatch: false, accumulated: 12000, timePassed: 288000 });
  controller.resume(); assert.deepEqual(commands, ["start"]);
  controller.observe({ ...initial, active: true, stopwatch: false, running: true, accumulated: 12000 });
  controller.pause(); assert.deepEqual(commands, ["start", "stop"]);
  controller.observe({ ...initial, active: true, stopwatch: false, accumulated: 13000 });
  assert.equal(controller.busy, false); controller.dispose();
});

test("four-digit inputs retain valid seconds and bound unsupported durations", () => {
  assert.equal(changeTimerDigit("0559", 2, 1), "0509");
  assert.equal(changeTimerDigit("0000", 2, -1), "0050");
  assert.equal(secondsFromDigits("0500"), 300);
  assert.equal(secondsFromDigits("0060"), 0);
  assert.equal(timerDigits(299001), "0500");
  assert.equal(timerDigits(-1), "0000");
  assert.equal(timerDigits(9999999999), "9959");
  const controller = new NativeTimerController(() => {}, () => {});
  assert.throws(() => controller.startCountdown(0));
  assert.throws(() => controller.startCountdown(6000));
  controller.dispose();
});

test("sender replacement, reset and deactivation wait for their own native acknowledgements", () => {
  const oldRoute: string[] = [];
  const route: string[] = [];
  const controller = new NativeTimerController((action) => oldRoute.push(action), () => {});
  let state = { ...initial, active: true, running: true, stopwatch: false, accumulated: 12000, timePassed: 288000 };
  controller.observe(state);
  controller.setSender((action) => route.push(action));
  controller.reset();
  assert.deepEqual(oldRoute, []);
  assert.deepEqual(route, ["stop"]);
  controller.observe(state);
  assert.deepEqual(route, ["stop"]);
  state = { ...state, running: false };
  controller.observe(state);
  assert.deepEqual(route, ["stop", "reset"]);
  assert.equal(controller.busy, true);
  state = { ...state, accumulated: 0, timePassed: state.time };
  controller.observe(state);
  assert.equal(controller.busy, false);
  controller.deactivate();
  assert.deepEqual(route, ["stop", "reset", "deactivate"]);
  controller.observe(state);
  assert.equal(controller.busy, true);
  controller.observe({ ...state, active: false });
  assert.equal(controller.busy, false);
  controller.dispose();
});

for (const seconds of [3, 20]) {
  test(`restarts an expired countdown at ${seconds}s when BBB keeps elapsed latched until start`, (context) => {
    const commands: { action: TimerAction; variables: TimerVariables }[] = [];
    const progress: unknown[] = [];
    const controller = new NativeTimerController((action, variables) => commands.push({ action, variables }), (value) => progress.push(value));
    context.after(() => controller.dispose());
    let state = { ...initial, active: true, stopwatch: false, time: 3000, timePassed: 3000, elapsed: true };
    controller.observe(state);
    controller.startCountdown(seconds);
    if (seconds !== 3) {
      assert.deepEqual(commands, [{ action: "time", variables: { time: seconds * 1000 } }]);
      state = { ...state, time: seconds * 1000, timePassed: seconds * 1000 };
      controller.observe(state);
    }
    assert.equal(commands.at(-1)?.action, "start");
    assert.equal(commands.some(({ action }) => action === "reset"), false);
    assert.equal(controller.busy, true);
    controller.observe({ ...state, running: true });
    assert.equal(controller.busy, true);
    controller.observe({ ...state, running: true, elapsed: false });
    assert.equal(controller.busy, false);
    assert.deepEqual(progress.at(-1), { busy: false, error: "" });
  });
}

test("an expired restart still fails when BBB never confirms a running non-expired timer", async () => {
  const commands: TimerAction[] = [];
  let message = "";
  const controller = new NativeTimerController((action) => commands.push(action), ({ error }) => { message = error; }, 5);
  const state = { ...initial, active: true, stopwatch: false, elapsed: true };
  controller.observe(state);
  controller.startCountdown(300);
  assert.deepEqual(commands, ["start"]);
  controller.observe({ ...state, running: true });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.match(message, /未确认/);
  assert.equal(controller.busy, false);
  controller.dispose();
});
