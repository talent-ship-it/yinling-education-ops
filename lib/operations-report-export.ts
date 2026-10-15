import { matchesOperationsOwnerFilter, resolveAssignableOperationsOwner } from "./demo-users";

export const OPERATIONS_REPORT_EXPORT_SCHEMA_VERSION = 1 as const;
export const ALL_REPORT_OWNERS = "all" as const;

export type OperationsReportTaskInput = Readonly<{
  id: string;
  owner: string;
  status: string;
}>;

export type OperationsReportStudentInput = Readonly<{
  id: string;
  owner: string;
  segment?: string;
  files?: number;
}>;

export type OperationsReportTeacherInput = Readonly<{
  id: string;
  acceptsStudents: boolean;
}>;

export type OperationsReportBookingInput = Readonly<{
  status: string;
}>;

export type OperationsReportExportInput = Readonly<{
  ownerFilter: string;
  tasks: readonly OperationsReportTaskInput[];
  students: readonly OperationsReportStudentInput[];
  teachers: readonly OperationsReportTeacherInput[];
  bookings: readonly OperationsReportBookingInput[];
  filesIndexed: boolean;
  generatedAt?: Date | string;
}>;

export type OperationsReportExport = Readonly<{
  meta: Readonly<{
    schemaVersion: typeof OPERATIONS_REPORT_EXPORT_SCHEMA_VERSION;
    report: "operations";
    generatedAt: string;
    ownerFilter: string;
  }>;
  scope: Readonly<{
    ownerFilter: string;
    taskCount: number;
    studentCount: number;
  }>;
  metrics: Readonly<{
    tasks: Readonly<{
      total: number;
      completed: number;
      pending: number;
    }>;
    students: Readonly<{
      total: number;
      trials: number;
    }>;
    teachers: Readonly<{
      active: number;
      total: number;
    }>;
    files: Readonly<{
      indexed: boolean;
      missing: number;
    }>;
    bookings: Readonly<{
      awaitingConfirmation: number;
    }>;
  }>;
  breakdowns: Readonly<{
    pendingTasksByOwner: Readonly<Record<string, number>>;
  }>;
  records: Readonly<{
    tasks: readonly Readonly<{
      id: string;
      owner: string;
      status: string;
    }>[];
    students: readonly Readonly<{
      id: string;
      owner: string;
      segment?: string;
      files: number;
    }>[];
  }>;
}>;

function reportOwnerFilter(value: string) {
  const trimmed = value.trim();
  return resolveAssignableOperationsOwner(trimmed) ?? (trimmed || ALL_REPORT_OWNERS);
}

function nonNegativeNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function isoTimestamp(value: Date | string | undefined) {
  const date = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError("generatedAt must be a valid date");
  return date.toISOString();
}

/**
 * Builds the small, browser-safe projection used by the Operations report.
 * The owner filter is applied here rather than relying on the caller to pass
 * already-filtered arrays, so a future caller cannot accidentally export the
 * full shared snapshot from this report surface.
 */
export function buildOperationsReportExport(
  input: OperationsReportExportInput,
): OperationsReportExport {
  const ownerFilter = reportOwnerFilter(input.ownerFilter);
  const reportTasks = input.tasks.filter((task) => matchesOperationsOwnerFilter(ownerFilter, task.owner));
  const reportStudents = input.students.filter((student) => matchesOperationsOwnerFilter(ownerFilter, student.owner));
  const completed = reportTasks.filter((task) => task.status === "done").length;
  const pending = reportTasks.length - completed;
  const pendingTasksByOwner = Object.fromEntries(
    Array.from(new Set([
      ...(ownerFilter === ALL_REPORT_OWNERS ? reportTasks.map((task) => resolveAssignableOperationsOwner(task.owner) ?? task.owner.trim()) : [ownerFilter]),
    ])).sort().map((owner) => [
      owner,
      reportTasks.filter((task) => matchesOperationsOwnerFilter(owner, task.owner) && task.status !== "done").length,
    ]),
  );
  const missingFiles = input.filesIndexed
    ? reportStudents.filter((student) => nonNegativeNumber(student.files) < 5).length
    : 0;
  const generatedAt = isoTimestamp(input.generatedAt);

  return {
    meta: {
      schemaVersion: OPERATIONS_REPORT_EXPORT_SCHEMA_VERSION,
      report: "operations",
      generatedAt,
      ownerFilter,
    },
    scope: {
      ownerFilter,
      taskCount: reportTasks.length,
      studentCount: reportStudents.length,
    },
    metrics: {
      tasks: { total: reportTasks.length, completed, pending },
      students: {
        total: reportStudents.length,
        trials: reportStudents.filter((student) => student.segment === "试听").length,
      },
      // Teachers are a shared resource metric in the visible report and have
      // no owner field, so they intentionally remain a global count.
      teachers: {
        active: input.teachers.filter((teacher) => teacher.acceptsStudents).length,
        total: input.teachers.length,
      },
      files: { indexed: input.filesIndexed, missing: missingFiles },
      bookings: {
        awaitingConfirmation: input.bookings.filter((booking) => booking.status === "待确认").length,
      },
    },
    breakdowns: { pendingTasksByOwner },
    records: {
      // Keep only fields needed to reconcile the exported indicators. Do not
      // copy names, notes, messages, payroll, credentials, or raw payloads.
      tasks: reportTasks.map(({ id, owner, status }) => ({ id, owner, status })),
      students: reportStudents.map((student) => ({
        id: student.id,
        owner: student.owner,
        ...(student.segment ? { segment: student.segment } : {}),
        files: nonNegativeNumber(student.files),
      })),
    },
  };
}

function reportFilenameOwnerSegment(ownerFilter: string) {
  const normalized = reportOwnerFilter(ownerFilter);
  if (normalized === ALL_REPORT_OWNERS) return "all-owners";
  const ascii = normalized
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return ascii ? `owner-${ascii}` : "owner-filter";
}

export function operationsReportFilename(ownerFilter: string, generatedAt?: Date | string) {
  return `yinling-education-ops-report-${reportFilenameOwnerSegment(ownerFilter)}-${isoTimestamp(generatedAt).slice(0, 10)}.json`;
}
