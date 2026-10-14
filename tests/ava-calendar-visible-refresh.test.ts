import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function refreshHarness() {
  const source = new URL("../lib/ava-calendar-visible-refresh.ts", import.meta.url);
  assert.ok(existsSync(source), "the two calendars need one shared visible-refresh implementation");
  const document = { visibilityState: "visible" };
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const effects: { callback: () => undefined | (() => void); dependencies: unknown[] }[] = [];
  const output = { exports: {} as Record<string, unknown> };
  let sequence = 0;
  const compiled = ts.transpileModule(readFileSync(source, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, { module: output, exports: output.exports, document,
    require(name: string) { assert.equal(name, "react"); return { useEffect: (callback: () => undefined | (() => void), dependencies: unknown[]) => effects.push({ callback, dependencies: Array.from(dependencies) }) }; },
    setTimeout(callback: () => void, delay: number) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  const hook = output.exports.useAvaCalendarVisibleRefresh;
  assert.equal(typeof hook, "function");
  function tick() {
    assert.equal(timers.size, 1);
    const [id, timer] = [...timers][0]!;
    assert.equal(timer.delay, 60000);
    timers.delete(id);
    timer.callback();
  }
  return { hook: hook as (loading: boolean, refresh: () => void) => void, document, timers, effects, tick };
}

test("one calendar refresh effect waits sixty seconds, pauses hidden reads and cancels its next timer", () => {
  const state = refreshHarness();
  let reads = 0;
  const refresh = () => { reads += 1; };
  state.hook(false, refresh);
  assert.deepEqual(state.effects[0]!.dependencies, [false, refresh]);
  const cleanup = state.effects[0]!.callback();
  assert.equal(reads, 0);
  state.tick();
  assert.equal(reads, 1);
  state.document.visibilityState = "hidden";
  state.tick();
  assert.equal(reads, 1);
  state.document.visibilityState = "visible";
  state.tick();
  assert.equal(reads, 2);
  assert.equal(typeof cleanup, "function");
  cleanup!();
  assert.equal(state.timers.size, 0);
});

test("loading and effect replacement never leave a second calendar refresh timer", () => {
  const state = refreshHarness();
  let reads = 0;
  const refresh = () => { reads += 1; };
  state.hook(true, refresh);
  assert.equal(state.effects[0]!.callback(), undefined);
  assert.equal(state.timers.size, 0);
  state.hook(false, refresh);
  const cleanup = state.effects[1]!.callback()!;
  assert.equal(state.timers.size, 1);
  state.tick();
  assert.equal(reads, 1);
  cleanup();
  state.hook(true, refresh);
  assert.equal(state.effects[2]!.callback(), undefined);
  assert.equal(state.timers.size, 0);
  state.hook(false, refresh);
  const lastCleanup = state.effects[3]!.callback()!;
  assert.equal(state.timers.size, 1);
  lastCleanup();
  assert.equal(state.timers.size, 0);
});
