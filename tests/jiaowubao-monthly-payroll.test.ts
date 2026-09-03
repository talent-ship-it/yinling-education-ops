import assert from "node:assert/strict";
import test from "node:test";

import ExcelJS from "exceljs";

import {
  configuredJiaowubaoGatewaySk,
  documentedGatewayLessonRequest,
  documentedGatewayMemberRequest,
  documentedGatewayScheduleRequest,
  JIAOWUBAO_GATEWAY_DEFAULT_URL,
  JIAOWUBAO_GATEWAY_LESSON_TOOL,
  JIAOWUBAO_GATEWAY_MAX_429_RETRIES,
  JIAOWUBAO_GATEWAY_MEMBER_TOOL,
  JIAOWUBAO_GATEWAY_PAGE_LIMIT,
  JIAOWUBAO_GATEWAY_REQUEST_GAP_MS,
  JIAOWUBAO_GATEWAY_SCHEDULE_TOOL,
  jiaowubaoGateway429BackoffMs,
} from "../lib/jiaowubao/gateway-contract.ts";
import { buildMonthlyPayrollReport, completedMonthlyPeriod, nonFutureMonthlyPeriod, parseMonthlyPeriod, parseTrialMemberIds } from "../lib/jiaowubao/monthly-payroll.ts";
import { JIAOWUBAO_MEMBER_QUERY_MAX_PAGES, prepareJiaowubaoMemberQuery } from "../lib/jiaowubao/member-client.ts";
import { collectPagesUntilEmpty } from "../lib/jiaowubao/pagination.ts";
import { normalizeJiaowubaoScheduleResponse } from "../lib/jiaowubao/schedule-client.ts";
import { createMonthlyPayrollSnapshot, readMonthlyPayrollSnapshot } from "../lib/jiaowubao/monthly-payroll-snapshot.ts";
import { createMonthlyPayrollWorkbook, monthlyPayrollFilename } from "../lib/payroll/monthly-workbook.ts";

const completedLesson = (overrides: Record<string, unknown> = {}) => ({
  branch_id: 7,
  cal_id: 1001,
  mem_id: 501,
  mem_title: "Ava 学员",
  course_id: 9,
  course_title: "Y9 English",
  team_id: 88,
  team_title: "Y9 ICAS",
  teacher_id: 201,
  teacher_title: "Crystal Wong",
  dated: "2026-08-05",
  time_title: "19:00-20:00",
  hours: 1,
  type: 2,
  type_title: "试听",
  sign: 1,
  sign_title: "已到达",
  over: 1,
  price: 999,
  ...overrides,
});

test("uses the documented gateway envelope for the complete per-student tool", () => {
  const params = { start: "2026-08-01", end: "2026-08-31", sign: -1, over: 1, page: 1, limit: 100 };
  assert.equal(JIAOWUBAO_GATEWAY_DEFAULT_URL, "https://card.jwbpro.com/open/jwb/gateway");
  assert.equal(JIAOWUBAO_GATEWAY_LESSON_TOOL, "query_lesson_list");
  assert.equal(JIAOWUBAO_GATEWAY_MEMBER_TOOL, "query_member_simple_list");
  assert.equal(JIAOWUBAO_GATEWAY_SCHEDULE_TOOL, "query_schedule_list");
  assert.equal(JIAOWUBAO_GATEWAY_PAGE_LIMIT, 100);
  assert.ok(JIAOWUBAO_GATEWAY_REQUEST_GAP_MS >= 3_100);
  assert.deepEqual(documentedGatewayLessonRequest("sk-test-only", params), {
    sk: "sk-test-only",
    tool: "query_lesson_list",
    params,
  });
  assert.deepEqual(documentedGatewayMemberRequest("sk-test-only", { page: 1, limit: 100 }), {
    sk: "sk-test-only",
    tool: "query_member_simple_list",
    params: { page: 1, limit: 100 },
  });
  assert.deepEqual(documentedGatewayScheduleRequest("sk-test-only", { page: 1, limit: 100 }), {
    sk: "sk-test-only",
    tool: "query_schedule_list",
    params: { page: 1, limit: 100 },
  });
});

