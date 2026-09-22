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

function declaredFunction(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name && node.body) {
    return { name: node.name.text, implementation: node };
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && node.initializer && isInlineFunction(node.initializer)) {
    return { name: node.name.text, implementation: node.initializer };
  }
  return null;
}

function callsPromiseReturningFunction(node: ts.Node, functionNames: ReadonlySet<string>) {
  let found = false;
  const visit = (candidate: ts.Node) => {
    if (found) return;
    if (candidate !== node && ts.isFunctionLike(candidate)) return;
    if (ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression)
      && functionNames.has(candidate.expression.text)) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function collectPromiseReturningFunctionNames(source: ts.SourceFile) {
  const implementations = new Map<string, ts.FunctionLikeDeclaration>();
  const visit = (node: ts.Node) => {
    const declared = declaredFunction(node);
    if (declared) implementations.set(declared.name, declared.implementation);
    ts.forEachChild(node, visit);
  };
  visit(source);

  const names = new Set([...implementations]
    .filter(([, implementation]) => hasAsyncModifier(implementation))
    .map(([name]) => name));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, implementation] of implementations) {
      if (!names.has(name) && callsPromiseReturningFunction(implementation, names)) {
        names.add(name);
        changed = true;
      }
    }
  }
  return names;
}

function isSetIntervalExpression(node: ts.Expression) {
  if (ts.isIdentifier(node)) return node.text === "setInterval";
  return ts.isPropertyAccessExpression(node) && node.name.text === "setInterval";
}

function isAsyncCallback(node: ts.Expression, promiseReturningFunctions: ReadonlySet<string>) {
  if (ts.isIdentifier(node)) return promiseReturningFunctions.has(node.text);
  return isInlineFunction(node)
    && (hasAsyncModifier(node) || callsPromiseReturningFunction(node, promiseReturningFunctions));
}

function isAsyncSetIntervalCall(node: ts.Node, promiseReturningFunctions: ReadonlySet<string>) {
  if (!ts.isCallExpression(node) || !isSetIntervalExpression(node.expression)) return false;
  const callback = node.arguments[0];
  return callback !== undefined && isAsyncCallback(callback, promiseReturningFunctions);
}

function asyncSetIntervalFailures(file: string, contents: string) {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const promiseReturningFunctions = collectPromiseReturningFunctionNames(source);
  const failures: string[] = [];
  const visit = (node: ts.Node) => {
    if (isAsyncSetIntervalCall(node, promiseReturningFunctions)) {
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
    "setInterval(() => declared(), 1);",
    "setInterval(() => { void assigned(); }, 1);",
    "function wrapped() { return declared(); }",
    "setInterval(wrapped, 1);",
    "setInterval(() => {}, 1);",
  ].join("\n");

  assert.deepEqual(asyncSetIntervalFailures("fixture.ts", source), [
    "fixture.ts:3",
    "fixture.ts:4",
    "fixture.ts:5",
    "fixture.ts:6",
    "fixture.ts:7",
    "fixture.ts:8",
    "fixture.ts:10",
  ]);
});

test("application polling never schedules an async callback with setInterval", () => {
  const failures = [...sourceFiles("app"), ...sourceFiles("lib")].flatMap((file) =>
    asyncSetIntervalFailures(relative(process.cwd(), file), readFileSync(file, "utf8"))
  );

  assert.deepEqual(failures, [], `async setInterval polling can overlap; use createSharedStatePoller instead:\n${failures.join("\n")}`);
});
