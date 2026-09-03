import "server-only";

import { fetchCompletedLessons } from "@/lib/jiaowubao/lesson-client";
import {
  buildMonthlyPayrollReport,
  completedMonthlyPeriod,
  parseTrialMemberIds,
  type StudentLessonDetail,
  type MonthlyPayrollReport,
} from "@/lib/jiaowubao/monthly-payroll";

export type PayrollUiStudentDetail = {
  name: string;
  lessons: number;
  kind: "常规" | "试听" | "待分类";
  matched: boolean;
  attendance: string;
  course: string;
  dated: string;
};

export type PayrollUiRow = {
  id: string;
  teacherId: string;
  teacherName: string;
  sourceTeacherId: string;
  period: string;
  /** Kept null until the vendor supplies a teacher-monthly-total source. */
  authoritativeTotalHours: null;
  derivedTeacherHours: number;
  unclassifiedHours: number;
  lessons: number;
  trialLessons: number;
  matchedLessons: number;
  amount: number;
  status: "需核对";
  note: string;
  studentDetails: PayrollUiStudentDetail[];
};

export type MonthlyPayrollSync = {
  report: MonthlyPayrollReport;
  payroll: PayrollUiRow[];
  unassignedStudentDetails: PayrollUiStudentDetail[];
  pages: number;
};

function payrollUiStudentDetail(detail: StudentLessonDetail): PayrollUiStudentDetail {
  return {
    name: detail.name,
    lessons: detail.lessons,
    kind: detail.kind,
    matched: detail.matched,
    attendance: detail.attendance,
    course: detail.course,
    dated: detail.dated,
  };
}
function melbourneYearMonth(now: Date) {
  const values = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => values.find((part) => part.type === type)?.value;
  return { year: Number(value("year")), month: Number(value("month")) };
}

export function previousCompletedMonth(now = new Date()): string {
  const { year, month } = melbourneYearMonth(now);
  const previous = new Date(Date.UTC(year, month - 2, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function generateMonthlyPayroll(periodInput?: string): Promise<MonthlyPayrollSync> {
  const period = completedMonthlyPeriod(periodInput ?? previousCompletedMonth());
  const trialMemberIds = parseTrialMemberIds(process.env.JIAOWUBAO_TRIAL_MEMBER_IDS);
  const fetched = await fetchCompletedLessons(period, trialMemberIds);
  const report = buildMonthlyPayrollReport({
    period,
    lessons: fetched.lessons,
    trialMemberIds,
  });
  const payroll = report.teachers.map((teacher) => {
    return {
      id: teacher.id,
      teacherId: `jwb:${teacher.sourceTeacherId}`,
      teacherName: teacher.teacherName,
      sourceTeacherId: teacher.sourceTeacherId,
      period: report.period.value,
      authoritativeTotalHours: null,
      derivedTeacherHours: teacher.derivedTeacherHours,
      unclassifiedHours: teacher.unclassifiedTeacherHours,
      lessons: teacher.derivedRegularHours,
      trialLessons: teacher.derivedTrialHours,
      matchedLessons: teacher.matchedStudentHours,
      amount: 0,
      status: "需核对" as const,
      note: teacher.notes.join(" "),
      studentDetails: teacher.studentDetails.map(payrollUiStudentDetail),
    };
  });
  return {
    report,
    payroll,
    unassignedStudentDetails: report.unassignedStudentDetails.map(payrollUiStudentDetail),
    pages: fetched.pages,
  };
}

export function publicSyncSummary(sync: MonthlyPayrollSync) {
  const { report } = sync;
  return {
    period: report.period.value,
    generatedAt: report.generatedAt,
    pages: sync.pages,
    summary: report.summary,
    warnings: report.warnings,
    source: report.source,
    payroll: sync.payroll,
    unassignedStudentDetails: sync.unassignedStudentDetails,
  };
}
