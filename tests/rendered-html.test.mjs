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
  assert.match(page, /const mobilePrimaryNavigation/);
  assert.match(page, /mobile-bottom-nav/);
  assert.match(page, /setMobilePreview\("student"\)/);
  assert.match(page, /setScheduleMode\("agenda"\)/);
  assert.match(page, /const sourceSnapshot/);
  assert.match(page, /const importLocalSnapshot/);
  assert.match(page, /zonedDateTimeToUtc/);
  assert.match(page, /teacherAvailableAt/);
  assert.match(page, /if \(!teacher\.availabilitySlots\?\.length\) return false/);
  assert.match(page, /bookingHasDstRisk/);
  assert.match(page, /activeLowHourStudents/);
  assert.match(page, /examReminderStudents/);
  assert.match(page, /function requiresLp/);
  assert.match(page, /student\.lpNeed !== "待确认"/);
  assert.match(page, /const recordStudents/);
  assert.match(page, /const recordTeachers/);
  assert.match(page, /sampleStudentIds\.has\(student\.id\)/);
  assert.match(page, /sampleTeacherIds\.has\(teacher\.id\)/);
  assert.match(page, /payload\.meta\?\.replaceExisting === true/);
  assert.match(page, /currentGrade/);
  assert.match(page, /真实资料本地快照/);
  assert.match(page, /非在读与不活跃学生/);
  assert.match(page, /Demo 不会向真实企业微信发送消息/);
  assert.match(page, /const lpWorkflowOptions/);
  assert.match(page, /二次试听/);
  assert.match(page, /确认家长在 48 小时内完成指定资料\/试卷/);
  assert.match(page, /function TeacherAvaBoard/);
  assert.match(page, /不能安全地生成可约日历/);
  assert.match(page, /const substitutionCandidates/);
  assert.match(page, /function bookingOccurrencesWithinRange/);
  assert.match(page, /bookingOccurrencesWithinRange\(booking, eventStart, eventEnd\)/);
  assert.match(page, /teacherHasBookingConflict/);
  assert.match(page, /const candidatePool = hasRealSnapshot \? recordTeachers : teachers/);
  assert.match(page, /在所选日期范围内未找到受影响课程，未创建任务/);
  assert.match(page, /function taskTiming/);
  assert.match(page, /function weekDatesForTimezone/);
  assert.match(page, /试听收费确认/);
  assert.match(page, /试听当天课后跟进/);
  assert.match(page, /老师离职：推荐老师名单/);
  assert.match(page, /请从老师清单选择涉及老师后再记录请假或离职/);
  assert.doesNotMatch(page, /const avaWeekDates = Array/);
  assert.doesNotMatch(page, /试听收费与课后跟进提醒/);
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
  assert.match(css, /@media \(max-width:760px\)/);
  assert.match(css, /\.mobile-bottom-nav/);
  assert.match(css, /\.mobile-detail-open/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.student-facts/);
  assert.match(css, /\.timezone-audit/);
  assert.match(css, /\.exam-reminder-strip/);
  assert.match(css, /\.data-snapshot-bar/);
  assert.match(css, /\.ava-week-grid/);
  assert.match(css, /grid-template-columns:repeat\(7,minmax\(130px,1fr\)\)/);
  assert.doesNotMatch(css, /transition:\s*all/i);
  assert.equal(packageJson.scripts.dev, "node scripts/dev-fixed-port.mjs");
  assert.match(devServer, /const PORT = 3001/);
  assert.match(devServer, /EADDRINUSE/);
});
