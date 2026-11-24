import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isCanonicalTaskDueAt } from "../lib/ops-tasks";
import * as poller from "../lib/shared-state-poller";
import * as recovery from "../lib/shared-state-recovery";

function mount(file: string, name: string) {
  let effect: (() => (() => void) | undefined) | undefined;
  let reads = 0;
  let updates = 0;
  const document = Object.assign(new EventTarget(), { hidden: true, visibilityState: "hidden" });
  const window = new EventTarget();
  const exports: Record<string, (active: boolean, operator: string, allOwners: boolean) => unknown> = {};
  const compiled = ts.transpileModule(readFileSync(new URL(`../app/${file}`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(compiled, {
    exports, document, window, AbortController, setTimeout, clearTimeout,
    fetch: async () => { reads += 1; return Response.json({ tasks: [], students: [], schedules: [] }); },
    require: (specifier: string) => {
      if (specifier === "react") return {
        useEffect: (callback: typeof effect) => { effect = callback; },
        useState: (initial: unknown) => [initial, () => { updates += 1; }],
      };
      if (specifier === "@/lib/ops-tasks") return { isCanonicalTaskDueAt };
      if (specifier === "@/lib/shared-state-poller") return poller;
      if (specifier === "@/lib/shared-state-recovery") return recovery;
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  exports[name](true, "Synthetic Operator", false);
  const cleanup = effect!();
  return {
    reads: () => reads, updates: () => updates,
    show: () => { document.hidden = false; document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange")); },
    hide: () => { document.hidden = true; document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange")); },
    focus: () => window.dispatchEvent(new Event("focus")),
    stop: () => cleanup?.(),
  };
}
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
for (const [file, name] of [["use-wecom-handover-tasks.ts", "useWecomHandoverTasks"], ["use-jiaowubao-unclosed-tasks.ts", "useJiaowubaoUnclosedTasks"]]) {
  test(`${name} skips hidden pages and refreshes once when visible`, async () => {
    const hook = mount(file, name);
    try {
      await settled();
      assert.equal(hook.reads(), 0, "a hidden page must not start a task-feed request");
      hook.show();
      hook.focus();
      await settled();
      assert.equal(hook.reads(), 1, "simultaneous focus and visibility events must coalesce");
      assert.equal(hook.updates(), 1);
      hook.hide();
      hook.focus();
      await settled();
      assert.equal(hook.reads(), 1);
      hook.stop();
      hook.show();
      hook.focus();
      await settled();
      assert.equal(hook.reads(), 1, "unmounted feeds must not restart");
    } finally { hook.stop(); }
  });
}

test("workspace version probes use a one-minute success interval", () => {
  const source = readFileSync(new URL("../app/operations-client.tsx", import.meta.url), "utf8");
  const syntax = ts.createSourceFile("client.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(syntax) === "createSharedStatePoller" && node.getText(syntax).includes("/api/app-state?mode=versions")) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  assert.equal(matches.length, 1);
  const options = matches[0].arguments[0] as ts.ObjectLiteralExpression;
  const delay = options.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(syntax) === "successDelayMs") as ts.PropertyAssignment | undefined;
  assert.ok(delay, "the workspace must set its interval explicitly");
  assert.equal(Number(delay.initializer.getText(syntax).replaceAll("_", "")), 60_000);
});
