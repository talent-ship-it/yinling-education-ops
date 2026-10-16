import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

test("calendar navigation reuses one role-scoped definition with its original labels and position", () => {
  const source = readFileSync("app/operations-client.tsx", "utf8");
  const ast = ts.createSourceFile("operations-client.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const variables = ast.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]);
  const definitions = variables.find((variable) => variable.name.getText(ast) === "navigationDefinitions").initializer;
  const navigation = definitions.elements.map((element) => Object.fromEntries(element.properties.map((property) => [property.name.getText(ast), ts.isStringLiteral(property.initializer) ? property.initializer.text : property.initializer.getText(ast)])));
  const calendar = navigation.filter((item) => item.id === "ava-calendar");
  assert.deepEqual(calendar, [{ id: "ava-calendar", label: "AVA日历", icon: "CalendarDays", group: "work" }]);
  assert.equal(navigation.at(-1).id, "ava-calendar");
  const preferences = {};
  runInNewContext(ts.transpileModule(readFileSync("lib/display-preferences.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: preferences });
  const navigationFor = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "navigationFor");
  const translated = runInNewContext(ts.transpileModule(`${navigationFor.getText(ast)}\nnavigationFor;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { navigationDefinitions: navigation, displayTerm: preferences.displayTerm });
  for (const [language, label] of [["zh-CN", "AVA日历"], ["en-AU", "AVA calendar"]]) {
    const items = translated(language);
    assert.equal(items.filter((item) => item.id === "ava-calendar").length, 1);
    assert.equal(items.at(-1).label, label);
  }
});

test("legacy live calendar entry redirects to the authenticated workspace section", () => {
  const source = readFileSync("app/ava-calendar/live/page.tsx", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  const redirects = [];
  const redirectSignal = new Error("redirect");
  runInNewContext(compiled, { exports, require(id) {
    if (id === "next/navigation") return { redirect(destination) { redirects.push(destination); throw redirectSignal; } };
    if (id === "react/jsx-runtime") return { jsx: () => null };
    return { default: () => null };
  } });
  assert.throws(() => exports.default(), (error) => error === redirectSignal);
  assert.deepEqual(redirects, ["/#section=ava-calendar"]);
});
