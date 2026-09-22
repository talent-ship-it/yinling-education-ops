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

function isInlineFunction(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function asyncFunctionDeclarationName(node: ts.FunctionDeclaration) {
  if (!node.name) return null;
  return hasAsyncModifier(node) ? node.name.text : null;
}

function asyncVariableDeclarationName(node: ts.VariableDeclaration) {
  if (!ts.isIdentifier(node.name)) return null;
  const initializer = node.initializer;
  if (!initializer || !isInlineFunction(initializer)) return null;
  return hasAsyncModifier(initializer) ? node.name.text : null;
}

function declaredAsyncFunctionName(node: ts.Node) {
  if (ts.isFunctionDeclaration(node)) return asyncFunctionDeclarationName(node);
  if (ts.isVariableDeclaration(node)) return asyncVariableDeclarationName(node);
  return null;
}

function collectAsyncFunctionNames(source: ts.SourceFile) {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    const name = declaredAsyncFunctionName(node);
    if (name) names.add(name);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function isSetIntervalExpression(node: ts.Expression) {
  if (ts.isIdentifier(node)) return node.text === "setInterval";
  return ts.isPropertyAccessExpression(node) && node.name.text === "setInterval";
}

function isAsyncCallback(node: ts.Expression, asyncFunctions: ReadonlySet<string>) {
  if (ts.isIdentifier(node)) return asyncFunctions.has(node.text);
  return isInlineFunction(node) && hasAsyncModifier(node);
}

function isAsyncSetIntervalCall(node: ts.Node, asyncFunctions: ReadonlySet<string>) {
  if (!ts.isCallExpression(node) || !isSetIntervalExpression(node.expression)) return false;
  const callback = node.arguments[0];
  return callback !== undefined && isAsyncCallback(callback, asyncFunctions);
}

function asyncSetIntervalFailures(file: string, contents: string) {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const asyncFunctions = collectAsyncFunctionNames(source);
  const failures: string[] = [];
  const visit = (node: ts.Node) => {
    if (isAsyncSetIntervalCall(node, asyncFunctions)) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      failures.push(`${file}:${position.line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return failures;
}

test("polling guard recognizes every supported async callback form", () => {
  const source = [
    "async function declared() {}",
    "const assigned = async function () {};",
    "setInterval(async () => {}, 1);",
    "window.setInterval(async function () {}, 1);",
    "setInterval(declared, 1);",
    "window.setInterval(assigned, 1);",
    "setInterval(() => {}, 1);",
  ].join("\n");

  assert.deepEqual(asyncSetIntervalFailures("fixture.ts", source), [
    "fixture.ts:3",
    "fixture.ts:4",
    "fixture.ts:5",
    "fixture.ts:6",
  ]);
});

test("application polling never schedules an async callback with setInterval", () => {
  const failures = [...sourceFiles("app"), ...sourceFiles("lib")].flatMap((file) =>
    asyncSetIntervalFailures(relative(process.cwd(), file), readFileSync(file, "utf8"))
  );

  assert.deepEqual(failures, [], `async setInterval polling can overlap; use createSharedStatePoller instead:\n${failures.join("\n")}`);
});
