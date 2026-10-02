import type { PayrollWorkbookExport } from "@/lib/payroll-export";
import { completeHourAttendance, completeHourGroups, completeHourRecords, completeHourSum, type CompleteHourRecord } from "@/lib/payroll-complete-hours";

type Value = string | number | null;
type Cell = Readonly<{ value: Value; style: number }>;
type Sheet = { name: string; rows: Cell[][]; widths: number[]; merges?: string[]; rowHeights: Map<number, number> };
const cell = (value: Value, style = typeof value === "number" ? 19 : 18): Cell => ({ value, style });
const hours = (value: number | null, style = 16) => cell(value === null ? "待核对" : Math.abs(value) > 1_000_000_000_000 ? String(value) : value, style);
function total(records: readonly CompleteHourRecord[]) {
  const credits = records.filter((record) => record.credit);
  return credits.length ? completeHourSum(credits.map((record) => record.hours)) : null;
}
function count(records: readonly CompleteHourRecord[]) {
  const credits = records.filter((record) => record.credit);
  return new Set(credits.map((record) => record.eventKey)).size;
}
const issues = (records: readonly CompleteHourRecord[]) => [...new Set(records.flatMap((record) => record.issues))].join("；");
const header = (labels: string[], style = 1) => labels.map((label) => cell(label, style));

function fitRows(rows: Cell[][], widths: number[], minimum = 22) {
  return new Map(rows.map((row, index) => {
    const lines = row.map((item, column) => String(item.value ?? "").split("\n").reduce((sum, part) => {
      const length = [...part].reduce((size, character) => size + (/[^\x00-\xff]/u.test(character) ? 2 : 1), 0);
      return sum + Math.max(1, Math.ceil(length / Math.max(1, widths[column] - 2)));
    }, 0));
    return [index + 1, Math.min(409.5, Math.max(minimum, Math.max(...lines, 1) * 14 + 4))];
  }));
}

function teacherGroups(records: CompleteHourRecord[]) {
  return completeHourGroups(records, (record) => record.teacherKey).sort((a, b) =>
    (total(b) ?? -Infinity) - (total(a) ?? -Infinity) || a[0].teacherName.localeCompare(b[0].teacherName));
}

function mainSheet(groups: CompleteHourRecord[][], year: number, month: number): Sheet {
  const rows: Cell[][] = [
    [cell(`${year}年${month}月教务宝课时表`, 2)],
    [cell("教务宝教师课时（完整学生明细，含试听学员）", 3)],
    header(["序号", "教师姓名", "学生姓名", "课时（小时）", "课时费单价（小时）", "合计（待补费率）", "老师总课时（小时）", "老师总薪资（待补）", "老师薪资备注"], 4),
  ];
  groups.forEach((records, index) => {
    const students = completeHourGroups(records, (record) => JSON.stringify([record.studentKey, record.trial])).sort((a, b) =>
      (total(b) ?? -Infinity) - (total(a) ?? -Infinity) || a[0].studentName.localeCompare(b[0].studentName));
    const color = 8 + (index % 3) * 2;
    const note = [`课节 ${count(records) || "待核对"}`, completeHourAttendance(records), `试听 ${count(records.filter((record) => record.trial))}`, issues(records)].filter(Boolean).join("；");
    students.forEach((student, studentIndex) => {
      const first = studentIndex === 0;
      rows.push([
        cell(first ? index + 1 : null, color), cell(first ? records[0].teacherName : null, color),
        cell(student[0].studentName, color + 1), hours(total(student), 6), cell(null, 5), cell(null, 5),
        first ? hours(total(records), 7) : cell(null, 5), cell(null, 5), cell(first ? note : null, 14),
      ]);
    });
  });
  const widths = [8, 21, 26, 14, 18, 18, 18, 18, 36];
  const rowHeights = fitRows(rows, widths);
  rowHeights.set(1, 42); rowHeights.set(2, 30); rowHeights.set(3, 32);
  return { name: "Sheet1", rows, widths, merges: ["A1:I1", "A2:I2"], rowHeights };
}

