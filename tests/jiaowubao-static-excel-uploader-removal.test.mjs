import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const [client, store, migration, importer] = await Promise.all([
  readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
  readFile(new URL(
    "../supabase/migrations/20260818001300_retire_jiaowubao_static_excel_browser_uploader.sql",
    import.meta.url,
  ), "utf8"),
  readFile(new URL("../lib/jiaowubao-static-import-service.ts", import.meta.url), "utf8"),
]);

const routePath = fileURLToPath(
  new URL("../app/api/student-import/jiaowubao-static-excel/route.ts", import.meta.url),
);

test("the rejected browser uploader is absent while the Tencent roster import boundary remains visible", () => {
  assert.equal(existsSync(routePath), false, "the static Excel HTTP route must not be deployed");
  assert.doesNotMatch(client, /教务宝静态 Excel 补充证据/u);
  assert.doesNotMatch(client, /jiaowubaoStaticExcel/u);
  assert.doesNotMatch(client, /\/api\/student-import\/jiaowubao-static-excel/u);
  assert.match(client, /腾讯学生总表[^\n]*唯一建档来源/u);
  assert.match(client, /来源处理后不纳入/u);
});

test("the app no longer exposes route-facing static Excel RPC helpers", () => {
  assert.doesNotMatch(store, /get_current_student_import_master_source/u);
  assert.doesNotMatch(store, /put_jiaowubao_static_excel_supplement/u);
  assert.doesNotMatch(store, /JiaowubaoStaticExcelSupplementPutResult/u);
  assert.match(importer, /export function prepareJiaowubaoStaticExcelImport/u);
});

test("the forward migration drops only the two browser-uploader RPCs and leaves the ledger inert", () => {
  assert.match(
    migration,
    /to_regprocedure\('public\.get_current_student_import_master_source\(text\)'\) is not null/i,
  );
  assert.match(
    migration,
    /revoke all on function public\.get_current_student_import_master_source\(text\)[\s\S]*?from public, anon, authenticated;/i,
  );
  assert.match(migration, /drop function if exists public\.get_current_student_import_master_source\(text\);/i);
  assert.match(
    migration,
    /to_regprocedure\('public\.put_jiaowubao_static_excel_supplement\(text,text,text,jsonb,text\)'\) is not null/i,
  );
  assert.match(
    migration,
    /revoke all on function public\.put_jiaowubao_static_excel_supplement\(text, text, text, jsonb, text\)[\s\S]*?from public, anon, authenticated;/i,
  );
  assert.match(
    migration,
    /drop function if exists public\.put_jiaowubao_static_excel_supplement\(text, text, text, jsonb, text\);/i,
  );
  assert.doesNotMatch(migration, /\bcascade\b/i);

  const executableSql = migration.replace(/^--.*$/gmu, "");
  assert.doesNotMatch(
    executableSql,
    /\b(?:alter|drop|truncate)\s+table\s+(?:internal\.)?jiaowubao_static_excel_/i,
  );
  assert.doesNotMatch(executableSql, /\b(?:insert\s+into|update|delete\s+from)\s+internal\.jiaowubao_static_excel_/i);
});
