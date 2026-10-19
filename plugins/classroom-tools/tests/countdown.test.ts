import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { CountdownPanel } from "../src/CountdownPanel";
import { NativeTimerController, type TimerAction, type TimerVariables } from "../src/timer";
import type { Countdown } from "../src/useCountdown";

Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: null } });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: () => 1 });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });

type SharedTimerState = NonNullable<Countdown["native"]>;
const elapsed: SharedTimerState = { songTrack: "", startedAt: null, active: true, stopwatch: false, running: false, elapsed: true, time: 3000, timePassed: 3000, accumulated: 0 };

function countdownFor(native: SharedTimerState, moderator: boolean, send: (action: TimerAction, variables: TimerVariables) => void = () => {}) {
  const controller = new NativeTimerController(send, () => {});
  controller.observe(native);
  const countdown: Countdown = { native, loading: false, ready: true, canControl: moderator, progress: { busy: false, error: "" }, controller, run: (operation) => operation() };
  return countdown;
}

function renderPanel(countdown: Countdown, moderator: boolean) {
  return React.createElement(CountdownPanel, { countdown, moderator, visible: true, close: () => {} });
}

function teacherDigits(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType("output").map((output) => output.children.join("")).join("");
}

for (const moderator of [false, true]) {
  test(`${moderator ? "teacher" : "student"} displays zero when the expired native timer returns its configured duration`, async () => {
    const countdown = countdownFor({ ...elapsed, running: true, elapsed: false, timePassed: 1000 }, moderator);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(renderPanel(countdown, moderator)); });
    try {
      const displayed = () => moderator ? teacherDigits(renderer) : renderer.root.findByProps({ className: "ilct-readonly" }).children.join("");
      assert.equal(displayed(), moderator ? "0001" : "00:01");
      await act(async () => { renderer.update(renderPanel({ ...countdown, native: elapsed }, moderator)); });
      assert.equal(displayed(), moderator ? "0000" : "00:00");
      assert.equal(renderer.root.findByProps({ role: "status" }).children.join(""), "时间到");
    } finally {
      await act(async () => { renderer.unmount(); });
      countdown.controller.dispose();
    }
  });
}

test("teacher can edit and start the next duration after expiry and sees the reset duration", async () => {
  const commands: { action: TimerAction; variables: TimerVariables }[] = [];
  const countdown = countdownFor(elapsed, true, (action, variables) => commands.push({ action, variables }));
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(renderPanel(countdown, true)); });
  try {
    assert.equal(teacherDigits(renderer), "0000");
    const increaseSeconds = () => renderer.root.findByProps({ "aria-label": "增加秒个位" });
    assert.equal(increaseSeconds().props.disabled, false);
    await act(async () => { increaseSeconds().props.onClick(); });
    assert.equal(teacherDigits(renderer), "0001");
    await act(async () => { increaseSeconds().props.onClick(); });
    assert.equal(teacherDigits(renderer), "0002");
    await act(async () => { renderer.root.findByProps({ className: "ilct-primary" }).props.onClick(); });
    assert.deepEqual(commands, [{ action: "time", variables: { time: 2000 } }]);
    const reset = { ...elapsed, time: 2000, timePassed: 2000, elapsed: false };
    await act(async () => { renderer.update(renderPanel({ ...countdown, native: reset }, true)); });
    assert.equal(teacherDigits(renderer), "0002");
  } finally {
    await act(async () => { renderer.unmount(); });
    countdown.controller.dispose();
  }
});

test("teacher restarts an expired countdown using its existing configured duration", async () => {
  const commands: TimerAction[] = [];
  const countdown = countdownFor(elapsed, true, (action) => commands.push(action));
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(renderPanel(countdown, true)); });
  try {
    await act(async () => { renderer.root.findByProps({ className: "ilct-primary" }).props.onClick(); });
    assert.deepEqual(commands, ["reset"]);
    countdown.controller.observe({ ...elapsed, elapsed: false });
    assert.deepEqual(commands, ["reset", "start"]);
  } finally {
    await act(async () => { renderer.unmount(); });
    countdown.controller.dispose();
  }
});
