import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?tsx?$/u.test(entry.name) ? [path] : [];
  });
}

function isSetIntervalReference(node: ts.Node) {
  if (ts.isIdentifier(node)) return node.text === "setInterval";
  return ts.isStringLiteral(node) && node.text === "setInterval"
    && ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node;
}

function setIntervalFailures(file: string, contents: string) {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const failures: string[] = [];
  const visit = (node: ts.Node) => {
    if (isSetIntervalReference(node)) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      failures.push(`${file}:${position.line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return failures;
}

test("polling guard rejects raw interval scheduling regardless of callback syntax", () => {
  const source = [
    "async function declared() {}",
    "setInterval(async () => {}, 1);",
    "window.setInterval(async function () {}, 1);",
    "setInterval(() => declared(), 1);",
    'window["setInterval"](() => { void declared(); }, 1);',
    "const schedule = globalThis.setInterval;",
    "schedule(() => {}, 1);",
    "setTimeout(() => {}, 1);",
  ].join("\n");

  assert.deepEqual(setIntervalFailures("fixture.ts", source), [
    "fixture.ts:2",
    "fixture.ts:3",
    "fixture.ts:4",
    "fixture.ts:5",
    "fixture.ts:6",
  ]);
});

test("application polling uses self-scheduling timeouts or the shared poller", () => {
  const failures = [...sourceFiles("app"), ...sourceFiles("lib")].flatMap((file) =>
    setIntervalFailures(relative(process.cwd(), file), readFileSync(file, "utf8"))
  );

  assert.deepEqual(failures, [], `setInterval polling can overlap; use a self-scheduling timeout or createSharedStatePoller instead:\n${failures.join("\n")}`);
});
