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
  const isOpsStoreModule = (moduleName) =>
    moduleName === "@/lib/ops-store" || /(?:^|\/)lib\/ops-store(?:\.ts)?$/u.test(moduleName);
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      if (!isOpsStoreModule(moduleName)) return;
      const bindings = node.importClause?.namedBindings;
      if (bindings && (ts.isNamespaceImport(bindings)
        || bindings.elements.some((element) => (element.propertyName ?? element.name).text === "putOpsState"))) {
        found = true;
      }
      return;
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const moduleName = node.arguments[0].text;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isOpsStoreModule(moduleName) && (isDynamicImport || isRequire)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
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
