import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

export const PUT_OPS_STATE_ROUTE_ALLOWLIST = Object.freeze([
  "app/api/app-state/route.ts",
  "app/api/students/lesson-package/route.ts",
]);

function routeFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...routeFiles(path));
    else if (entry.isFile() && entry.name === "route.ts") files.push(path);
  }
  return files;
}

function importsPutOpsState(file) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return source.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
    const moduleName = statement.moduleSpecifier.text;
    if (!(moduleName === "@/lib/ops-store" || /(?:^|\/)lib\/ops-store(?:\.ts)?$/u.test(moduleName))) return false;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) return false;
    if (ts.isNamespaceImport(bindings)) return true;
    return bindings.elements.some((element) => (element.propertyName ?? element.name).text === "putOpsState");
  });
}

export function directPutOpsStateRouteImports(root) {
  const apiDirectory = resolve(root, "app/api");
  return routeFiles(apiDirectory)
    .filter(importsPutOpsState)
    .map((file) => relative(root, file).split(sep).join("/"))
    .sort();
}

export function assertApiWriteBoundaries(root) {
  const actual = directPutOpsStateRouteImports(root);
  const allowlist = [...PUT_OPS_STATE_ROUTE_ALLOWLIST].sort();
  const unapproved = actual.filter((file) => !allowlist.includes(file));
  const stale = allowlist.filter((file) => !actual.includes(file));
  if (unapproved.length || stale.length) {
    throw new Error([
      "Direct putOpsState route imports changed.",
      `Unapproved: ${unapproved.join(", ") || "none"}.`,
      `Stale allowlist entries: ${stale.join(", ") || "none"}.`,
      "Add a narrow atomic store operation instead of expanding the generic write boundary.",
    ].join(" "));
  }
  return actual;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, "..");
  const routes = assertApiWriteBoundaries(root);
  process.stdout.write(`API write boundary: PASS (${routes.length} explicitly allowed routes)\n`);
}
