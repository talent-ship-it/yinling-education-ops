import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));

function runtimeImports(entry) {
  const { outputText } = ts.transpileModule(readFileSync(entry, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.Preserve },
  });
  const ast = ts.createSourceFile(entry, outputText, ts.ScriptTarget.Latest, true);
  return ast.statements
    .filter((statement) => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
    .map((statement) => statement.moduleSpecifier?.text)
    .filter((specifier) => typeof specifier === "string" && /^(?:\.|@\/)/.test(specifier));
}

function resolveLocalImport(entry, specifier) {
  const base = specifier.startsWith("@/") ? path.join(root, specifier.slice(2)) : path.resolve(path.dirname(entry), specifier);
  const resolved = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`].find((file) => existsSync(file));
  assert.ok(resolved, `Unresolved local runtime import: ${specifier}`);
  return resolved;
}

function runtimeDependencies(entry, files = new Set()) {
  if (files.has(entry)) return files;
  files.add(entry);
  if (!/\.(?:tsx?|mjs)$/.test(entry)) return files;
  for (const specifier of runtimeImports(entry)) {
    runtimeDependencies(resolveLocalImport(entry, specifier), files);
  }
  return files;
}

for (const entry of ["lib/ava-calendar-live-client.ts", "app/ava-calendar/live/calendar-client.tsx"]) {
  test(`${entry} keeps LP workflow validation outside its existing lazy boundary`, () => {
    const dependencies = runtimeDependencies(path.join(root, entry));
    for (const file of ["lib/lp-workflows.ts", "lib/trial-operations.ts"]) {
      assert.ok(!dependencies.has(path.join(root, file)), `Calendar decoder reaches eager workflow module: ${file}`);
    }
  });
}
