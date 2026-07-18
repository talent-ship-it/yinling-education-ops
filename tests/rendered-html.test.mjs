import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the education operations workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>吟领教务 \| Learning Operations<\/title>/);
  assert.match(html, /今天先处理什么/);
  assert.match(html, /学生档案/);
  assert.match(html, /排课/);
  assert.match(html, /本地 MVP/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("implements the demo workflow instead of placeholder modules", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const devServer = await readFile(new URL("../scripts/dev-fixed-port.mjs", import.meta.url), "utf8");

  assert.match(page, /function usePersistentState/);
  assert.match(page, /window\.localStorage/);
  assert.match(page, /const scheduleConflict/);
  assert.match(page, /requestedStart < bookingEnd && bookingStart < requestedEnd/);
  assert.match(page, /const createWorkflowTasks/);
  assert.match(page, /uniqueSequence \+= 1/);
  assert.match(page, /recordMessage/);
  assert.match(page, /runSync/);
  assert.match(page, /renderOperations/);
  assert.match(page, /renderRenewals/);
  assert.match(page, /renderPayroll/);
  assert.match(page, /renderFiles/);
  assert.match(page, /renderReports/);
  assert.match(page, /renderSettings/);
  assert.match(page, /renderAudit/);
  assert.match(page, /function ViewTabs/);
  assert.match(page, /function Pagination/);
  assert.match(page, /globalSearchOpen/);
  assert.match(page, /setModal\(null\)/);
  assert.match(page, /const bulkAssignStudents/);
  assert.match(page, /const advanceLp/);
  assert.match(page, /const filteredStudents/);
  assert.match(page, /const filteredTeachers/);
  assert.match(page, /window\.scrollTo\(0, 0\)/);
  assert.match(page, /setStudentPage\(Math\.floor\(sortedIndex \/ pageSize\) \+ 1\)/);
  assert.match(page, /Demo 不会向真实企业微信发送消息/);
  assert.doesNotMatch(page, /function EmptyModule/);
  assert.match(css, /\.dialog-backdrop/);
  assert.match(css, /\.command-strip/);
  assert.match(css, /\.audit-panel/);
  assert.match(css, /\.master-detail-layout/);
  assert.match(css, /\.collection-viewport/);
  assert.match(css, /\.global-search-dialog/);
  assert.match(css, /\.message-layout/);
  assert.match(css, /--brand:#75C9C2/);
  assert.match(css, /--ease-out:cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
  assert.match(css, /--ease-drawer:cubic-bezier\(0\.32, 0\.72, 0, 1\)/);
  assert.match(css, /@media \(hover:hover\) and \(pointer:fine\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /dialog-enter/);
  assert.match(css, /toast-enter/);
  assert.doesNotMatch(css, /transition:\s*all/i);
  assert.equal(packageJson.scripts.dev, "node scripts/dev-fixed-port.mjs");
  assert.match(devServer, /const PORT = 3001/);
  assert.match(devServer, /EADDRINUSE/);
});