test("prefers the new gateway key while accepting the existing server-only key name", () => {
  assert.equal(configuredJiaowubaoGatewaySk({ JIAOWUBAO_GATEWAY_SK: "new-key", JIAOWUBAO_OPEN_API_SK: "old-key" }), "new-key");
  assert.equal(configuredJiaowubaoGatewaySk({ JIAOWUBAO_OPEN_API_SK: "old-key" }), "old-key");
  assert.equal(configuredJiaowubaoGatewaySk({}), null);
});

test("uses bounded rate-limit recovery only for non-interactive gateway runners", () => {
  assert.equal(JIAOWUBAO_GATEWAY_MAX_429_RETRIES, 2);
  assert.equal(jiaowubaoGateway429BackoffMs(null, 0, 0), 61_000);
  assert.equal(jiaowubaoGateway429BackoffMs("1", 0, 0), 61_000);
  assert.equal(jiaowubaoGateway429BackoffMs("180", 0, 0), 180_000);
  assert.equal(jiaowubaoGateway429BackoffMs(null, 1, 0), 122_000);
});

test("requires a narrow member lookup and never coerces an unsafe filter ID", () => {
  assert.equal(JIAOWUBAO_MEMBER_QUERY_MAX_PAGES, 2);
  assert.deepEqual(prepareJiaowubaoMemberQuery({ keyword: "王欣" }), {
    filters: { keyword: "王欣" },
    maxPages: 2,
  });
  assert.deepEqual(prepareJiaowubaoMemberQuery({ teacherId: "201", teamId: 88 }), {
    filters: { teacher_id: 201, team_id: 88 },
    maxPages: 2,
  });
  assert.throws(() => prepareJiaowubaoMemberQuery({}), /至少填写/);
  assert.throws(() => prepareJiaowubaoMemberQuery({ keyword: "A" }), /至少需要两个字符/);
  assert.throws(() => prepareJiaowubaoMemberQuery({ teacherId: "9007199254740992" }), /安全整数范围/);
  assert.throws(() => prepareJiaowubaoMemberQuery({ keyword: "王欣" }, { maxPages: 3 }), /最多读取两页/);
});

test("only accepts a valid monthly period", () => {
  assert.deepEqual(parseMonthlyPeriod("2026-08"), { value: "2026-08", start: "2026-08-01", end: "2026-08-31" });
  assert.throws(() => parseMonthlyPeriod("2026-13"), /有效/);
  assert.throws(() => parseMonthlyPeriod("August"), /YYYY-MM/);
  assert.deepEqual([...parseTrialMemberIds("501, 502, 503")], ["501", "502", "503"]);
  assert.deepEqual([...parseTrialMemberIds("501")], ["501"]);
  assert.deepEqual([...parseTrialMemberIds("00501, 502, 503")], ["501", "502", "503"]);
  assert.deepEqual([...parseTrialMemberIds("")], []);
  assert.throws(() => parseTrialMemberIds("501,trial"), /正整数/);
  assert.throws(() => parseTrialMemberIds("501,00501"), /重复/);
  const augustInMelbourne = new Date("2026-08-15T00:00:00.000Z");
  assert.equal(nonFutureMonthlyPeriod("2026-08", augustInMelbourne), "2026-08");
  assert.throws(() => nonFutureMonthlyPeriod("2026-09", augustInMelbourne), /未来月份/);
  assert.equal(completedMonthlyPeriod("2026-07", augustInMelbourne), "2026-07");
  assert.throws(() => completedMonthlyPeriod("2026-08", augustInMelbourne), /已经结束/);
});

test("keeps requesting pages after a vendor-capped short page until an empty page", async () => {
  const requested: number[] = [];
  const result = await collectPagesUntilEmpty({
    maxPages: 10,
    requestPage: async (page) => {
      requested.push(page);
      if (page === 1) return [{ id: "a" }]; // deliberately shorter than a configured vendor limit
      if (page === 2) return [{ id: "b" }];
      return [];
    },
    recordKey: (row) => row.id,
    protocolError: (message) => new Error(message),
  });

  assert.deepEqual(requested, [1, 2, 3]);
  assert.equal(result.pages, 2);
  assert.deepEqual(result.rows, [{ id: "a" }, { id: "b" }]);
});

