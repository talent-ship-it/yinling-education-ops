import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("account administration searches, filters and paginates large account collections", async () => {
  const lifecycle = await read("../app/account-admin-lifecycle.tsx");

  assert.match(lifecycle, /const pageSize = 12/);
  assert.match(lifecycle, /const filteredAccounts = useMemo/);
  assert.match(lifecycle, /const pagedAccounts = filteredAccounts\.slice/);
  assert.match(lifecycle, /placeholder="搜索账号、角色或权限"/);
  assert.match(lifecycle, /aria-label="账号状态筛选"/);
  assert.match(lifecycle, /pagedAccounts\.map\(\(account\) =>/);
  assert.match(lifecycle, /filteredAccounts\.length > pageSize/);
  assert.match(lifecycle, /没有匹配的账号/);
  assert.doesNotMatch(lifecycle, /\{accounts\.map\(\(account\) =>/);
});
