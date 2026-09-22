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

function hasAsyncModifier(node: ts.Node) {
  return ts.canHaveModifiers(node)
    && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
}

test("application polling never schedules an async callback with setInterval", () => {
  const failures: string[] = [];
  for (const file of [...sourceFiles("app"), ...sourceFiles("lib")]) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const asyncFunctions = new Set<string>();
    const collectAsyncFunctions = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name && hasAsyncModifier(node)) asyncFunctions.add(node.name.text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        && hasAsyncModifier(node.initializer)) {
        asyncFunctions.add(node.name.text);
      }
      ts.forEachChild(node, collectAsyncFunctions);
    };
    collectAsyncFunctions(source);

    const inspectIntervals = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const isSetInterval = ts.isIdentifier(node.expression)
          ? node.expression.text === "setInterval"
          : ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "setInterval";
        const callback = node.arguments[0];
        const isAsyncCallback = callback && (
          ((ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && hasAsyncModifier(callback))
          || (ts.isIdentifier(callback) && asyncFunctions.has(callback.text))
        );
        if (isSetInterval && isAsyncCallback) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          failures.push(`${relative(process.cwd(), file)}:${position.line + 1}`);
        }
      }
      ts.forEachChild(node, inspectIntervals);
    };
    inspectIntervals(source);
  }

  assert.deepEqual(failures, [], `async setInterval polling can overlap; use createSharedStatePoller instead:\n${failures.join("\n")}`);
});