function detailSheet(groups: CompleteHourRecord[][]): Sheet {
  const rows = [header(["序号", "教师姓名", "学生姓名", "课时（小时）", "课节数", "课程名称", "课节日期范围", "签到情况", "类型", "数据来源"])];
  for (const teacher of groups) {
    const students = completeHourGroups(teacher, (record) => JSON.stringify([record.studentKey, record.course, record.trial]));
    students.sort((a, b) => a[0].studentName.localeCompare(b[0].studentName) || a[0].course.localeCompare(b[0].course));
    for (const records of students) {
      const record = records[0];
      const dates = records.map((item) => item.date).sort();
      rows.push([
        cell(rows.length), cell(record.teacherName), cell(record.studentName), hours(total(records)),
        cell(count(records) || "待核对"), cell(record.course), cell(`${dates[0]} 至 ${dates.at(-1)}`),
        cell(completeHourAttendance(records)), cell(record.trial ? "试听" : "常规"),
        cell(["教务宝课节原始记录汇总", issues(records)].filter(Boolean).join("；")),
      ]);
    }
  }
  const widths = [8, 21, 26, 14, 10, 36, 22, 23, 10, 26];
  return { name: "学生明细", rows, widths, rowHeights: fitRows(rows, widths) };
}

function rawSheet(records: CompleteHourRecord[]): Sheet {
  const rows = [header(["课节ID", "日期", "时间", "老师姓名", "角色", "老师课时", "教务宝原始学生/账号", "解析学生姓名", "课程名称", "签到状态", "试听", "结课状态", "数据来源"])];
  for (const record of records) {
    const attendance = record.lessons.length === 1 ? record.lessons[0].attendanceTitle ?? "签到待核对" : completeHourAttendance([record]);
    rows.push([
      cell(record.calendarId), cell(record.date), cell(record.time), cell(record.teacherName), cell(record.role), hours(record.hours),
      cell(record.originalNames), cell(record.studentName), cell(record.course), cell(attendance),
      cell(record.trial ? "是" : "否"), cell("已结课"), cell([record.source, ...record.issues].join("；")),
    ]);
  }
  const widths = [13, 13, 14, 21, 11, 12, 28, 28, 36, 12, 8, 12, 24];
  return { name: "课节原始明细", rows, widths, rowHeights: fitRows(rows, widths) };
}

function sourceSheet(input: PayrollWorkbookExport, records: CompleteHourRecord[], groups: CompleteHourRecord[][], year: number, month: number): Sheet {
  const evidence = input.evidence!;
  const roleHours = total(records);
  const studentHours = completeHourSum(evidence.lessons.map((lesson) => lesson.hours));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const summary: [string, Value][] = [
    ["数据来源", `教务宝｜${input.month}-01 至 ${input.month}-${lastDay}｜已结课双源快照`],
    ["提取方式", "教务宝开放 API：query_schedule_list 老师角色课时；query_lesson_list 学生、课程与签到记录。"],
    ["课节记录", evidence.scheduleRowCount], ["教师人数", groups.length],
    ["教师总课时", roleHours ?? "待核对"], ["学员总课时", studentHours ?? "待核对"],
    ["试听/测试账号或课程标识课节", count(records.filter((record) => record.trial))],
    ["汇总规则", "按老师角色课时逐节汇总到老师—学生；小组课合列学生且只计一次角色课时，不按学生人数重复或拆分。缺失、冲突待核对，不用学生课时或排课时长代替。"],
    ["试听规则", "保留来源试听标记、共享试听账号或课程中的试听/测试标识。共享账号解析姓名是待核对候选；原始账号保留在《课节原始明细》。"],
    ["历史关联", "历史消课未提供分校时，只有唯一课节编号且日期、时间、课程、班级及老师角色资料一致，才展示待核对的候选学生关联；角色课时是来源值，不是已核准的学生分摊课时。其他来源冲突将角色课时与学生证据分行保留。"],
    ["核验结果", roleHours === null ? "存在未知老师课时，汇总待核对；不得据此锁定薪资。" : `老师明细合计 ${roleHours.toFixed(2)} 小时 = 老师角色课时合计 ${roleHours.toFixed(2)} 小时；工资待补。`],
    ["学生消课来源行数", evidence.lessonRowCount], ["老师角色明细行数", evidence.schedules.reduce((sum, schedule) => sum + schedule.teachers.length, 0)],
    ["异常学生来源课时数", evidence.lessons.filter((lesson) => lesson.hoursIssue || lesson.hours === null).length],
    ["异常老师角色课时数", evidence.schedules.flatMap((schedule) => schedule.teachers).filter((teacher) => teacher.sourceTeacherHoursIssue || teacher.sourceTeacherHours === null).length],
    ["待核对课节", count(records.filter((record) => record.issues.length > 0))],
    ["核对边界", "异常有限课时保留原值并计入来源合计，仍须核对，不代表已核准工资。来源未知或合计超出安全数值范围时显示待核对；单价、工资及银行资料不导出。"],
    ["来源发布时间", evidence.publishedAt], ["来源修订", evidence.revision],
    ["映射修订", evidence.projectionRevision], ["导出时间", input.generatedAt],
  ];
  const rows = [[cell(`${year}年${month}月课时表：数据来源与核验`, 15)], [],
    ...summary.map(([label, value]) => [cell(label, 17), cell(value, typeof value === "number" ? 19 : 14)])];
  const widths = [24, 98, 8, 8, 8, 8];
  const rowHeights = fitRows(rows, widths, 30);
  rowHeights.set(1, 32); rowHeights.set(2, 22);
  return { name: "数据说明", rows, widths, merges: ["A1:F1"], rowHeights };
}