test("allows the configured maximum number of data pages and probes one final empty page", async () => {
  const requested: number[] = [];
  const result = await collectPagesUntilEmpty({
    maxPages: 2,
    requestPage: async (page) => {
      requested.push(page);
      return page <= 2 ? [{ id: String(page) }] : [];
    },
    recordKey: (row) => row.id,
    protocolError: (message) => new Error(message),
  });

  assert.deepEqual(requested, [1, 2, 3]);
  assert.equal(result.pages, 2);
  assert.deepEqual(result.rows, [{ id: "1" }, { id: "2" }]);
});

test("normalizes schedule aggregates without ever exposing incomplete stu_list data", () => {
  const result = normalizeJiaowubaoScheduleResponse({
    ret: "1",
    data: {
      lists: [{
        cal_id: 88,
        dated: "2026-08-05",
        time_start: 930,
        time_end: "1030",
        type: 2,
        appoint: 0,
        over: 1,
        over_state: 1,
        team_id: 6,
        team_title: "Y9 ICAS",
        course_id: 7,
        course_title: "English",
        room_id: 0,
        room_title: "",
        teacher_id: 201,
        teacher_title: "Crystal Wong",
        teacher_hour: 1,
        teacher_s: 0,
        teacher_s_title: "",
        teacher_s_hour: 0.5,
        teacher_t: 0,
        teacher_t_hour: 0,
        mem_num: 4,
        mem_num_sign: 4,
        mem_num_not_sign: 0,
        mem_arrive: 3,
        mem_leave: 1,
        arrive_percent: "75%",
        mem_not_comment: 2,
        ks_num: 4,
        ks_reception: 4,
        ks_not: 0,
        price_mem: 800,
        try_arrive: 1,
        all_leave: 0,
        stu_list: [{ mem_id: 501, name: "Must not escape group aggregate" }],
      }],
    },
  });

  assert.equal(result.summary.lessons, 1);
  assert.equal(result.summary.arrivedMembers, 3);
  assert.equal(result.summary.consumedHours, 4);
  assert.equal(result.lessons[0]?.timeStart, "930");
  assert.equal(result.lessons[0]?.studentDetailPolicy, "aggregate-only");
  assert.equal("stu_list" in (result.lessons[0] ?? {}), false);
  assert.equal(result.lessons[0]?.teachers.length, 2);
  assert.equal(result.lessons[0]?.teachers[1]?.hours, 0.5);
  assert.equal(result.lessons[0]?.teachers[1]?.teacherId, null);
  assert.equal(result.lessons[0]?.classType, 2);
  assert.equal(result.lessons[0]?.arrivalPercent, "75%");
  assert.throws(
    () => normalizeJiaowubaoScheduleResponse({ ret: "1", data: { list: [] } }),
    /data\.lists/,
  );
  assert.throws(
    () => normalizeJiaowubaoScheduleResponse({ ret: "1", data: { lists: [{ cal_id: 1, dated: "bad", over: 1 }] } }),
    /dated/,
  );
});

test("keeps each student row while deduplicating a group lesson for teacher hours", () => {
  const report = buildMonthlyPayrollReport({
    period: "2026-08",
    trialMemberIds: parseTrialMemberIds("501,502,503"),
    lessons: [
      completedLesson(),
      completedLesson({ mem_id: 502, mem_title: "Ben 学员" }),
      completedLesson({ cal_id: 1002, mem_id: 777, mem_title: "Cara 学员", type: 3, type_title: "常规", hours: 2 }),
    ],
    generatedAt: "2026-09-03T00:00:00.000Z",
  });

  assert.equal(report.lessons.length, 3);
  assert.equal(report.summary.uniqueLessons, 2);
  assert.equal(report.teachers.length, 1);
  const teacher = report.teachers[0];
  assert.equal(teacher.authoritativeTotalHours, null);
  assert.equal(teacher.derivedTeacherHours, 3);
  assert.equal(teacher.derivedTrialHours, 1);
  assert.equal(teacher.derivedRegularHours, 2);
  assert.equal(teacher.matchedStudentHours, 2);
  assert.equal(teacher.studentDetails.length, 3);
  assert.equal(teacher.studentDetails.filter((detail) => !detail.matched).length, 2);
  assert.match(teacher.notes.join(" "), /月度总课时/);
});

