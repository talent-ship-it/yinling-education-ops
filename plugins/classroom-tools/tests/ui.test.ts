import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginApi } from "bigbluebutton-html-plugin-sdk";
Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: Object.assign(new EventTarget(), { currentScript: null, hidden: false, fullscreenElement: null }) });
const { ClassroomTools, default: Plugin } = await import("../src/Plugin");
function classroomApi(role: "MODERATOR" | "VIEWER", supported = true) {
  return {
    useCurrentUser: () => ({ data: { role, presenter: role === "MODERATOR" }, loading: false }),
    useTimer: () => ({ data: { active: true, running: false, stopwatch: false, time: 300000, accumulated: 1000, elapsed: false, timePassed: 299000 }, loading: false }),
    useShouldUnmountPlugin: () => false,
    useCustomMutation: supported ? () => [() => {}, { loading: false }] : undefined,
  } as unknown as PluginApi;
}
test("students see the shared remaining time without teacher controls", () => {
  const html = renderToStaticMarkup(React.createElement(ClassroomTools, { api: classroomApi("VIEWER") }));
  assert.match(html, /04:59/);
  assert.match(html, /由老师控制/);
  assert.doesNotMatch(html, /增加分钟|>继续<|关闭计时器/);
});
test("moderators receive four-digit arrow controls for the existing shared timer", () => {
  const html = renderToStaticMarkup(React.createElement(ClassroomTools, { api: classroomApi("MODERATOR") }));
  assert.equal((html.match(/class="ilct-arrow"/g) ?? []).length, 8);
  assert.match(html, />继续</);
  assert.match(html, /关闭计时器/);
});
test("unsupported native mutation capability disables classroom timer controls", () => {
  const html = renderToStaticMarkup(React.createElement(ClassroomTools, { api: classroomApi("MODERATOR", false) }));
  assert.match(html, /当前课堂不支持同步倒计时/);
  assert.match(html, /class="ilct-primary" disabled=""/);
});
test("initializes the pinned SDK inside the plugin's React render context", () => {
  const windowState = { bbb_plugins: { test: { pluginName: "InsiderClassroomTools" } } };
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: windowState });
  try {
    assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(Plugin, { uuid: "test" })));
    assert.equal(typeof (windowState.bbb_plugins.test as unknown as PluginApi).useTimer, "function");
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: originalWindow });
  }
});