export function completeHoursSheets(input: PayrollWorkbookExport, year: number, month: number) {
  if (!input.evidence) throw new Error("完整课时表缺少双源快照。");
  const records = completeHourRecords(input.evidence, input.month);
  const groups = teacherGroups(records);
  const sheets = [mainSheet(groups, year, month), detailSheet(groups), rawSheet(records), sourceSheet(input, records, groups, year, month)];
  sheets[1].rowHeights.set(1, 30); sheets[2].rowHeights.set(1, 30);
  return sheets;
}

export function completeHoursStylesXml() {
  const fonts = [[10, "000000", false], [10, "FFFFFF", true], [24, "000000", true], [16, "000000", true],
    [11, "000000", true], [10, "C00000", true], [10, "000000", true], [16, "FFFFFF", true], [11, "000000", false]] as const;
  const fills = ["FFFFFF", "1F4E78", "FFD966", "E2F0D9", "F2F2F2", "E7E6E6", "FCE4EC", "D9EAF7", "E2F0D9"];
  const formats = [
    [8, -2, 0, "left", 0], [1, 1, 1, "center", 0], [2, 2, 0, "center", 0], [3, 3, 0, "center", 0],
    [4, 4, 1, "center", 0], [0, 0, 1, "center", 0], [0, 5, 1, "center", 164], [5, 0, 1, "center", 164],
    [6, 6, 1, "center", 0], [0, 6, 1, "left", 0], [6, 7, 1, "center", 0], [0, 7, 1, "left", 0],
    [6, 8, 1, "center", 0], [0, 8, 1, "left", 0], [0, 0, 1, "left", 0], [7, 1, 0, "center", 0],
    [0, 0, 1, "right", 164], [4, 7, 1, "left", 0], [0, 0, 1, "left", 0], [0, 0, 1, "right", 0],
  ] as const;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.##"/></numFmts>
<fonts count="${fonts.length}">${fonts.map(([size, color, bold]) => `<font>${bold ? "<b/>" : ""}<sz val="${size}"/><color rgb="FF${color}"/><name val="Carlito"/></font>`).join("")}</fonts>
<fills count="${fills.length + 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fills.map((color) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${color}"/></patternFill></fill>`).join("")}</fills>
<borders count="2"><border/><border>${["left", "right", "top", "bottom"].map((side) => `<${side} style="thin"><color rgb="FFA6A6A6"/></${side}>`).join("")}</border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="8" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${formats.length}">${formats.map(([font, fill, border, align, number]) => `<xf numFmtId="${number}" fontId="${font}" fillId="${fill + 2}" borderId="${border}" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1" applyNumberFormat="1"><alignment horizontal="${align}" vertical="center" wrapText="1"/></xf>`).join("")}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}