test("does not multiply a shared course into every teacher and does not guess trial status", () => {
  const report = buildMonthlyPayrollReport({
    period: "2026-08",
    lessons: [
      completedLesson({
        teacher_s: 202,
        teacher_s_title: "Tara Liu",
        teacher_s_hour: 1.5,
        hours: 1.5,
      }),
    ],
  });

  assert.equal(report.teachers.length, 2);
  assert.equal(report.summary.derivedTeacherHours, 0);
  assert.equal(report.summary.unmatchedTeacherLessonGroups, 2);
  assert.equal(report.summary.unclassifiedLessons, 1);
  assert.equal(report.summary.unclassifiedStudentHours, 1.5);
  assert.ok(report.warnings.some((warning) => warning.includes("试听")));
});

test("does not double-count a malformed lesson that repeats one teacher in two roles", () => {
  const report = buildMonthlyPayrollReport({
    period: "2026-08",
    lessons: [completedLesson({ teacher_s: 201, teacher_s_title: "Crystal Wong" })],
  });

  assert.equal(report.teachers.length, 2);
  assert.equal(report.summary.derivedTeacherHours, 0);
  assert.equal(report.summary.unmatchedTeacherLessonGroups, 2);
});

test("marks mixed trial and regular members of one shared lesson as unresolved", () => {
  const report = buildMonthlyPayrollReport({
    period: "2026-08",
    trialMemberIds: parseTrialMemberIds("501,502,503"),
    lessons: [
      completedLesson({ mem_id: 501, mem_title: "试听账号" }),
      completedLesson({ mem_id: 777, mem_title: "常规学生" }),
    ],
  });

  const teacher = report.teachers[0];
  assert.equal(teacher.derivedTeacherHours, 1);
  assert.equal(teacher.derivedTrialHours, 0);
  assert.equal(teacher.derivedRegularHours, 0);
  assert.equal(teacher.unclassifiedTeacherHours, 1);
  assert.equal(teacher.unresolvedClassificationCount, 1);
  assert.equal(report.summary.unresolvedClassificationGroups, 1);
});

test("uses the confirmed trial-name convention without losing the B account", () => {
  const report = buildMonthlyPayrollReport({
    period: "2026-08",
    trialMemberIds: parseTrialMemberIds("501,502,503"),
    lessons: [
      completedLesson({
        mem_title: "试听学员 B",
        team_title: "Zachary 张泽睿 (WA)",
        course_title: "Y4 ICAS English Spelling",
      }),
      completedLesson({
        cal_id: 1002,
        mem_title: "试听学员 B",
        team_title: "试听班级",
        course_title: "Phyllis 嘟嘟 AEAS English",
      }),
      completedLesson({
        cal_id: 1003,
        mem_title: "试听学员 B",
        team_title: "Zachary 张泽睿 (WA)",
        course_title: "Fiona 周雨霏 VCE English",
      }),
      completedLesson({
        cal_id: 1004,
        mem_title: "试听学员 B",
        team_title: "试听班级",
        course_title: "Y4 ICAS English Spelling",
      }),
      completedLesson({
        cal_id: 1005,
        mem_title: "试听学员 B",
        team_title: "Rita Wu (NZL)",
        course_title: "Y9 ICAS English",
      }),
      completedLesson({
        cal_id: 1006,
        mem_title: "试听学员 B",
        team_title: "试听班级",
        course_title: "English Spelling (WA)",
      }),
    ],
  });

  const [className, courseName, conflict, unresolved, englishClassName, courseOnlyEnglish] = report.lessons;
  assert.equal(className?.memberName, "试听学员 B");
  assert.equal(className?.displayStudentName, "Zachary 张泽睿");
  assert.equal(className?.studentNameSource, "trial_team_title_prefix");
  assert.equal(courseName?.displayStudentName, "Phyllis 嘟嘟");
  assert.equal(courseName?.studentNameSource, "trial_course_title_prefix");
  assert.equal(conflict?.displayStudentName, "试听学员 B");
  assert.equal(conflict?.studentNameSource, "trial_name_conflict");
  assert.equal(unresolved?.displayStudentName, "试听学员 B");
  assert.equal(unresolved?.studentNameSource, "trial_account_unresolved");
  assert.equal(englishClassName?.displayStudentName, "Rita Wu");
  assert.equal(englishClassName?.studentNameSource, "trial_team_title_prefix");
  assert.equal(courseOnlyEnglish?.displayStudentName, "试听学员 B");
  assert.equal(courseOnlyEnglish?.studentNameSource, "trial_account_unresolved");
  assert.ok(report.warnings.some((warning) => warning.includes("未能从班级名称或课程名称安全提取")));
  assert.ok(report.warnings.some((warning) => warning.includes("班级名称和课程名称疑似对应不同学生")));
});

