import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("account administration searches and paginates large account collections", async () => {
  const client = await read("../app/operations-client.tsx");
  const start = client.indexOf("  const renderAccounts = () =>");
  const end = client.indexOf("  const renderView = () =>", start);
  assert.ok(start >= 0 && end > start);
  const accounts = client.slice(start, end);

  assert.match(accounts, /const filteredAccounts = accounts\.filter/);
  assert.match(accounts, /const accountPageSize = 10/);
  assert.match(accounts, /const pagedAccounts = filteredAccounts\.slice/);
  assert.match(accounts, /placeholder="搜索账号、角色或登录方式"/);
  assert.match(accounts, /pagedAccounts\.map\(\(account\) =>/);
  assert.match(accounts, /<Pagination[\s\S]*total=\{filteredAccounts\.length\}/);
  assert.match(accounts, /没有找到匹配账号/);
  assert.doesNotMatch(accounts, /\{accounts\.map\(\(account\) =>/);
});