test("normalizes a zero-padded JWB member ID before trial classification", () => {
  const report = buildMonthlyPayrollReport({
    period: "2026-08",
    trialMemberIds: parseTrialMemberIds("501,502,503"),
    lessons: [completedLesson({ mem_id: "00501" })],
  });

  assert.equal(report.lessons[0]?.memberId, "501");
  assert.equal(report.lessons[0]?.kind, "试听");
});

test("rejects any record that is not completed or falls outside the requested month", () => {
  assert.throws(() => buildMonthlyPayrollReport({ period: "2026-08", lessons: [completedLesson({ over: 0 })] }), /已结课/);
  assert.throws(() => buildMonthlyPayrollReport({ period: "2026-08", lessons: [completedLesson({ dated: "2026-09-01" })] }), /不在/);
});

test("writes a complete, readable xlsx workbook from the reconciled source", async () => {
  const report = buildMonthlyPayrollReport({
    period: "2026-08",
    trialMemberIds: parseTrialMemberIds("501,502,503"),
    lessons: [completedLesson({ mem_title: "=not-a-formula" })],
  });
  const output = await createMonthlyPayrollWorkbook(report);
  assert.equal(new TextDecoder().decode(output.subarray(0, 2)), "PK");
  assert.equal(monthlyPayrollFilename("2026-08"), "2026年08月教务宝课时表_完整版.xlsx");

  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(output as unknown as ArrayBuffer);
  assert.deepEqual(loaded.worksheets.map((sheet) => sheet.name), ["Sheet1", "学生明细", "课节原始明细", "数据说明"]);
  assert.equal(loaded.getWorksheet("Sheet1")?.getCell("A1").value, "2026年8月教务宝课时表");
  assert.equal(loaded.getWorksheet("课节原始明细")?.getCell("D2").value, "=not-a-formula");
  assert.equal(loaded.getWorksheet("课节原始明细")?.getCell("D2").type, ExcelJS.ValueType.String);
  assert.equal(loaded.getWorksheet("课节原始明细")?.getCell("P2").value, "query_lesson_list · over=1");
  assert.equal(loaded.getWorksheet("Sheet1")?.getCell("L3").value, "开户行");
  assert.equal(loaded.getWorksheet("学生明细")?.getCell("A3").value, "序号");
});

test("shows records without a teacher in both approved presentation sheets", async () => {
  const report = buildMonthlyPayrollReport({
    period: "2026-08",
    trialMemberIds: parseTrialMemberIds("501,502,503"),
    lessons: [completedLesson({ teacher_id: 0, teacher_title: null, teacher_s: 0, teacher_t: 0 })],
  });

  assert.equal(report.teachers.length, 0);
  assert.equal(report.unassignedStudentDetails.length, 1);
  assert.equal(report.summary.lessonsWithoutTeachers, 1);

  const workbook = await createMonthlyPayrollWorkbook(report);
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(workbook as unknown as ArrayBuffer);
  assert.equal(loaded.getWorksheet("Sheet1")?.getCell("B4").value, "未分配教师（教务宝未返回教师 ID）");
  assert.equal(loaded.getWorksheet("学生明细")?.getCell("B4").value, "未分配教师（教务宝未返回教师 ID）");
});

test("downloads the exact signed report that the browser just reviewed", () => {
  const report = buildMonthlyPayrollReport({ period: "2026-08", lessons: [completedLesson()] });
  const secret = "s".repeat(32);
  const token = createMonthlyPayrollSnapshot(report, { secret, now: 1_000 });

  assert.deepEqual(readMonthlyPayrollSnapshot(token, { secret, now: 1_001 }), report);
  assert.throws(() => readMonthlyPayrollSnapshot(`${token}x`, { secret, now: 1_001 }), /校验失败/);
  assert.throws(() => readMonthlyPayrollSnapshot(token, { secret, now: 1_000 + 15 * 60 * 1000 }), /已过期/);
});
