"use client";

import {
  ArrowUpDown,
  ArrowRight,
  BookOpen,
  CalendarDays,
  CalendarOff,
  CalendarPlus,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  Clock3,
  Database,
  Download,
  Copy,
  ExternalLink,
  FilePlus2,
  FileText,
  Filter,
  FolderOpen,
  GraduationCap,
  LayoutDashboard,
  ListChecks,
  ListTodo,
  KeyRound,
  Link2,
  LogOut,
  MapPin,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  UserCog,
  UserRoundX,
  Users,
  Video,
  Wallet,
  X,
} from "lucide-react";

import { cleanTimezone } from "@/lib/timezone";
import { observeInterfaceLocalization, translateInterfaceText } from "@/lib/interface-localization";
import { downloadPayrollExcel } from "@/lib/payroll-export";
import {
  defaultDisplayPreferences,
  displayPreferencesStorageKey,
  displayTerm,
  displayTimezoneOptions,
  interfaceCopy,
  localeFor,
  parseDisplayPreferences,
  timezoneLabelFor,
  type DisplayPreferences,
  type InterfaceLanguage,
} from "@/lib/display-preferences";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_LIMITED_ADMIN_USER, DEMO_STAFF_USERS, DEMO_TEACHER_USERS, isDemoTeacher } from "@/lib/demo-users";
import {
  generateTrialBookingTasks,
  generateTrialRequestTasks,
  linkTrialRequestTasksToBooking,
  closeTasksForBooking,
  reconcileTrialBookingTasks,
  refreshTaskStatus,
  restoreTrialRequestTasksToWorkflow,
  sortTasksByDueAt,
  statusForDueAt,
  upsertTasksByRule,
  type OpsTask,
  type TaskCategory,
  type TaskStatus,
} from "@/lib/ops-tasks";
import {
  LP_STAGES,
  LP_WORKFLOW_TYPES,
  changeLpStage,
  reviseLpWorkflow,
  type LpFieldValues,
  type LpRevision,
  type LpStage,
  type LpStageAuditEntry,
  type LpWorkflowType,
} from "@/lib/lp-workflows";
import {
  RENEWAL_STATUS_LABELS,
  addLessonPackageHours,
  appendStudentFollowUp,
  bindSubjectToLessonPackage,
  buildExamTaskDefinitions,
  createStudentLessonPackage,
  estimateExamResultDate,
  getLatestStudentFollowUp,
  getLessonPackageBalance,
  mapLessonPackageDepletionEstimates,
  normalizeRenewalBusinessStatus,
  sortStudentExams,
  type LessonHourLedgerEntry,
  type RenewalStatus as RenewalBusinessStatus,
  type StudentExamRecord,
  type StudentFollowUp,
  type StudentLessonPackage,
} from "@/lib/student-records";
import { LpRevisionHistory, LpWorkflowFields, parseLpWorkflowFormData } from "@/app/lp-workflow-fields";
import { ToDoList, type ToDoFilter } from "@/app/to-do-list";
import { StudentRecordsPanel, type StudentRecordPanelSection } from "@/app/student-records-panel";
import { ExamForm, FollowUpForm, LessonPackageForm, parseExamFormData, parseFollowUpFormData, parseLessonPackageFormData } from "@/app/student-record-forms";

type Section =
  | "dashboard"
  | "students"
  | "teachers"
  | "schedule"
  | "classroom"
  | "courses"
  | "lp"
  | "operations"
  | "renewals"
  | "payroll"
  | "messages"
  | "files"
  | "sync"
  | "reports"
  | "settings"
  | "accounts"
  | "audit";

type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "purple";
type ModalKind = "student" | "studentEdit" | "studentEvidence" | "studentRecords" | "studentFollowUp" | "lessonPackage" | "exam" | "task" | "booking" | "temporaryClassroom" | "operation" | "renewal" | "file" | "template" | "lp" | "lpRevision" | "ava" | "teacherCapacity" | "payrollNew" | "payrollEdit" | null;
type MobilePreview = "student" | "teacher" | "booking" | "operation" | "message" | "classroom" | null;

type OperatorProfile = { role: string; scope: string; tone: Tone };

function operatorProfile(operator: string): OperatorProfile {
  if (operator === "Nixon") return { role: "超级管理员", scope: "全部资料、薪资和系统设置", tone: "purple" };
  if (operator === DEMO_LIMITED_ADMIN_USER) return { role: "运营管理员", scope: "全局运营与教务协同", tone: "blue" };
  if (isDemoTeacher(operator)) return { role: "老师", scope: "自己的学生、约课和网上课堂", tone: "green" };
  return { role: "教务", scope: "负责学生、排课和跟进", tone: "blue" };
}
type StudentStatus = "待确认" | "待排课" | "试听中" | "在读" | "待续课" | "停课" | "非在读" | "不活跃";
type StudentSegment = "试听" | "已报名";
type LpNeed = "待确认" | "无需LP" | "试听LP" | "新生LP" | "老生新LP" | "代课LP" | "LP修改";

type AvailabilitySlot = {
  day: number;
  start: string;
  end: string;
};

type Student = {
  id: string;
  name: string;
  initials: string;
  status: StudentStatus;
  segment?: StudentSegment;
  owner: string;
  course: string;
  timezone: string;
  guardian: string;
  guardianWechat?: string;
  teacher: string;
  next: string;
  nextTone: Tone;
  files: number;
  examDate?: string;
  examSubject?: string;
  resultDate?: string;
  grade?: string;
  gradeBaseYear?: number;
  location?: string;
  planner?: string;
  remainingHours?: number;
  contractHours?: number;
  contractEffectiveDate?: string;
  jwbSyncedAt?: string;
  jwbSyncStatus?: string;
  reportProgress?: string;
  followUp?: string;
  followUpHistory?: StudentFollowUp[];
  exams?: StudentExamRecord[];
  lessonPackages?: StudentLessonPackage[];
  lessonLedger?: LessonHourLedgerEntry[];
  notes?: string;
  lpNeed?: LpNeed;
  renewalMonth?: string;
  renewalDate?: string;
  sourceRow?: number;
};

type Teacher = {
  id: string;
  name: string;
  initials: string;
  subjects: string[];
  timezone: string;
  availability: string;
  load: number;
  capacity: number;
  acceptsStudents: boolean;
  note: string;
  departments?: string[];
  subjectDetail?: string;
  location?: string;
  availabilityTimezone?: string;
  availabilityStatus?: "可接新生" | "暂停接新" | "待确认";
  availabilityUpdated?: string;
  availabilitySlots?: AvailabilitySlot[];
  offlineArea?: string;
  sourceCategories?: string[];
  newStudentCapacity?: number;
  capacityAssignments?: string[];
};

type Task = OpsTask;

type Booking = {
  id: string;
  studentId: string;
  teacherId: string;
  date: string;
  start: string;
  duration: number;
  kind: "试听" | "常规课" | "代课";
  status: "待确认" | "已确认" | "已完成";
  timezone: string;
  recurring?: boolean;
  repeatCount?: number;
  course?: string;
  source?: string;
  sourceLessonId?: string;
  sourceStudentName?: string;
  sourceTeacherName?: string;
  sourceTiming?: "已结束" | "未开始";
  requestedAt?: string;
  packageId?: string;
  completedAt?: string;
  classroom?: {
    meetingId: string;
    status: "ready" | "running" | "ended";
    createdAt: string;
  };
};

type ClassroomRuntime = {
  meetingId: string;
  running: boolean;
  participantCount: number;
  moderatorCount: number;
  recording?: boolean;
  recordings: Array<{
    id: string;
    name: string;
    state: string;
    playbackUrl?: string;
  }>;
};

type CourseRecord = {
  id: string;
  name: string;
  status: "在用" | "已完结";
  source: string;
};

type BookingOccurrence = Booking & {
  occurrenceKey: string;
};

type LpItem = {
  id: string;
  studentId: string;
  title: string;
  workflowType?: LpWorkflowType;
  stage: LpStage;
  owner: string;
  due: string;
  needsParentFollowUp?: boolean;
  needsTeacherPrep?: boolean;
  publishedDate?: string;
  fields?: LpFieldValues;
  revisionNumber?: number;
    revisions?: LpRevision[];
  stageAudit?: LpStageAuditEntry[];
};

type Operation = {
  id: string;
  studentId: string;
  type: "调课" | "请假" | "学生请假" | "老师请假" | "停课" | "代课" | "换老师" | "老师离职";
  detail: string;
  status: "待处理" | "已确认";
  createdAt: string;
  teacherId?: string;
  eventStart?: string;
  eventEnd?: string;
  affectedLessonCount?: number;
  recommendedTeacherIds?: string[];
  chosenTeacherId?: string;
  sourceBookingId?: string;
};

type RenewalStatus = "已续课" | "未续课-活跃" | "未续课-不活跃" | "未续课-不活跃（已考完）" | "待跟进" | "已联系" | "已跟进" | "本次未跟进" | "等待家长" | "已确认";

type Renewal = {
  id: string;
  studentId: string;
  remaining: number;
  estimate: string;
  status: RenewalStatus;
  businessStatus?: RenewalBusinessStatus;
  owner: string;
  lastAttemptAt?: string;
  lastContactedAt?: string;
  followUpNote?: string;
  followUpAttachmentId?: string;
  followUpAttachmentTitle?: string;
  renewalDateNote?: string;
};

type PayrollRow = {
  id: string;
  teacherId: string;
  lessons: number;
  trialLessons: number;
  amount: number;
  status: "需核对" | "可审核" | "已锁定";
  note: string;
  month?: string;
  section?: string;
  currency?: "CNY" | "AUD";
  teacherName?: string;
  teacherTotalHours?: number;
  teacherTotalAmount?: number;
  lineAmount?: number;
  lineCount?: number;
  rateRange?: number[];
  sourceHours?: number | null;
  sourceLessonCount?: number | null;
  sourceNoShowHours?: number | null;
  hourVariance?: number | null;
  bankAccount?: string;
  bankName?: string;
  paymentNote?: string;
  source?: string;
  lockedBy?: string;
  lockedAt?: string;
  lines?: PayrollLine[];
};

type PayrollLine = {
  studentName: string;
  hours: number;
  rate: number;
  subtotal: number;
  note?: string;
  isTrial?: boolean;
  sourceRow?: number;
};

type Message = {
  id: string;
  studentId: string;
  kind: string;
  recipient: string;
  body: string;
  status: "待人工确认" | "仅内部" | "已记录发送";
  createdAt: string;
};

type FileRecord = {
  id: string;
  studentId: string;
  title: string;
  type: "Learning Plan" | "学校资料" | "Report 资料" | "成绩单" | "课堂反馈" | "FU" | "续课 FU" | "资料链接" | "其他";
  source: string;
  addedAt: string;
};

type AuditEntry = {
  id: string;
  time: string;
  actor: string;
  action: string;
  detail: string;
  tone: Tone;
};

type Rules = {
  lpDays: string;
  feedbackHours: string;
  renewalDays: string;
  escalation: string;
  lowHours: string;
  examDays: string;
};

export type ImportPayload = {
  meta?: { studentCount?: number; teacherCount?: number; createdAt?: string; replaceExisting?: boolean };
  students?: Student[];
  teachers?: Teacher[];
  tasks?: Task[];
  bookings?: Booking[];
  courses?: CourseRecord[];
  lpItems?: LpItem[];
  operations?: Operation[];
  renewals?: Renewal[];
  payroll?: PayrollRow[];
  messages?: Message[];
  files?: FileRecord[];
  audit?: AuditEntry[];
  rules?: Rules;
  dataSnapshot?: { label: string; students: number; teachers: number; importedAt: string };
  versions?: Record<string, number>;
  syncSources?: SyncSource[];
};

type SyncSource = {
  source_id: string;
  title: string;
  source_type: string;
  url?: string | null;
  modified_at?: string | null;
  synced_at: string;
  row_count: number;
  status: string;
  payload?: { sheetNames?: string[]; note?: string };
};

type RemoteStateRow<T = unknown> = {
  entity: string;
  payload: T;
  version: number;
  updated_at: string;
  updated_by: string;
};

type SharedSyncState = "synced" | "saving" | "offline" | "error" | "conflict";

type ToastState = {
  id: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

type ConfirmRequest = {
  title: string;
  detail: string;
  items?: string[];
  confirmLabel: string;
  tone?: "primary" | "danger";
  onConfirm: () => void | Promise<void>;
};

const navigationDefinitions: Array<{ id: Section; label: string; icon: typeof LayoutDashboard; group: "work" | "support" }> = [
  { id: "dashboard", label: "工作台", icon: LayoutDashboard, group: "work" },
  { id: "students", label: "学生档案", icon: Users, group: "work" },
  { id: "teachers", label: "老师资源", icon: GraduationCap, group: "work" },
  { id: "schedule", label: "排课", icon: CalendarDays, group: "work" },
  { id: "classroom", label: "网上教室", icon: Video, group: "work" },
  { id: "courses", label: "课程与课包", icon: BookOpen, group: "work" },
  { id: "lp", label: "试听与 LP", icon: BookOpen, group: "work" },
  { id: "operations", label: "调课与代课", icon: CalendarPlus, group: "work" },
  { id: "renewals", label: "考试与续课", icon: ListChecks, group: "work" },
  { id: "payroll", label: "课时与薪资", icon: Wallet, group: "support" },
  { id: "messages", label: "消息队列", icon: MessageSquare, group: "support" },
  { id: "files", label: "文件中心", icon: FolderOpen, group: "support" },
  { id: "sync", label: "同步与导入", icon: RefreshCw, group: "support" },
  { id: "reports", label: "运营报表", icon: SlidersHorizontal, group: "support" },
  { id: "settings", label: "规则设置", icon: Settings, group: "support" },
  { id: "accounts", label: "账号与权限", icon: KeyRound, group: "support" },
  { id: "audit", label: "操作审计", icon: ShieldCheck, group: "support" },
];

function navigationFor(language: InterfaceLanguage) {
  return navigationDefinitions.map((item) => ({ ...item, label: displayTerm(item.label, language) }));
}

const staffSectionIds = new Set<Section>(["dashboard", "students", "teachers", "schedule", "courses", "lp", "operations", "renewals", "messages", "files"]);
const teacherSectionIds = new Set<Section>(["dashboard", "students", "schedule", "classroom"]);
const noPayrollAdminSectionIds = new Set<Section>(navigationDefinitions.filter((item) => item.id !== "payroll").map((item) => item.id));

const baseStudents: Student[] = [
  { id: "STU-0248", name: "Olivia Chen", initials: "OC", status: "试听中", owner: "思佳", course: "Year 10 English", timezone: "Australia/Melbourne · UTC+10", guardian: "Chen 先生 · 企业微信客户群", teacher: "待匹配", next: "确认 N-2 资料与收费", nextTone: "red", files: 4 },
  { id: "STU-0194", name: "Lucas Wang", initials: "LW", status: "在读", owner: "Tiffany", course: "IB Mathematics AA HL", timezone: "Australia/Sydney · UTC+10", guardian: "Wang 女士 · 企业微信客户", teacher: "Daniel Wu", next: "发送 LP 给老师", nextTone: "amber", files: 9, examDate: "2026-11-03" },
  { id: "STU-0231", name: "Sophie Liu", initials: "SL", status: "在读", owner: "Abby", course: "VCE Chemistry", timezone: "Australia/Melbourne · UTC+10", guardian: "Liu 女士 · 企业微信客户群", teacher: "Amelia Brown", next: "更新考试节点", nextTone: "blue", files: 7, examDate: "2026-10-29" },
  { id: "STU-0176", name: "Ethan Zhao", initials: "EZ", status: "待续课", owner: "思佳", course: "Year 12 Physics", timezone: "Australia/Perth · UTC+8", guardian: "Zhao 女士 · 企业微信客户", teacher: "Michael Yu", next: "续课 N-8 跟进", nextTone: "amber", files: 6 },
  { id: "STU-0251", name: "Mia Zhang", initials: "MZ", status: "待排课", owner: "思佳", course: "Year 8 English", timezone: "Australia/Melbourne · UTC+10", guardian: "Zhang 女士 · 企业微信客户群", teacher: "待匹配", next: "匹配试听老师", nextTone: "blue", files: 3 },
  { id: "STU-0252", name: "Noah Li", initials: "NL", status: "在读", owner: "Tiffany", course: "IB Chemistry HL", timezone: "Australia/Sydney · UTC+10", guardian: "Li 先生 · 企业微信客户", teacher: "Amelia Brown", next: "课后反馈检查", nextTone: "green", files: 8, examDate: "2026-11-06" },
  { id: "STU-0253", name: "Emma Xu", initials: "EX", status: "试听中", owner: "Abby", course: "Year 11 Mathematics", timezone: "Asia/Shanghai · UTC+8", guardian: "Xu 女士 · 企业微信客户群", teacher: "Grace Lin", next: "确认试听反馈", nextTone: "amber", files: 4 },
  { id: "STU-0254", name: "Leo Sun", initials: "LS", status: "在读", owner: "思佳", course: "VCE Physics", timezone: "Australia/Melbourne · UTC+10", guardian: "Sun 先生 · 企业微信客户", teacher: "Michael Yu", next: "更新 Learning Plan", nextTone: "blue", files: 10, examDate: "2026-10-30" },
  { id: "STU-0255", name: "Chloe Yang", initials: "CY", status: "停课", owner: "Tara", course: "Year 9 Science", timezone: "Australia/Brisbane · UTC+10", guardian: "Yang 女士 · 企业微信客户", teacher: "Rachel Song", next: "确认预计复课日", nextTone: "red", files: 6 },
  { id: "STU-0256", name: "Oscar Hu", initials: "OH", status: "待续课", owner: "Tiffany", course: "IB Economics HL", timezone: "Australia/Sydney · UTC+10", guardian: "Hu 先生 · 企业微信客户群", teacher: "Daniel Wu", next: "续课 N-8 跟进", nextTone: "purple", files: 9 },
  { id: "STU-0257", name: "Ava Lin", initials: "AL", status: "在读", owner: "Abby", course: "Year 7 English", timezone: "Australia/Perth · UTC+8", guardian: "Lin 女士 · 企业微信客户", teacher: "Grace Lin", next: "作业提交检查", nextTone: "green", files: 7 },
  { id: "STU-0258", name: "Henry Gao", initials: "HG", status: "待排课", owner: "思佳", course: "HSC Mathematics Advanced", timezone: "Australia/Sydney · UTC+10", guardian: "Gao 先生 · 企业微信客户群", teacher: "待匹配", next: "确认长期时间", nextTone: "blue", files: 2 },
  { id: "STU-0259", name: "Sophia Wu", initials: "SW", status: "试听中", owner: "Tara", course: "VCE English", timezone: "Australia/Melbourne · UTC+10", guardian: "Wu 女士 · 企业微信客户", teacher: "Amelia Brown", next: "试听前 N-2 检查", nextTone: "red", files: 5 },
  { id: "STU-0260", name: "Jack Huang", initials: "JH", status: "在读", owner: "Tiffany", course: "IB Mathematics AI", timezone: "Asia/Shanghai · UTC+8", guardian: "Huang 女士 · 企业微信客户群", teacher: "Daniel Wu", next: "确认下月课表", nextTone: "amber", files: 11 },
  { id: "STU-0261", name: "Ella Zhou", initials: "EZ", status: "在读", owner: "Abby", course: "Year 10 Chemistry", timezone: "Australia/Brisbane · UTC+10", guardian: "Zhou 先生 · 企业微信客户", teacher: "Rachel Song", next: "补充最近成绩单", nextTone: "amber", files: 4 },
  { id: "STU-0262", name: "William Tang", initials: "WT", status: "待续课", owner: "思佳", course: "HSC English Advanced", timezone: "Australia/Sydney · UTC+10", guardian: "Tang 女士 · 企业微信客户群", teacher: "Amelia Brown", next: "确认新学期目标", nextTone: "purple", files: 8 },
];

const initialStudentDetails: Record<string, Partial<Student>> = {
  "STU-0248": { segment: "试听", grade: "Year 10", gradeBaseYear: 2026, location: "VIC", planner: "Tara", remainingHours: 0, lpNeed: "试听LP", reportProgress: "待试听后补充", followUp: "待完成试听", notes: "试听资料仍需确认" },
  "STU-0194": { segment: "已报名", grade: "Year 11", gradeBaseYear: 2026, location: "NSW", planner: "Eileen", remainingHours: 12, lpNeed: "老生新LP", reportProgress: "Semester 1 已归档", followUp: "2026-07-16", examSubject: "IB Mathematics", notes: "需要保留历史 LP 版本" },
  "STU-0231": { segment: "已报名", grade: "Year 12", gradeBaseYear: 2026, location: "VIC", planner: "Tara", remainingHours: 4, lpNeed: "LP修改", reportProgress: "待上传", followUp: "2026-07-18", examSubject: "VCE Chemistry", notes: "考试日期变更后需复核排课" },
  "STU-0176": { segment: "已报名", grade: "Year 12", gradeBaseYear: 2026, location: "WA", planner: "Tara", remainingHours: 3, lpNeed: "无需LP", reportProgress: "已完成", followUp: "2026-07-17", notes: "低课时强提醒仅在在读状态生效" },
  "STU-0251": { segment: "试听", grade: "Year 8", gradeBaseYear: 2026, location: "VIC", planner: "Eileen", lpNeed: "试听LP", reportProgress: "未开始", followUp: "待试听", notes: "等待匹配老师" },
  "STU-0252": { segment: "已报名", grade: "Year 11", gradeBaseYear: 2026, location: "NSW", planner: "Tara", remainingHours: 9, lpNeed: "无需LP", reportProgress: "已归档", followUp: "2026-07-15", examSubject: "IB Chemistry", notes: "无特殊备注" },
  "STU-0253": { segment: "试听", grade: "Year 11", gradeBaseYear: 2026, location: "CHN", planner: "Eileen", lpNeed: "试听LP", reportProgress: "未开始", followUp: "待试听反馈", notes: "中国时区" },
  "STU-0254": { segment: "已报名", grade: "Year 9", gradeBaseYear: 2025, location: "VIC", planner: "Tara", remainingHours: 7, lpNeed: "老生新LP", reportProgress: "待更新", followUp: "2026-07-14", examSubject: "VCE Physics", notes: "系统按基准年份自动显示当前年级" },
  "STU-0255": { segment: "已报名", grade: "Year 9", gradeBaseYear: 2026, location: "QLD", planner: "Eileen", remainingHours: 2, lpNeed: "无需LP", reportProgress: "暂停", followUp: "等待复课", notes: "停课学生不进入低课时强提醒" },
};

const initialStudents: Student[] = baseStudents.map((student) => ({ ...student, ...initialStudentDetails[student.id] }));
const sampleStudentIds = new Set(initialStudents.map((student) => student.id));

const baseTeachers: Teacher[] = [
  { id: "TEA-011", name: "Amelia Brown", initials: "AB", subjects: ["Year 10 English", "VCE English"], timezone: "Australia/Melbourne · UTC+10", availability: "周六 15:00-20:00", load: 8, capacity: 12, acceptsStudents: true, note: "长期时段匹配，试听经验充足" },
  { id: "TEA-027", name: "Grace Lin", initials: "GL", subjects: ["Year 7-10 English", "写作"], timezone: "Australia/Sydney · UTC+10", availability: "周六 16:00-19:00", load: 10, capacity: 12, acceptsStudents: true, note: "科目匹配，当前负载偏高" },
  { id: "TEA-042", name: "Rachel Song", initials: "RS", subjects: ["Year 9-10 English"], timezone: "Australia/Brisbane · UTC+10", availability: "周六 14:00-17:00", load: 4, capacity: 10, acceptsStudents: false, note: "需确认家长对老师背景的偏好" },
  { id: "TEA-053", name: "Daniel Wu", initials: "DW", subjects: ["IB Mathematics AA HL", "IB Mathematics AI"], timezone: "Australia/Sydney · UTC+10", availability: "周四 17:00-21:00", load: 7, capacity: 10, acceptsStudents: true, note: "IB 课程规划完成，长期时段稳定" },
  { id: "TEA-061", name: "Michael Yu", initials: "MY", subjects: ["VCE Physics", "Year 10-12 Physics"], timezone: "Australia/Melbourne · UTC+10", availability: "周二、周日 17:00-21:00", load: 9, capacity: 12, acceptsStudents: true, note: "物理课程稳定，可接一位长期学生" },
  { id: "TEA-067", name: "Olivia Park", initials: "OP", subjects: ["IB Chemistry HL", "VCE Chemistry"], timezone: "Australia/Sydney · UTC+10", availability: "周三、周六 16:00-20:00", load: 5, capacity: 10, acceptsStudents: true, note: "化学方向匹配，可承担试听" },
  { id: "TEA-071", name: "Kevin Zhang", initials: "KZ", subjects: ["HSC Mathematics Advanced", "Year 7-10 Mathematics"], timezone: "Australia/Brisbane · UTC+10", availability: "周一、周五 18:00-21:00", load: 10, capacity: 10, acceptsStudents: false, note: "当前满载，仅保留代课候选" },
  { id: "TEA-076", name: "Lily Chen", initials: "LC", subjects: ["IB Economics HL", "VCE Economics"], timezone: "Australia/Melbourne · UTC+10", availability: "周六、周日 10:00-16:00", load: 3, capacity: 9, acceptsStudents: true, note: "经济学方向，周末容量充足" },
  { id: "TEA-082", name: "Sophie Martin", initials: "SM", subjects: ["HSC English Advanced", "VCE English"], timezone: "Australia/Sydney · UTC+10", availability: "周二、周四 17:30-21:00", load: 6, capacity: 10, acceptsStudents: true, note: "高年级英语与写作经验" },
  { id: "TEA-088", name: "Andrew Liu", initials: "AL", subjects: ["Year 7-10 Science", "Year 10 Chemistry"], timezone: "Australia/Perth · UTC+8", availability: "周末 13:00-18:00", load: 4, capacity: 8, acceptsStudents: true, note: "西澳时区，适合中国晚间课程" },
];

const initialTeacherDetails: Record<string, Partial<Teacher>> = {
  "TEA-011": { departments: ["中小学"], location: "VIC", availabilityTimezone: "Australia/Melbourne", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 6, start: "15:00", end: "20:00" }] },
  "TEA-027": { departments: ["中小学"], location: "NSW", availabilityTimezone: "Australia/Sydney", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 6, start: "16:00", end: "19:00" }] },
  "TEA-042": { departments: ["中小学"], location: "QLD", availabilityTimezone: "Australia/Brisbane", availabilityStatus: "暂停接新", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 6, start: "14:00", end: "17:00" }] },
  "TEA-053": { departments: ["中小学", "大学"], location: "NSW", availabilityTimezone: "Australia/Sydney", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 4, start: "17:00", end: "21:00" }] },
  "TEA-061": { departments: ["中小学", "大学"], location: "VIC", availabilityTimezone: "Australia/Melbourne", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 2, start: "17:00", end: "21:00" }, { day: 0, start: "17:00", end: "21:00" }] },
  "TEA-067": { departments: ["中小学", "大学"], location: "NSW", availabilityTimezone: "Australia/Sydney", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 3, start: "16:00", end: "20:00" }, { day: 6, start: "16:00", end: "20:00" }] },
  "TEA-071": { departments: ["中小学"], location: "QLD", availabilityTimezone: "Australia/Brisbane", availabilityStatus: "暂停接新", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 1, start: "18:00", end: "21:00" }, { day: 5, start: "18:00", end: "21:00" }] },
  "TEA-076": { departments: ["中小学", "大学"], location: "VIC", availabilityTimezone: "Australia/Melbourne", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 6, start: "10:00", end: "16:00" }, { day: 0, start: "10:00", end: "16:00" }] },
  "TEA-082": { departments: ["中小学"], location: "NSW", availabilityTimezone: "Australia/Sydney", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 2, start: "17:30", end: "21:00" }, { day: 4, start: "17:30", end: "21:00" }] },
  "TEA-088": { departments: ["中小学"], location: "WA", availabilityTimezone: "Australia/Perth", availabilityStatus: "可接新生", availabilityUpdated: "近期 AVA", availabilitySlots: [{ day: 6, start: "13:00", end: "18:00" }, { day: 0, start: "13:00", end: "18:00" }] },
};

const initialTeachers: Teacher[] = baseTeachers.map((teacher) => ({ ...teacher, ...initialTeacherDetails[teacher.id] }));
const sampleTeacherIds = new Set(initialTeachers.map((teacher) => teacher.id));
function buildRuntimeDefaults(importPayload?: ImportPayload) {
  const realStudents = (importPayload?.students ?? []).filter((student) => student?.id && student?.name);
  const realTeachers = (importPayload?.teachers ?? []).filter((teacher) => teacher?.id && teacher?.name);
  const hasRealData = Boolean(realStudents.length || realTeachers.length);
  const importedAt = importPayload?.meta?.createdAt ?? new Date().toISOString().slice(0, 10);

  return {
    defaultStudents: hasRealData ? realStudents : initialStudents,
    defaultTeachers: hasRealData ? realTeachers : initialTeachers,
    defaultTasks: hasRealData ? importPayload?.tasks ?? [] : initialTasks,
    defaultBookings: hasRealData ? importPayload?.bookings ?? [] : initialBookings,
    defaultCourses: hasRealData ? importPayload?.courses ?? [] : [],
    defaultLpItems: hasRealData ? importPayload?.lpItems ?? [] : initialLp,
    defaultOperations: hasRealData ? importPayload?.operations ?? [] : initialOperations,
    defaultRenewals: hasRealData ? importPayload?.renewals ?? [] : initialRenewals,
    defaultPayroll: hasRealData ? importPayload?.payroll ?? [] : initialPayroll,
    defaultMessages: hasRealData ? importPayload?.messages ?? [] : initialMessages,
    defaultFiles: hasRealData ? importPayload?.files ?? [] : initialFiles,
    defaultAudit: hasRealData ? importPayload?.audit ?? [] : initialAudit,
    defaultRules: importPayload?.rules ?? defaultRules,
    defaultDataSnapshot: importPayload?.dataSnapshot ?? (hasRealData
      ? { label: "Supabase 真实资料快照", students: realStudents.length, teachers: realTeachers.length, importedAt }
      : { label: "脱敏示例数据", students: initialStudents.length, teachers: initialTeachers.length, importedAt: "未导入" }),
    defaultSelectedStudentId: realStudents[0]?.id ?? "STU-0248",
    defaultSelectedTeacherId: realTeachers[0]?.id ?? "TEA-011",
    storagePrefix: hasRealData ? `yinling-mvp-supabase-${importedAt}` : "yinling-mvp",
  };
}

const initialTasks: Task[] = [];
const initialBookings: Booking[] = [];
const initialLp: LpItem[] = [];
const initialOperations: Operation[] = [];
const initialRenewals: Renewal[] = [];
const initialPayroll: PayrollRow[] = [];
const initialMessages: Message[] = [];
const initialFiles: FileRecord[] = [];
const initialAudit: AuditEntry[] = [];

const defaultRules: Rules = { lpDays: "N-3", feedbackHours: "48", renewalDays: "8", escalation: "逾期 4 小时后通知主管", lowHours: "5", examDays: "30" };
const lpStages: LpItem["stage"][] = [...LP_STAGES];
const lpWorkflowOptions: Array<{ id: LpWorkflowType; lpNeed: LpNeed; title: string; detail: string }> = [
  { id: "试听 LP", lpNeed: "试听LP", title: "试听 LP", detail: "试听资料、老师备课、收费与试听后跟进" },
  { id: "老师新 LP", lpNeed: "老生新LP", title: "老师新 LP", detail: "新老师接手课程的资料交接" },
  { id: "老师 LP 修改", lpNeed: "LP修改", title: "老师 LP 修改", detail: "老师反馈修改后重新审核" },
  { id: "换老师试听", lpNeed: "试听LP", title: "换老师试听", detail: "更换老师后的试听交接" },
  { id: "代课 LP", lpNeed: "代课LP", title: "代课 LP", detail: "原老师指定内容、资料和新老师交接" },
  { id: "学生直报（无试听）", lpNeed: "新生LP", title: "学生直报（无试听）", detail: "直报学生的课程与购买课时交接" },
  { id: "学生报名交接", lpNeed: "新生LP", title: "学生报名交接", detail: "试听后报名的信息交接" },
];

function mergeConcurrentPayload<T>(committed: T, local: T, remote: T) {
  if (!Array.isArray(committed) || !Array.isArray(local) || !Array.isArray(remote)) return { value: remote, conflicts: 0 };
  const isItem = (value: unknown): value is { id: string } => Boolean(value) && typeof value === "object" && !Array.isArray(value) && typeof (value as { id?: unknown }).id === "string";
  if (![...committed, ...local, ...remote].every(isItem)) return { value: remote, conflicts: 0 };

  const baseline = new Map(committed.map((item) => [item.id, item]));
  const localItems = new Map(local.map((item) => [item.id, item]));
  const remoteItems = new Map(remote.map((item) => [item.id, item]));
  const orderedIds = [...new Set([...remote.map((item) => item.id), ...local.map((item) => item.id)])];
  let conflicts = 0;
  const value = orderedIds.flatMap((itemId) => {
    const base = baseline.get(itemId);
    const localItem = localItems.get(itemId);
    const remoteItem = remoteItems.get(itemId);
    if (!base) return [localItem ?? remoteItem].filter(Boolean);
    if (!localItem) return remoteItem ? [remoteItem] : [];
    if (!remoteItem) return [localItem];
    const localChanged = JSON.stringify(localItem) !== JSON.stringify(base);
    const remoteChanged = JSON.stringify(remoteItem) !== JSON.stringify(base);
    if (localChanged && remoteChanged && JSON.stringify(localItem) !== JSON.stringify(remoteItem)) {
      conflicts += 1;
      return [remoteItem];
    }
    return [localChanged ? localItem : remoteItem];
  });
  return { value: value as T, conflicts };
}

function useSharedState<T>(
  entity: string,
  initialValue: T,
  initialVersion: number,
  actor: string,
  onSync: (state: SharedSyncState, message?: string) => void,
  readOnly = false,
) {
  const [value, setValue] = useState<T>(initialValue);
  const [version, setVersion] = useState(initialVersion);
  const versionRef = useRef(initialVersion);
  const valueRef = useRef(initialValue);
  const readyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const committedRef = useRef(JSON.stringify(initialValue));

  useEffect(() => {
    readyRef.current = true;
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (!readyRef.current || readOnly) return;
    const serialized = JSON.stringify(value);
    if (serialized === committedRef.current) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    onSync("saving", `正在保存 ${entity}`);

    timerRef.current = window.setTimeout(() => {
      const payload = value;
      const payloadSerialized = serialized;
      queueRef.current = queueRef.current.then(async () => {
        const response = await fetch("/api/app-state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entity, payload, expectedVersion: versionRef.current }),
        });
        const body = await response.json().catch(() => ({}));

        if (response.status === 409 && body.current) {
          const current = body.current as RemoteStateRow<T>;
          const merged = mergeConcurrentPayload(JSON.parse(committedRef.current) as T, valueRef.current, current.payload);
          committedRef.current = JSON.stringify(current.payload);
          versionRef.current = current.version;
          setVersion(current.version);
          setValue(merged.value);
          onSync("conflict", merged.conflicts ? `${entity} 有 ${merged.conflicts} 条同一记录被其他人更新，已保留最新版本，请复核` : `${entity} 已合并其他人的更新，正在保存你的改动`);
          return;
        }
        if (!response.ok || !body.row) throw new Error(body.error || `${entity} 保存失败`);

        const row = body.row as RemoteStateRow<T>;
        committedRef.current = payloadSerialized;
        versionRef.current = row.version;
        setVersion(row.version);
        onSync("synced", `${entity} 已同步`);
      }).catch((error: unknown) => {
        onSync(navigator.onLine ? "error" : "offline", error instanceof Error ? error.message : `${entity} 保存失败`);
      });
    }, 450);
  }, [actor, entity, onSync, readOnly, value]);

  const applyRemote = useCallback((row: RemoteStateRow<T>) => {
    if (row.version <= versionRef.current) return;
    const local = valueRef.current;
    const committed = JSON.parse(committedRef.current) as T;
    const hasPendingLocalChanges = JSON.stringify(local) !== committedRef.current;
    const merged = hasPendingLocalChanges ? mergeConcurrentPayload(committed, local, row.payload) : { value: row.payload, conflicts: 0 };
    committedRef.current = JSON.stringify(row.payload);
    versionRef.current = row.version;
    setVersion(row.version);
    setValue(merged.value);
    onSync(merged.conflicts ? "conflict" : "synced", merged.conflicts ? `${entity} 有 ${merged.conflicts} 条同一记录已更新，请复核` : hasPendingLocalChanges ? `${entity} 已合并其他人的更新` : `${entity} 已接收 ${row.updated_by} 的更新`);
  }, [entity, onSync]);

  return [value, setValue, { version, applyRemote }] as const;
}

function nowLabel(preferences = defaultDisplayPreferences()) {
  return formatClock(new Date(), preferences.timezone, preferences);
}

function currentLocalDateTimeValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 16);
}

function currentDateTimeValueInTimezone(timezone: string) {
  const parts = zonedParts(new Date(), cleanTimezone(timezone));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function formatFollowUpTime(value?: string, preferences = defaultDisplayPreferences()) {
  if (!value) return preferences.language === "en-AU" ? "No successful follow-up recorded" : "暂无成功跟进记录";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T12:00:00Z`);
    const suffix = preferences.language === "en-AU" ? "(time not recorded in the historical entry)" : "（历史记录未含具体时间）";
    return `${formatDisplayDate(date, preferences.timezone, preferences)} ${suffix}`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${formatDisplayDate(parsed, preferences.timezone, preferences)} ${formatClock(parsed, preferences.timezone, preferences)}`;
}

let uniqueSequence = 0;

function id(prefix: string) {
  uniqueSequence += 1;
  return `${prefix}-${Date.now().toString().slice(-6)}-${uniqueSequence}`;
}

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "新";
}

const timezoneOptions = displayTimezoneOptions.map((option) => ({ ...option, label: option.zh }));

function timezoneLabel(value: string, language: InterfaceLanguage = "zh-CN") {
  const timezone = cleanTimezone(value);
  return timezoneLabelFor(timezone, language);
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])) as Record<string, string>;
}

function timezoneOffsetMs(date: Date, timezone: string) {
  const parts = zonedParts(date, timezone);
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - date.getTime();
}

function zonedDateTimeToUtc(date: string, time: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  const first = new Date(wallClock - timezoneOffsetMs(new Date(wallClock), timezone));
  return new Date(wallClock - timezoneOffsetMs(first, timezone));
}

function bookingInstant(booking: Booking) {
  return zonedDateTimeToUtc(booking.date, booking.start, cleanTimezone(booking.timezone));
}

function formatDisplayDate(date: Date, timezone: string, preferences = defaultDisplayPreferences()) {
  const parts = zonedParts(date, cleanTimezone(timezone));
  return preferences.dateFormat === "ymd"
    ? `${parts.year}/${parts.month}/${parts.day}`
    : `${parts.day}/${parts.month}/${parts.year}`;
}

function formatInstant(date: Date, timezone: string, preferences = defaultDisplayPreferences()) {
  const safeTimezone = cleanTimezone(timezone);
  const weekday = new Intl.DateTimeFormat(localeFor(preferences.language), { timeZone: safeTimezone, weekday: "short" }).format(date);
  return `${formatDisplayDate(date, safeTimezone, preferences)} ${weekday} ${formatClock(date, safeTimezone, preferences)}`;
}

function formatHours(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "待匹配";
  return `${Number(value.toFixed(2)).toLocaleString()} 小时`;
}

function formatMoney(amount: number, currency: PayrollRow["currency"] = "AUD") {
  const prefix = currency === "CNY" ? "¥" : "A$";
  return `${prefix}${Number(amount.toFixed(2)).toLocaleString()}`;
}

function payrollCurrencyLabel(currency: PayrollRow["currency"] = "AUD") {
  return currency === "CNY" ? "人民币" : "澳币";
}

function maskAccount(value?: string) {
  if (!value) return "未导入";
  if (value.startsWith("尾号")) return value;
  const compact = value.replace(/\s+/g, "");
  if (!compact) return "未导入";
  return `尾号 ${compact.slice(-4)}`;
}

function formatClock(date: Date, timezone: string, preferences = defaultDisplayPreferences()) {
  const parts = zonedParts(date, cleanTimezone(timezone));
  if (preferences.timeFormat === "12h") {
    const hour = Number(parts.hour);
    const marker = preferences.language === "en-AU" ? (hour < 12 ? "am" : "pm") : (hour < 12 ? "上午" : "下午");
    return `${hour % 12 || 12}:${parts.minute} ${marker}`;
  }
  return `${parts.hour}:${parts.minute}`;
}

function isoDateInTimezone(date: Date, timezone: string) {
  const parts = zonedParts(date, cleanTimezone(timezone));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isPastBooking(booking: Booking) {
  const startsAt = bookingInstant(booking).getTime();
  const endsAt = startsAt + Math.max(1, booking.duration || 0) * 60 * 1000;
  return endsAt < Date.now();
}

function formatSourceTime(value?: string | null, preferences = defaultDisplayPreferences()) {
  if (!value) return preferences.language === "en-AU" ? "Never synced" : "从未读取";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${formatDisplayDate(parsed, preferences.timezone, preferences)} ${formatClock(parsed, preferences.timezone, preferences)}`;
}

function sourceIsStale(source: SyncSource, now = Date.now()) {
  const syncedAt = new Date(source.synced_at).getTime();
  return !Number.isFinite(syncedAt) || now - syncedAt > 36 * 60 * 60 * 1000;
}

function formatAuditTime(value: string, preferences = defaultDisplayPreferences()) {
  if (!value || value.startsWith("今天") || value.startsWith("昨天")) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${formatDisplayDate(parsed, preferences.timezone, preferences)} ${formatClock(parsed, preferences.timezone, preferences)}`;
}

function shiftIsoDate(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function daysBetweenIsoDates(from: string, to: string) {
  const start = new Date(`${from}T12:00:00Z`).getTime();
  const end = new Date(`${to}T12:00:00Z`).getTime();
  return Math.round((end - start) / 86400000);
}

function weekDatesForTimezone(timezone: string, preferences = defaultDisplayPreferences()) {
  const today = isoDateInTimezone(new Date(), timezone);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday = shiftIsoDate(today, weekday === 0 ? -6 : 1 - weekday);
  return Array.from({ length: 7 }, (_, index) => {
    const date = shiftIsoDate(monday, index);
    const dateAtNoon = new Date(`${date}T12:00:00Z`);
    return { date, label: new Intl.DateTimeFormat(localeFor(preferences.language), { weekday: "short", day: "numeric", timeZone: "UTC" }).format(dateAtNoon) };
  });
}

function monthDatesForTimezone(timezone: string, monthOffset: number, preferences = defaultDisplayPreferences()) {
  const today = isoDateInTimezone(new Date(), timezone);
  const [currentYear, currentMonth] = today.split("-").map(Number);
  const monthStart = new Date(Date.UTC(currentYear, currentMonth - 1 + monthOffset, 1));
  const year = monthStart.getUTCFullYear();
  const month = monthStart.getUTCMonth();
  const firstDate = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const weekday = monthStart.getUTCDay();
  const gridStart = shiftIsoDate(firstDate, weekday === 0 ? -6 : 1 - weekday);
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = shiftIsoDate(gridStart, index);
    const parsed = new Date(`${date}T12:00:00Z`);
    return {
      date,
      day: parsed.getUTCDate(),
      inMonth: parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month,
    };
  });
  return {
    label: new Intl.DateTimeFormat(localeFor(preferences.language), { year: "numeric", month: "long", timeZone: "UTC" }).format(monthStart),
    days,
  };
}

function bookingOccurrencesWithinRange(booking: Booking, rangeStart: string, rangeEnd: string): BookingOccurrence[] {
  if (!rangeStart || !rangeEnd || rangeStart > rangeEnd || booking.date > rangeEnd) return [];
  if (!booking.recurring) return booking.date >= rangeStart ? [{ ...booking, occurrenceKey: `${booking.id}:${booking.date}` }] : [];

  const daysUntilRange = daysBetweenIsoDates(booking.date, rangeStart);
  const firstOffset = daysUntilRange > 0 ? Math.ceil(daysUntilRange / 7) * 7 : 0;
  const occurrences: BookingOccurrence[] = [];
  let occurrenceIndex = firstOffset / 7;
  const repeatCount = booking.repeatCount == null ? Number.POSITIVE_INFINITY : Math.max(1, booking.repeatCount);
  for (let date = shiftIsoDate(booking.date, firstOffset); date <= rangeEnd && occurrenceIndex < repeatCount; date = shiftIsoDate(date, 7)) {
    occurrences.push({ ...booking, date, occurrenceKey: `${booking.id}:${date}` });
    occurrenceIndex += 1;
  }
  return occurrences;
}

function taskTiming(dueDate: string, timezone = "Australia/Melbourne", futureTone: Tone = "blue") {
  const dueAt = zonedDateTimeToUtc(dueDate, "18:00", timezone);
  const status = statusForDueAt(dueAt, new Date(), timezone);
  return {
    due: `${dueDate} 18:00`,
    dueAt: dueAt.toISOString(),
    status,
    tone: status === "overdue" ? "red" as const : status === "today" ? "amber" as const : futureTone,
  };
}

function displayAvaSlotsForDates(teacher: Teacher, targetTimezone: string, dates: string[], preferences = defaultDisplayPreferences()) {
  const sourceTimezone = cleanTimezone(teacher.availabilityTimezone ?? teacher.timezone);
  if (!dates.length) return [];
  const visibleDates = new Set(dates);
  const slots = teacher.availabilitySlots ?? [];
  const results: Array<{ date: string; start: string; end: string; slotIndex: number }> = [];
  for (let sourceDate = shiftIsoDate(dates[0], -1); sourceDate <= shiftIsoDate(dates.at(-1)!, 1); sourceDate = shiftIsoDate(sourceDate, 1)) {
    const sourceDay = new Date(`${sourceDate}T12:00:00Z`).getUTCDay();
    slots.forEach((slot, slotIndex) => {
      if (slot.day !== sourceDay) return;
      const start = zonedDateTimeToUtc(sourceDate, slot.start, sourceTimezone);
      const end = zonedDateTimeToUtc(sourceDate, slot.end, sourceTimezone);
      const displayed = zonedParts(start, cleanTimezone(targetTimezone));
      const displayedDate = `${displayed.year}-${displayed.month}-${displayed.day}`;
      if (!visibleDates.has(displayedDate)) return;
      results.push({ date: displayedDate, start: formatClock(start, targetTimezone, preferences), end: formatClock(end, targetTimezone, preferences), slotIndex });
    });
  }
  return results;
}

function lpPublishedDay(item: LpItem) {
  if (!item.publishedDate) return null;
  const elapsed = Math.max(0, daysBetweenIsoDates(item.publishedDate, isoDateInTimezone(new Date(), "Australia/Melbourne")));
  return `已发布第 ${elapsed + 1} 天`;
}

function currentGrade(student: Student) {
  const grade = student.grade?.trim();
  if (!grade) return "年级待确认";
  const match = grade.match(/^Year\s*(\d+)$/i);
  if (!match || !student.gradeBaseYear) return grade;
  const progressed = Math.min(12, Number(match[1]) + Math.max(0, new Date().getFullYear() - student.gradeBaseYear));
  return `Year ${progressed}`;
}

function isActiveStudent(student: Student) {
  return student.status === "在读" || student.status === "待续课";
}

function requiresLp(student: Student) {
  return Boolean(student.lpNeed && student.lpNeed !== "无需LP" && student.lpNeed !== "待确认");
}

function availabilityInTimezone(teacher: Teacher, targetTimezone: string, preferences = defaultDisplayPreferences()) {
  if (!teacher.availabilitySlots?.length) {
    return preferences.language === "en-AU"
      ? `${teacher.availability} (original text; needs structuring)`
      : `${teacher.availability}（原文，待结构化）`;
  }
  const targetWeek = weekDatesForTimezone(targetTimezone, preferences);
  return teacher.availabilitySlots.map((slot) => {
    const dayOffset = slot.day === 0 ? 6 : slot.day - 1;
    const date = targetWeek[dayOffset]?.date ?? targetWeek[0].date;
    const sourceTimezone = cleanTimezone(teacher.availabilityTimezone ?? teacher.timezone);
    const start = zonedDateTimeToUtc(date, slot.start, sourceTimezone);
    const end = zonedDateTimeToUtc(date, slot.end, sourceTimezone);
    return `${formatInstant(start, targetTimezone, preferences)}-${formatClock(end, targetTimezone, preferences)}`;
  }).join("；");
}

function availabilitySummary(teacher: Teacher) {
  const slotCount = teacher.availabilitySlots?.length ?? 0;
  if (!slotCount) return { title: "待结构化", detail: "原始 AVA · 详情查看", raw: true };
  return { title: `${slotCount} 个可约时段`, detail: `已结构化 · ${teacher.availabilityUpdated ?? "教师总表"}`, raw: false };
}

function availabilitySlotsText(slots: AvailabilitySlot[]) {
  if (!slots.length) return "AVA 待确认";
  const dayLabels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return [...slots]
    .sort((left, right) => left.day - right.day || left.start.localeCompare(right.start))
    .map((slot) => `${dayLabels[slot.day]} ${slot.start}-${slot.end}`)
    .join("；");
}

function teacherAvailableAt(teacher: Teacher, date: string, start: string, duration: number, inputTimezone: string) {
  if (!teacher.availabilitySlots?.length) return false;
  const requestedStart = zonedDateTimeToUtc(date, start, inputTimezone);
  const requestedEnd = new Date(requestedStart.getTime() + duration * 60000);
  const teacherTimezone = cleanTimezone(teacher.availabilityTimezone ?? teacher.timezone);
  const local = zonedParts(requestedStart, teacherTimezone);
  const localDate = `${local.year}-${local.month}-${local.day}`;
  const localDay = new Date(`${localDate}T12:00:00Z`).getUTCDay();
  return teacher.availabilitySlots.some((slot) => {
    if (slot.day !== localDay) return false;
    const slotStart = zonedDateTimeToUtc(localDate, slot.start, teacherTimezone);
    const slotEnd = zonedDateTimeToUtc(localDate, slot.end, teacherTimezone);
    return requestedStart >= slotStart && requestedEnd <= slotEnd;
  });
}

function bookingHasDstRisk(booking: Booking, student: Student, teacher: Teacher) {
  if (!booking.recurring) return false;
  const rangeEnd = booking.repeatCount == null
    ? shiftIsoDate(booking.date, 140)
    : shiftIsoDate(booking.date, Math.min(140, Math.max(0, booking.repeatCount - 1) * 7));
  const occurrences = bookingOccurrencesWithinRange(booking, booking.date, rangeEnd);
  if (occurrences.length < 2) return false;
  const studentTimezone = cleanTimezone(student.timezone);
  const teacherTimezone = cleanTimezone(teacher.timezone);
  const initialInstant = bookingInstant(occurrences[0]);
  const initialDifference = timezoneOffsetMs(initialInstant, studentTimezone) - timezoneOffsetMs(initialInstant, teacherTimezone);
  return occurrences.slice(1).some((occurrence) => {
    const instant = bookingInstant(occurrence);
    return timezoneOffsetMs(instant, studentTimezone) - timezoneOffsetMs(instant, teacherTimezone) !== initialDifference;
  });
}

function statusTone(status: Student["status"] | TaskStatus | PayrollRow["status"] | Renewal["status"]): Tone {
  const map: Record<string, Tone> = {
    "试听中": "amber", "在读": "green", "待排课": "blue", "待确认": "neutral", "待续课": "purple", "停课": "red", "非在读": "neutral", "不活跃": "neutral",
    overdue: "red", today: "amber", upcoming: "blue", waiting: "purple", done: "green",
    "需核对": "amber", "可审核": "blue", "已锁定": "green",
    "待跟进": "amber", "已联系": "blue", "已跟进": "blue", "本次未跟进": "amber", "等待家长": "purple", "已确认": "green",
    "已续课": "green", "未续课-活跃": "amber", "未续课-不活跃": "neutral", "未续课-不活跃（已考完）": "neutral",
  };
  return map[status] ?? "neutral";
}

function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function Avatar({ initials: letters, tone = "blue" }: { initials: string; tone?: Tone }) {
  return <span className={`avatar ${tone}`}>{letters}</span>;
}

function IconButton({ label, children, onClick }: { label: string; children: ReactNode; onClick?: () => void }) {
  return <button className="icon-button" aria-label={label} title={label} type="button" onClick={onClick}>{children}</button>;
}

function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header"><div><p className="eyebrow">真实资料 · 保存后多人可见</p><h2>{title}</h2></div><IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton></header>
        {children}
      </section>
    </div>
  );
}

function ViewTabs({ value, items, onChange, label = "保存视图" }: { value: string; items: Array<{ id: string; label: string; count?: number }>; onChange: (value: string) => void; label?: string }) {
  return <div className="view-tabs" role="tablist" aria-label={label}>{items.map((item) => <button className={value === item.id ? "active" : ""} type="button" role="tab" aria-selected={value === item.id} key={item.id} onClick={() => onChange(item.id)}>{item.label}{item.count !== undefined && <span>{item.count}</span>}</button>)}</div>;
}

function ListToolbar({ query, onQuery, placeholder, count, children }: { query: string; onQuery: (value: string) => void; placeholder: string; count: string; children?: ReactNode }) {
  return <div className="collection-toolbar"><div className="search-field"><Search size={16} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder={placeholder} aria-label={placeholder} /></div><div className="toolbar-actions">{children}<span className="result-count">{count}</span></div></div>;
}

function Pagination({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (page: number) => void }) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const end = Math.min(safePage * pageSize, total);
  return <footer className="pagination"><span>显示 {start}-{end}，共 {total} 条</span><div><button type="button" aria-label="上一页" disabled={safePage <= 1} onClick={() => onPage(safePage - 1)}><ChevronLeft size={16} /></button><strong>第 {safePage} / {pageCount} 页</strong><button type="button" aria-label="下一页" disabled={safePage >= pageCount} onClick={() => onPage(safePage + 1)}><ChevronRight size={16} /></button></div></footer>;
}

function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return <div className="collection-empty"><Search size={22} /><strong>{title}</strong>{detail ? <span>{detail}</span> : null}</div>;
}

function AuthStatusScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-mark">吟</div>
        <p className="eyebrow">内部教务系统</p>
        <h1>{title}</h1>
        <p className="login-copy">{detail}</p>
      </section>
    </main>
  );
}

function AuthLoginScreen({ onSubmit, loading, error }: { onSubmit: (password: string) => void; loading: boolean; error: string }) {
  const [password, setPassword] = useState("");

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-mark">吟</div>
        <p className="eyebrow">内部教务系统</p>
        <h1>吟领教务</h1>
        <p className="login-copy">请输入登录密码进入对应工作视图。</p>
        <form
          className="login-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(password);
          }}
        >
          <label htmlFor="password">登录密码</label>
          <input id="password" value={password} type="password" autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} required autoFocus />
          {error ? <span className="login-error">{error}</span> : null}
          <button type="submit" disabled={loading}>{loading ? "正在进入..." : "进入系统"}</button>
        </form>
      </section>
    </main>
  );
}

async function fetchSupabaseSnapshot() {
  const response = await fetch("/api/app-snapshot", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "真实资料读取失败。");
  return body as ImportPayload;
}

export default function OperationsApp() {
  const [authenticated, setAuthenticated] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [initialData, setInitialData] = useState<ImportPayload | null>(null);
  const [nixonAuthenticated, setNixonAuthenticated] = useState(false);
  const [sessionUser, setSessionUser] = useState("");
  const [dataError, setDataError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/demo-session", { cache: "no-store" })
      .then((response) => response.json())
      .then((body) => {
        if (!active) return;
        setAuthenticated(Boolean(body.ok));
        setSessionUser(typeof body.user === "string" ? body.user : "");
      })
      .catch(() => {
        if (active) setAuthenticated(false);
      })
      .finally(() => {
        if (active) setAuthLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!authenticated) return;

    let active = true;
    Promise.all([
      fetchSupabaseSnapshot(),
      fetch("/api/nixon-session", { cache: "no-store" }).then((response) => response.json()).catch(() => ({ ok: false })),
    ])
      .then(([payload, nixonSession]) => {
        if (!active) return;
        const hasRows = Boolean(payload.students?.length || payload.teachers?.length);
        if (!hasRows) {
          setDataError("当前账号未授权读取真实资料，或 Supabase 还没有导入数据。");
          setInitialData(null);
          return;
        }
        setNixonAuthenticated(Boolean(nixonSession.ok));
        setInitialData(payload);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setDataError(error instanceof Error ? error.message : "Supabase 数据读取失败。");
        setInitialData(null);
      });

    return () => {
      active = false;
    };
  }, [authenticated]);

  const submitPassword = async (password: string) => {
    setLoginLoading(true);
    setLoginError("");
    const response = await fetch("/api/demo-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const body = await response.json().catch(() => ({}));

    setLoginLoading(false);
    if (!response.ok) {
      setLoginError(body.error || "密码不正确。");
      return;
    }
    setAuthenticated(true);
    setSessionUser(typeof body.user === "string" ? body.user : "");
  };

  if (authLoading) return <AuthStatusScreen title="正在检查访问状态" detail="系统正在确认当前登录身份。" />;
  if (!authenticated) return <AuthLoginScreen onSubmit={submitPassword} loading={loginLoading} error={loginError} />;
  if (dataError) return <AuthStatusScreen title="无法读取真实资料" detail={dataError} />;
  if (!initialData) return <AuthStatusScreen title="正在加载资料" detail="已通过验证，正在读取学生和老师数据。" />;

  return <OperationsWorkspace initialData={initialData} initialNixonUnlocked={nixonAuthenticated} initialOperator={sessionUser} />;
}

function OperationsWorkspace({ initialData, initialNixonUnlocked, initialOperator }: { initialData?: ImportPayload; initialNixonUnlocked: boolean; initialOperator: string }) {
  const defaults = useMemo(() => buildRuntimeDefaults(initialData), [initialData]);
  const [active, setActive] = useState<Section>("dashboard");
  const sessionOperator = initialOperator || (initialNixonUnlocked ? "Nixon" : defaults.defaultStudents.find((student) => student.owner && student.owner !== "Nixon")?.owner ?? "Abby");
  const isAdminSession = initialNixonUnlocked && sessionOperator === "Nixon";
  const [currentOperator, setCurrentOperator] = useState(sessionOperator);
  const [displayPreferences, setDisplayPreferences] = useState<DisplayPreferences>(() => defaultDisplayPreferences(isDemoTeacher(sessionOperator)));
  const [displayPreferencesReady, setDisplayPreferencesReady] = useState(false);
  const [displayPreferencesOwner, setDisplayPreferencesOwner] = useState("");
  const [displayPreferencesOpen, setDisplayPreferencesOpen] = useState(false);
  const [sharedSyncState, setSharedSyncState] = useState<SharedSyncState>("synced");
  const [sharedSyncMessage, setSharedSyncMessage] = useState("Supabase 多人共享已连接");
  const reportSharedSync = useCallback((state: SharedSyncState, message = "") => {
    setSharedSyncState(state);
    if (message) setSharedSyncMessage(message);
  }, []);
  const versionFor = (entity: string) => initialData?.versions?.[entity] ?? 1;
  const [students, setStudents, studentsShared] = useSharedState("students", defaults.defaultStudents, versionFor("students"), currentOperator, reportSharedSync);
  const [teachers, setTeachers, teachersShared] = useSharedState("teachers", defaults.defaultTeachers, versionFor("teachers"), currentOperator, reportSharedSync);
  const [tasks, setTasks, tasksShared] = useSharedState("tasks", defaults.defaultTasks, versionFor("tasks"), currentOperator, reportSharedSync);
  const [bookings, setBookings, bookingsShared] = useSharedState("bookings", defaults.defaultBookings, versionFor("bookings"), currentOperator, reportSharedSync);
  const [courses, , coursesShared] = useSharedState("courses", defaults.defaultCourses, versionFor("courses"), currentOperator, reportSharedSync);
  const [lpItems, setLpItems, lpShared] = useSharedState("lpItems", defaults.defaultLpItems, versionFor("lpItems"), currentOperator, reportSharedSync);
  const [operations, setOperations, operationsShared] = useSharedState("operations", defaults.defaultOperations, versionFor("operations"), currentOperator, reportSharedSync);
  const [renewals, setRenewals, renewalsShared] = useSharedState("renewals", defaults.defaultRenewals, versionFor("renewals"), currentOperator, reportSharedSync);
  const [payroll, setPayroll, payrollShared] = useSharedState("payroll", defaults.defaultPayroll, versionFor("payroll"), currentOperator, reportSharedSync);
  const [messages, setMessages, messagesShared] = useSharedState("messages", defaults.defaultMessages, versionFor("messages"), currentOperator, reportSharedSync);
  const [files, setFiles, filesShared] = useSharedState("files", defaults.defaultFiles, versionFor("files"), currentOperator, reportSharedSync);
  const [audit, setAudit, auditShared] = useSharedState("audit", defaults.defaultAudit, versionFor("audit"), currentOperator, reportSharedSync, true);
  const [rules, setRules, rulesShared] = useSharedState("rules", defaults.defaultRules, versionFor("rules"), currentOperator, reportSharedSync);
  const [dataSnapshot, setDataSnapshot, dataSnapshotShared] = useSharedState("dataSnapshot", defaults.defaultDataSnapshot, versionFor("dataSnapshot"), currentOperator, reportSharedSync);
  const [syncSources, setSyncSources] = useState<SyncSource[]>(initialData?.syncSources ?? []);
  const [syncRefreshBusy, setSyncRefreshBusy] = useState(false);
  const [rulesDraft, setRulesDraft] = useState<Rules>(defaults.defaultRules);
  const [rulesDraftTouched, setRulesDraftTouched] = useState(false);
  const [selectedStudentId, setSelectedStudentId] = useState(defaults.defaultSelectedStudentId);
  const [selectedTeacherId, setSelectedTeacherId] = useState(defaults.defaultSelectedTeacherId);
  const [selectedMessageId, setSelectedMessageId] = useState("MSG-001");
  const [taskFilter, setTaskFilter] = useState<ToDoFilter>("all");
  const [taskRefreshKey, setTaskRefreshKey] = useState(0);
  const [search, setSearch] = useState("");
  const [studentView, setStudentView] = useState("all");
  const [studentOwner, setStudentOwner] = useState("all");
  const [studentPage, setStudentPage] = useState(1);
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [teacherQuery, setTeacherQuery] = useState("");
  const [teacherView, setTeacherView] = useState("available");
  const [teacherSubject, setTeacherSubject] = useState("all");
  const [teacherDay, setTeacherDay] = useState("all");
  const [teacherPage, setTeacherPage] = useState(1);
  const [scheduleMode, setScheduleMode] = useState<"week" | "agenda">("agenda");
  const [scheduleFilter, setScheduleFilter] = useState("all");
  const [scheduleDay, setScheduleDay] = useState("all");
  const [schedulePage, setSchedulePage] = useState(1);
  const [selectedBookingId, setSelectedBookingId] = useState("LES-001");
  const [selectedBookingDate, setSelectedBookingDate] = useState<string | null>(null);
  const [selectedBookingDateId, setSelectedBookingDateId] = useState<string | null>(null);
  const [selectedBookingIds, setSelectedBookingIds] = useState<string[]>([]);
  const [bookingDraft, setBookingDraft] = useState<Booking | null>(null);
  const [bookingPrefillStudentId, setBookingPrefillStudentId] = useState<string | null>(null);
  const [bookingPrefillTeacherId, setBookingPrefillTeacherId] = useState<string | null>(null);
  const [operationDraft, setOperationDraft] = useState<Partial<Operation> | null>(null);
  const [classroomRuntime, setClassroomRuntime] = useState<ClassroomRuntime | null>(null);
  const [classroomBusy, setClassroomBusy] = useState(false);
  const [classroomView, setClassroomView] = useState<"upcoming" | "history">("upcoming");
  const [temporaryClassroomLink, setTemporaryClassroomLink] = useState<{ bookingId: string; url: string } | null>(null);
  const [courseQuery, setCourseQuery] = useState("");
  const [coursePage, setCoursePage] = useState(1);
  const [selectedCourseId, setSelectedCourseId] = useState(defaults.defaultCourses[0]?.id ?? "");
  const [lpMode, setLpMode] = useState<"board" | "table">("board");
  const [lpFilter, setLpFilter] = useState("active");
  const [lpDraftType, setLpDraftType] = useState<LpWorkflowType>(LP_WORKFLOW_TYPES[0]);
  const [lpRevisionDraft, setLpRevisionDraft] = useState<LpItem | null>(null);
  const [avaView, setAvaView] = useState<"week" | "month">("week");
  const [avaMonthOffset, setAvaMonthOffset] = useState(0);
  const [avaDraft, setAvaDraft] = useState<{ teacherId: string; slotIndex: number; slot: AvailabilitySlot } | null>(null);
  const [operationFilter, setOperationFilter] = useState("open");
  const [selectedOperationId, setSelectedOperationId] = useState("OPS-001");
  const [renewalFilter, setRenewalFilter] = useState("attention");
  const [renewalPage, setRenewalPage] = useState(1);
  const [renewalDraft, setRenewalDraft] = useState<Renewal | null>(null);
  const [studentRecordKind, setStudentRecordKind] = useState<StudentRecordPanelSection>("lp");
  const [teacherCapacityDraft, setTeacherCapacityDraft] = useState<Teacher | null>(null);
  const [renewalUploadBusy, setRenewalUploadBusy] = useState(false);
  const [evidenceUploadBusy, setEvidenceUploadBusy] = useState(false);
  const [payrollFilter, setPayrollFilter] = useState("all");
  const [payrollCurrency, setPayrollCurrency] = useState("all");
  const [payrollMonthSelection, setPayrollMonthSelection] = useState("");
  const [payrollPage, setPayrollPage] = useState(1);
  const [selectedPayrollId, setSelectedPayrollId] = useState("");
  const [payrollDraft, setPayrollDraft] = useState<PayrollRow | null>(null);
  const availablePayrollMonths = useMemo(
    () => Array.from(new Set(payroll.map((row) => row.month).filter((month): month is string => Boolean(month)))).sort().reverse(),
    [payroll],
  );
  const activePayrollMonth = payrollMonthSelection || availablePayrollMonths[0] || new Date().toISOString().slice(0, 7);
  const monthPayroll = useMemo(
    () => payroll.filter((row) => row.month === activePayrollMonth),
    [activePayrollMonth, payroll],
  );
  const [messageFilter, setMessageFilter] = useState("open");
  const [messageQuery, setMessageQuery] = useState("");
  const [fileFilter, setFileFilter] = useState("all");
  const [fileQuery, setFileQuery] = useState("");
  const [reportOwner, setReportOwner] = useState("all");
  const [settingsTab, setSettingsTab] = useState("reminders");
  const [auditQuery, setAuditQuery] = useState("");
  const [auditFilter, setAuditFilter] = useState("all");
  const [auditPage, setAuditPage] = useState(1);
  const [selectedAccountName, setSelectedAccountName] = useState<string>("Admin");
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");
  const [modal, setModal] = useState<ModalKind>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [operatorMenuOpen, setOperatorMenuOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [mobilePreview, setMobilePreview] = useState<MobilePreview>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const interfaceRootRef = useRef<HTMLElement>(null);
  const operatorMenuRef = useRef<HTMLDivElement>(null);
  const operatorLabel = (operator: string) => operator === "Nixon" ? "Admin" : operator;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reads one external, account-scoped browser preference record after hydration.
    setDisplayPreferencesReady(false);
    const fallback = defaultDisplayPreferences(isDemoTeacher(sessionOperator));
    try {
      setDisplayPreferences(parseDisplayPreferences(window.localStorage.getItem(displayPreferencesStorageKey(sessionOperator)), fallback));
    } catch {
      setDisplayPreferences(fallback);
    } finally {
      setDisplayPreferencesOwner(sessionOperator);
      setDisplayPreferencesReady(true);
    }
  }, [sessionOperator]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setTaskRefreshKey(new Date().getTime()), 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!displayPreferencesReady || displayPreferencesOwner !== sessionOperator) return;
    try {
      window.localStorage.setItem(displayPreferencesStorageKey(sessionOperator), JSON.stringify(displayPreferences));
    } catch {
      // Browser storage can be unavailable in private mode; displaying the selected values still works for this session.
    }
  }, [displayPreferences, displayPreferencesOwner, displayPreferencesReady, sessionOperator]);

  useEffect(() => {
    document.documentElement.lang = displayPreferences.language;
    document.title = displayPreferences.language === "en-AU"
      ? "Yinling Operations"
      : "吟领教务 | Learning Operations";
  }, [displayPreferences.language]);

  useEffect(() => {
    if (!displayPreferencesReady || !interfaceRootRef.current) return;
    return observeInterfaceLocalization(interfaceRootRef.current, displayPreferences.language);
  }, [displayPreferences.language, displayPreferencesReady]);

  const updateDisplayPreferences = useCallback((patch: Partial<DisplayPreferences>) => {
    setDisplayPreferences((current) => ({ ...current, ...patch }));
  }, []);
  const scheduleTimezone = cleanTimezone(displayPreferences.timezone);
  const scheduleDensity = displayPreferences.density;

  const selectedTeacher = teachers.find((teacher) => teacher.id === selectedTeacherId) ?? teachers[0];
  const studentById = (studentId: string) => students.find((student) => student.id === studentId);
  const teacherById = (teacherId: string) => teachers.find((teacher) => teacher.id === teacherId);
  const hasRealSnapshot = dataSnapshot.label === "真实资料本地快照" || dataSnapshot.label === "真实资料线上临时快照" || dataSnapshot.label === "Supabase 真实资料快照" || dataSnapshot.label === "Supabase 多人共享真实资料";
  const recordStudents = useMemo(() => hasRealSnapshot ? students.filter((student) => !sampleStudentIds.has(student.id)) : students, [hasRealSnapshot, students]);
  const recordTeachers = useMemo(() => hasRealSnapshot ? teachers.filter((teacher) => !sampleTeacherIds.has(teacher.id)) : teachers, [hasRealSnapshot, teachers]);
  const isFullAdminSession = isAdminSession;
  const isLimitedAdminSession = sessionOperator === DEMO_LIMITED_ADMIN_USER;
  const canUseAdminScope = isFullAdminSession || isLimitedAdminSession;
  const canViewPayroll = isFullAdminSession && currentOperator === "Nixon";
  const isAdminView = currentOperator === "Nixon" || currentOperator === DEMO_LIMITED_ADMIN_USER;
  const isTeacherView = isDemoTeacher(currentOperator);
  const interfaceText = interfaceCopy[displayPreferences.language];
  const navigation = useMemo(() => navigationFor(displayPreferences.language), [displayPreferences.language]);
  const currentTeacher = useMemo(() => isTeacherView ? recordTeachers.find((teacher) => teacher.name.trim().toLocaleLowerCase() === currentOperator.trim().toLocaleLowerCase()) : undefined, [currentOperator, isTeacherView, recordTeachers]);
  const teacherBookingStudentIds = useMemo(() => new Set(currentTeacher ? bookings.filter((booking) => booking.teacherId === currentTeacher.id).map((booking) => booking.studentId) : []), [bookings, currentTeacher]);
  const visibleNavigation = useMemo(() => isAdminView ? navigation.filter((item) => canViewPayroll || noPayrollAdminSectionIds.has(item.id)) : navigation.filter((item) => isTeacherView ? teacherSectionIds.has(item.id) : staffSectionIds.has(item.id)), [canViewPayroll, isAdminView, isTeacherView, navigation]);
  const visibleMobileNavigation = useMemo(() => visibleNavigation.filter((item) => isTeacherView ? ["dashboard", "students", "schedule", "classroom"].includes(item.id) : ["dashboard", "students", "schedule", "messages"].includes(item.id)), [isTeacherView, visibleNavigation]);
  const scopedStudents = useMemo(() => {
    if (isAdminView) return recordStudents;
    if (isTeacherView) {
      const teacherName = currentOperator.trim().toLocaleLowerCase();
      return recordStudents.filter((student) => student.teacher.trim().toLocaleLowerCase() === teacherName || teacherBookingStudentIds.has(student.id));
    }
    return recordStudents.filter((student) => student.owner === currentOperator);
  }, [currentOperator, isAdminView, isTeacherView, recordStudents, teacherBookingStudentIds]);
  const scopedStudentIds = useMemo(() => new Set(scopedStudents.map((student) => student.id)), [scopedStudents]);
  const scopedTasks = useMemo(() => isAdminView ? tasks : tasks.filter((task) => task.owner === currentOperator || scopedStudentIds.has(task.studentId)), [currentOperator, isAdminView, scopedStudentIds, tasks]);
  const scopedBookings = useMemo(() => isAdminView ? bookings : isTeacherView ? bookings.filter((booking) => booking.teacherId === currentTeacher?.id) : bookings.filter((booking) => scopedStudentIds.has(booking.studentId)), [bookings, currentTeacher?.id, isAdminView, isTeacherView, scopedStudentIds]);
  const scopedLpItems = useMemo(() => isAdminView ? lpItems : lpItems.filter((item) => item.owner === currentOperator || scopedStudentIds.has(item.studentId)), [currentOperator, isAdminView, lpItems, scopedStudentIds]);
  const scopedOperations = useMemo(() => isAdminView ? operations : operations.filter((operation) => scopedStudentIds.has(operation.studentId)), [isAdminView, operations, scopedStudentIds]);
  const scopedRenewals = useMemo(() => isAdminView ? renewals : renewals.filter((renewal) => renewal.owner === currentOperator || scopedStudentIds.has(renewal.studentId)), [currentOperator, isAdminView, renewals, scopedStudentIds]);
  const scopedMessages = useMemo(() => isAdminView ? messages : messages.filter((message) => scopedStudentIds.has(message.studentId)), [isAdminView, messages, scopedStudentIds]);
  const scopedFiles = useMemo(() => isAdminView ? files : files.filter((file) => scopedStudentIds.has(file.studentId)), [files, isAdminView, scopedStudentIds]);
  const selectedStudent = scopedStudents.find((student) => student.id === selectedStudentId) ?? scopedStudents[0] ?? (isTeacherView ? { id: "STU-NONE", name: "暂无关联学生", initials: "--", status: "待确认", owner: "教务", course: "待分配", timezone: "Australia/Melbourne", guardian: "待补充", teacher: currentOperator, next: "等待管理员关联学生", nextTone: "neutral", files: 0 } satisfies Student : recordStudents[0]);
  const selectedMessageState = scopedMessages.find((message) => message.id === selectedMessageId);
  const selectedBookingSeries = scopedBookings.find((booking) => booking.id === selectedBookingId);
  const selectedBooking = selectedBookingSeries && selectedBookingDate && selectedBookingDateId === selectedBookingSeries.id
    ? { ...selectedBookingSeries, date: selectedBookingDate }
    : selectedBookingSeries;
  const selectedOperationState = scopedOperations.find((operation) => operation.id === selectedOperationId);
  const examReminderStudents = useMemo(() => {
    const now = new Date();
    const threshold = Number(rules.examDays || 30);
    return scopedStudents.filter((student) => {
      if (!student.examDate || !isActiveStudent(student)) return false;
      const exam = new Date(`${student.examDate}T12:00:00`);
      const days = Math.ceil((exam.getTime() - now.getTime()) / 86400000);
      return days >= 0 && days <= threshold;
    });
  }, [scopedStudents, rules.examDays]);
  const dstRiskBookings = useMemo(() => scopedBookings.filter((booking) => {
    const student = students.find((item) => item.id === booking.studentId);
    const teacher = teachers.find((item) => item.id === booking.teacherId);
    return student && teacher ? bookingHasDstRisk(booking, student, teacher) : false;
  }), [scopedBookings, students, teachers]);
  const ownerOptions = useMemo(() => Array.from(new Set(recordStudents.map((student) => student.owner).filter(Boolean))).sort(), [recordStudents]);
  const operatorOptions = useMemo(() => canUseAdminScope ? Array.from(new Set([sessionOperator, DEMO_LIMITED_ADMIN_USER, ...DEMO_STAFF_USERS, ...ownerOptions.filter((owner) => owner !== "Nixon"), ...DEMO_TEACHER_USERS])) : [sessionOperator], [canUseAdminScope, ownerOptions, sessionOperator]);
  const teamOwnerOptions = useMemo(() => Array.from(new Set([...ownerOptions, "思佳", "Tiffany", "Abby", "Tara"])).sort(), [ownerOptions]);
  const teacherSubjectOptions = useMemo(() => Array.from(new Set(recordTeachers.flatMap((teacher) => teacher.subjects))).sort(), [recordTeachers]);
  const staleSources = useMemo(() => syncSources.filter((source) => sourceIsStale(source)), [syncSources]);
  const latestSourceSync = useMemo(() => syncSources
    .map((source) => new Date(source.synced_at))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((left, right) => right.getTime() - left.getTime())[0], [syncSources]);
  const sourceFreshnessLabel = !syncSources.length
    ? "未连接外部只读来源"
    : staleSources.length
      ? `${staleSources.length} 个来源已超过 36 小时未读取`
      : `外部来源截至 ${formatSourceTime(latestSourceSync?.toISOString(), displayPreferences)}`;
  const displayedRules = rulesDraftTouched ? rulesDraft : rules;

  const addAudit = (action: string, detail: string, tone: Tone = "blue") => {
    const viewedAs = currentOperator !== sessionOperator ? ` · 当前查看 ${operatorLabel(currentOperator)} 视图` : "";
    const auditDetail = `${detail}${viewedAs}`;
    const optimisticEntry: AuditEntry = { id: id("AUD"), time: new Date().toISOString(), actor: operatorLabel(sessionOperator), action, detail: auditDetail, tone };
    setAudit((current) => [optimisticEntry, ...current]);
    void fetch("/api/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, detail: auditDetail, tone }),
    }).then(async (response) => {
      if (response.ok) return;
      const body = await response.json().catch(() => ({}));
      notify(body.error || "操作审计保存失败");
    }).catch(() => notify("操作审计保存失败"));
  };

  const notify = (message: string, undo?: () => void) => {
    const toastId = id("TOAST");
    setToast({
      id: toastId,
      message: translateInterfaceText(message, displayPreferences.language),
      actionLabel: undo ? translateInterfaceText("撤销", displayPreferences.language) : undefined,
      onAction: undo,
    });
    window.setTimeout(
      () => setToast((current) => (current?.id === toastId ? null : current)),
      undo ? 12000 : 4200,
    );
  };

  const requestConfirmation = (request: ConfirmRequest) => {
    setConfirmRequest(request);
  };

  const confirmRequestedAction = async () => {
    if (!confirmRequest || confirmBusy) return;
    setConfirmBusy(true);
    try {
      await confirmRequest.onConfirm();
      setConfirmRequest(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : "操作失败，请重试");
    } finally {
      setConfirmBusy(false);
    }
  };

  const completeTask = (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task || task.status === "done") return;
    const before = { ...task };
    setTasks((current) => current.map((item) => item.id === taskId ? { ...item, status: "done", tone: "green", closedAt: new Date().toISOString(), result: "已由当前操作员确认完成" } : item));
    addAudit("完成强提醒任务", `${task.title} · ${studentById(task.studentId)?.name ?? "未关联学生"}`, "green");
    notify("已完成并写入操作记录", () => {
      setTasks((current) => current.map((item) => item.id === taskId ? before : item));
      addAudit("撤销完成强提醒任务", `${task.title} · 恢复为 ${before.status}`, "amber");
    });
  };

  const visibleTasks = useMemo(() => {
    const now = taskRefreshKey ? new Date(taskRefreshKey) : new Date();
    return sortTasksByDueAt(scopedTasks.map((task) => refreshTaskStatus(task, now)).filter((task) => task.status !== "done"));
  }, [scopedTasks, taskRefreshKey]);

  const switchOperator = (operator: string) => {
    const teacherView = isDemoTeacher(operator);
    const adminScope = operator === "Nixon" || operator === DEMO_LIMITED_ADMIN_USER;
    const teacher = teacherView ? recordTeachers.find((item) => item.name.trim().toLocaleLowerCase() === operator.trim().toLocaleLowerCase()) : undefined;
    const teacherStudentIds = new Set(teacher ? bookings.filter((booking) => booking.teacherId === teacher.id).map((booking) => booking.studentId) : []);
    const allowedStudents = adminScope ? recordStudents : teacherView ? recordStudents.filter((student) => student.teacher.trim().toLocaleLowerCase() === operator.trim().toLocaleLowerCase() || teacherStudentIds.has(student.id)) : recordStudents.filter((student) => student.owner === operator);
    setCurrentOperator(operator);
    setTaskFilter("all");
    setStudentView(adminScope || teacherView ? "all" : "mine");
    setStudentOwner("all");
    setStudentPage(1);
    setSelectedStudentIds([]);
    const firstOwnedStudent = allowedStudents[0];
    const allowedStudentIds = new Set(allowedStudents.map((student) => student.id));
    if (firstOwnedStudent) setSelectedStudentId(firstOwnedStudent.id);
    if (teacher) setSelectedTeacherId(teacher.id);
    const firstBooking = bookings.find((booking) => teacher ? booking.teacherId === teacher.id : allowedStudentIds.has(booking.studentId));
    const firstMessage = messages.find((message) => allowedStudentIds.has(message.studentId));
    const firstOperation = operations.find((operation) => allowedStudentIds.has(operation.studentId));
    if (firstBooking) {
      setSelectedBookingId(firstBooking.id);
      setSelectedBookingDate(firstBooking.date);
      setSelectedBookingDateId(firstBooking.id);
    }
    if (firstMessage) setSelectedMessageId(firstMessage.id);
    if (firstOperation) setSelectedOperationId(firstOperation.id);
    if (!adminScope && !(teacherView ? teacherSectionIds : staffSectionIds).has(active)) setActive("dashboard");
    if (operator === DEMO_LIMITED_ADMIN_USER && active === "payroll") setActive("dashboard");
    notify(adminScope ? "已切换到全局管理视图" : teacherView ? `已切换到 ${operator} 的老师视图` : `已切换到 ${operator} 的个人工作视图`);
  };

  const requestOperatorSwitch = (operator: string) => {
    if (!canUseAdminScope && operator !== sessionOperator) return;
    switchOperator(operator);
  };

  const logout = async () => {
    setLogoutBusy(true);
    try {
      const response = await fetch("/api/demo-logout", { method: "POST" });
      if (!response.ok) throw new Error("logout failed");
      window.location.assign("/");
    } catch {
      setLogoutBusy(false);
      notify("退出失败，请重试");
    }
  };

  const sharedVersionsRef = useRef<Record<string, number>>({});
  const remoteHandlersRef = useRef<Record<string, (row: RemoteStateRow) => void>>({});

  useEffect(() => {
    sharedVersionsRef.current = {
      students: studentsShared.version,
      teachers: teachersShared.version,
      tasks: tasksShared.version,
      bookings: bookingsShared.version,
      courses: coursesShared.version,
      lpItems: lpShared.version,
      operations: operationsShared.version,
      renewals: renewalsShared.version,
      payroll: payrollShared.version,
      messages: messagesShared.version,
      files: filesShared.version,
      audit: auditShared.version,
      rules: rulesShared.version,
      dataSnapshot: dataSnapshotShared.version,
    };
    remoteHandlersRef.current = {
      students: studentsShared.applyRemote as (row: RemoteStateRow) => void,
      teachers: teachersShared.applyRemote as (row: RemoteStateRow) => void,
      tasks: tasksShared.applyRemote as (row: RemoteStateRow) => void,
      bookings: bookingsShared.applyRemote as (row: RemoteStateRow) => void,
      courses: coursesShared.applyRemote as (row: RemoteStateRow) => void,
      lpItems: lpShared.applyRemote as (row: RemoteStateRow) => void,
      operations: operationsShared.applyRemote as (row: RemoteStateRow) => void,
      renewals: renewalsShared.applyRemote as (row: RemoteStateRow) => void,
      payroll: payrollShared.applyRemote as (row: RemoteStateRow) => void,
      messages: messagesShared.applyRemote as (row: RemoteStateRow) => void,
      files: filesShared.applyRemote as (row: RemoteStateRow) => void,
      audit: auditShared.applyRemote as (row: RemoteStateRow) => void,
      rules: rulesShared.applyRemote as (row: RemoteStateRow) => void,
      dataSnapshot: dataSnapshotShared.applyRemote as (row: RemoteStateRow) => void,
    };
  }, [auditShared.applyRemote, auditShared.version, bookingsShared.applyRemote, bookingsShared.version, coursesShared.applyRemote, coursesShared.version, dataSnapshotShared.applyRemote, dataSnapshotShared.version, filesShared.applyRemote, filesShared.version, lpShared.applyRemote, lpShared.version, messagesShared.applyRemote, messagesShared.version, operationsShared.applyRemote, operationsShared.version, payrollShared.applyRemote, payrollShared.version, renewalsShared.applyRemote, renewalsShared.version, rulesShared.applyRemote, rulesShared.version, studentsShared.applyRemote, studentsShared.version, tasksShared.applyRemote, tasksShared.version, teachersShared.applyRemote, teachersShared.version]);

  useEffect(() => {
    let stopped = false;
    let polling = false;
    let timeout: number | null = null;
    const activeDelayMs = 15_000;
    const errorDelayMs = 60_000;

    const schedule = (delayMs: number) => {
      if (stopped || document.hidden) return;
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        timeout = null;
        void poll();
      }, delayMs);
    };

    const poll = async () => {
      if (stopped || polling || document.hidden) return;
      polling = true;
      let nextDelayMs = activeDelayMs;
      try {
        const versionResponse = await fetch("/api/app-state?mode=versions", { cache: "no-store" });
        const versionBody = await versionResponse.json().catch(() => ({}));
        if (!versionResponse.ok) throw new Error(versionBody.error || "共享状态检查失败");
        const changed = (versionBody.versions as RemoteStateRow[])
          .filter((row) => row.version > (sharedVersionsRef.current[row.entity] ?? 0))
          .map((row) => row.entity)
          .filter((entity) => Boolean(remoteHandlersRef.current[entity]));

        if (changed.length && !stopped) {
          const stateResponse = await fetch(`/api/app-state?entities=${encodeURIComponent(changed.join(","))}`, { cache: "no-store" });
          const stateBody = await stateResponse.json().catch(() => ({}));
          if (!stateResponse.ok) throw new Error(stateBody.error || "共享资料刷新失败");
          (stateBody.rows as RemoteStateRow[]).forEach((row) => remoteHandlersRef.current[row.entity]?.(row));
        } else if (!stopped && navigator.onLine) {
          reportSharedSync("synced", "Supabase 多人共享已连接");
        }
      } catch (error) {
        nextDelayMs = errorDelayMs;
        if (!stopped) reportSharedSync(navigator.onLine ? "error" : "offline", error instanceof Error ? error.message : "共享同步暂时不可用");
      } finally {
        polling = false;
        schedule(nextDelayMs);
      }
    };

    const wake = () => {
      if (stopped || document.hidden) return;
      if (timeout !== null) {
        window.clearTimeout(timeout);
        timeout = null;
      }
      void poll();
    };
    const onVisible = () => { if (!document.hidden) wake(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    void poll();
    return () => {
      stopped = true;
      if (timeout !== null) window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [reportSharedSync]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setGlobalSearchOpen(true);
      }
      if (event.key === "Escape") {
        setGlobalSearchOpen(false);
        setModal(null);
        setMobileMenuOpen(false);
        setOperatorMenuOpen(false);
        setDisplayPreferencesOpen(false);
        setMobilePreview(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!operatorMenuOpen) return;
    const closeOperatorMenu = (event: MouseEvent) => {
      if (!operatorMenuRef.current?.contains(event.target as Node)) setOperatorMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOperatorMenu);
    return () => document.removeEventListener("mousedown", closeOperatorMenu);
  }, [operatorMenuOpen]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [active]);

  useEffect(() => {
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    const frame = window.requestAnimationFrame(() => setScheduleMode("agenda"));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (rules.lowHours && rules.examDays) return;
    setRules((current) => ({ ...defaultRules, ...current, lowHours: current.lowHours ?? defaultRules.lowHours, examDays: current.examDays ?? defaultRules.examDays }));
  }, [rules.examDays, rules.lowHours, setRules]);

  const filteredStudents = useMemo(() => scopedStudents.filter((student) => {
    const haystack = `${student.name} ${student.id} ${student.course} ${student.grade ?? ""} ${student.location ?? ""} ${student.owner} ${student.planner ?? ""} ${student.teacher}`.toLowerCase();
    const matchesSearch = haystack.includes(search.trim().toLowerCase());
    if (!matchesSearch || (studentOwner !== "all" && student.owner !== studentOwner)) return false;
    if (studentView === "mine") return isTeacherView || student.owner === currentOperator;
    if (studentView === "trial") return student.status === "试听中" || student.status === "待排课";
    if (studentView === "enrolled") return student.segment === "已报名" && isActiveStudent(student);
    if (studentView === "lp") return requiresLp(student);
    if (studentView === "renewal") return student.status === "待续课";
    if (studentView === "paused") return student.status === "停课" || student.status === "非在读" || student.status === "不活跃";
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name)), [currentOperator, isTeacherView, scopedStudents, search, studentOwner, studentView]);

  const pageSize = 12;
  const safeStudentPage = Math.min(studentPage, Math.max(1, Math.ceil(filteredStudents.length / pageSize)));
  const pagedStudents = filteredStudents.slice((safeStudentPage - 1) * pageSize, safeStudentPage * pageSize);
  const teacherMatch = (teacher: Teacher) => teacher.subjects.some((subject) => selectedStudent.course.includes(subject.split(" ").slice(-1)[0])) ? 94 : teacher.subjects.some((subject) => subject.includes("English") && selectedStudent.course.includes("English")) ? 87 : 76;
  const filteredTeachers = recordTeachers.filter((teacher) => {
    const matchesSearch = `${teacher.name} ${teacher.id} ${teacher.subjects.join(" ")} ${teacher.subjectDetail ?? ""} ${teacher.location ?? ""} ${teacher.timezone}`.toLowerCase().includes(teacherQuery.trim().toLowerCase());
    if (!matchesSearch || (teacherSubject !== "all" && !teacher.subjects.includes(teacherSubject))) return false;
    if (teacherDay !== "all" && !(teacher.availabilitySlots ?? []).some((slot) => slot.day === Number(teacherDay))) return false;
    if (teacherView === "available") return teacher.acceptsStudents;
    if (teacherView === "capacity") return teacher.load < teacher.capacity * 0.8;
    if (teacherView === "matched") return teacherMatch(teacher) >= 85;
    return true;
  }).sort((a, b) => teacherMatch(b) - teacherMatch(a));
  const teacherPageSize = 8;
  const safeTeacherPage = Math.min(teacherPage, Math.max(1, Math.ceil(filteredTeachers.length / teacherPageSize)));
  const pagedTeachers = filteredTeachers.slice((safeTeacherPage - 1) * teacherPageSize, safeTeacherPage * teacherPageSize);

  const globalResults = globalQuery.trim() ? [
    ...scopedStudents.filter((student) => `${student.name} ${student.id} ${student.course}`.toLowerCase().includes(globalQuery.trim().toLowerCase())).slice(0, 6).map((student) => ({ id: student.id, type: "学生", title: student.name, detail: `${student.id} · ${student.course}`, action: () => { goToStudent(student.id); setGlobalSearchOpen(false); } })),
    ...(!isTeacherView ? recordTeachers.filter((teacher) => `${teacher.name} ${teacher.id} ${teacher.subjects.join(" ")}`.toLowerCase().includes(globalQuery.trim().toLowerCase())).slice(0, 4).map((teacher) => ({ id: teacher.id, type: "老师", title: teacher.name, detail: `${teacher.id} · ${teacher.subjects.join("、")}`, action: () => { setSelectedTeacherId(teacher.id); setActive("teachers"); setGlobalSearchOpen(false); } })) : []),
  ] : [];

  const goToStudent = (studentId: string, section: Section = "students") => {
    if (!scopedStudentIds.has(studentId)) {
      notify("当前身份无权查看该学生档案");
      return;
    }
    setSelectedStudentId(studentId);
    if (section === "students") {
      const sortedIndex = [...scopedStudents].sort((a, b) => a.name.localeCompare(b.name)).findIndex((student) => student.id === studentId);
      if (sortedIndex >= 0) {
        setSearch("");
        setStudentView("all");
        setStudentPage(Math.floor(sortedIndex / pageSize) + 1);
      }
    }
    setActive(section);
    if (section === "students") setMobilePreview("student");
  };

  const openStudentPreview = (studentId: string) => {
    setSelectedStudentId(studentId);
    setMobilePreview("student");
  };

  const openStudentRecord = (studentId: string, section: StudentRecordPanelSection) => {
    setSelectedStudentId(studentId);
    setStudentRecordKind(section);
    setMobilePreview(null);
    setModal("studentRecords");
  };

  const addStudentRecord = (section: StudentRecordPanelSection) => {
    if (isTeacherView) {
      notify("老师账号只能查看学生资料");
      return;
    }
    setStudentRecordKind(section);
    if (section === "report") setModal("file");
    else if (section === "fu") setModal("studentEvidence");
    else if (section === "followUp") setModal("studentFollowUp");
    else if (section === "lessonPackages") setModal("lessonPackage");
    else if (section === "exams") setModal("exam");
    else setModal("file");
  };

  const navigateMobile = (section: Section) => {
    setActive(section);
    setMobileMenuOpen(false);
    setMobilePreview(null);
  };

  const scheduleConflict = (studentId: string, teacherId: string, date: string, start: string, duration: number, inputTimezone: string, excludeBookingId?: string) => {
    const requestedStart = zonedDateTimeToUtc(date, start, inputTimezone).getTime();
    const requestedEnd = requestedStart + duration * 60000;

    return bookings.some((booking) => {
      if (booking.id === excludeBookingId) return false;
      if (booking.studentId !== studentId && booking.teacherId !== teacherId) return false;
      return bookingOccurrencesWithinRange(booking, date, date).some((occurrence) => {
        const bookingStart = bookingInstant(occurrence).getTime();
        const bookingEnd = bookingStart + occurrence.duration * 60000;
        return requestedStart < bookingEnd && bookingStart < requestedEnd;
      });
    });
  };

  const teacherHasBookingConflict = (teacherId: string, requestedBooking: Booking) => {
    const requestedStart = bookingInstant(requestedBooking).getTime();
    const requestedEnd = requestedStart + requestedBooking.duration * 60000;
    return bookings.some((booking) => booking.teacherId === teacherId && bookingOccurrencesWithinRange(booking, requestedBooking.date, requestedBooking.date).some((occurrence) => {
      const bookingStart = bookingInstant(occurrence).getTime();
      const bookingEnd = bookingStart + occurrence.duration * 60000;
      return requestedStart < bookingEnd && bookingStart < requestedEnd;
    }));
  };

  const substitutionCandidates = (booking: Booking, unavailableTeacherId: string) => {
    const unavailableTeacher = teacherById(unavailableTeacherId);
    const student = studentById(booking.studentId);
    if (!unavailableTeacher || !student) return [];
    const candidatePool = hasRealSnapshot ? recordTeachers : teachers;
    return candidatePool.filter((teacher) => {
      if (teacher.id === unavailableTeacherId || !teacher.availabilitySlots?.length) return false;
      const sharesSubject = teacher.subjects.some((subject) => unavailableTeacher.subjects.includes(subject))
        || teacher.subjects.some((subject) => student.course.includes(subject.split(" ").slice(-1)[0]));
      return sharesSubject
        && teacherAvailableAt(teacher, booking.date, booking.start, booking.duration, booking.timezone)
        && !teacherHasBookingConflict(teacher.id, booking);
    }).slice(0, 5);
  };

  const createLpWorkflow = (studentId: string, workflowType: LpWorkflowType, fields: LpFieldValues, studentOverride?: Student) => {
    const student = studentOverride ?? studentById(studentId);
    if (!student) return false;
    const option = lpWorkflowOptions.find((item) => item.id === workflowType) ?? lpWorkflowOptions[0];
    const createdAt = new Date();
    const dueAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
    const responsibleOperations = typeof fields.responsibleOperations === "string" ? fields.responsibleOperations : student.owner;
    const needsParentFollowUp = fields.specifiedContentStatus === "需要跟进";
    const needsTeacherPrep = fields.preparationFollowUp === "是";
    const workflowId = id("LP");
    const item: LpItem = {
      id: workflowId,
      studentId,
      title: `${option.title} · ${student.name}`,
      workflowType,
      stage: "待资料",
      owner: responsibleOperations,
      due: formatInstant(dueAt, "Australia/Melbourne", displayPreferences),
      needsParentFollowUp,
      needsTeacherPrep,
      publishedDate: workflowType === "老师 LP 修改" ? isoDateInTimezone(createdAt, "Australia/Melbourne") : undefined,
      fields,
      revisionNumber: 1,
      revisions: [{
        id: id("LPR"),
        workflowId,
        number: 1,
        changedAt: createdAt.toISOString(),
        changedBy: operatorLabel(sessionOperator),
        note: "创建 LP",
        before: {},
        after: fields,
      }],
      stageAudit: [],
    };
    const generated: Task[] = [
      { id: id("TSK"), title: `${option.title}：核对交接信息`, owner: responsibleOperations, studentId, due: formatInstant(dueAt, "Australia/Melbourne", displayPreferences), dueAt: dueAt.toISOString(), status: statusForDueAt(dueAt, createdAt), tone: "blue", category: "LP", trigger: `${option.title} 创建后自动生成`, ruleKey: "lp.handover", anchorBookingId: item.id },
    ];
    if (workflowType === "试听 LP" || workflowType === "换老师试听") {
      generated.push(...generateTrialRequestTasks({
        anchorBookingId: item.id,
        studentId,
        owner: responsibleOperations,
        requestedAt: createdAt,
        now: createdAt,
      }));
    }
    const alreadyHasParentRequestTask = workflowType === "试听 LP" || workflowType === "换老师试听";
    if (fields.specifiedContentStatus === "需要跟进" && !alreadyHasParentRequestTask) {
      const contentDueAt = zonedDateTimeToUtc(isoDateInTimezone(createdAt, "Australia/Melbourne"), "18:00", "Australia/Melbourne");
      generated.push({ id: id("TSK"), title: "跟进指定内容", owner: responsibleOperations, studentId, due: formatInstant(contentDueAt, "Australia/Melbourne", displayPreferences), dueAt: contentDueAt.toISOString(), status: statusForDueAt(contentDueAt, createdAt), tone: "red", category: "LP", trigger: `${option.title} 指定内容需要跟进`, ruleKey: "lp.specified-content", anchorBookingId: item.id });
    }
    if (fields.preparationFollowUp === "是") {
      generated.push({ id: id("TSK"), title: "跟进老师备课", owner: responsibleOperations, studentId, due: formatInstant(dueAt, "Australia/Melbourne", displayPreferences), dueAt: dueAt.toISOString(), status: statusForDueAt(dueAt, createdAt), tone: "amber", category: "LP", trigger: `${option.title} 需要跟进备课`, ruleKey: "lp.preparation-follow-up", anchorBookingId: item.id });
    }
    setLpItems((current) => [item, ...current]);
    setTasks((current) => sortTasksByDueAt(upsertTasksByRule(current, generated)));
    setStudents((current) => current.map((entry) => entry.id === studentId ? { ...entry, lpNeed: option.lpNeed, next: `${option.title} 已创建`, nextTone: "amber" } : entry));
    addAudit("创建 LP 工作流", `${student.name} · ${option.title} · ${generated.length} 项强提醒`, "green");
    return true;
  };

  const assignTeacher = (teacher: Teacher) => {
    if (!selectedStudent) return;
    const beforeTeacher = selectedStudent.teacher;
    const beforeNext = selectedStudent.next;
    const beforeTone = selectedStudent.nextTone;
    setSelectedTeacherId(teacher.id);
    setStudents((current) => current.map((student) => student.id === selectedStudent.id ? { ...student, teacher: teacher.name, next: "确认试听排课", nextTone: "amber" } : student));
    addAudit("选择候选老师", `${selectedStudent.name} → ${teacher.name}，等待排课确认`, "green");
    notify(`${teacher.name} 已选为候选老师`, () => {
      setStudents((current) => current.map((student) => student.id === selectedStudent.id ? { ...student, teacher: beforeTeacher, next: beforeNext, nextTone: beforeTone } : student));
      addAudit("撤销候选老师", `${selectedStudent.name}：恢复为 ${beforeTeacher}`, "amber");
    });
  };

  const updateStudentStatus = (student: Student, status: Student["status"]) => {
    if (student.status === status) return;
    const previousStatus = student.status;
    requestConfirmation({
      title: "确认修改学生状态",
      detail: `${student.name} 将从「${previousStatus}」调整为「${status}」。`,
      items: ["状态会影响低课时、续课和考试提醒范围", "不会删除学生、课表或历史记录"],
      confirmLabel: `调整为 ${status}`,
      onConfirm: () => {
        setStudents((current) => current.map((entry) => entry.id === student.id ? { ...entry, status } : entry));
        addAudit("更新学生状态", `${student.name}：${previousStatus} → ${status}`, "blue");
        notify("学生状态已更新", () => {
          setStudents((current) => current.map((entry) => entry.id === student.id ? { ...entry, status: previousStatus } : entry));
          addAudit("撤销学生状态更新", `${student.name}：${status} → ${previousStatus}`, "amber");
        });
      },
    });
  };

  const toggleTeacherAvailability = (teacher: Teacher) => {
    const nextAccepts = !teacher.acceptsStudents;
    const nextStatus = nextAccepts ? "可接新生" : "暂停接新";
    requestConfirmation({
      title: nextAccepts ? "确认开放接新" : "确认暂停接新",
      detail: `${teacher.name} 的接新状态将改为「${nextStatus}」。`,
      items: [nextAccepts ? "该老师会重新进入可接新老师筛选" : "该老师将不再用于新的试听排课", "既有排课不会改变"],
      confirmLabel: nextStatus,
      onConfirm: () => {
        setTeachers((current) => current.map((entry) => entry.id === teacher.id ? { ...entry, acceptsStudents: nextAccepts, availabilityStatus: nextStatus } : entry));
        addAudit("更新老师接新状态", `${teacher.name}：${nextStatus}`, "blue");
        notify("老师接新状态已更新", () => {
          setTeachers((current) => current.map((entry) => entry.id === teacher.id ? { ...entry, acceptsStudents: teacher.acceptsStudents, availabilityStatus: teacher.availabilityStatus } : entry));
          addAudit("撤销老师接新状态更新", `${teacher.name}：恢复原状态`, "amber");
        });
      },
    });
  };

  const submitTeacherCapacity = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!teacherCapacityDraft) return;
    if (!isAdminView) {
      notify("可接新生数量需要管理员调整");
      return;
    }
    const data = new FormData(event.currentTarget);
    const capacity = Number(data.get("newStudentCapacity"));
    if (!Number.isSafeInteger(capacity) || capacity < 0) {
      notify("可接新生数量必须是 0 或正整数");
      return;
    }
    const previous = teacherCapacityDraft.newStudentCapacity;
    setTeachers((current) => current.map((teacher) => teacher.id === teacherCapacityDraft.id ? {
      ...teacher,
      newStudentCapacity: capacity,
      acceptsStudents: capacity > 0 ? teacher.acceptsStudents : false,
      availabilityStatus: capacity > 0 ? teacher.availabilityStatus : "暂停接新",
    } : teacher));
    addAudit("调整可接新生数量", `${teacherCapacityDraft.name}：${previous ?? "待录入"} → ${capacity}`, capacity === 0 ? "amber" : "blue");
    setTeacherCapacityDraft(null);
    setModal(null);
    notify("可接新生数量已保存");
  };

  const toggleStudentSelection = (studentId: string) => {
    setSelectedStudentIds((current) => current.includes(studentId) ? current.filter((idValue) => idValue !== studentId) : [...current, studentId]);
  };

  const bulkAssignStudents = (owner: string) => {
    if (!selectedStudentIds.length) return;
    const targetIds = [...selectedStudentIds];
    const before = students.filter((student) => targetIds.includes(student.id)).map((student) => ({ id: student.id, owner: student.owner }));
    requestConfirmation({
      title: "确认批量分配负责人",
      detail: `将 ${targetIds.length} 位学生的负责教务改为 ${owner}。`,
      items: before.slice(0, 6).map((entry) => `${studentById(entry.id)?.name ?? entry.id}：${entry.owner} → ${owner}`),
      confirmLabel: `确认分配给 ${owner}`,
      onConfirm: () => {
        setStudents((current) => current.map((student) => targetIds.includes(student.id) ? { ...student, owner } : student));
        addAudit("批量分配学生", `${targetIds.length} 位学生 → ${owner}`, "blue");
        setSelectedStudentIds([]);
        notify(`已将 ${targetIds.length} 位学生分配给 ${owner}`, () => {
          const previousOwners = new Map(before.map((entry) => [entry.id, entry.owner]));
          setStudents((current) => current.map((student) => previousOwners.has(student.id) ? { ...student, owner: previousOwners.get(student.id)! } : student));
          addAudit("撤销批量分配学生", `${targetIds.length} 位学生恢复原负责人`, "amber");
        });
      },
    });
  };

  const advanceLp = (item: LpItem) => {
    const currentIndex = lpStages.indexOf(item.stage);
    const nextStage = lpStages[Math.min(currentIndex + 1, lpStages.length - 1)];
    if (nextStage === item.stage) return;
    setLpStage(item, nextStage);
  };

  const setLpStage = (item: LpItem, stage: LpItem["stage"]) => {
    if (stage === item.stage) return;
    const previousStage = item.stage;
    requestConfirmation({
      title: stage === "完成" ? "确认完成 LP" : "确认调整 LP 阶段",
      detail: `${item.title} 将从「${previousStage}」调整为「${stage}」。`,
      items: stage === "完成" ? ["完成后会离开进行中队列", "相关提醒不会被自动删除"] : undefined,
      confirmLabel: `调整为 ${stage}`,
      onConfirm: () => {
        const changedAt = new Date().toISOString();
        setLpItems((current) => current.map((entry) => {
          if (entry.id !== item.id) return entry;
          const changed = changeLpStage({
            id: entry.id,
            type: entry.workflowType ?? "试听 LP",
            stage: entry.stage,
            fields: entry.fields ?? {},
            revisionNumber: entry.revisionNumber ?? 1,
            revisions: entry.revisions ?? [],
            audit: entry.stageAudit ?? [],
          }, stage, { id: id("LPA"), at: changedAt, actor: operatorLabel(sessionOperator) });
          return { ...entry, stage: changed.stage, stageAudit: [...changed.audit] };
        }));
        addAudit("调整 LP 阶段", `${item.title}：${previousStage} → ${stage}`, stage === "完成" ? "green" : "blue");
        notify(`LP 已调整到「${stage}」`, () => {
          const revertedAt = new Date().toISOString();
          setLpItems((current) => current.map((entry) => {
            if (entry.id !== item.id || entry.stage !== stage) return entry;
            const reverted = changeLpStage({
              id: entry.id,
              type: entry.workflowType ?? "试听 LP",
              stage: entry.stage,
              fields: entry.fields ?? {},
              revisionNumber: entry.revisionNumber ?? 1,
              revisions: entry.revisions ?? [],
              audit: entry.stageAudit ?? [],
            }, previousStage, { id: id("LPA"), at: revertedAt, actor: operatorLabel(sessionOperator) });
            return { ...entry, stage: reverted.stage, stageAudit: [...reverted.audit] };
          }));
          addAudit("撤销 LP 阶段调整", `${item.title}：${stage} → ${previousStage}`, "amber");
        });
      },
    });
  };

  const retreatLp = (item: LpItem) => {
    const currentIndex = lpStages.indexOf(item.stage);
    if (currentIndex <= 0) return;
    setLpStage(item, lpStages[currentIndex - 1]);
  };

  const openBookingEditor = (booking: Booking) => {
    setBookingDraft(booking);
    setBookingPrefillStudentId(booking.studentId);
    setBookingPrefillTeacherId(booking.teacherId);
    setSelectedStudentId(booking.studentId);
    setSelectedTeacherId(booking.teacherId);
    setModal("booking");
  };

  const openNewBooking = (studentId?: string, teacherId?: string) => {
    setBookingDraft(null);
    setBookingPrefillStudentId(studentId ?? selectedStudent.id);
    setBookingPrefillTeacherId(teacherId ?? null);
    setModal("booking");
  };

  const openBookingOperation = (booking: Booking, type: Operation["type"]) => {
    setSelectedStudentId(booking.studentId);
    setSelectedTeacherId(booking.teacherId);
    setOperationDraft({
      studentId: booking.studentId,
      teacherId: booking.teacherId,
      type,
      eventStart: booking.date,
      eventEnd: booking.date,
      sourceBookingId: booking.id,
      detail: `${type} · ${booking.date} ${booking.start} · ${studentById(booking.studentId)?.name ?? booking.studentId}`,
    });
    setModal("operation");
  };

  const toggleBookingSelection = (bookingId: string) => {
    setSelectedBookingIds((current) => current.includes(bookingId) ? current.filter((idValue) => idValue !== bookingId) : [...current, bookingId]);
  };

  const bulkUpdateBookingStatus = (status: Booking["status"]) => {
    if (!selectedBookingIds.length) return;
    if (status === "已完成") {
      notify("完成课程请按具体课次处理，不能整组完成周期课");
      return;
    }
    const targetIds = [...selectedBookingIds];
    const before = bookings.filter((booking) => targetIds.includes(booking.id)).map((booking) => ({ id: booking.id, status: booking.status }));
    requestConfirmation({
      title: "确认批量更新课程系列",
      detail: `${targetIds.length} 个课程系列将统一改为「${status}」。周期课会整组更新。`,
      confirmLabel: `整组设为${status}`,
      tone: "primary",
      onConfirm: () => {
        setBookings((current) => current.map((booking) => targetIds.includes(booking.id) ? { ...booking, status } : booking));
        addAudit("批量更新课程", `${targetIds.length} 个课程系列 → ${status}`, "blue");
        setSelectedBookingIds([]);
        notify(`已更新 ${targetIds.length} 个课程系列`, () => {
          const previous = new Map(before.map((entry) => [entry.id, entry.status]));
          setBookings((current) => current.map((booking) => previous.has(booking.id) ? { ...booking, status: previous.get(booking.id)! } : booking));
          addAudit("撤销批量更新课程", `${targetIds.length} 个课程系列恢复原状态`, "amber");
        });
      },
    });
  };

  const confirmBookingStatus = (booking: Booking, status: Booking["status"]) => {
    if (booking.status === status) return;
    if (status === "已完成" && booking.recurring) {
      notify("周期课需要按具体课次完成，不能整组标记完成");
      return;
    }
    const previousStatus = booking.status;
    const student = studentById(booking.studentId);
    requestConfirmation({
      title: status === "已完成" ? "确认课程已完成" : "确认课程状态",
      detail: `${student?.name ?? booking.studentId} · ${booking.date} ${booking.start} 将从「${previousStatus}」调整为「${status}」。`,
      items: status === "已完成" ? ["完成状态会进入课时与薪资核对", "本次只更新课程状态，不会自动扣课时或写入薪资"] : ["不会修改上课时间或在线教室链接"],
      confirmLabel: `调整为 ${status}`,
      tone: status === "已完成" ? "danger" : "primary",
      onConfirm: () => {
        setBookings((current) => current.map((entry) => entry.id === booking.id ? { ...entry, status } : entry));
        addAudit("更新课程状态", `${student?.name ?? booking.studentId}：${previousStatus} → ${status}`, status === "已完成" ? "green" : "blue");
        notify("课程状态已更新", () => {
          setBookings((current) => current.map((entry) => entry.id === booking.id ? { ...entry, status: previousStatus } : entry));
          addAudit("撤销课程状态更新", `${student?.name ?? booking.studentId}：${status} → ${previousStatus}`, "amber");
        });
      },
    });
  };

  const deleteBookingSeries = (booking: Booking) => {
    if (!isAdminView) {
      notify("删除排课需要管理员处理");
      return;
    }
    const student = studentById(booking.studentId);
    const teacher = teacherById(booking.teacherId);
    const previousTasks = tasks.filter((task) => task.anchorBookingId === booking.id);
    const assignedThroughCapacity = Boolean(teacher?.capacityAssignments?.includes(booking.studentId));
    const otherTeacherStudentBooking = bookings.some((entry) => entry.id !== booking.id && entry.teacherId === booking.teacherId && entry.studentId === booking.studentId);
    requestConfirmation({
      title: booking.recurring ? "确认删除整个课程系列" : "确认删除课程",
      detail: `${student?.name ?? booking.studentId} · ${booking.date} ${booking.start}`,
      items: booking.recurring ? ["整个周期课程系列都会删除", "已完成的试听提醒会保留，未完成提醒会关闭"] : ["未完成的试听提醒会同时关闭"],
      confirmLabel: booking.recurring ? "删除整个系列" : "删除课程",
      tone: "danger",
      onConfirm: () => {
        setBookings((current) => current.filter((entry) => entry.id !== booking.id));
        if (booking.kind === "试听") {
          setTasks((current) => closeTasksForBooking(current, booking.id, new Date(), "试听排课已删除"));
        }
        if (teacher && assignedThroughCapacity && !otherTeacherStudentBooking) {
          setTeachers((current) => current.map((entry) => entry.id === teacher.id ? {
            ...entry,
            newStudentCapacity: entry.newStudentCapacity === undefined ? undefined : entry.newStudentCapacity + 1,
            capacityAssignments: (entry.capacityAssignments ?? []).filter((studentId) => studentId !== booking.studentId),
          } : entry));
        }
        addAudit("删除排课", `${student?.name ?? booking.studentId} · ${booking.recurring ? "整个系列" : "单次课程"}`, "amber");
        setSelectedBookingId(bookings.find((entry) => entry.id !== booking.id)?.id ?? "");
        setSelectedBookingDate(null);
        setSelectedBookingDateId(null);
        notify("排课已删除", () => {
          setBookings((current) => current.some((entry) => entry.id === booking.id) ? current : [booking, ...current]);
          if (previousTasks.length) setTasks((current) => sortTasksByDueAt([
            ...current.filter((task) => task.anchorBookingId !== booking.id),
            ...previousTasks,
          ]));
          if (teacher && assignedThroughCapacity && !otherTeacherStudentBooking) {
            setTeachers((current) => current.map((entry) => entry.id === teacher.id ? teacher : entry));
          }
          addAudit("撤销删除排课", `${student?.name ?? booking.studentId} · 已恢复`, "amber");
        });
      },
    });
  };

  const deleteAvaSlot = (teacherId: string, slotIndex: number) => {
    const teacher = teacherById(teacherId);
    const slot = teacher?.availabilitySlots?.[slotIndex];
    if (!teacher || !slot) return;
    requestConfirmation({
      title: "确认删除固定可约时段",
      detail: `${teacher.name} · ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][slot.day]} ${slot.start}-${slot.end}`,
      items: ["不会删除已经排好的课程", "后续新排课将不再使用这个时段"],
      confirmLabel: "删除时段",
      tone: "danger",
      onConfirm: () => {
        setTeachers((current) => current.map((entry) => {
          if (entry.id !== teacherId) return entry;
          const availabilitySlots = (entry.availabilitySlots ?? []).filter((_, index) => index !== slotIndex);
          return { ...entry, availabilitySlots, availability: availabilitySlotsText(availabilitySlots), availabilityUpdated: `手动修改 · 今天 ${nowLabel()}` };
        }));
        addAudit("删除老师 AVA", `${teacher.name} · ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][slot.day]} ${slot.start}-${slot.end}`, "amber");
        notify("该固定可约时段已删除", () => {
          setTeachers((current) => current.map((entry) => {
            if (entry.id !== teacherId) return entry;
            const availabilitySlots = [...(entry.availabilitySlots ?? [])];
            availabilitySlots.splice(slotIndex, 0, slot);
            return { ...entry, availabilitySlots, availability: availabilitySlotsText(availabilitySlots), availabilityUpdated: `撤销删除 · 今天 ${nowLabel()}` };
          }));
          addAudit("撤销删除老师 AVA", `${teacher.name} · 恢复固定时段`, "amber");
        });
      },
    });
  };

  const editAvaSlot = (teacherId: string, slotIndex: number) => {
    const slot = teacherById(teacherId)?.availabilitySlots?.[slotIndex];
    if (!slot) return;
    setAvaDraft({ teacherId, slotIndex, slot });
    setSelectedTeacherId(teacherId);
    setModal("ava");
  };

  const recordMessage = (messageOrEvent?: Message | React.MouseEvent<HTMLButtonElement>) => {
    const visibleMessages = scopedMessages.filter((entry) => {
      const matchesQuery = `${entry.kind} ${entry.recipient} ${studentById(entry.studentId)?.name ?? ""}`.toLowerCase().includes(messageQuery.trim().toLowerCase());
      if (!matchesQuery) return false;
      if (messageFilter === "open") return entry.status !== "已记录发送";
      if (messageFilter === "confirm") return entry.status === "待人工确认";
      if (messageFilter === "sent") return entry.status === "已记录发送";
      if (messageFilter === "internal") return entry.status === "仅内部";
      return true;
    });
    const explicitMessage = messageOrEvent && "kind" in messageOrEvent ? messageOrEvent : undefined;
    const message = explicitMessage ?? visibleMessages.find((entry) => entry.id === selectedMessageState?.id) ?? visibleMessages[0];
    if (!message) return;
    if (message.status === "已记录发送") return;
    const recipient = message.recipient.trim();
    if (!recipient || /待关联|待确认|未知/.test(recipient)) {
      notify("收件对象尚未映射，不能记录为已发送");
      return;
    }
    requestConfirmation({
      title: "确认记录为已发送",
      detail: `${message.kind} → ${recipient}`,
      items: ["系统不会实际发送企业微信消息", "此操作只记录人工已经完成发送"],
      confirmLabel: "确认已人工发送",
      onConfirm: () => {
        setMessages((current) => current.map((entry) => entry.id === message.id ? { ...entry, status: "已记录发送" } : entry));
        addAudit("记录消息发送", `${message.kind} → ${recipient}`, "green");
        notify("已记录为人工发送", () => {
          setMessages((current) => current.map((entry) => entry.id === message.id ? { ...entry, status: message.status } : entry));
          addAudit("撤销消息发送记录", `${message.kind} → ${recipient}`, "amber");
        });
      },
    });
  };

  const resetDemo = () => {
    requestConfirmation({
      title: "重新载入共享资料",
      detail: rulesDraftTouched
        ? "当前规则草稿尚未保存，重新载入后会丢失。"
        : "页面会重新读取 Supabase 中最近保存的共享资料。",
      items: [
        "不会清空 Supabase 资料",
        "当前尚未提交的表单和筛选状态会被清除",
      ],
      confirmLabel: "重新载入",
      tone: rulesDraftTouched ? "danger" : "primary",
      onConfirm: () => window.location.reload(),
    });
  };

  const refreshSourceStatus = async () => {
    if (syncRefreshBusy) return;
    setSyncRefreshBusy(true);
    try {
      const payload = await fetchSupabaseSnapshot();
      const nextSources = Array.isArray(payload.syncSources) ? payload.syncSources : [];
      setSyncSources(nextSources);
      const staleCount = nextSources.filter((source) => sourceIsStale(source)).length;
      addAudit("检查外部只读来源", `${nextSources.length} 个来源 · ${staleCount} 个超过 36 小时未读取`, staleCount ? "amber" : "green");
      notify(staleCount ? `状态已刷新：${staleCount} 个来源数据已过期` : "来源状态已刷新，页面资料没有被覆盖");
    } catch (error) {
      notify(error instanceof Error ? error.message : "来源状态刷新失败");
    } finally {
      setSyncRefreshBusy(false);
    }
  };

  const exportDemo = () => {
    const payload = { meta: { schemaVersion: 3, dataSnapshot }, students, teachers, tasks, bookings, courses, lpItems, operations, renewals, payroll, messages, files, audit, rules };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "yinling-education-ops-data.json";
    link.click();
    URL.revokeObjectURL(url);
    addAudit("导出当前业务数据", "已下载 JSON 副本", "blue");
    notify("已导出当前业务数据");
  };

  const importLocalSnapshot = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text()) as ImportPayload;
      const importedStudents = (payload.students ?? []).filter((student) => student?.id && student?.name);
      const importedTeachers = (payload.teachers ?? []).filter((teacher) => teacher?.id && teacher?.name);
      if (!importedStudents.length || !importedTeachers.length) throw new Error("missing-records");
      const replaceExisting = payload.meta?.replaceExisting === true;
      requestConfirmation({
        title: replaceExisting ? "确认覆盖导入共享资料" : "确认合并导入共享资料",
        detail: `${file.name} · ${importedStudents.length} 位学生、${importedTeachers.length} 位老师`,
        items: [
          replaceExisting
            ? "同类资料将按导入包重新建立，请先确认这是完整资料包"
            : "相同内部 ID 会以导入包内容更新，其余资料保留",
          "保存后其他在线用户也会看到变更",
          "导入前会再次确认范围",
        ],
        confirmLabel: replaceExisting ? "确认覆盖导入" : "确认合并导入",
        tone: replaceExisting ? "danger" : "primary",
        onConfirm: () => {
          setStudents((current) => replaceExisting ? [...initialStudents, ...importedStudents] : (() => {
            const incomingIds = new Set(importedStudents.map((student) => student.id));
            return [...current.filter((student) => !incomingIds.has(student.id)), ...importedStudents];
          })());
          setTeachers((current) => replaceExisting ? [...initialTeachers, ...importedTeachers] : (() => {
            const incomingIds = new Set(importedTeachers.map((teacher) => teacher.id));
            return [...current.filter((teacher) => !incomingIds.has(teacher.id)), ...importedTeachers];
          })());
          setSelectedStudentId(importedStudents[0].id);
          setSelectedTeacherId(importedTeachers[0].id);
          const importedAt = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
          setDataSnapshot({ label: "Supabase 多人共享真实资料", students: importedStudents.length, teachers: importedTeachers.length, importedAt });
          addAudit("导入真实资料快照", `${importedStudents.length} 位学生、${importedTeachers.length} 位老师；已写入共享数据库`, "green");
          setStudentPage(1);
          setTeacherPage(1);
          notify(`已导入并共享 ${importedStudents.length} 位学生和 ${importedTeachers.length} 位老师`);
        },
      });
    } catch {
      notify("导入失败：请选择本系统生成的本地资料包");
    } finally {
      event.target.value = "";
    }
  };

  const classroomRequest = async (body: { action: "create" | "teacher-join" | "student-link" | "end"; bookingId: string }) => {
    const response = await fetch("/api/classroom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "在线教室操作失败");
    return result;
  };

  const persistClassroom = (bookingId: string, meetingId: string, status: "ready" | "running" | "ended") => {
    setBookings((current) => {
      let changed = false;
      const next = current.map((booking) => {
        if (booking.id !== bookingId) return booking;
        const bookingStatus = status === "ended" ? "已完成" : booking.status;
        if (booking.status === bookingStatus && booking.classroom?.meetingId === meetingId && booking.classroom.status === status) return booking;
        changed = true;
        return {
          ...booking,
          status: bookingStatus,
          classroom: {
            meetingId,
            status,
            createdAt: booking.classroom?.createdAt ?? new Date().toISOString(),
          },
        };
      });
      return changed ? next : current;
    });
  };

  const refreshClassroom = async (booking: Booking, quiet = false) => {
    try {
      const response = await fetch(`/api/classroom?bookingId=${encodeURIComponent(booking.id)}`, { cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "无法读取教室状态");
      const recordings = Array.isArray(result.recordings) ? result.recordings : [];
      const runtime: ClassroomRuntime = { ...result.status, recordings };
      setClassroomRuntime(runtime);
      const nextStatus = runtime.running
        ? "running"
        : booking.classroom?.status === "running" || recordings.length
          ? "ended"
          : "ready";
      persistClassroom(booking.id, runtime.meetingId, nextStatus);
      if (!quiet) notify(runtime.running ? `教室进行中，当前 ${runtime.participantCount} 人在线` : recordings.length ? "课堂已结束，录播正在处理或已就绪" : "教室已创建，尚未开始");
      return runtime;
    } catch (error) {
      if (!quiet) notify(error instanceof Error ? error.message : "无法读取教室状态");
      return null;
    }
  };

  const provisionClassroom = async (booking: Booking, announce: boolean) => {
    const result = await classroomRequest({ action: "create", bookingId: booking.id });
    const meetingId = String(result.meeting?.meetingId || "");
    if (!meetingId) throw new Error("在线教室没有返回会议 ID");
    persistClassroom(booking.id, meetingId, "ready");
    if (!classroomRuntime?.running) setClassroomRuntime({ meetingId, running: false, participantCount: 0, moderatorCount: 0, recordings: classroomRuntime?.recordings ?? [] });
    if (announce) {
      addAudit("创建在线教室", `${studentById(booking.studentId)?.name ?? booking.studentId} · ${booking.id}`, "green");
      notify(result.meeting?.duplicate ? "已读取现有在线教室" : "在线教室已创建，可发送学生链接");
    }
    return meetingId;
  };

  const createClassroom = async (booking: Booking) => {
    if (isPastBooking(booking)) {
      notify("历史课程不能新建网上教室，请创建新的排课");
      return "";
    }
    setClassroomBusy(true);
    try {
      return await provisionClassroom(booking, true);
    } catch (error) {
      notify(error instanceof Error ? error.message : "在线教室创建失败");
      return "";
    } finally {
      setClassroomBusy(false);
    }
  };

  const joinTeacherClassroom = async (booking: Booking) => {
    if (isPastBooking(booking)) {
      notify("历史课程不能重新开课，请创建新的排课");
      return;
    }
    const popup = window.open("about:blank", "_blank");
    if (popup) {
      const useEnglishInterface = displayPreferences.language === "en-AU";
      popup.opener = null;
      popup.document.title = useEnglishInterface ? "Entering online classroom" : "正在进入网上教室";
      popup.document.documentElement.lang = useEnglishInterface ? "en-AU" : "zh-CN";
      popup.document.body.innerHTML = `
        <main style="min-height:100vh;display:grid;place-items:center;margin:0;background:#f4fbfa;color:#163b37;font-family:Arial,sans-serif">
          <section style="width:min(420px,calc(100vw - 40px));text-align:center">
            <div style="width:44px;height:44px;margin:0 auto 20px;border:4px solid #c8ebe8;border-top-color:#277f77;border-radius:50%;animation:spin 1s linear infinite"></div>
            <h1 style="font-size:22px;margin:0 0 10px">${useEnglishInterface ? "Connecting to online classroom" : "正在连接网上教室"}</h1>
            <p style="font-size:15px;line-height:1.6;margin:0;color:#55746f">${
              useEnglishInterface
                ? "This usually takes 10–30 seconds. Keep this page open, then allow microphone and camera access when prompted."
                : "通常需要 10–30 秒，请不要关闭此页面。进入后请允许浏览器使用麦克风和摄像头。"
            }</p>
          </section>
          <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
        </main>`;
    }
    setClassroomBusy(true);
    try {
      const result = await classroomRequest({ action: "teacher-join", bookingId: booking.id });
      if (!result.url) throw new Error("无法生成老师进入链接");
      const meetingId = String(result.meetingId || booking.classroom?.meetingId || "");
      if (meetingId) persistClassroom(booking.id, meetingId, "ready");
      if (popup) {
        popup.location.replace(result.url);
        notify("课堂已在新标签页打开；首次进入请允许浏览器使用麦克风和摄像头");
      } else {
        window.location.assign(result.url);
      }
      addAudit("老师进入在线教室", `${studentById(booking.studentId)?.name ?? booking.studentId} · ${booking.id}`, "blue");
      window.setTimeout(() => void refreshClassroom({ ...booking, classroom: booking.classroom ?? { meetingId, status: "ready", createdAt: new Date().toISOString() } }, true), 2500);
    } catch (error) {
      popup?.close();
      notify(error instanceof Error ? error.message : "无法进入在线教室");
    } finally {
      setClassroomBusy(false);
    }
  };

  const copyStudentClassroomLink = async (booking: Booking) => {
    if (isPastBooking(booking)) {
      notify("历史课程不能生成新的学生进入链接");
      return;
    }
    setClassroomBusy(true);
    try {
      const result = await classroomRequest({ action: "student-link", bookingId: booking.id });
      if (!result.url) throw new Error("无法生成学生进入链接");
      const meetingId = String(result.meetingId || booking.classroom?.meetingId || "");
      if (meetingId) persistClassroom(booking.id, meetingId, "ready");
      setTemporaryClassroomLink({ bookingId: booking.id, url: String(result.url) });
      addAudit("复制学生教室链接", `${studentById(booking.studentId)?.name ?? booking.studentId} · ${booking.id}`, "blue");
      try {
        await Promise.race([
          navigator.clipboard.writeText(result.url),
          new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("clipboard timeout")), 1500)),
        ]);
        notify("学生进入链接已复制");
      } catch {
        notify("学生链接已生成，请从页面复制或直接打开学生端");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "学生链接生成失败");
    } finally {
      setClassroomBusy(false);
    }
  };

  const prepareTemporaryClassroomLink = async (booking: Booking) => {
    setClassroomBusy(true);
    try {
      // Shared booking writes are debounced. Retry briefly until the server can
      // authorize the newly-created scoped booking.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await fetch("/api/classroom", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "student-link", bookingId: booking.id }),
        });
        const result = await response.json().catch(() => ({}));
        if (response.ok && result.url) {
          const meetingId = String(result.meetingId || booking.classroom?.meetingId || "");
          if (meetingId) persistClassroom(booking.id, meetingId, "ready");
          setTemporaryClassroomLink({ bookingId: booking.id, url: String(result.url) });
          addAudit("创建临时网上课堂", `${studentById(booking.studentId)?.name ?? booking.studentId} · ${booking.id}`, "green");
          notify("临时课堂已创建，学生链接可以复制或打开");
          return;
        }
        if (response.status !== 403 || attempt === 19) {
          throw new Error(result.error || "临时课堂创建失败");
        }
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "临时课堂创建失败");
    } finally {
      setClassroomBusy(false);
    }
  };

  const submitTemporaryClassroom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const studentId = String(data.get("studentId") ?? "").trim();
    const teacherId = isTeacherView ? (currentTeacher?.id ?? "") : String(data.get("teacherId") ?? "").trim();
    const duration = Number(data.get("duration") ?? 60);
    const student = studentById(studentId);
    const teacher = teacherById(teacherId);
    if (!student || !teacher) {
      notify("请从清单选择学生和老师。");
      return;
    }
    if (isTeacherView && !scopedStudentIds.has(studentId)) {
      notify("老师账号只能为自己的学生创建临时课堂。");
      return;
    }

    const parts = zonedParts(new Date(), scheduleTimezone);
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const start = `${parts.hour}:${parts.minute}`;
    if (scheduleConflict(studentId, teacherId, date, start, duration, scheduleTimezone)) {
      notify("学生或老师当前已有重叠课程，请先调整现有排课。");
      return;
    }

    const bookingId = id("TMP");
    const booking: Booking = {
      id: bookingId,
      studentId,
      teacherId,
      date,
      start,
      duration,
      kind: "常规课",
      status: "已确认",
      timezone: scheduleTimezone,
      recurring: false,
      repeatCount: 1,
      course: String(data.get("course") ?? "").trim() || `${student.course}（临时课堂）`,
      source: "临时课堂",
      classroom: {
        meetingId: `yinling-${bookingId}`,
        status: "ready",
        createdAt: new Date().toISOString(),
      },
    };

    setTemporaryClassroomLink(null);
    setBookings((current) => [...current, booking]);
    setSelectedBookingId(booking.id);
    setSelectedBookingDate(date);
    setSelectedBookingDateId(booking.id);
    setSelectedStudentId(studentId);
    setSelectedTeacherId(teacherId);
    setClassroomView("upcoming");
    setClassroomRuntime(null);
    setMobilePreview("classroom");
    setModal(null);
    setActive("classroom");
    void prepareTemporaryClassroomLink(booking);
  };

  const endClassroom = async (booking: Booking) => {
    requestConfirmation({
      title: "确认结束在线课堂",
      detail: `${studentById(booking.studentId)?.name ?? booking.studentId} · ${booking.date} ${booking.start}`,
      items: ["所有在线参与者会立即离开", "排课状态会更新为已完成", "课时与薪资仍需人工核对", "录播处理完成后才会出现回放"],
      confirmLabel: "结束课堂并结课",
      tone: "danger",
      onConfirm: async () => {
        setClassroomBusy(true);
        try {
          const result = await classroomRequest({ action: "end", bookingId: booking.id });
          persistClassroom(booking.id, String(result.meetingId || booking.classroom?.meetingId || ""), "ended");
          setClassroomRuntime((current) => current ? { ...current, running: false, participantCount: 0, moderatorCount: 0 } : current);
          addAudit("结束在线教室", `${studentById(booking.studentId)?.name ?? booking.studentId} · ${booking.id}`, "green");
          notify("课堂已结束并更新课程状态；课时和薪资仍需人工核对");
        } catch (error) {
          notify(error instanceof Error ? error.message : "在线教室结束失败");
        } finally {
          setClassroomBusy(false);
        }
      },
    });
  };

  useEffect(() => {
    if (active !== "classroom" || !selectedBooking?.classroom?.meetingId) return;
    let stopped = false;
    const poll = async () => {
      const response = await fetch(`/api/classroom?bookingId=${encodeURIComponent(selectedBooking.id)}`, { cache: "no-store" }).catch(() => null);
      if (!response || stopped) return;
      const result = await response.json().catch(() => ({}));
      if (!response.ok || stopped) return;
      const recordings = Array.isArray(result.recordings) ? result.recordings : [];
      const runtime: ClassroomRuntime = { ...result.status, recordings };
      setClassroomRuntime(runtime);
      setBookings((current) => {
        let changed = false;
        const next = current.map((booking) => {
          if (booking.id !== selectedBooking.id) return booking;
          const nextStatus: NonNullable<Booking["classroom"]>["status"] = runtime.running ? "running" : booking.classroom?.status === "running" || recordings.length ? "ended" : "ready";
          const bookingStatus = nextStatus === "ended" ? "已完成" : booking.status;
          if (booking.status === bookingStatus && booking.classroom?.meetingId === runtime.meetingId && booking.classroom.status === nextStatus) return booking;
          changed = true;
          return {
            ...booking,
            status: bookingStatus,
            classroom: { meetingId: runtime.meetingId, status: nextStatus, createdAt: booking.classroom?.createdAt ?? new Date().toISOString() },
          };
        });
        return changed ? next : current;
      });
    };
    void poll();
    const interval = window.setInterval(poll, 15000);
    return () => { stopped = true; window.clearInterval(interval); };
  }, [active, selectedBooking?.classroom?.meetingId, selectedBooking?.id, setBookings]);

  const renderTeacherDashboard = () => {
    const english = displayPreferences.language === "en-AU";
    const pendingBookings = scopedBookings.filter(
      (booking) => booking.status === "待确认" && !isPastBooking(booking),
    );
    const upcomingTeacherBookings = scopedBookings
      .filter((booking) => !isPastBooking(booking))
      .sort(
        (left, right) =>
          bookingInstant(left).getTime() - bookingInstant(right).getTime(),
      );
    const totalMinutes = scopedBookings.reduce((sum, booking) => sum + booking.duration, 0);
    const todayLabel = new Intl.DateTimeFormat(localeFor(displayPreferences.language), { year: "numeric", month: "long", day: "numeric", weekday: "long", timeZone: displayPreferences.timezone }).format(new Date());
    return <>
      <ViewHeading eyebrow={todayLabel} title={english ? "My teaching workspace" : "我的教学工作台"} copy={english ? `Students, schedule, and online classrooms for ${currentOperator}. This view only includes data linked directly to this teacher.` : `${currentOperator} 老师的学生、排课与网上教室。这里只显示与当前老师直接关联的真实资料。`} actions={<><button className="secondary-button" type="button" onClick={() => setActive("students")}><Users size={17} /> {english ? "My students" : "我的学生"}</button><button className="primary-button" type="button" onClick={() => openNewBooking()}><CalendarPlus size={17} /> {english ? "New booking" : "新建约课"}</button></>} />
      <section className="command-strip teacher-command-strip" aria-label={english ? "Teacher shortcuts" : "老师快捷操作"}>
        <button type="button" onClick={() => openNewBooking()}><CalendarPlus size={18} /><span><strong>{english ? "Schedule a lesson" : "安排课程"}</strong><small>{english ? "Choose one of your students and check for conflicts" : "从自己的学生中选择并检查时间冲突"}</small></span><ChevronRight size={16} /></button>
        <button type="button" onClick={() => setActive("schedule")}><CalendarDays size={18} /><span><strong>{english ? "View schedule" : "查看课表"}</strong><small>{english ? "Review student, teacher, and Melbourne times" : "按学生、老师和墨尔本时间核对"}</small></span><ChevronRight size={16} /></button>
        <button type="button" onClick={() => setActive("classroom")}><Video size={18} /><span><strong>{english ? "Online classroom" : "网上教室"}</strong><small>{english ? "Create a room, share student links, and check recordings" : "创建课堂、发送学生链接并查看录播"}</small></span><ChevronRight size={16} /></button>
      </section>
      <section className="metric-grid teacher-metric-grid" aria-label={english ? "My teaching overview" : "我的教学概览"}>
        <Metric tone="green" icon={<Users size={21} />} value={scopedStudents.length.toString()} label={english ? "My students" : "我的学生"} detail={english ? "Students linked to this teacher only" : "仅显示当前老师关联学生"} onClick={() => setActive("students")} />
        <Metric tone="blue" icon={<CalendarDays size={21} />} value={scopedBookings.length.toString()} label={english ? "Lesson records" : "课程记录"} detail={english ? "Imported schedule records" : "当前已导入的排课"} onClick={() => setActive("schedule")} />
        <Metric tone="amber" icon={<Clock3 size={21} />} value={pendingBookings.length.toString()} label={english ? "Pending" : "待确认"} detail={english ? "Lessons needing confirmation" : "需要确认的课程"} onClick={() => setActive("schedule")} />
        <Metric tone="purple" icon={<Video size={21} />} value={`${Math.round(totalMinutes / 60)}h`} label={english ? "Scheduled time" : "排课时长"} detail={english ? "Based on the current lesson records" : "按当前课程记录汇总"} onClick={() => setActive("classroom")} />
      </section>
      <section className="teacher-dashboard-grid">
        <article className="panel teacher-roster-panel"><div className="panel-header"><div><p className="eyebrow">{english ? "Student management" : "学生管理"}</p><h2>{english ? "My students" : "我的学生"}</h2></div><IconButton label={english ? "Open students" : "打开学生列表"} onClick={() => setActive("students")}><Users size={18} /></IconButton></div><div className="teacher-student-list">{scopedStudents.slice(0, 8).map((student) => <button type="button" key={student.id} onClick={() => goToStudent(student.id)}><Avatar initials={student.initials} tone={statusTone(student.status)} /><span><strong>{student.name}</strong><small>{student.course} · {displayTerm(student.status, displayPreferences.language)}</small></span><ChevronRight size={16} /></button>)}{!scopedStudents.length && <EmptyState title={english ? "No linked students" : "暂无关联学生"} detail={english ? "Students appear here after they are linked by an administrator or their lessons are imported." : "管理员为老师关联学生或导入排课后，这里会自动出现。"} />}</div></article>
        <article className="panel today-panel"><div className="panel-header"><div><p className="eyebrow">{english ? "My schedule" : "我的排课"}</p><h2>{english ? "Upcoming lessons" : "接下来课程"}</h2></div><IconButton label={english ? "Open schedule" : "打开排课"} onClick={() => setActive("schedule")}><CalendarDays size={18} /></IconButton></div>{upcomingTeacherBookings.length ? <ScheduleList bookings={upcomingTeacherBookings} studentById={studentById} teacherById={teacherById} onOpen={(booking) => { setSelectedBookingId(booking.id); setSelectedBookingDate(booking.date); setSelectedBookingDateId(booking.id); setSelectedStudentId(booking.studentId); setActive("schedule"); }} /> : <EmptyState title={english ? "No upcoming lessons" : "暂无未来排课"} detail={english ? "Use New booking to schedule a future lesson for one of your students." : "点击“新建约课”为自己的学生安排未来课程。"} />}<button className="text-button" type="button" onClick={() => setActive("classroom")}><Video size={16} /> {english ? "Manage online classrooms" : "管理在线教室"}</button></article>
      </section>
    </>;
  };

  const renderDashboard = () => {
    if (isTeacherView) return renderTeacherDashboard();
    const operatorStudents = scopedStudents;
    const operatorStudentIds = new Set(operatorStudents.map((student) => student.id));
    const operatorBookings = currentOperator === "Nixon" ? bookings : bookings.filter((booking) => operatorStudentIds.has(booking.studentId));
    const todayDate = isoDateInTimezone(new Date(), "Australia/Melbourne");
    const operatorTodayBookings = operatorBookings
      .flatMap((booking) => bookingOccurrencesWithinRange(booking, shiftIsoDate(todayDate, -1), shiftIsoDate(todayDate, 1)))
      .filter((booking) => isoDateInTimezone(bookingInstant(booking), "Australia/Melbourne") === todayDate);
    const operatorExamStudents = examReminderStudents.filter((student) => operatorStudentIds.has(student.id));
    const operatorDstBookings = dstRiskBookings.filter((booking) => operatorStudentIds.has(booking.studentId));
    const nearestExam = operatorExamStudents[0];
    const pendingAva = recordTeachers.filter((teacher) => (teacher.availabilityStatus ?? "待确认") === "待确认").length;
    const todayLabel = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(new Date());
    return <>
      <ViewHeading eyebrow={todayLabel} title="To Do List" actions={<><button className="secondary-button" type="button" onClick={() => setActive("schedule")}><CalendarDays size={17} /> 查看排课</button><button className="primary-button" type="button" onClick={() => setModal("student")}><UserPlus size={17} /> 新建学生</button></>} />
      <section className="command-strip" aria-label="快速工作流">
        <button type="button" onClick={() => openNewBooking()}><CalendarPlus size={18} /><span><strong>安排课程</strong></span><ChevronRight size={16} /></button>
        <button type="button" onClick={() => setActive("lp")}><BookOpen size={18} /><span><strong>处理 LP</strong></span><ChevronRight size={16} /></button>
        <button type="button" onClick={() => setModal("operation")}><RefreshCw size={18} /><span><strong>记录异常</strong></span><ChevronRight size={16} /></button>
        {canViewPayroll && <button type="button" onClick={() => setActive("payroll")}><Wallet size={18} /><span><strong>核对薪资</strong></span><ChevronRight size={16} /></button>}
      </section>
      <section className="dashboard-grid">
        <div><ToDoList tasks={visibleTasks} studentName={(studentId) => studentById(studentId)?.name} filter={taskFilter} onFilterChange={setTaskFilter} onComplete={completeTask} onOpen={(task) => goToStudent(task.studentId)} /><button className="text-button" type="button" onClick={() => setModal("task")}><Plus size={16} /> 添加内部任务</button></div>
        <article className="panel today-panel"><div className="panel-header"><div><p className="eyebrow">墨尔本今日 · 按学生当地时间</p><h2>今日课程</h2></div><IconButton label="打开排课" onClick={() => setActive("schedule")}><CalendarDays size={18} /></IconButton></div><ScheduleList bookings={operatorTodayBookings} studentById={studentById} teacherById={teacherById} onOpen={(booking) => goToStudent(booking.studentId, "schedule")} /><div className="panel-foot"><MapPin size={15} /> 排课页会同时显示学生、老师与公司时间</div></article>
        <article className="panel risk-panel"><div className="panel-header"><div><h2>风险与缺口</h2></div><StatusPill tone="amber">{operatorExamStudents.length + operatorDstBookings.length + pendingAva} 项</StatusPill></div>{nearestExam ? <RiskRow tone="amber" title={`${nearestExam.name} 的考试进入 30 天窗口`} detail={`${nearestExam.examSubject ?? "考试"} · ${nearestExam.examDate}`} action={() => goToStudent(nearestExam.id)} /> : null}{operatorDstBookings.length ? <RiskRow tone="purple" title={`${operatorDstBookings.length} 节长期课受夏令时影响`} detail="学生与老师时差会变化" action={() => setActive("schedule")} /> : null}<RiskRow tone="blue" title={`${pendingAva} 位老师的 AVA 待结构化`} detail="排课前需确认" action={() => setActive("teachers")} /></article>
      </section>
    </>;
  };

  const renderStudents = () => {
    const english = displayPreferences.language === "en-AU";
    const viewItems = [
      { id: "all", label: isTeacherView && displayPreferences.language === "en-AU" ? "My students" : isAdminView ? "全部学生" : isTeacherView ? "我的学生" : "我负责的学生", count: scopedStudents.length },
      ...(!isTeacherView ? [{ id: "mine", label: currentOperator === "Nixon" ? "我负责的" : `${currentOperator} 负责`, count: scopedStudents.filter((student) => student.owner === currentOperator).length }] : []),
      { id: "trial", label: isTeacherView && displayPreferences.language === "en-AU" ? "Trials / to schedule" : "试听与待排课", count: scopedStudents.filter((student) => student.status === "试听中" || student.status === "待排课").length },
      { id: "enrolled", label: isTeacherView && displayPreferences.language === "en-AU" ? "Enrolled and active" : "已报名在读", count: scopedStudents.filter((student) => student.segment === "已报名" && isActiveStudent(student)).length },
      { id: "lp", label: isTeacherView && displayPreferences.language === "en-AU" ? "Needs LP" : "需要 LP", count: scopedStudents.filter(requiresLp).length },
      { id: "renewal", label: isTeacherView && displayPreferences.language === "en-AU" ? "Renewal due" : "待续课", count: scopedStudents.filter((student) => student.status === "待续课").length },
      { id: "paused", label: isTeacherView && displayPreferences.language === "en-AU" ? "Paused / inactive" : "暂停/非在读", count: scopedStudents.filter((student) => student.status === "停课" || student.status === "非在读" || student.status === "不活跃").length },
    ];
    const pageIds = pagedStudents.map((student) => student.id);
    const pageSelected = pageIds.length > 0 && pageIds.every((studentId) => selectedStudentIds.includes(studentId));
    const visibleSelectedStudent = pagedStudents.find((student) => student.id === selectedStudentId) ?? pagedStudents[0];
    return <>
      <ViewHeading eyebrow={isTeacherView ? (english ? "Teacher workspace · students and bookings" : "老师个人视图 · 学生与约课") : "学生 CRM · 试听、已报名与 LP 分流"} title={isTeacherView && english ? "My students" : isTeacherView ? "我的学生" : "学生档案"} copy={isTeacherView && english ? "View the students you teach and schedule lessons directly. Student status is maintained by Operations." : isTeacherView ? "查看自己负责授课的学生资料，并直接为学生安排课程。学生状态由教务维护。" : "按学员状态、负责教务和 LP 类型筛选；年级按基准年份自动推进，Report、跟进、考试与特殊备注集中在同一档案。"} actions={<><button className="secondary-button" type="button" onClick={() => setGlobalSearchOpen(true)}><Search size={17} /> {isTeacherView && english ? "Find a student" : "查找学生"}</button>{!isTeacherView && <button className="primary-button" type="button" onClick={() => setModal("student")}><UserPlus size={17} /> 新建学生</button>}</>} />
      <section className="panel collection-shell student-collection">
        <ViewTabs value={studentView} items={viewItems} onChange={(value) => { setStudentView(value); setStudentPage(1); setSelectedStudentIds([]); }} label="学生保存视图" />
        <ListToolbar query={search} onQuery={(value) => { setSearch(value); setStudentPage(1); }} placeholder={isTeacherView && english ? "Search name, ID, course, teacher, or owner" : "搜索姓名、ID、课程、老师或负责人"} count={`${filteredStudents.length} ${isTeacherView && english ? "students" : "位学生"}`}>
          {isAdminView && <select className="filter-select" value={studentOwner} onChange={(event) => { setStudentOwner(event.target.value); setStudentPage(1); }} aria-label="按负责教务筛选"><option value="all">全部教务</option>{ownerOptions.map((owner) => <option key={owner}>{owner}</option>)}</select>}
          <button className="toolbar-button" type="button" onClick={() => { setSearch(""); setStudentOwner("all"); setStudentView("all"); setStudentPage(1); }}><Filter size={15} /> 清除筛选</button>
          <button className="toolbar-button" type="button" onClick={() => notify("当前列配置已保存在此浏览器") }><ArrowUpDown size={15} /> 姓名排序</button>
        </ListToolbar>
        {selectedStudentIds.length > 0 && <div className="bulk-bar"><strong>已选 {selectedStudentIds.length} 位</strong><span>批量分配负责人</span>{teamOwnerOptions.map((owner) => <button type="button" key={owner} onClick={() => bulkAssignStudents(owner)}>{owner}</button>)}<button className="bulk-clear" type="button" onClick={() => setSelectedStudentIds([])}>取消选择</button></div>}
        <div className="master-detail-layout">
          <article className="collection-main">
            <div className="collection-head student-grid"><input type="checkbox" disabled={!isAdminView} checked={pageSelected} aria-label={english ? "Select students on this page" : "选择本页学生"} onChange={() => setSelectedStudentIds(pageSelected ? selectedStudentIds.filter((studentId) => !pageIds.includes(studentId)) : Array.from(new Set([...selectedStudentIds, ...pageIds])))} /><span>{isTeacherView && english ? "Student / grade / course" : "学生 / 年级 / 课程"}</span><span>{isTeacherView && english ? "Status / teacher" : "学员状态 / 老师"}</span><span>{isTeacherView && english ? "Operations owner" : "负责教务"}</span><span>{isTeacherView && english ? "Next step" : "下一步"}</span></div>
            <div className="collection-viewport">
              {pagedStudents.length ? pagedStudents.map((student) => <div className={`collection-row student-grid ${visibleSelectedStudent?.id === student.id ? "selected" : ""}`} key={student.id}><input type="checkbox" disabled={!isAdminView} checked={selectedStudentIds.includes(student.id)} aria-label={`${english ? "Select" : "选择"} ${student.name}`} onChange={() => toggleStudentSelection(student.id)} /><button className="row-primary table-person" type="button" onClick={() => openStudentPreview(student.id)}><Avatar initials={student.initials} tone={statusTone(student.status)} /><span><strong>{student.name}</strong><small>{student.id} · {currentGrade(student)} · {student.course}</small></span></button><button className="row-cell stacked" type="button" onClick={() => openStudentPreview(student.id)}><StatusPill tone={statusTone(student.status)}>{displayTerm(student.segment ?? "已报名", displayPreferences.language)} · {displayTerm(student.status, displayPreferences.language)}</StatusPill><small>{student.teacher}</small></button><button className="row-cell" type="button" onClick={() => openStudentPreview(student.id)}>{student.owner}</button><button className="row-cell" type="button" onClick={() => openStudentPreview(student.id)}><StatusPill tone={student.nextTone}>{student.next}</StatusPill></button></div>) : <EmptyState title={isTeacherView && english ? "No matching students" : "没有符合条件的学生"} detail={isTeacherView && english ? "Adjust your search or switch the saved view and try again." : "调整搜索或切换保存视图后再试。"} />}
            </div>
            <Pagination page={safeStudentPage} total={filteredStudents.length} pageSize={pageSize} onPage={(page) => { setStudentPage(page); setMobilePreview(null); }} />
          </article>
          {visibleSelectedStudent ? <StudentDetail student={visibleSelectedStudent} tasks={scopedTasks} bookings={scopedBookings} files={scopedFiles} studentById={studentById} teacherById={teacherById} preferences={displayPreferences} mobileOpen={mobilePreview === "student"} canEditStatus={!isTeacherView} onClose={() => setMobilePreview(null)} onRecord={(section) => openStudentRecord(visibleSelectedStudent.id, section)} onSchedule={() => { setMobilePreview(null); openNewBooking(visibleSelectedStudent.id); }} onEdit={() => { setSelectedStudentId(visibleSelectedStudent.id); setModal("studentEdit"); }} onEvidence={() => { setSelectedStudentId(visibleSelectedStudent.id); setModal("studentEvidence"); }} onStatus={(status) => updateStudentStatus(visibleSelectedStudent, status)} /> : <aside className="record-preview"><EmptyState title="没有可显示的学生" detail="调整筛选条件后再选择学生。" /></aside>}
        </div>
      </section>
    </>;
  };

  const renderTeachers = () => {
    const viewItems = [
      { id: "available", label: "可接新生", count: recordTeachers.filter((teacher) => teacher.acceptsStudents).length },
      { id: "matched", label: "高匹配", count: recordTeachers.filter((teacher) => teacherMatch(teacher) >= 85).length },
      { id: "capacity", label: "容量充足", count: recordTeachers.filter((teacher) => teacher.load < teacher.capacity * 0.8).length },
      { id: "all", label: "全部老师", count: recordTeachers.length },
    ];
    const visibleSelectedTeacher = pagedTeachers.find((teacher) => teacher.id === selectedTeacherId) ?? pagedTeachers[0];
    return <>
      <ViewHeading eyebrow="教师总表 · 中小学与大学合并检索" title="老师资源库" copy="跨部门老师只保留一份主档，可按标准科目、接新状态和 AVA 搜索；原始 AVA 未结构化时明确提示人工确认。" actions={<button className="primary-button" type="button" disabled={!visibleSelectedTeacher} onClick={() => openNewBooking(undefined, visibleSelectedTeacher?.id)}><CalendarPlus size={17} /> 用当前候选排课</button>} />
      <section className="matching-context"><div><span>当前匹配学生</span><strong>{selectedStudent.name}</strong><small>{selectedStudent.course} · {selectedStudent.timezone}</small></div><button type="button" onClick={() => setActive("students")}>更换学生 <ChevronRight size={15} /></button></section>
      {visibleSelectedTeacher ? <TeacherAvaBoard teacher={visibleSelectedTeacher} teachers={recordTeachers} bookings={bookings} studentById={studentById} targetTimezone={scheduleTimezone} preferences={displayPreferences} view={avaView} monthOffset={avaMonthOffset} onView={setAvaView} onMonthOffset={setAvaMonthOffset} onTeacherChange={setSelectedTeacherId} onAddAva={() => { setAvaDraft(null); setModal("ava"); }} onEditAva={(slotIndex) => editAvaSlot(visibleSelectedTeacher.id, slotIndex)} onDeleteAva={(slotIndex) => deleteAvaSlot(visibleSelectedTeacher.id, slotIndex)} /> : <section className="panel"><EmptyState title="没有可显示的老师 AVA" detail="调整筛选条件后再选择老师。" /></section>}
      <section className="panel collection-shell">
        <ViewTabs value={teacherView} items={viewItems} onChange={(value) => { setTeacherView(value); setTeacherPage(1); }} label="老师保存视图" />
        <ListToolbar query={teacherQuery} onQuery={(value) => { setTeacherQuery(value); setTeacherPage(1); }} placeholder="搜索老师、科目、ID 或时区" count={`${filteredTeachers.length} 位老师`}>
          <select className="filter-select" value={teacherSubject} onChange={(event) => { setTeacherSubject(event.target.value); setTeacherPage(1); }} aria-label="按标准科目筛选"><option value="all">全部科目</option>{teacherSubjectOptions.map((subject) => <option key={subject}>{subject}</option>)}</select>
          <select className="filter-select" value={teacherDay} onChange={(event) => { setTeacherDay(event.target.value); setTeacherPage(1); }} aria-label="按星期可排筛选"><option value="all">全部星期</option><option value="1">周一</option><option value="2">周二</option><option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option><option value="0">周日</option></select>
          <button className="toolbar-button" type="button" onClick={() => { setTeacherQuery(""); setTeacherSubject("all"); setTeacherDay("all"); setTeacherView("available"); }}><Filter size={15} /> 清除筛选</button>
        </ListToolbar>
        <div className="master-detail-layout teacher-layout">
          <article className="collection-main">
            <div className="collection-head teacher-grid-row"><span>老师 / 科目</span><span>匹配</span><span>已排 / 容量</span><span>AVA</span><span>状态</span></div>
            <div className="collection-viewport">
              {pagedTeachers.length ? pagedTeachers.map((teacher) => {
                const ava = availabilitySummary(teacher);
                return <button className={`collection-row teacher-grid-row ${visibleSelectedTeacher?.id === teacher.id ? "selected" : ""}`} type="button" key={teacher.id} onClick={() => { setSelectedTeacherId(teacher.id); setMobilePreview("teacher"); }}><span className="table-person"><Avatar initials={teacher.initials} tone={teacher.acceptsStudents ? "green" : "neutral"} /><span><strong>{teacher.name}</strong><small>{teacher.subjects.slice(0, 2).join(" · ")} · {(teacher.departments ?? []).join("/")}</small></span></span><strong className="match-score">{teacherMatch(teacher)}%</strong><span className="teacher-load"><strong className={teacher.newStudentCapacity === 0 ? "low-hours" : ""}>{teacher.newStudentCapacity === undefined ? "待录入" : `${teacher.newStudentCapacity} 人`}</strong><small>可接新生</small></span><span className={`teacher-availability ${ava.raw ? "raw" : ""}`}><strong>{ava.title}</strong><small>{ava.detail}</small></span><StatusPill tone={teacher.acceptsStudents ? "green" : teacher.availabilityStatus === "待确认" ? "amber" : "neutral"}>{teacher.availabilityStatus ?? (teacher.acceptsStudents ? "可接新生" : "暂停接新")}</StatusPill></button>;
              }) : <EmptyState title="没有匹配的老师" detail="切换视图或清除搜索条件。" />}
            </div>
            <Pagination page={safeTeacherPage} total={filteredTeachers.length} pageSize={teacherPageSize} onPage={(page) => { setTeacherPage(page); setMobilePreview(null); }} />
          </article>
          {visibleSelectedTeacher ? <aside className={`record-preview teacher-preview ${mobilePreview === "teacher" ? "mobile-detail-open" : ""}`}><button className="mobile-preview-close" type="button" aria-label="关闭老师详情" onClick={() => setMobilePreview(null)}><ChevronLeft size={20} /> 返回老师列表</button><div className="detail-top"><Avatar initials={visibleSelectedTeacher.initials} tone={visibleSelectedTeacher.acceptsStudents ? "green" : "neutral"} /><div><p>{visibleSelectedTeacher.id} · {(visibleSelectedTeacher.departments ?? ["待确认"]).join(" / ")}</p><h2>{visibleSelectedTeacher.name}</h2><StatusPill tone={visibleSelectedTeacher.acceptsStudents ? "green" : visibleSelectedTeacher.availabilityStatus === "待确认" ? "amber" : "neutral"}>{visibleSelectedTeacher.availabilityStatus ?? (visibleSelectedTeacher.acceptsStudents ? "可接新生" : "暂停接新")}</StatusPill></div></div><div className="match-hero"><span>与 {selectedStudent.name} 的匹配度</span><strong>{teacherMatch(visibleSelectedTeacher)}%</strong><small>{visibleSelectedTeacher.note}</small></div><div className="detail-section"><span>可教科目</span><div className="teacher-tags">{visibleSelectedTeacher.subjects.map((subject) => <span key={subject}>{subject}</span>)}</div><p>{visibleSelectedTeacher.subjectDetail ?? "以教师总表原始范围为准"}</p></div><div className="detail-section split"><div><span>地区 / 时区</span><strong>{visibleSelectedTeacher.location ?? "待确认"} · {timezoneLabel(visibleSelectedTeacher.timezone, displayPreferences.language)}</strong></div><div><span>可接新生</span><strong className={visibleSelectedTeacher.newStudentCapacity === 0 ? "low-hours" : ""}>{visibleSelectedTeacher.newStudentCapacity === undefined ? "待录入" : `${visibleSelectedTeacher.newStudentCapacity} 人`}</strong></div></div><div className="detail-section availability-converter"><span>AVA 换算显示</span><select className="filter-select" value={scheduleTimezone} onChange={(event) => updateDisplayPreferences({ timezone: cleanTimezone(event.target.value) })} aria-label="AVA 显示时区">{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{displayPreferences.language === "en-AU" ? option.en : option.zh}</option>)}</select><strong className={`availability-value ${(visibleSelectedTeacher.availabilitySlots?.length ?? 0) ? "structured" : "raw"}`}>{availabilityInTimezone(visibleSelectedTeacher, scheduleTimezone, displayPreferences)}</strong><p>来源：{visibleSelectedTeacher.availabilityUpdated ?? "教师总表"} · 原时区 {timezoneLabel(visibleSelectedTeacher.availabilityTimezone ?? visibleSelectedTeacher.timezone, displayPreferences.language)}</p></div><button className="primary-button full" type="button" disabled={!visibleSelectedTeacher.acceptsStudents} onClick={() => assignTeacher(visibleSelectedTeacher)}><Check size={16} /> 选择为候选老师</button>{isAdminView && <><button className="secondary-button full" type="button" onClick={() => { setTeacherCapacityDraft(visibleSelectedTeacher); setModal("teacherCapacity"); }}>调整可接新生数量</button><button className="secondary-button full" type="button" onClick={() => toggleTeacherAvailability(visibleSelectedTeacher)}>{visibleSelectedTeacher.acceptsStudents ? "暂停接新" : "开放接新"}</button></>}</aside> : <aside className="record-preview"><EmptyState title="没有可显示的老师" detail="调整筛选条件后再选择老师。" /></aside>}
        </div>
      </section>
    </>;
  };

  const renderCourses = () => {
    const normalizedQuery = courseQuery.trim().toLowerCase();
    const filteredCourses = courses.filter((course) => course.name.toLowerCase().includes(normalizedQuery));
    const pageSize = 12;
    const safePage = Math.min(coursePage, Math.max(1, Math.ceil(filteredCourses.length / pageSize)));
    const pagedCourses = filteredCourses.slice((safePage - 1) * pageSize, safePage * pageSize);
    const selectedCourse = pagedCourses.find((course) => course.id === selectedCourseId) ?? pagedCourses[0];
    const selectedCourseBookings = selectedCourse ? bookings.filter((booking) => booking.course === selectedCourse.name) : [];
    const categoryFor = (name: string) => /试听/.test(name) ? "试听专用课程" : /AEAS|AAS|ACER|AMC/i.test(name) ? "考试与竞赛" : /IB|VCE|HSC|Year\s*\d/i.test(name) ? "中小学课程" : "大学与通用课程";

    return <>
      <ViewHeading eyebrow="教务宝只读课程镜像" title="课程与课包" copy="先将教务宝的在用课程目录完整镜像到本系统；课程名称可搜索、可与真实排课核对。课包价格和扣课规则仍待取得结构化来源后再启用。" actions={<button className="secondary-button" type="button" onClick={() => setActive("sync")}><RefreshCw size={17} /> 查看同步来源</button>} />
      <section className="panel collection-shell">
        <ListToolbar query={courseQuery} onQuery={(value) => { setCourseQuery(value); setCoursePage(1); }} placeholder="搜索课程名称" count={`${filteredCourses.length} 门在用课程`}>
          <button className="toolbar-button" type="button" onClick={() => { setCourseQuery(""); setCoursePage(1); }}><Filter size={15} /> 清除筛选</button>
        </ListToolbar>
        <div className="master-detail-layout course-layout">
          <article className="collection-main">
            <div className="collection-head course-grid-row"><span>课程名称</span><span>分类</span><span>本周排课</span><span>状态</span></div>
            <div className="collection-viewport">{pagedCourses.map((course) => {
              const lessonCount = bookings.filter((booking) => booking.course === course.name).length;
              return <button className={`collection-row course-grid-row ${selectedCourse?.id === course.id ? "selected" : ""}`} type="button" key={course.id} onClick={() => setSelectedCourseId(course.id)}><span><strong>{course.name}</strong><small>{course.id}</small></span><span>{categoryFor(course.name)}</span><strong>{lessonCount} 节</strong><StatusPill tone="green">{course.status}</StatusPill></button>;
            })}</div>
            <Pagination page={safePage} total={filteredCourses.length} pageSize={pageSize} onPage={setCoursePage} />
          </article>
          {selectedCourse ? <aside className="record-preview course-preview"><div className="preview-header"><div><p className="eyebrow">课程档案</p><h2>{selectedCourse.name}</h2></div><StatusPill tone="green">{selectedCourse.status}</StatusPill></div><div className="detail-section"><span>课程分类</span><strong>{categoryFor(selectedCourse.name)}</strong><p>来源：{selectedCourse.source}</p></div><div className="detail-section split"><div><span>本周排课</span><strong>{selectedCourseBookings.length} 节</strong></div><div><span>关联学生</span><strong>{new Set(selectedCourseBookings.map((booking) => booking.studentId)).size} 人</strong></div></div><div className="detail-section"><span>课包与收费规则</span><strong>待结构化导入</strong><p>当前不会根据课程名称猜测价格、课时或扣课规则。</p></div>{selectedCourseBookings.length ? <button className="primary-button full" type="button" onClick={() => { const booking = selectedCourseBookings[0]; setSelectedBookingId(booking.id); setSelectedBookingDate(booking.date); setSelectedBookingDateId(booking.id); setActive("schedule"); }}><CalendarDays size={16} /> 查看本周排课</button> : <button className="secondary-button full" type="button" onClick={() => openNewBooking()}><CalendarPlus size={16} /> 为课程安排排课</button>}</aside> : <EmptyState title="没有课程记录" detail="清除搜索条件后重试。" />}
        </div>
      </section>
    </>;
  };

  const renderSchedule = () => {
    const weekDays = weekDatesForTimezone(scheduleTimezone, displayPreferences);
    const weekRangeLabel = `${formatDisplayDate(new Date(`${weekDays[0]?.date}T12:00:00Z`), scheduleTimezone, displayPreferences)} - ${formatDisplayDate(new Date(`${weekDays.at(-1)?.date}T12:00:00Z`), scheduleTimezone, displayPreferences)}`;
    const weekDateSet = new Set(weekDays.map((day) => day.date));
    const scheduleOccurrences = scopedBookings
      .flatMap((booking) => bookingOccurrencesWithinRange(booking, shiftIsoDate(weekDays[0].date, -1), shiftIsoDate(weekDays.at(-1)!.date, 1)))
      .filter((booking) => {
        const local = zonedParts(bookingInstant(booking), scheduleTimezone);
        return weekDateSet.has(`${local.year}-${local.month}-${local.day}`);
      });
    const filteredBookings = scheduleOccurrences.filter((booking) => {
      const matchesStatus = scheduleFilter === "pending" ? booking.status === "待确认" : scheduleFilter === "trial" ? booking.kind === "试听" : scheduleFilter === "dst" ? dstRiskBookings.some((risk) => risk.id === booking.id) : true;
      if (!matchesStatus || scheduleDay === "all") return matchesStatus;
      const local = zonedParts(bookingInstant(booking), scheduleTimezone);
      return `${local.year}-${local.month}-${local.day}` === scheduleDay;
    }).sort((a, b) => bookingInstant(a).getTime() - bookingInstant(b).getTime());
    const schedulePageSize = 10;
    const safeSchedulePage = Math.min(schedulePage, Math.max(1, Math.ceil(filteredBookings.length / schedulePageSize)));
    const pagedScheduleBookings = filteredBookings.slice((safeSchedulePage - 1) * schedulePageSize, safeSchedulePage * schedulePageSize);
    const visibleWeekDays = scheduleDay === "all" ? weekDays : weekDays.filter((day) => day.date === scheduleDay);
    const currentScheduleScope = scheduleMode === "agenda" ? pagedScheduleBookings : filteredBookings;
    const displayedBooking = currentScheduleScope.find((booking) => booking.id === selectedBooking?.id && booking.date === selectedBooking?.date) ?? currentScheduleScope[0];
    const displayedBookingSeries = displayedBooking ? scopedBookings.find((booking) => booking.id === displayedBooking.id) ?? displayedBooking : undefined;
    if (!scopedBookings.length) {
      return <>
        <ViewHeading eyebrow={isTeacherView ? "老师个人课表 · 时区自动换算" : "统一时点 + IANA 时区 + AVA 占用锁定"} title={isTeacherView ? "我的排课" : "排课与时区检查"} copy={isTeacherView ? "这里只显示自己的课程；创建约课时会固定当前老师，并检查学生、老师时间冲突和 AVA。" : "排课统一保存为准确时点；可以一键切换墨尔本、阿德莱德、悉尼、布里斯班、珀斯和中国时间，并检查重叠、结构化 AVA 与夏令时风险。"} actions={<button className="primary-button" type="button" onClick={() => openNewBooking()}><CalendarPlus size={17} /> 新建约课</button>} />
        <section className="panel collection-shell"><EmptyState title="暂无真实排课数据" detail="当前 Supabase 只导入了学生和老师档案；排课数据导入后会在这里显示。" /></section>
      </>;
    }
    if (!displayedBooking || !displayedBookingSeries) {
      return <>
        <ViewHeading eyebrow={isTeacherView ? "老师个人课表 · 时区自动换算" : "统一时点 + IANA 时区 + AVA 占用锁定"} title={isTeacherView ? "我的排课" : "排课与时区检查"} copy="当前筛选没有匹配课程，不会继续显示之前选中的课程详情。" actions={<><button className="secondary-button" type="button" onClick={() => { setScheduleFilter("all"); setScheduleDay("all"); setSchedulePage(1); }}>清除排课筛选</button><button className="primary-button" type="button" onClick={() => openNewBooking()}><CalendarPlus size={17} /> 新建约课</button></>} />
        <section className="panel collection-shell"><EmptyState title="当前筛选下没有排课" detail="清除筛选后再选择需要处理的课程。" /></section>
      </>;
    }
    const bookingStudent = studentById(displayedBooking.studentId);
    const bookingTeacher = teacherById(displayedBooking.teacherId);
    if (!bookingStudent || !bookingTeacher) {
      return <>
        <ViewHeading eyebrow={isTeacherView ? "老师个人课表 · 时区自动换算" : "统一时点 + IANA 时区 + AVA 占用锁定"} title={isTeacherView ? "我的排课" : "排课与时区检查"} copy="当前课程缺少有效关联，不会继续显示其他课程的详情。" actions={<button className="primary-button" type="button" onClick={() => openNewBooking()}><CalendarPlus size={17} /> 新建约课</button>} />
        <section className="panel collection-shell"><EmptyState title="课程关联资料不完整" detail="课程缺少有效的学生或老师内部 ID，请先在数据来源中修复关联。" /></section>
      </>;
    }
    const selectedInstant = bookingInstant(displayedBooking);
    const selectedDstRisk = bookingHasDstRisk(displayedBookingSeries, bookingStudent, bookingTeacher);
    const historicalBooking = isPastBooking(displayedBooking);
    return <>
      <ViewHeading eyebrow={isTeacherView ? "老师个人课表 · 时区自动换算" : "统一时点 + IANA 时区 + AVA 占用锁定"} title={isTeacherView ? "我的排课" : "排课与时区检查"} copy={isTeacherView ? "这里只显示自己的课程；创建约课时会固定当前老师，并检查学生、老师时间冲突和 AVA。" : "排课统一保存为准确时点；可以一键切换墨尔本、阿德莱德、悉尼、布里斯班、珀斯和中国时间，并检查重叠、结构化 AVA 与夏令时风险。"} actions={<button className="primary-button" type="button" onClick={() => openNewBooking()}><CalendarPlus size={17} /> 新建约课</button>} />
      <section className="panel schedule-shell">
        <div className="calendar-toolbar"><div className="segmented"><button className={scheduleMode === "week" ? "active" : ""} type="button" onClick={() => setScheduleMode("week")}>{displayPreferences.language === "en-AU" ? "Week" : "周视图"}</button><button className={scheduleMode === "agenda" ? "active" : ""} type="button" onClick={() => { setScheduleMode("agenda"); setSchedulePage(1); }}>{displayPreferences.language === "en-AU" ? "List" : "日程列表"}</button></div><strong>{weekRangeLabel}</strong><div className="toolbar-actions"><select className="filter-select" value={scheduleDay} onChange={(event) => { setScheduleDay(event.target.value); setSchedulePage(1); }} aria-label={displayPreferences.language === "en-AU" ? "Schedule date" : "排课日期筛选"}><option value="all">{displayPreferences.language === "en-AU" ? "All dates" : "全部日期"}</option>{weekDays.map((day) => <option value={day.date} key={day.date}>{day.label}</option>)}</select>{scheduleMode === "week" && <select className="filter-select" value={scheduleDensity} onChange={(event) => updateDisplayPreferences({ density: event.target.value as DisplayPreferences["density"] })} aria-label={displayPreferences.language === "en-AU" ? "Week view density" : "周视图显示密度"}><option value="comfortable">{displayPreferences.language === "en-AU" ? "Comfortable" : "放大显示"}</option><option value="compact">{displayPreferences.language === "en-AU" ? "Compact" : "紧凑显示"}</option></select>}<select className="filter-select" value={scheduleTimezone} onChange={(event) => { updateDisplayPreferences({ timezone: cleanTimezone(event.target.value) }); setSchedulePage(1); }} aria-label={displayPreferences.language === "en-AU" ? "Schedule timezone" : "排课显示时区"}>{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{displayPreferences.language === "en-AU" ? `Display: ${option.en}` : `显示：${option.zh}`}</option>)}</select><select className="filter-select" value={scheduleFilter} onChange={(event) => { setScheduleFilter(event.target.value); setSchedulePage(1); }} aria-label={displayPreferences.language === "en-AU" ? "Schedule filter" : "排课筛选"}><option value="all">{displayPreferences.language === "en-AU" ? "All lessons" : "全部课程"}</option><option value="pending">{displayPreferences.language === "en-AU" ? "Pending" : "待确认"}</option><option value="trial">{displayPreferences.language === "en-AU" ? "Trials only" : "仅试听"}</option><option value="dst">{displayPreferences.language === "en-AU" ? "DST review" : "夏令时需复核"}</option></select></div></div>
        <div className={`timezone-audit ${dstRiskBookings.length ? "warning" : "ok"}`}><Clock3 size={17} /><span><strong>{dstRiskBookings.length ? `${dstRiskBookings.length} 节长期课的师生时差会在未来 140 天内变化` : "当前长期课未发现跨地区夏令时变化"}</strong><small>系统会按 IANA 时区自动换算；发生相对时差变化时保留课程并要求教务复核，不会静默改时间。</small></span></div>
        <div className="master-detail-layout schedule-layout">
          <article className="collection-main schedule-main">
            {scheduleMode === "week" ? (
              <div className={`week-board ${scheduleDensity} ${visibleWeekDays.length === 1 ? "single-day" : ""}`}>
                {visibleWeekDays.map((day) => {
                  const dayBookings = filteredBookings.filter((booking) => {
                    const local = zonedParts(bookingInstant(booking), scheduleTimezone);
                    return `${local.year}-${local.month}-${local.day}` === day.date;
                  });

                  return (
                    <section className="week-day" key={day.date}>
                      <header>
                        <span><strong>{day.label}</strong><small>{timezoneLabel(scheduleTimezone, displayPreferences.language)}</small></span>
                        <b>{dayBookings.length} {displayPreferences.language === "en-AU" ? "lessons" : "节"}</b>
                      </header>
                      <div className="week-day-events">
                        {dayBookings.length ? dayBookings.map((booking) => {
                          const student = studentById(booking.studentId);
                          const teacher = teacherById(booking.teacherId);
                          const displayTime = formatClock(bookingInstant(booking), scheduleTimezone, displayPreferences);

                          return (
                            <button
                              className={`week-event ${displayedBooking.id === booking.id && displayedBooking.date === booking.date ? "selected" : ""} ${booking.status === "待确认" ? "amber" : booking.kind === "试听" ? "blue" : "green"}`}
                              key={booking.occurrenceKey}
                              type="button"
                              onClick={() => {
                                setSelectedBookingId(booking.id);
                                setSelectedBookingDate(booking.date);
                                setSelectedBookingDateId(booking.id);
                                setSelectedStudentId(booking.studentId);
                                setSelectedTeacherId(booking.teacherId);
                                setMobilePreview("booking");
                              }}
                            >
                              <span><strong>{displayTime}</strong><small>{booking.duration} {displayPreferences.language === "en-AU" ? "min" : "分钟"}</small></span>
                              <b>{student?.name}</b>
                              <small>{booking.course ?? booking.kind}</small>
                              <em>{teacher?.name}</em>
                            </button>
                          );
                        }) : <div className="week-day-empty">{displayPreferences.language === "en-AU" ? "No matching lessons today" : "当天没有符合条件的课程"}</div>}
                      </div>
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="agenda-list">
                {selectedBookingIds.length > 0 && <div className="bulk-bar"><strong>已选 {selectedBookingIds.length} 个课程系列</strong><button type="button" onClick={() => bulkUpdateBookingStatus("待确认")}>设为待确认</button><button type="button" onClick={() => bulkUpdateBookingStatus("已确认")}>设为已确认</button><button className="bulk-clear" type="button" onClick={() => setSelectedBookingIds([])}>取消选择</button></div>}
                <div className="collection-head agenda-select-grid"><input type="checkbox" aria-label="选择本页全部课程系列；周期课会整组更新" checked={pagedScheduleBookings.length > 0 && pagedScheduleBookings.every((booking) => selectedBookingIds.includes(booking.id))} onChange={(event) => setSelectedBookingIds((current) => event.target.checked ? Array.from(new Set([...current, ...pagedScheduleBookings.map((booking) => booking.id)])) : current.filter((idValue) => !pagedScheduleBookings.some((booking) => booking.id === idValue)))} /><span>显示时间</span><span>学生 / 课程</span><span>老师</span><span>类型</span><span>状态</span></div>
                <div className="collection-viewport">
                  {pagedScheduleBookings.length ? pagedScheduleBookings.map((booking) => {
                    const student = studentById(booking.studentId);
                    const teacher = teacherById(booking.teacherId);
                    const instant = bookingInstant(booking);
                    const bookingSeries = scopedBookings.find((entry) => entry.id === booking.id) ?? booking;
                    const hasRisk = student && teacher ? bookingHasDstRisk(bookingSeries, student, teacher) : false;

                    return <div className={`collection-row agenda-select-row ${displayedBooking.id === booking.id && displayedBooking.date === booking.date ? "selected" : ""}`} key={booking.occurrenceKey}>
                      <input type="checkbox" aria-label={`选择 ${student?.name ?? "课程"} 的整个课程系列`} title={booking.recurring ? "周期课状态按整个系列更新" : "选择该课程"} checked={selectedBookingIds.includes(booking.id)} onChange={() => toggleBookingSelection(booking.id)} />
                      <button className="agenda-row-main" type="button" onClick={() => { setSelectedBookingId(booking.id); setSelectedBookingDate(booking.date); setSelectedBookingDateId(booking.id); setSelectedStudentId(booking.studentId); setSelectedTeacherId(booking.teacherId); setMobilePreview("booking"); }}>
                        <span><strong>{formatInstant(instant, scheduleTimezone, displayPreferences)}</strong><small>{timezoneLabel(scheduleTimezone, displayPreferences.language)} · {booking.duration} {displayPreferences.language === "en-AU" ? "min" : "分钟"}</small></span>
                        <span><strong>{student?.name}</strong><small>{booking.course ?? student?.course}</small></span>
                        <span>{teacher?.name}<small>{timezoneLabel(teacher?.timezone ?? "Australia/Melbourne", displayPreferences.language)}</small></span>
                        <StatusPill tone={booking.kind === "试听" ? "blue" : hasRisk ? "purple" : "green"}>{hasRisk ? "时差复核" : booking.kind}</StatusPill>
                        <StatusPill tone={booking.status === "待确认" ? "amber" : "green"}>{booking.status}</StatusPill>
                      </button>
                    </div>;
                  }) : <EmptyState title="当前筛选下没有排课" detail="切换日期或清除课程筛选后再试。" />}
                </div>
                <Pagination page={safeSchedulePage} total={filteredBookings.length} pageSize={schedulePageSize} onPage={setSchedulePage} />
              </div>
            )}
          </article>
          <aside className={`record-preview booking-panel ${mobilePreview === "booking" ? "mobile-detail-open" : ""}`}>
            <button className="mobile-preview-close" type="button" aria-label="关闭课程详情" onClick={() => setMobilePreview(null)}><ChevronLeft size={20} /> 返回课程列表</button>
            <div className="panel-header"><div><p className="eyebrow">{historicalBooking ? "历史课程 · 只读" : displayedBooking.source ?? "课程预览"}</p><h2>{bookingStudent.name}</h2><small>{displayedBooking.course ?? bookingStudent.course}</small></div><StatusPill tone={historicalBooking ? "blue" : displayedBooking.status === "待确认" ? "amber" : "green"}>{historicalBooking ? "已归档" : displayedBooking.status}</StatusPill></div>
            <TimeLine label={`${displayPreferences.language === "en-AU" ? "Student time" : "学生时间"} · ${timezoneLabel(bookingStudent.timezone, displayPreferences.language)}`} time={formatInstant(selectedInstant, bookingStudent.timezone, displayPreferences)} detail={cleanTimezone(bookingStudent.timezone)} />
            <TimeLine label={`${displayPreferences.language === "en-AU" ? "Teacher time" : "老师时间"} · ${timezoneLabel(bookingTeacher.timezone, displayPreferences.language)}`} time={formatInstant(selectedInstant, bookingTeacher.timezone, displayPreferences)} detail={bookingTeacher.name} />
            <TimeLine label={displayPreferences.language === "en-AU" ? "Melbourne reference time" : "墨尔本基准时间"} time={formatInstant(selectedInstant, "Australia/Melbourne", displayPreferences)} detail={displayPreferences.language === "en-AU" ? "DST is handled automatically" : "系统按日期自动处理夏令时"} />
            <TimeLine label={`${displayPreferences.language === "en-AU" ? "Viewing" : "当前查看"} · ${timezoneLabel(scheduleTimezone, displayPreferences.language)}`} time={formatInstant(selectedInstant, scheduleTimezone, displayPreferences)} detail={`${displayPreferences.language === "en-AU" ? "Source time" : "来源时段"}：${displayedBooking.sourceTiming ?? (displayPreferences.language === "en-AU" ? "manual entry" : "人工录入")}`} />
            <div className={`check-list ${selectedDstRisk ? "warning" : ""}`}><span><CircleCheck size={16} /> 课程时段没有检测到重叠</span><span><CircleCheck size={16} /> 已关联学生与老师内部 ID</span>{selectedDstRisk ? <span><CircleAlert size={16} /> 长期课未来会发生相对时差变化，需教务复核</span> : <span><CircleCheck size={16} /> 长期课未发现相对时差变化</span>}</div>
            {!historicalBooking && displayedBooking.status === "待确认" && <button className="primary-button full" type="button" onClick={() => confirmBookingStatus(displayedBookingSeries, "已确认")}>确认课程</button>}
            {!historicalBooking && <div className="booking-action-grid">
              <button className="secondary-button" type="button" onClick={() => openBookingEditor(displayedBookingSeries)}><Pencil size={15} /> 编辑整个课程系列</button>
              {!isTeacherView && <><button className="secondary-button" type="button" onClick={() => openBookingOperation(displayedBooking, "学生请假")}><UserRoundX size={15} /> 学生请假</button>
              <button className="secondary-button" type="button" onClick={() => openBookingOperation(displayedBooking, "老师请假")}><CalendarOff size={15} /> 老师请假</button>
              <button className="secondary-button" type="button" onClick={() => openBookingOperation(displayedBooking, "代课")}><RefreshCw size={15} /> 启动代课</button>
              {isAdminView && <button className="danger-button" type="button" onClick={() => deleteBookingSeries(displayedBookingSeries)}><X size={15} /> {displayedBookingSeries.recurring ? "删除整个系列" : "删除课程"}</button>}</>}
            </div>}
            {historicalBooking ? <div className="form-notice"><CircleAlert size={16} /> 历史课程已归档，只能查看已有录播和课堂记录，不能重新创建教室或学生链接。</div> : !displayedBooking.classroom?.meetingId ? <button className="primary-button full" type="button" disabled={classroomBusy} onClick={() => void createClassroom(displayedBooking)}><Video size={16} /> {classroomBusy ? "正在创建…" : "创建在线教室"}</button> : displayedBooking.classroom.status === "ended" ? <button className="secondary-button full" type="button" onClick={() => { setActive("classroom"); setMobilePreview(null); }}><Video size={16} /> 查看录播与课堂记录</button> : <>
              <button className="primary-button full" type="button" disabled={classroomBusy} onClick={() => void joinTeacherClassroom(displayedBooking)}><ExternalLink size={16} /> {classroomBusy ? "正在处理…" : "老师进入教室"}</button>
              <button className="secondary-button full" type="button" disabled={classroomBusy} onClick={() => void copyStudentClassroomLink(displayedBooking)}><Link2 size={16} /> {classroomBusy ? "正在处理…" : "复制学生链接"}</button>
              <button className="secondary-button full" type="button" onClick={() => { setActive("classroom"); setMobilePreview(null); }}><Video size={16} /> 查看教室与录播</button>
            </>}
            <button className="secondary-button full" type="button" onClick={() => goToStudent(bookingStudent.id)}>打开学生档案</button>
          </aside>
        </div>
      </section>
    </>;
  };

  const renderLp = () => {
    const visibleLp = scopedLpItems.filter((item) => lpFilter === "review" ? item.stage === "待审核" : lpFilter === "revision" ? item.stage === "需修改" : lpFilter === "waiting" ? item.stage === "待资料" || item.stage === "待备课确认" : lpFilter === "complete" ? item.stage === "完成" : lpFilter === "active" ? item.stage !== "完成" : true);
    const viewItems = [{ id: "active", label: "进行中", count: scopedLpItems.filter((item) => item.stage !== "完成").length }, { id: "review", label: "待审核", count: scopedLpItems.filter((item) => item.stage === "待审核").length }, { id: "revision", label: "需修改", count: scopedLpItems.filter((item) => item.stage === "需修改").length }, { id: "waiting", label: "等待资料/确认", count: scopedLpItems.filter((item) => item.stage === "待资料" || item.stage === "待备课确认").length }, { id: "complete", label: "已完成", count: scopedLpItems.filter((item) => item.stage === "完成").length }, { id: "all", label: "全部", count: scopedLpItems.length }];
    const stageTone = (stage: LpItem["stage"]): Tone => stage === "完成" ? "green" : stage === "需修改" ? "red" : stage === "待审核" ? "amber" : stage === "已发老师" ? "blue" : "purple";
    const stageControls = (item: LpItem, compact = false) => (
      <div className={compact ? "lp-row-actions" : "lp-card-actions"}>
        <button className="icon-button" type="button" disabled={item.stage === lpStages[0]} aria-label="退回上一阶段" title="退回上一阶段" onClick={() => retreatLp(item)}><ChevronLeft size={15} /></button>
        <select className="lp-stage-select" value={item.stage} aria-label={`${item.title} 当前阶段`} onChange={(event) => setLpStage(item, event.target.value as LpItem["stage"])}>
          {lpStages.map((stage) => <option value={stage} key={stage}>{stage}</option>)}
        </select>
        <button className="icon-button" type="button" disabled={item.stage === lpStages.at(-1)} aria-label="推进下一阶段" title="推进下一阶段" onClick={() => advanceLp(item)}><ChevronRight size={15} /></button>
        <button className="icon-button" type="button" aria-label="新增 LP 修订版本" title="新增 LP 修订版本" onClick={() => { setLpRevisionDraft(item); setModal("lpRevision"); }}><Pencil size={15} /></button>
      </div>
    );

    return <>
      <ViewHeading eyebrow="Learning Plan" title="试听与 LP" actions={<button className="primary-button" type="button" onClick={() => setModal("lp")}><Plus size={17} /> 创建 LP</button>} />
      <section className="panel collection-shell">
        <div className="view-bar">
          <ViewTabs value={lpFilter} items={viewItems} onChange={setLpFilter} label="LP 保存视图" />
          <div className="segmented"><button className={lpMode === "board" ? "active" : ""} type="button" onClick={() => setLpMode("board")}>看板</button><button className={lpMode === "table" ? "active" : ""} type="button" onClick={() => setLpMode("table")}>表格</button></div>
        </div>
        {lpMode === "board" ? (
          <section className="kanban-board">
            {lpStages.filter((stage) => lpFilter !== "complete" || stage === "完成").map((stage) => (
              <article key={stage}>
                <header><span className={`kanban-dot ${stageTone(stage)}`} /> {stage}<strong>{visibleLp.filter((item) => item.stage === stage).length}</strong></header>
                {visibleLp.filter((item) => item.stage === stage).map((item) => {
                  const student = studentById(item.studentId);
                  const publishedDay = lpPublishedDay(item);
                  return <div className="kanban-card" key={item.id}>
                    <p>{student?.name} · 规划：{student?.planner ?? "待分配"} · 教务：{item.owner}</p>
                    <h3>{item.title}</h3>
                    <span>{item.workflowType ?? "历史 LP"} · 截止：{item.due}</span>
                    <div className="card-tags"><StatusPill tone={stageTone(item.stage)}>{item.stage}</StatusPill>{publishedDay && <StatusPill tone="purple">{publishedDay}</StatusPill>}{item.needsParentFollowUp && <StatusPill tone="red">家长跟进</StatusPill>}{item.needsTeacherPrep && <StatusPill tone="blue">老师备课</StatusPill>}</div>
                    {stageControls(item)}
                  </div>;
                })}
              </article>
            ))}
          </section>
        ) : (
          <div className="collection-main">
            <div className="collection-head lp-grid-row"><span>学生 / 计划</span><span>类型</span><span>规划 / 教务</span><span>阶段</span><span>截止时间</span><span>操作</span></div>
            <div className="collection-viewport">
              {visibleLp.map((item) => {
                const student = studentById(item.studentId);
                const publishedDay = lpPublishedDay(item);
                return <div className="collection-row lp-grid-row" key={item.id}>
                  <button className="row-primary table-person" type="button" onClick={() => goToStudent(item.studentId)}><Avatar initials={student?.initials ?? "?"} tone={statusTone(student?.status ?? "待排课")} /><span><strong>{student?.name}</strong><small>{item.title}</small></span></button>
                  <span>{item.workflowType ?? "历史 LP"}{publishedDay && <small className="inline-meta">{publishedDay}</small>}</span>
                  <span>{student?.planner ?? "待分配"}<small className="inline-meta">{item.owner}</small></span>
                  <StatusPill tone={stageTone(item.stage)}>{item.stage}</StatusPill>
                  <span>{item.due}</span>
                  {stageControls(item, true)}
                </div>;
              })}
            </div>
          </div>
        )}
      </section>
    </>;
  };

  const renderOperations = () => {
    const isLeaveOperation = (operation: Operation) =>
      ["请假", "学生请假", "老师请假", "代课", "停课", "老师离职"].includes(
        operation.type,
      );
    const visibleOperations = scopedOperations.filter((operation) =>
      operationFilter === "open"
        ? operation.status === "待处理"
        : operationFilter === "confirmed"
          ? operation.status === "已确认"
          : operationFilter === "leave"
            ? isLeaveOperation(operation)
            : true,
    );
    const selectedOperation =
      visibleOperations.find(
        (operation) => operation.id === selectedOperationState?.id,
      ) ?? visibleOperations[0];
    if (!selectedOperation) {
      return (
        <>
          <ViewHeading
            eyebrow="结构化异常处理"
            title="调课、请假、代课与离职"
            copy="老师请假或离职时，按日期找出受影响课程，给出可用代课候选，并将每位学生的沟通和交接任务分配到负责人。"
            actions={
              <button
                className="primary-button"
                type="button"
                onClick={() => setModal("operation")}
              >
                <CalendarPlus size={17} /> 记录异常
              </button>
            }
          />
          <section className="panel collection-shell">
            <ViewTabs
              value={operationFilter}
              items={[
                {
                  id: "open",
                  label: "待处理",
                  count: scopedOperations.filter(
                    (item) => item.status === "待处理",
                  ).length,
                },
                {
                  id: "confirmed",
                  label: "已确认",
                  count: scopedOperations.filter(
                    (item) => item.status === "已确认",
                  ).length,
                },
                {
                  id: "leave",
                  label: "请假、代课与离职",
                  count: scopedOperations.filter(isLeaveOperation).length,
                },
                { id: "all", label: "全部", count: scopedOperations.length },
              ]}
              onChange={setOperationFilter}
              label="异常保存视图"
            />
            <EmptyState
              title="当前视图没有异常记录"
              detail="切换上方状态标签，或新建一条异常处理记录。"
            />
          </section>
        </>
      );
    }
    const operationStudent = studentById(selectedOperation.studentId);
    if (!operationStudent)
      return (
        <section className="panel collection-shell">
          <EmptyState
            title="异常记录缺少学生关联"
            detail="请先修复该记录的学生内部 ID。"
          />
        </section>
      );
    const operationTeacher = selectedOperation.teacherId
      ? teacherById(selectedOperation.teacherId)
      : undefined;
    const recommendedTeachers = (selectedOperation.recommendedTeacherIds ?? [])
      .map((teacherId) => teacherById(teacherId))
      .filter((teacher): teacher is Teacher => Boolean(teacher));
    return (
      <>
        <ViewHeading
          eyebrow="结构化异常处理"
          title="调课、请假、代课与离职"
          copy="老师请假或离职时，按日期找出受影响课程，给出可用代课候选，并将每位学生的沟通和交接任务分配到负责人。"
          actions={
            <button
              className="primary-button"
              type="button"
              onClick={() => setModal("operation")}
            >
              <CalendarPlus size={17} /> 记录异常
            </button>
          }
        />
        <section className="panel collection-shell">
          <ViewTabs
            value={operationFilter}
            items={[
              {
                id: "open",
                label: "待处理",
                count: scopedOperations.filter(
                  (item) => item.status === "待处理",
                ).length,
              },
              {
                id: "confirmed",
                label: "已确认",
                count: scopedOperations.filter(
                  (item) => item.status === "已确认",
                ).length,
              },
              {
                id: "leave",
                label: "请假、代课与离职",
                count: scopedOperations.filter(isLeaveOperation).length,
              },
              { id: "all", label: "全部", count: scopedOperations.length },
            ]}
            onChange={setOperationFilter}
            label="异常保存视图"
          />
          <div className="master-detail-layout operations-layout">
            <article className="collection-main">
              <div className="collection-head operation-grid-row">
                <span>记录</span>
                <span>学生</span>
                <span>创建时间</span>
                <span>状态</span>
              </div>
              <div className="collection-viewport">
                {visibleOperations.length ? (
                  visibleOperations.map((operation) => {
                    const student = studentById(operation.studentId);
                    return (
                      <button
                        className={`collection-row operation-grid-row ${selectedOperation.id === operation.id ? "selected" : ""}`}
                        type="button"
                        key={operation.id}
                        onClick={() => {
                          setSelectedOperationId(operation.id);
                          setSelectedStudentId(operation.studentId);
                          setMobilePreview("operation");
                        }}
                      >
                        <span>
                          <strong>{operation.type}</strong>
                          <small>{operation.detail}</small>
                        </span>
                        <span>
                          {student?.name}
                          <small>{student?.course}</small>
                        </span>
                        <span>{operation.createdAt}</span>
                        <StatusPill
                          tone={
                            operation.status === "已确认" ? "green" : "amber"
                          }
                        >
                          {operation.status}
                        </StatusPill>
                      </button>
                    );
                  })
                ) : (
                  <EmptyState
                    title="当前视图没有异常记录"
                    detail="切换视图或新建一条异常处理记录。"
                  />
                )}
              </div>
              {visibleOperations.length < 4 && (
                <div className="operations-queue-insight">
                  <div>
                    <span>当前视图</span>
                    <strong>{visibleOperations.length} 条待处理记录</strong>
                    <small>切换上方状态标签即可查看其他异常。</small>
                  </div>
                  <div>
                    <span>队列概览</span>
                    <strong>
                      {
                        scopedOperations.filter(
                          (item) => item.status === "待处理",
                        ).length
                      }{" "}
                      待处理 ·{" "}
                      {
                        scopedOperations.filter(
                          (item) => item.status === "已确认",
                        ).length
                      }{" "}
                      已确认
                    </strong>
                    <small>每次确认都会保留在操作审计中。</small>
                  </div>
                  <div>
                    <span>处理顺序</span>
                    <strong>先确认老师影响，再处理代课与沟通</strong>
                    <small>请假和离职会自动生成负责人截止任务。</small>
                  </div>
                </div>
              )}
            </article>
            <aside
              className={`record-preview ${mobilePreview === "operation" ? "mobile-detail-open" : ""}`}
            >
              <button
                className="mobile-preview-close"
                type="button"
                aria-label="关闭异常详情"
                onClick={() => setMobilePreview(null)}
              >
                <ChevronLeft size={20} /> 返回异常列表
              </button>
              <div className="preview-header">
                <div>
                  <p className="eyebrow">异常记录</p>
                  <h2>
                    {selectedOperation.type} · {operationStudent.name}
                  </h2>
                </div>
                <StatusPill
                  tone={
                    selectedOperation.status === "已确认" ? "green" : "amber"
                  }
                >
                  {selectedOperation.status}
                </StatusPill>
              </div>
              <div className="detail-section">
                <span>处理说明</span>
                <strong>{selectedOperation.detail}</strong>
                <p>
                  {selectedOperation.createdAt} · {operationStudent.owner} 负责
                </p>
              </div>
              {operationTeacher && (
                <div className="detail-section">
                  <span>原老师与影响范围</span>
                  <strong>
                    {operationTeacher.name} ·{" "}
                    {selectedOperation.affectedLessonCount ?? 0} 节受影响课程
                  </strong>
                  <p>
                    {selectedOperation.eventStart || "日期待确认"} 至{" "}
                    {selectedOperation.eventEnd || "日期待确认"}
                  </p>
                </div>
              )}
              {operationTeacher && (
                <div className="detail-section">
                  <span>代课候选</span>
                  {recommendedTeachers.length ? (
                    <div className="operation-recommendations">
                      {recommendedTeachers.map((teacher) => (
                        <button
                          className={
                            selectedOperation.chosenTeacherId === teacher.id
                              ? "selected-choice"
                              : "choice-button"
                          }
                          type="button"
                          key={teacher.id}
                          onClick={() => {
                            const previousTeacherId =
                              selectedOperation.chosenTeacherId;
                            if (previousTeacherId === teacher.id) return;
                            requestConfirmation({
                              title: "确认选择代课候选",
                              detail: `${operationStudent.name} · ${teacher.name}`,
                              items: [
                                "这里只记录推荐选择，不会自动改排课程",
                                "正式代课时间仍需学生、原老师和代课老师确认",
                              ],
                              confirmLabel: "记录此候选",
                              onConfirm: () => {
                                setOperations((current) =>
                                  current.map((entry) =>
                                    entry.id === selectedOperation.id
                                      ? {
                                          ...entry,
                                          chosenTeacherId: teacher.id,
                                        }
                                      : entry,
                                  ),
                                );
                                addAudit(
                                  "选择代课推荐老师",
                                  `${operationStudent.name} · ${teacher.name}`,
                                  "green",
                                );
                                notify(
                                  `${teacher.name} 已标记为推荐老师，尚未自动排课`,
                                  () => {
                                    setOperations((current) =>
                                      current.map((entry) =>
                                        entry.id === selectedOperation.id
                                          ? {
                                              ...entry,
                                              chosenTeacherId:
                                                previousTeacherId,
                                            }
                                          : entry,
                                      ),
                                    );
                                    addAudit(
                                      "撤销代课候选选择",
                                      `${operationStudent.name} · ${teacher.name}`,
                                      "amber",
                                    );
                                  },
                                );
                              },
                            });
                          }}
                        >
                          <span>
                            <strong>{teacher.name}</strong>
                            <small>
                              {teacher.subjects.slice(0, 2).join(" · ")}
                            </small>
                          </span>
                          {selectedOperation.chosenTeacherId === teacher.id ? (
                            <Check size={16} />
                          ) : (
                            <ChevronRight size={16} />
                          )}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p>
                      没有找到同时满足科目和结构化 AVA 的候选。请先补全 AVA
                      后再选择，不会猜测老师可用时间。
                    </p>
                  )}
                </div>
              )}
              <div className="detail-section">
                <span>确认前检查</span>
                <ul className="compact-rules">
                  <li>学生与老师的新时间是否都确认</li>
                  <li>是否影响课时、薪资或代课安排</li>
                  <li>是否需要生成对外消息待办</li>
                </ul>
              </div>
              {selectedOperation.status === "待处理" && (
                <button
                  className="primary-button full"
                  type="button"
                  onClick={() => {
                    requestConfirmation({
                      title: "确认异常处理已完成",
                      detail: `${selectedOperation.type} · ${operationStudent.name}`,
                      items: [
                        `${selectedOperation.eventStart || "开始日期待确认"} 至 ${selectedOperation.eventEnd || "结束日期待确认"}`,
                        `${selectedOperation.affectedLessonCount ?? 0} 节课程可能受影响`,
                        selectedOperation.chosenTeacherId
                          ? `代课候选：${teacherById(selectedOperation.chosenTeacherId)?.name ?? selectedOperation.chosenTeacherId}`
                          : "尚未选择代课候选",
                        "确认后，工作台里的后续沟通任务仍会保留",
                      ],
                      confirmLabel: "确认处理完成",
                      onConfirm: () => {
                        setOperations((current) =>
                          current.map((entry) =>
                            entry.id === selectedOperation.id
                              ? { ...entry, status: "已确认" }
                              : entry,
                          ),
                        );
                        addAudit(
                          "确认异常处理",
                          `${selectedOperation.type} · ${operationStudent.name}`,
                          "green",
                        );
                        notify("已确认，后续任务仍保留在工作台", () => {
                          setOperations((current) =>
                            current.map((entry) =>
                              entry.id === selectedOperation.id
                                ? { ...entry, status: "待处理" }
                                : entry,
                            ),
                          );
                          addAudit(
                            "撤销异常处理确认",
                            `${selectedOperation.type} · ${operationStudent.name}`,
                            "amber",
                          );
                        });
                      },
                    });
                  }}
                >
                  确认处理
                </button>
              )}
              <button
                className="secondary-button full"
                type="button"
                onClick={() => goToStudent(operationStudent.id)}
              >
                查看学生档案
              </button>
            </aside>
          </div>
        </section>
      </>
    );
  };

  const renderRenewals = () => {
    const today = isoDateInTimezone(new Date(), "Australia/Melbourne");
    const now = new Date();
    const projectionEnd = shiftIsoDate(today, 365);
    const projections = new Map(scopedStudents.map((student) => {
      const packages = student.lessonPackages ?? [];
      const projectedOccurrences = scopedBookings
        .filter((booking) => booking.studentId === student.id && booking.packageId)
        .flatMap((booking) => bookingOccurrencesWithinRange(booking, shiftIsoDate(today, -1), projectionEnd))
        .filter((occurrence) => bookingInstant(occurrence).getTime() >= now.getTime())
        .flatMap((occurrence) => {
          const lessonPackage = packages.find((entry) => entry.id === occurrence.packageId);
          const subjectId = occurrence.course ?? student.course;
          if (!lessonPackage || !lessonPackage.subjectIds.includes(subjectId)) return [];
          return [{
            id: occurrence.occurrenceKey,
            packageId: occurrence.packageId,
            subjectId,
            date: occurrence.date,
            start: occurrence.start,
            timezone: occurrence.timezone,
            duration: occurrence.duration,
            status: occurrence.status,
          }];
        });
      let estimates: ReturnType<typeof mapLessonPackageDepletionEstimates> = [];
      try {
        estimates = mapLessonPackageDepletionEstimates(packages, projectedOccurrences);
      } catch {
        estimates = [];
      }
      const earliest = estimates
        .filter((estimate) => estimate.depletionDate)
        .sort((left, right) => left.depletionDate!.localeCompare(right.depletionDate!))[0];
      const remaining = packages.length
        ? packages.reduce((sum, lessonPackage) => sum + getLessonPackageBalance(lessonPackage).remainingHours, 0)
        : student.remainingHours ?? 0;
      return [student.id, { earliest, remaining }] as const;
    }));
    const automaticStudents = scopedStudents.filter((student) => {
      if (!isActiveStudent(student)) return false;
      const projection = projections.get(student.id);
      return Boolean(projection?.earliest?.depletionDate || (projection && projection.remaining < Number(rules.lowHours || 5)));
    });
    const renewalRows: Renewal[] = [
      ...scopedRenewals
        .filter((renewal) => Boolean(studentById(renewal.studentId)))
        .map((renewal) => {
          const student = studentById(renewal.studentId)!;
          const projection = projections.get(student.id);
          return {
            ...renewal,
            remaining: projection?.remaining ?? student.remainingHours ?? renewal.remaining,
            estimate: projection?.earliest?.depletionDate ?? renewal.estimate ?? student.renewalDate ?? student.renewalMonth ?? "待确认",
            businessStatus: renewal.businessStatus ?? normalizeRenewalBusinessStatus(renewal.status),
          };
        }),
      ...automaticStudents
        .filter((student) => !scopedRenewals.some((renewal) => renewal.studentId === student.id))
        .map((student) => {
          const projection = projections.get(student.id)!;
          return {
            id: `REN-AUTO-${student.id}`,
            studentId: student.id,
            remaining: projection.remaining,
            estimate: projection.earliest?.depletionDate ?? student.renewalDate ?? student.renewalMonth ?? "待确认",
            status: "待跟进" as const,
            businessStatus: "not_renewed_active" as const,
            owner: student.owner,
          };
        }),
    ];
    const businessStatusFor = (renewal: Renewal) => renewal.businessStatus ?? normalizeRenewalBusinessStatus(renewal.status);
    const visibleRenewals = renewalRows.filter((renewal) => renewalFilter === "attention"
      ? businessStatusFor(renewal) !== "renewed"
      : renewalFilter === "renewed"
        ? businessStatusFor(renewal) === "renewed"
        : renewalFilter === "inactive"
          ? businessStatusFor(renewal) === "not_renewed_inactive" || businessStatusFor(renewal) === "not_renewed_exam_finished"
          : true);
    const renewalPageSize = 10;
    const safeRenewalPage = Math.min(renewalPage, Math.max(1, Math.ceil(visibleRenewals.length / renewalPageSize)));
    const pagedRenewals = visibleRenewals.slice((safeRenewalPage - 1) * renewalPageSize, safeRenewalPage * renewalPageSize);
    return <>
      <ViewHeading eyebrow="学生档案联动" title="考试与续课" actions={<button className="secondary-button" type="button" onClick={() => setModal("task")}><Plus size={17} /> 添加任务</button>} />
      <section className="exam-reminder-strip"><div><span className="risk-icon amber"><CalendarDays size={17} /></span><span><strong>{examReminderStudents.length} 位学生进入考试提醒窗口</strong></span></div>{examReminderStudents.slice(0, 4).map((student) => <button type="button" key={student.id} onClick={() => goToStudent(student.id)}><strong>{student.name}</strong><small>{student.examSubject || "考试"} · {student.examDate}</small><ChevronRight size={15} /></button>)}</section>
      <section className="panel collection-shell renewal-collection">
        <ViewTabs
          value={renewalFilter}
          items={[
            { id: "attention", label: "需要关注", count: renewalRows.filter((item) => businessStatusFor(item) !== "renewed").length },
            { id: "renewed", label: "已续课", count: renewalRows.filter((item) => businessStatusFor(item) === "renewed").length },
            { id: "inactive", label: "不活跃", count: renewalRows.filter((item) => businessStatusFor(item) === "not_renewed_inactive" || businessStatusFor(item) === "not_renewed_exam_finished").length },
            { id: "all", label: "全部", count: renewalRows.length },
          ]}
          onChange={(value) => { setRenewalFilter(value); setRenewalPage(1); }}
          label="续课保存视图"
        />
        <div className="collection-main">
          <div className="collection-head renewal-grid-row"><span>学生 / 课程</span><span>剩余课时</span><span>预计续课</span><span>负责人</span><span>状态 / 时间</span><span>操作</span></div>
          <div className="collection-viewport">
            {pagedRenewals.length ? pagedRenewals.map((renewal) => {
              const student = studentById(renewal.studentId);
              const lowHours = renewal.remaining < Number(rules.lowHours || 5);
              const latestFollowUp = getLatestStudentFollowUp(student?.followUpHistory ?? []);
              const lastContactedAt = latestFollowUp?.followedUpAt ?? renewal.lastContactedAt ?? (/^\d{4}-\d{2}-\d{2}$/.test(student?.followUp ?? "") ? student?.followUp : undefined);
              const businessStatus = businessStatusFor(renewal);
              const displayStatus = RENEWAL_STATUS_LABELS[businessStatus];
              const businessTone: Tone = businessStatus === "renewed" ? "green" : businessStatus === "not_renewed_active" ? "amber" : "neutral";
              return <div className="collection-row renewal-grid-row" key={renewal.id}>
                <button className="row-primary table-person" type="button" onClick={() => goToStudent(renewal.studentId)}><Avatar initials={student?.initials ?? "?"} tone={lowHours ? "red" : businessTone} /><span><strong>{student?.name}</strong><small>{student?.course} · {student?.status}</small></span></button>
                <strong className={lowHours ? "low-hours" : ""}>{renewal.remaining} 小时</strong>
                <span><strong>{renewal.estimate}</strong>{renewal.renewalDateNote ? <small>{renewal.renewalDateNote}</small> : null}</span>
                <span>{renewal.owner}</span>
                <span className="renewal-status-cell"><StatusPill tone={businessTone}>{displayStatus}</StatusPill><small>{renewal.lastAttemptAt ? `本次 ${formatFollowUpTime(renewal.lastAttemptAt, displayPreferences)}` : `上次成功 ${formatFollowUpTime(lastContactedAt, displayPreferences)}`}</small>{renewal.status === "本次未跟进" && <small>上次成功 {formatFollowUpTime(lastContactedAt, displayPreferences)}</small>}</span>
                <button className="compact-button" type="button" onClick={() => { setRenewalDraft({ ...renewal, lastContactedAt }); setModal("renewal"); }}>记录跟进</button>
              </div>;
            }) : <EmptyState title="当前没有续课记录" />}
          </div>
          <Pagination page={safeRenewalPage} total={visibleRenewals.length} pageSize={renewalPageSize} onPage={setRenewalPage} />
        </div>
      </section>
    </>;
  };

  const renderPayroll = () => {
    const visiblePayroll = monthPayroll.filter((row) => {
      const matchesStatus =
        payrollFilter === "review"
          ? row.status === "需核对"
          : payrollFilter === "ready"
            ? row.status === "可审核"
            : payrollFilter === "locked"
              ? row.status === "已锁定"
              : true;
      const matchesCurrency =
        payrollCurrency === "all" || row.currency === payrollCurrency;
      return matchesStatus && matchesCurrency;
    });
    const payrollPageSize = 10;
    const safePayrollPage = Math.min(
      payrollPage,
      Math.max(1, Math.ceil(visiblePayroll.length / payrollPageSize)),
    );
    const pagedPayroll = visiblePayroll.slice(
      (safePayrollPage - 1) * payrollPageSize,
      safePayrollPage * payrollPageSize,
    );
    const selectedPayroll =
      pagedPayroll.find((row) => row.id === selectedPayrollId) ??
      pagedPayroll[0];
    const cnyTotal = monthPayroll
      .filter((row) => row.currency === "CNY")
      .reduce((total, row) => total + row.amount, 0);
    const audTotal = monthPayroll
      .filter((row) => row.currency !== "CNY")
      .reduce((total, row) => total + row.amount, 0);
    const totalHours = monthPayroll.reduce(
      (total, row) =>
        total + (row.teacherTotalHours ?? row.lessons + row.trialLessons),
      0,
    );
    const lockPayrollRow = (targetId: string) => {
      const row = payroll.find((item) => item.id === targetId);
      if (!row || row.status === "已锁定") return;
      const teacherName = row
        ? (teacherById(row.teacherId)?.name ?? row.teacherName ?? row.teacherId)
        : "未知老师";
      requestConfirmation({
        title: "确认锁定老师薪资",
        detail: `${teacherName} · ${formatMoney(row.amount, row.currency)} · ${row.month ?? "月份待确认"}`,
        items: [
          "请先确认课时、费率和学生明细",
          "锁定记录会保留实际登录管理员和时间",
        ],
        confirmLabel: "确认锁定",
        onConfirm: () => {
          setPayroll((current) =>
            current.map((item) =>
              item.id === targetId
                ? {
                    ...item,
                    status: "已锁定",
                    lockedBy: operatorLabel(sessionOperator),
                    lockedAt: new Date().toISOString(),
                    note: item.note.includes("已锁定")
                      ? item.note
                      : `${item.note}；已由 ${operatorLabel(sessionOperator)} 人工锁定`,
                  }
                : item,
            ),
          );
          addAudit(
            "锁定薪资记录",
            `${teacherName} · ${formatMoney(row.amount, row.currency)}`,
            "green",
          );
          notify("已锁定本月薪资记录", () => {
            setPayroll((current) =>
              current.map((item) => (item.id === targetId ? row : item)),
            );
            addAudit(
              "撤销锁定薪资记录",
              `${teacherName} · ${formatMoney(row.amount, row.currency)}`,
              "amber",
            );
          });
        },
      });
    };

    const lockAllReadyPayroll = () => {
      const readyRows = monthPayroll.filter((row) => row.status === "可审核");
      if (!readyRows.length) return;
      requestConfirmation({
        title: "确认批量锁定可审核薪资",
        detail: `${readyRows.length} 位老师 · ${activePayrollMonth}`,
        items: [
          "只锁定状态为“可审核”的记录",
          "需核对记录不会被锁定",
          "锁定后仍可在 12 秒内撤销",
        ],
        confirmLabel: `锁定 ${readyRows.length} 条`,
        onConfirm: () => {
          const readyIds = new Set(readyRows.map((row) => row.id));
          setPayroll((current) =>
            current.map((row) =>
              readyIds.has(row.id)
                ? {
                    ...row,
                    status: "已锁定",
                    lockedBy: operatorLabel(sessionOperator),
                    lockedAt: new Date().toISOString(),
                    note: row.note.includes("批量锁定")
                      ? row.note
                      : `${row.note}；已批量锁定`,
                  }
                : row,
            ),
          );
          addAudit("批量锁定薪资", `${readyRows.length} 条可审核记录`, "green");
          notify(`已锁定 ${readyRows.length} 条可审核记录`, () => {
            const previous = new Map(readyRows.map((row) => [row.id, row]));
            setPayroll((current) =>
              current.map((row) => previous.get(row.id) ?? row),
            );
            addAudit(
              "撤销批量锁定薪资",
              `${readyRows.length} 条记录恢复原状态`,
              "amber",
            );
          });
        },
      });
    };

    const exportCurrentPayroll = () => {
      downloadPayrollExcel(
        activePayrollMonth,
        monthPayroll.map((row) => ({
          teacherName: teacherById(row.teacherId)?.name ?? row.teacherName ?? row.teacherId,
          month: row.month ?? activePayrollMonth,
          section: row.section ?? "教师薪资",
          currency: row.currency ?? "AUD",
          status: row.status,
          payrollHours: row.teacherTotalHours ?? row.lessons + row.trialLessons,
          sourceHours: row.sourceHours,
          amount: row.amount,
          bankName: row.bankName,
          bankAccount: row.bankAccount,
          paymentNote: row.paymentNote ?? row.note,
          lockedBy: row.lockedBy,
          lockedAt: row.lockedAt,
          lines: row.lines ?? [],
        })),
      );
      addAudit("导出月度薪资 Excel", `${activePayrollMonth} · ${monthPayroll.length} 位老师`, "blue");
    };

    return (
      <>
        <ViewHeading
          eyebrow="教务宝课时证据 + 人工费率表"
          title="课时与薪资"
          copy={`当前显示 ${activePayrollMonth} 薪资。系统保留每位老师的学生明细、课时费、教务宝匹配差异和人工锁定记录。`}
          actions={
            <>
              <label className="payroll-month-picker">
                <span>薪资月份</span>
                <input
                  type="month"
                  value={activePayrollMonth}
                  onChange={(event) => {
                    setPayrollMonthSelection(event.target.value);
                    setPayrollPage(1);
                    setSelectedPayrollId("");
                  }}
                  aria-label="薪资月份"
                />
              </label>
              <button className="secondary-button" type="button" disabled={!monthPayroll.length} onClick={exportCurrentPayroll}>
                <Download size={17} /> 导出本月 Excel
              </button>
              <button className="primary-button" type="button" onClick={() => setModal("payrollNew")}>
                <UserPlus size={17} /> 新增老师薪资
              </button>
              <button className="secondary-button" type="button" onClick={() => setActive("sync")}>
                <Database size={17} /> 查看数据来源
              </button>
            </>
          }
        />
        <section className="metric-grid payroll-metrics">
          <Metric
            tone="blue"
            icon={<FileText size={21} />}
            value={formatHours(totalHours)}
            label="薪资表课时"
            detail={`${monthPayroll.reduce((total, row) => total + (row.lineCount ?? row.lines?.length ?? 0), 0)} 条学生明细`}
          />
          <Metric
            tone="amber"
            icon={<CircleAlert size={21} />}
            value={`${monthPayroll.filter((row) => row.status === "需核对").length}`}
            label="需要核对"
            detail="姓名、课时或费率例外"
          />
          <Metric
            tone="green"
            icon={<Wallet size={21} />}
            value={formatMoney(cnyTotal, "CNY")}
            label="人民币薪资"
            detail="国内教师合计"
          />
          <Metric
            tone="purple"
            icon={<ShieldCheck size={21} />}
            value={formatMoney(audTotal, "AUD")}
            label="澳币薪资"
            detail={`${monthPayroll.filter((row) => row.status === "已锁定").length} 条已锁定`}
          />
        </section>
        <section className="panel collection-shell">
          <div className="view-bar">
            <ViewTabs
              value={payrollFilter}
              items={[
                { id: "all", label: "全部", count: monthPayroll.length },
                {
                  id: "review",
                  label: "需核对",
                  count: monthPayroll.filter((item) => item.status === "需核对")
                    .length,
                },
                {
                  id: "ready",
                  label: "可审核",
                  count: monthPayroll.filter((item) => item.status === "可审核")
                    .length,
                },
                {
                  id: "locked",
                  label: "已锁定",
                  count: monthPayroll.filter((item) => item.status === "已锁定")
                    .length,
                },
              ]}
              onChange={(value) => {
                setPayrollFilter(value);
                setPayrollPage(1);
              }}
              label="薪资保存视图"
            />
            <div className="toolbar-actions">
              <select
                className="filter-select"
                value={payrollCurrency}
                onChange={(event) => {
                  setPayrollCurrency(event.target.value);
                  setPayrollPage(1);
                }}
                aria-label="薪资币种筛选"
              >
                <option value="all">全部币种</option>
                <option value="CNY">人民币</option>
                <option value="AUD">澳币</option>
              </select>
              <button
                className="secondary-button"
                type="button"
                disabled={!monthPayroll.some((row) => row.status === "可审核")}
                onClick={lockAllReadyPayroll}
              >
                <ShieldCheck size={16} /> 批量锁定可审核
              </button>
            </div>
          </div>
          {monthPayroll.length ? (
            <div className="master-detail-layout payroll-layout">
              <article className="collection-main">
                <div className="collection-head payroll-grid-row">
                  <span>老师</span>
                  <span>薪资表课时</span>
                  <span>教务宝课时</span>
                  <span>建议金额</span>
                  <span>状态</span>
                </div>
                <div className="collection-viewport">
                  {pagedPayroll.length ? (
                    pagedPayroll.map((row) => {
                      const teacher = teacherById(row.teacherId);
                      const teacherName =
                        teacher?.name ?? row.teacherName ?? row.teacherId;
                      const salaryHours =
                        row.teacherTotalHours ?? row.lessons + row.trialLessons;
                      const hasVariance =
                        row.hourVariance !== null &&
                        row.hourVariance !== undefined &&
                        Math.abs(row.hourVariance) > 0.01;
                      return (
                        <button
                          className={`collection-row payroll-grid-row ${selectedPayroll?.id === row.id ? "selected" : ""}`}
                          type="button"
                          key={row.id}
                          onClick={() => setSelectedPayrollId(row.id)}
                        >
                          <span className="table-person">
                            <Avatar
                              initials={
                                teacher?.initials ?? initials(teacherName)
                              }
                              tone={row.status === "需核对" ? "amber" : "blue"}
                            />
                            <span>
                              <strong>{teacherName}</strong>
                              <small>
                                {row.section ?? "教师薪资"} ·{" "}
                                {payrollCurrencyLabel(row.currency)}
                              </small>
                            </span>
                          </span>
                          <span>
                            <strong>{formatHours(salaryHours)}</strong>
                            <small>
                              {row.lineCount ?? row.lines?.length ?? 0} 条明细
                            </small>
                          </span>
                          <span className={hasVariance ? "low-hours" : ""}>
                            {formatHours(row.sourceHours)}
                            <small>
                              {hasVariance
                                ? `差异 ${formatHours(row.hourVariance)}`
                                : row.sourceHours === null ||
                                    row.sourceHours === undefined
                                  ? "未匹配"
                                  : "已匹配"}
                            </small>
                          </span>
                          <strong>
                            {formatMoney(row.amount, row.currency)}
                          </strong>
                          <StatusPill tone={statusTone(row.status)}>
                            {row.status}
                          </StatusPill>
                        </button>
                      );
                    })
                  ) : (
                    <EmptyState
                      title="当前筛选下没有薪资记录"
                      detail="切换状态或币种筛选查看其他记录。"
                    />
                  )}
                </div>
                <Pagination
                  page={safePayrollPage}
                  total={visiblePayroll.length}
                  pageSize={payrollPageSize}
                  onPage={setPayrollPage}
                />
              </article>
              {selectedPayroll && (
                <aside className="record-preview payroll-preview">
                  <div className="preview-header">
                    <div>
                      <p className="eyebrow">
                        {selectedPayroll.month ?? "薪资月份待确认"} ·{" "}
                        {selectedPayroll.section ?? "教师薪资"}
                      </p>
                      <h2>
                        {teacherById(selectedPayroll.teacherId)?.name ??
                          selectedPayroll.teacherName ??
                          selectedPayroll.teacherId}
                      </h2>
                    </div>
                    <StatusPill tone={statusTone(selectedPayroll.status)}>
                      {selectedPayroll.status}
                    </StatusPill>
                  </div>
                  <div className="student-facts payroll-facts">
                    <span>
                      <small>薪资表课时</small>
                      <strong>
                        {formatHours(
                          selectedPayroll.teacherTotalHours ??
                            selectedPayroll.lessons +
                              selectedPayroll.trialLessons,
                        )}
                      </strong>
                      <em>
                        常规 {formatHours(selectedPayroll.lessons)} · 试听{" "}
                        {formatHours(selectedPayroll.trialLessons)}
                      </em>
                    </span>
                    <span>
                      <small>教务宝课时</small>
                      <strong>
                        {formatHours(selectedPayroll.sourceHours)}
                      </strong>
                      <em>
                        {selectedPayroll.sourceLessonCount === null ||
                        selectedPayroll.sourceLessonCount === undefined
                          ? "未匹配汇总"
                          : `${selectedPayroll.sourceLessonCount} 节课`}
                      </em>
                    </span>
                    <span>
                      <small>建议金额</small>
                      <strong>
                        {formatMoney(
                          selectedPayroll.amount,
                          selectedPayroll.currency,
                        )}
                      </strong>
                      <em>{payrollCurrencyLabel(selectedPayroll.currency)}</em>
                    </span>
                    <span>
                      <small>付款信息</small>
                      <strong>
                        {maskAccount(selectedPayroll.bankAccount)}
                      </strong>
                      <em>{selectedPayroll.bankName || "银行待确认"}</em>
                    </span>
                  </div>
                  <div className="detail-section">
                    <span>费率与说明</span>
                    <strong>
                      {selectedPayroll.rateRange?.length
                        ? selectedPayroll.rateRange
                            .map((rate) =>
                              formatMoney(rate, selectedPayroll.currency),
                            )
                            .join("、")
                        : "费率待确认"}
                    </strong>
                    <p>{selectedPayroll.paymentNote || selectedPayroll.note}</p>
                  </div>
                  <div className="detail-section">
                    <span>学生明细</span>
                    <div className="payroll-line-list">
                      {(selectedPayroll.lines ?? [])
                        .slice(0, 12)
                        .map((line) => (
                          <div
                            className="payroll-line"
                            key={`${line.studentName}-${line.sourceRow}`}
                          >
                            <span>
                              <strong>{line.studentName}</strong>
                              <small>
                                {line.note ||
                                  (line.isTrial ? "试听" : "常规课")}
                              </small>
                            </span>
                            <span>{formatHours(line.hours)}</span>
                            <span>
                              {formatMoney(line.rate, selectedPayroll.currency)}
                            </span>
                            <strong>
                              {formatMoney(
                                line.subtotal,
                                selectedPayroll.currency,
                              )}
                            </strong>
                          </div>
                        ))}
                      {(selectedPayroll.lines?.length ?? 0) > 12 && (
                        <p className="muted-cell">
                          还有 {(selectedPayroll.lines?.length ?? 0) - 12}{" "}
                          条明细，已保存在系统数据中。
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    className="secondary-button full"
                    type="button"
                    onClick={() => {
                      setPayrollDraft(selectedPayroll);
                      setModal("payrollEdit");
                    }}
                  >
                    <Pencil size={16} /> 编辑老师与费率
                  </button>
                  {selectedPayroll.status !== "已锁定" ? (
                    <button
                      className="primary-button full"
                      type="button"
                      onClick={() => lockPayrollRow(selectedPayroll.id)}
                    >
                      <ShieldCheck size={16} /> 人工锁定此老师薪资
                    </button>
                  ) : (
                    <div className="detail-section">
                      <span>锁定记录</span>
                      <strong>{selectedPayroll.lockedBy ?? "已锁定"}</strong>
                      <p>{selectedPayroll.lockedAt ?? selectedPayroll.note}</p>
                    </div>
                  )}
                </aside>
              )}
            </div>
          ) : (
            <EmptyState
              title="该月份暂无薪资记录"
              detail="可以新增老师薪资记录，或先导入该月份的教务宝课时数据。"
            />
          )}
        </section>
      </>
    );
  };

  const renderMessages = () => {
    const visibleMessages = scopedMessages.filter((message) => {
      const matchesQuery =
        `${message.kind} ${message.recipient} ${studentById(message.studentId)?.name ?? ""}`
          .toLowerCase()
          .includes(messageQuery.trim().toLowerCase());
      if (!matchesQuery) return false;
      if (messageFilter === "open") return message.status !== "已记录发送";
      if (messageFilter === "confirm") return message.status === "待人工确认";
      if (messageFilter === "sent") return message.status === "已记录发送";
      if (messageFilter === "internal") return message.status === "仅内部";
      return true;
    });
    const selectedMessage =
      visibleMessages.find(
        (message) => message.id === selectedMessageState?.id,
      ) ?? visibleMessages[0];
    if (!selectedMessage && !scopedMessages.length) {
      return (
        <>
          <ViewHeading
            eyebrow="按学生关系路由 · 发送前确认"
            title="消息队列"
            copy="像收件箱一样集中搜索和筛选；左侧选择消息，右侧确认收件对象和内容，避免在长列表中误操作。"
            actions={
              <button
                className="primary-button"
                type="button"
                onClick={() => setModal("template")}
              >
                <Plus size={17} /> 新建消息
              </button>
            }
          />
          <section className="panel collection-shell">
            <EmptyState
              title="暂无真实消息记录"
              detail="当前 Supabase 没有导入消息队列；后续接入企业微信后会在这里显示。"
            />
          </section>
        </>
      );
    }
    if (!selectedMessage) {
      return (
        <>
          <ViewHeading
            eyebrow="按学生关系路由 · 发送前确认"
            title="消息队列"
            copy="像收件箱一样集中搜索和筛选；左侧选择消息，右侧确认收件对象和内容，避免在长列表中误操作。"
            actions={
              <button
                className="primary-button"
                type="button"
                onClick={() => setModal("template")}
              >
                <Plus size={17} /> 新建消息
              </button>
            }
          />
          <section className="panel collection-shell">
            <ViewTabs
              value={messageFilter}
              items={[
                { id: "open", label: "待处理", count: scopedMessages.filter((item) => item.status !== "已记录发送").length },
                { id: "confirm", label: "待人工确认", count: scopedMessages.filter((item) => item.status === "待人工确认").length },
                { id: "internal", label: "仅内部", count: scopedMessages.filter((item) => item.status === "仅内部").length },
                { id: "sent", label: "已记录发送", count: scopedMessages.filter((item) => item.status === "已记录发送").length },
                { id: "all", label: "全部", count: scopedMessages.length },
              ]}
              onChange={setMessageFilter}
              label="消息保存视图"
            />
            <ListToolbar
              query={messageQuery}
              onQuery={setMessageQuery}
              placeholder="搜索学生、消息类型或收件对象"
              count="0 条消息"
            />
            <EmptyState
              title="没有符合条件的消息"
              detail="切换状态视图或清除搜索，不会显示筛选范围以外的旧详情。"
            />
          </section>
        </>
      );
    }
    const recipientUnresolved =
      !selectedMessage.recipient.trim() ||
      /待关联|待确认|未知/.test(selectedMessage.recipient);
    return (
      <>
        <ViewHeading
          eyebrow="按学生关系路由 · 发送前确认"
          title="消息队列"
          copy="像收件箱一样集中搜索和筛选；左侧选择消息，右侧确认收件对象和内容，避免在长列表中误操作。"
          actions={
            <button
              className="primary-button"
              type="button"
              onClick={() => setModal("template")}
            >
              <Plus size={17} /> 新建消息
            </button>
          }
        />
        <section className="panel collection-shell">
          <ViewTabs
            value={messageFilter}
            items={[
              {
                id: "open",
                label: "待处理",
                count: scopedMessages.filter(
                  (item) => item.status !== "已记录发送",
                ).length,
              },
              {
                id: "confirm",
                label: "待人工确认",
                count: scopedMessages.filter(
                  (item) => item.status === "待人工确认",
                ).length,
              },
              {
                id: "internal",
                label: "仅内部",
                count: scopedMessages.filter((item) => item.status === "仅内部")
                  .length,
              },
              {
                id: "sent",
                label: "已记录发送",
                count: scopedMessages.filter(
                  (item) => item.status === "已记录发送",
                ).length,
              },
              { id: "all", label: "全部", count: scopedMessages.length },
            ]}
            onChange={setMessageFilter}
            label="消息保存视图"
          />
          <ListToolbar
            query={messageQuery}
            onQuery={setMessageQuery}
            placeholder="搜索学生、消息类型或收件对象"
            count={`${visibleMessages.length} 条消息`}
          />
          <div className="master-detail-layout message-layout">
            <article className="collection-main">
              <div className="collection-viewport message-list">
                {visibleMessages.length ? (
                  visibleMessages.map((message) => {
                    const student = studentById(message.studentId);
                    return (
                      <button
                        className={`message-list-row ${selectedMessage.id === message.id ? "selected" : ""}`}
                        type="button"
                        key={message.id}
                        onClick={() => {
                          setSelectedMessageId(message.id);
                          setMobilePreview("message");
                        }}
                      >
                        <span
                          className={`route-icon ${message.status === "待人工确认" ? "amber" : "blue"}`}
                        >
                          <MessageCircle size={18} />
                        </span>
                        <span>
                          <strong>{message.kind}</strong>
                          <small>
                            {student?.name} · {message.recipient}
                          </small>
                          <em>{message.body}</em>
                        </span>
                        <span>
                          <StatusPill
                            tone={
                              message.status === "待人工确认"
                                ? "amber"
                                : message.status === "已记录发送"
                                  ? "green"
                                  : "blue"
                            }
                          >
                            {message.status}
                          </StatusPill>
                          <small>{message.createdAt}</small>
                        </span>
                      </button>
                    );
                  })
                ) : (
                  <EmptyState
                    title="没有符合条件的消息"
                    detail="切换视图或清除搜索。"
                  />
                )}
              </div>
              <div className="send-log">
                <strong>安全边界</strong>
                <p>
                  <CircleAlert size={15} /> 当前只记录发送意图，未连接企业微信
                  API。
                </p>
              </div>
            </article>
            <aside
              className={`record-preview message-preview ${mobilePreview === "message" ? "mobile-detail-open" : ""}`}
            >
              <button
                className="mobile-preview-close"
                type="button"
                aria-label="关闭消息详情"
                onClick={() => setMobilePreview(null)}
              >
                <ChevronLeft size={20} /> 返回消息列表
              </button>
              <div className="preview-header">
                <div>
                  <p className="eyebrow">发送前预览</p>
                  <h2>{selectedMessage.kind}</h2>
                </div>
                <StatusPill
                  tone={
                    selectedMessage.status === "待人工确认"
                      ? "amber"
                      : selectedMessage.status === "已记录发送"
                        ? "green"
                        : "blue"
                  }
                >
                  {selectedMessage.status}
                </StatusPill>
              </div>
              <div className="route-summary">
                <span>
                  关联学生
                  <strong>
                    {studentById(selectedMessage.studentId)?.name}
                  </strong>
                </span>
                <span>
                  收件对象<strong>{selectedMessage.recipient}</strong>
                </span>
                <span>
                  创建时间<strong>{selectedMessage.createdAt}</strong>
                </span>
              </div>
              <div className="message-bubble">{selectedMessage.body}</div>
              <div className="preview-foot">
                <CircleAlert size={16} />{" "}
                真实外部消息仍需企业微信权限、收件对象映射与人工确认。
              </div>
              <button
                className="primary-button full"
                type="button"
                disabled={
                  selectedMessage.status === "已记录发送" ||
                  recipientUnresolved
                }
                onClick={recordMessage}
              >
                <Send size={16} />{" "}
                {selectedMessage.status === "已记录发送"
                  ? "已记录发送"
                  : recipientUnresolved
                    ? "先关联收件对象"
                  : "记录为已发送"}
              </button>
            </aside>
          </div>
        </section>
      </>
    );
  };

  const renderFiles = () => {
    const visibleFiles = scopedFiles.filter((file) => {
      const matchesQuery =
        `${file.title} ${file.type} ${file.source} ${studentById(file.studentId)?.name ?? ""}`
          .toLowerCase()
          .includes(fileQuery.trim().toLowerCase());
      return matchesQuery && (fileFilter === "all" || file.type === fileFilter);
    });
    return (
      <>
        <ViewHeading
          eyebrow="资料索引 · 不依赖文件名猜测"
          title="文件中心"
          copy="用类型视图和搜索定位资料；每条文件记录直接关联学生，不需要进入不断变长的文件夹树。"
          actions={!isTeacherView ?
            <button
              className="primary-button"
              type="button"
              onClick={() => setModal("file")}
            >
              <FilePlus2 size={17} /> 登记资料链接
            </button>
          : undefined}
        />
        <section className="panel collection-shell">
          <ViewTabs
            value={fileFilter}
            items={[
              { id: "all", label: "全部", count: scopedFiles.length },
              {
                id: "Learning Plan",
                label: "Learning Plan",
                count: scopedFiles.filter(
                  (item) => item.type === "Learning Plan",
                ).length,
              },
              {
                id: "成绩单",
                label: "成绩单",
                count: scopedFiles.filter((item) => item.type === "成绩单")
                  .length,
              },
              {
                id: "课堂反馈",
                label: "课堂反馈",
                count: scopedFiles.filter((item) => item.type === "课堂反馈")
                  .length,
              },
              {
                id: "续课 FU",
                label: "续课 FU",
                count: scopedFiles.filter((item) => item.type === "续课 FU")
                  .length,
              },
              {
                id: "资料链接",
                label: "资料链接",
                count: scopedFiles.filter((item) => item.type === "资料链接")
                  .length,
              },
            ]}
            onChange={setFileFilter}
            label="文件保存视图"
          />
          <ListToolbar
            query={fileQuery}
            onQuery={setFileQuery}
            placeholder="搜索资料名、学生、类型或来源"
            count={`${visibleFiles.length} 项资料`}
          />
          <div className="collection-main">
            <div className="collection-head file-grid-row">
              <span>资料</span>
              <span>关联学生</span>
              <span>类型</span>
              <span>来源</span>
              <span>加入时间</span>
            </div>
            <div className="collection-viewport">
              {visibleFiles.length ? (
                visibleFiles.map((file) => {
                  const student = studentById(file.studentId);
                  const linkedSource =
                    file.source.startsWith("/") ||
                    /^https?:\/\//.test(file.source);
                  return (
                    <div className="collection-row file-grid-row" key={file.id}>
                      <span className="file-title">
                        <span className="file-icon">
                          <FileText size={17} />
                        </span>
                        <strong>{file.title}</strong>
                      </span>
                      <button
                        className="inline-link"
                        type="button"
                        onClick={() => goToStudent(file.studentId)}
                      >
                        {student?.name} <ChevronRight size={14} />
                      </button>
                      <StatusPill
                        tone={
                          file.type === "Learning Plan"
                            ? "blue"
                            : file.type === "续课 FU"
                              ? "green"
                              : "neutral"
                        }
                      >
                        {file.type}
                      </StatusPill>
                      {linkedSource ? (
                        <a
                          className="inline-link file-source-link"
                          href={file.source}
                          target="_blank"
                          rel="noreferrer"
                        >
                          打开来源 <ExternalLink size={13} />
                        </a>
                      ) : (
                        <small>{file.source}</small>
                      )}
                      <span>{file.addedAt}</span>
                    </div>
                  );
                })
              ) : (
                <EmptyState
                  title="没有找到资料"
                  detail="调整类型视图或搜索关键词。"
                />
              )}
            </div>
          </div>
        </section>
      </>
    );
  };

  const renderSync = () => (
    <>
      <ViewHeading
        eyebrow="Supabase 主数据 · 腾讯文档只读镜像"
        title="同步与导入"
        copy="站内新增和修改只写入 Supabase，并实时共享给其他在线成员。腾讯文档当前只读取和留存镜像，不会从本系统回写或删除原文档内容。"
        actions={
          <>
            <input
              id="shared-data-import"
              className="visually-hidden"
              type="file"
              accept="application/json"
              onChange={importLocalSnapshot}
            />
            <label
              className="secondary-button"
              htmlFor="shared-data-import"
            >
              <FilePlus2 size={17} /> 导入到共享数据库
            </label>
            <button
              className="primary-button"
              type="button"
              disabled={syncRefreshBusy}
              onClick={() => void refreshSourceStatus()}
            >
              <RefreshCw size={17} />
              {syncRefreshBusy ? "正在检查来源…" : "检查来源状态"}
            </button>
          </>
        }
      />
      <section className="sync-workspace">
        <section className="sync-summary source-summary">
          <SummaryCard
            icon={<Users size={19} />}
            tone="green"
            title={`${recordStudents.length} 位有效学生`}
            text="Supabase 多人共享学生档案"
          />
          <SummaryCard
            icon={<GraduationCap size={19} />}
            tone="blue"
            title={`${recordTeachers.length} 位去重老师`}
            text="中小学、大学及近期 AVA 汇总"
          />
          <SummaryCard
            icon={<RefreshCw size={19} />}
            tone={staleSources.length ? "amber" : "green"}
            title={sourceFreshnessLabel}
            text={`${syncSources.length} 个只读来源 · 不向腾讯文档写回`}
          />
        </section>
        <section className="data-snapshot-bar">
          <span>
            <Database size={17} />
            <strong>{dataSnapshot.label}</strong>
            <small>
              {dataSnapshot.students} 位学生 · {dataSnapshot.teachers} 位老师 ·
              最近导入 {dataSnapshot.importedAt}
            </small>
          </span>
          <StatusPill
            tone={
              sharedSyncState === "synced"
                ? "green"
                : sharedSyncState === "saving"
                  ? "blue"
                  : "amber"
            }
          >
            {sharedSyncState === "synced"
              ? "多人共享在线"
              : sharedSyncState === "saving"
                ? "正在保存"
                : "同步需检查"}
          </StatusPill>
        </section>
        <section className="sync-layout">
          <article className="panel ownership-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">数据所有权</p>
                <h2>系统现在如何保存</h2>
              </div>
              <StatusPill tone="green">已启用</StatusPill>
            </div>
            <OwnershipRow
              title="学生、老师、排课、任务与业务记录"
              detail="Supabase 为站内唯一写入目标，所有在线成员共享最新版本"
              tone="green"
              label="系统主数据"
            />
            <OwnershipRow
              title="腾讯文档"
              detail="只读取、只做镜像；本系统不会修改腾讯文档"
              tone="blue"
              label="只读来源"
            />
            <OwnershipRow
              title="并发修改"
              detail="保存前检查版本；发现别人先修改时不会静默覆盖"
              tone="amber"
              label="防覆盖"
            />
            <OwnershipRow
              title="外部消息"
              detail="未连接企业微信前只生成待确认记录，不自动发送"
              tone="purple"
              label="人工确认"
            />
          </article>
          <aside className="panel source-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">腾讯文档来源</p>
                <h2>最近读取状态</h2>
              </div>
              <StatusPill
                tone={
                  !syncSources.length || staleSources.length
                    ? "amber"
                    : "green"
                }
              >
                {syncSources.length
                  ? staleSources.length
                    ? `${staleSources.length} 个已过期`
                    : `${syncSources.length} 个来源正常`
                  : "等待首次镜像"}
              </StatusPill>
            </div>
            {syncSources.length ? (
              <div className="source-list">
                {syncSources.map((source) => (
                  <div className="source-row" key={source.source_id}>
                    <span>
                      <strong>{source.title}</strong>
                      <small>
                        {source.row_count} 行 · {formatSourceTime(source.synced_at, displayPreferences)}
                      </small>
                    </span>
                    <StatusPill
                      tone={
                        source.status === "synced" && !sourceIsStale(source)
                          ? "green"
                          : "amber"
                      }
                    >
                      {sourceIsStale(source)
                        ? "数据已过期"
                        : source.status === "synced"
                          ? "只读已读取"
                        : source.status}
                    </StatusPill>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="尚未写入腾讯文档镜像"
                detail="系统仍以 Supabase 现有资料正常运行；完成只读读取后会在这里显示来源和时间。"
              />
            )}
          </aside>
        </section>
      </section>
    </>
  );
  const renderReports = () => {
    const reportTasks = tasks.filter(
      (task) => reportOwner === "all" || task.owner === reportOwner,
    );
    const reportStudents = recordStudents.filter(
      (student) => reportOwner === "all" || student.owner === reportOwner,
    );
    const completed = reportTasks.filter(
      (task) => task.status === "done",
    ).length;
    const trialCount = reportStudents.filter(
      (student) => student.status === "试听中",
    ).length;
    const activeTeachers = recordTeachers.filter(
      (teacher) => teacher.acceptsStudents,
    ).length;
    const hasFileIndex = files.length > 0;
    const missingFiles = hasFileIndex
      ? reportStudents.filter((student) => student.files < 5).length
      : 0;
    return (
      <>
        <ViewHeading
          eyebrow="运营结果而非单纯运行成功"
          title="运营报表"
          copy="先选择负责人再看同一口径指标；生产版还会提供日期范围和团队视图。"
          actions={
            <>
              <select
                className="filter-select header-filter"
                value={reportOwner}
                onChange={(event) => setReportOwner(event.target.value)}
                aria-label="报表负责人"
              >
                <option value="all">全部负责人</option>
                {teamOwnerOptions.map((owner) => (
                  <option key={owner}>{owner}</option>
                ))}
              </select>
              <button
                className="secondary-button"
                type="button"
                onClick={exportDemo}
              >
                <Download size={17} /> 导出数据
              </button>
            </>
          }
        />
        <section className="report-grid">
          <ReportCard
            value={`${completed}/${reportTasks.length}`}
            label="任务完成"
            detail={reportOwner === "all" ? "全部负责人" : reportOwner}
            tone="green"
          />
          <ReportCard
            value={`${trialCount}`}
            label="进行中的试听"
            detail="需要持续关注"
            tone="amber"
          />
          <ReportCard
            value={`${activeTeachers}/${teachers.length}`}
            label="可接新老师"
            detail="当前可用资源"
            tone="blue"
          />
          <ReportCard
            value={hasFileIndex ? `${missingFiles}` : "待接入"}
            label={hasFileIndex ? "资料待补" : "文件索引"}
            detail={
              hasFileIndex
                ? "文件索引少于 5 项"
                : "当前没有完整文件索引，暂不计算缺失数量"
            }
            tone={hasFileIndex ? "red" : "amber"}
          />
        </section>
        <section className="two-column">
          <article className="panel chart-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">负责人负载</p>
                <h2>待处理任务</h2>
              </div>
              <StatusPill tone="blue">动态计算</StatusPill>
            </div>
            {teamOwnerOptions.map((owner) => {
              const count = tasks.filter(
                (task) => task.owner === owner && task.status !== "done",
              ).length;
              return (
                <div className="bar-row" key={owner}>
                  <span>{owner}</span>
                  <div>
                    <i style={{ width: `${Math.max(12, count * 24)}%` }} />
                  </div>
                  <strong>{count} 项</strong>
                </div>
              );
            })}
          </article>
          <article className="panel chart-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">需要留意</p>
                <h2>数据质量</h2>
              </div>
              <StatusPill tone="amber">人工复核</StatusPill>
            </div>
            <DataIssue
              title={
                hasFileIndex ? "试听资料缺少索引" : "文件索引尚未接入"
              }
              count={
                hasFileIndex
                  ? `${missingFiles} 位学生`
                  : "未生成缺失结论"
              }
              tone={hasFileIndex ? "red" : "amber"}
            />
            {canViewPayroll && (
              <DataIssue
                title="薪资规则例外"
                count={`${payroll.filter((row) => row.status === "需核对").length} 条记录`}
                tone="amber"
              />
            )}
            <DataIssue
              title="同步冲突"
              count={
                sharedSyncState === "conflict" ? "1 项需重新载入" : "0 项待处理"
              }
              tone="blue"
            />
            <DataIssue
              title="未确认排课"
              count={`${bookings.filter((booking) => booking.status === "待确认").length} 节`}
              tone="purple"
            />
          </article>
        </section>
      </>
    );
  };

  const renderSettings = () => (
    <>
      <ViewHeading
        eyebrow="规则应可读、可改、可审计"
        title="规则设置"
        copy="按提醒、数据和集成分区；每项规则都明确当前是否真正生效。"
        actions={
          <button
            className="secondary-button"
            type="button"
            onClick={resetDemo}
          >
            <RefreshCw size={17} /> 重新载入共享数据
          </button>
        }
      />
      <section className="panel settings-shell">
        <ViewTabs
          value={settingsTab}
          items={[
            { id: "reminders", label: "提醒规则" },
            { id: "data", label: "数据与备份" },
            { id: "integrations", label: "外部集成" },
          ]}
          onChange={setSettingsTab}
          label="设置分类"
        />
        {settingsTab === "reminders" && (
          <article className="settings-panel settings-form">
            <div className="settings-intro">
              <div>
                <p className="eyebrow">强提醒规则</p>
                <h2>时间节点</h2>
              </div>
              <StatusPill tone="amber">多人共享</StatusPill>
            </div>
            <div className="settings-fields">
              <label>
                LP 默认提前
                <input
                  value={displayedRules.lpDays}
                  onChange={(event) => {
                    setRulesDraft({
                      ...displayedRules,
                      lpDays: event.target.value,
                    });
                    setRulesDraftTouched(true);
                  }}
                />
              </label>
              <label>
                课后反馈检查（小时）
                <input
                  value={displayedRules.feedbackHours}
                  onChange={(event) => {
                    setRulesDraft({
                      ...displayedRules,
                      feedbackHours: event.target.value,
                    });
                    setRulesDraftTouched(true);
                  }}
                />
              </label>
              <label>
                续课预销售提前（天）
                <input
                  value={displayedRules.renewalDays}
                  onChange={(event) => {
                    setRulesDraft({
                      ...displayedRules,
                      renewalDays: event.target.value,
                    });
                    setRulesDraftTouched(true);
                  }}
                />
              </label>
              <label>
                低课时阈值
                <input
                  type="number"
                  min="1"
                  value={displayedRules.lowHours}
                  onChange={(event) => {
                    setRulesDraft({
                      ...displayedRules,
                      lowHours: event.target.value,
                    });
                    setRulesDraftTouched(true);
                  }}
                />
              </label>
              <label>
                考试提前提醒（天）
                <input
                  type="number"
                  min="1"
                  value={displayedRules.examDays}
                  onChange={(event) => {
                    setRulesDraft({
                      ...displayedRules,
                      examDays: event.target.value,
                    });
                    setRulesDraftTouched(true);
                  }}
                />
              </label>
              <label>
                逾期升级规则
                <input
                  value={displayedRules.escalation}
                  onChange={(event) => {
                    setRulesDraft({
                      ...displayedRules,
                      escalation: event.target.value,
                    });
                    setRulesDraftTouched(true);
                  }}
                />
              </label>
            </div>
            <button
              className="primary-button settings-save"
              type="button"
              disabled={!rulesDraftTouched}
              onClick={() => {
                const numericValues = [
                  displayedRules.feedbackHours,
                  displayedRules.renewalDays,
                  displayedRules.lowHours,
                  displayedRules.examDays,
                ].map(Number);
                if (numericValues.some((value) => !Number.isFinite(value) || value < 1)) {
                  notify("小时、天数和低课时阈值必须是大于 0 的数字");
                  return;
                }
                const previousRules = rules;
                requestConfirmation({
                  title: "确认更新全局提醒规则",
                  detail: `LP ${displayedRules.lpDays} · 课后 ${displayedRules.feedbackHours} 小时 · 低课时 ${displayedRules.lowHours} · 考试 ${displayedRules.examDays} 天`,
                  items: [
                    "保存后会影响所有在线教务看到的提醒结果",
                    `逾期升级：${displayedRules.escalation}`,
                    "保存后可在 12 秒内撤销",
                  ],
                  confirmLabel: "保存全局规则",
                  onConfirm: () => {
                    setRules(displayedRules);
                    setRulesDraftTouched(false);
                    addAudit(
                      "保存强提醒规则",
                      `LP ${displayedRules.lpDays}、课后 ${displayedRules.feedbackHours}h、低课时 ${displayedRules.lowHours}、考试 ${displayedRules.examDays} 天`,
                      "green",
                    );
                    notify("规则已保存到 Supabase，并同步给其他在线成员", () => {
                      setRules(previousRules);
                      setRulesDraft(previousRules);
                      setRulesDraftTouched(false);
                      addAudit("撤销强提醒规则更新", "恢复上一个规则版本", "amber");
                    });
                  },
                });
              }}
            >
              <Check size={17} />
              {rulesDraftTouched ? "保存规则" : "规则未修改"}
            </button>
          </article>
        )}
        {settingsTab === "data" && (
          <article className="settings-panel">
            <div className="settings-intro">
              <div>
                <p className="eyebrow">数据安全</p>
                <h2>真实资料与共享保存</h2>
              </div>
              <StatusPill tone="amber">私有访问</StatusPill>
            </div>
            <div className="settings-list">
              <OwnershipRow
                title="当前存储"
                detail="站内业务数据写入 Supabase，在线成员读取同一版本"
                tone="green"
                label="已启用"
              />
              <OwnershipRow
                title="真实资料来源"
                detail="学生总表、教师总表与教务宝只读镜像；缺失字段保留待确认"
                tone="green"
                label="已加载"
              />
              <OwnershipRow
                title="数据导出"
                detail="可随时导出 JSON 副本"
                tone="green"
                label="可用"
              />
              <OwnershipRow
                title="共享数据库"
                detail="Supabase 已启用版本检查与共享写入；冲突不会静默覆盖"
                tone="green"
                label="已启用"
              />
            </div>
            <div className="button-row">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setActive("sync")}
              >
                <FilePlus2 size={16} /> 打开共享导入
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={exportDemo}
              >
                <Download size={16} /> 导出当前数据
              </button>
            </div>
          </article>
        )}
        {settingsTab === "integrations" && (
          <article className="settings-panel">
            <div className="settings-intro">
              <div>
                <p className="eyebrow">连接状态</p>
                <h2>外部系统</h2>
              </div>
              <StatusPill tone="blue">部分连接</StatusPill>
            </div>
            <div className="integration-list">
              <OwnershipRow
                title="企业微信"
                detail="需要应用权限、员工与客户群映射"
                tone="amber"
                label="待 PoC"
              />
              <OwnershipRow
                title="教务宝"
                detail="学生课时、课程目录与本周排课已只读镜像；不会回写教务宝"
                tone="green"
                label="只读已接入"
              />
              <OwnershipRow
                title="腾讯表格"
                detail="已完成只读来源识别与 Supabase 镜像，不向腾讯文档回写"
                tone="green"
                label="只读已接入"
              />
              <OwnershipRow
                title="BiggerBlueButton"
                detail="已连接托管课堂 API；支持独立老师/学生链接、互动白板、投票、分组讨论和自动录播"
                tone="green"
                label="已接入"
              />
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => setActive("sync")}
            >
              <RefreshCw size={16} /> 查看同步状态
            </button>
          </article>
        )}
      </section>
    </>
  );

  const renderAudit = () => {
    const filteredAudit = audit.filter((entry) => {
      const matchesQuery = `${operatorLabel(entry.actor)} ${entry.actor} ${entry.action} ${entry.detail}`
        .toLowerCase()
        .includes(auditQuery.trim().toLowerCase());
      return (
        matchesQuery &&
        (auditFilter === "all" ||
          (auditFilter === "system"
            ? entry.actor === "系统"
            : auditFilter === "manual"
              ? entry.actor !== "系统"
              : entry.tone === auditFilter))
      );
    });
    const auditPageSize = 8;
    const safePage = Math.min(
      auditPage,
      Math.max(1, Math.ceil(filteredAudit.length / auditPageSize)),
    );
    const pagedAudit = filteredAudit.slice(
      (safePage - 1) * auditPageSize,
      safePage * auditPageSize,
    );
    return (
      <>
        <ViewHeading
          eyebrow="完整操作留痕"
          title="操作审计"
          copy="搜索操作者、动作或关联结果；分页后仍保留统一记录口径。"
          actions={
            <button
              className="secondary-button"
              type="button"
              onClick={exportDemo}
            >
              <Download size={17} /> 导出数据
            </button>
          }
        />
        <section className="panel collection-shell">
          <ViewTabs
            value={auditFilter}
            items={[
              { id: "all", label: "全部", count: audit.length },
              {
                id: "manual",
                label: "人工操作",
                count: audit.filter((entry) => entry.actor !== "系统").length,
              },
              {
                id: "system",
                label: "系统事件",
                count: audit.filter((entry) => entry.actor === "系统").length,
              },
              {
                id: "amber",
                label: "需关注",
                count: audit.filter((entry) => entry.tone === "amber").length,
              },
            ]}
            onChange={(value) => {
              setAuditFilter(value);
              setAuditPage(1);
            }}
            label="审计保存视图"
          />
          <ListToolbar
            query={auditQuery}
            onQuery={(value) => {
              setAuditQuery(value);
              setAuditPage(1);
            }}
            placeholder="搜索操作者、动作或详情"
            count={`${filteredAudit.length} 条记录`}
          />
          <div className="collection-main">
            <div className="collection-head audit-grid-row">
              <span>时间</span>
              <span>操作者</span>
              <span>动作</span>
              <span>详情</span>
            </div>
            <div className="collection-viewport">
              {pagedAudit.length ? (
                pagedAudit.map((entry) => (
                  <div className="collection-row audit-grid-row" key={entry.id}>
                    <span>{formatAuditTime(entry.time, displayPreferences)}</span>
                    <span>{operatorLabel(entry.actor)}</span>
                    <span>
                      <StatusPill tone={entry.tone}>{entry.action}</StatusPill>
                    </span>
                    <span>{entry.detail}</span>
                  </div>
                ))
              ) : (
                <EmptyState
                  title="没有审计记录"
                  detail="调整筛选或搜索条件。"
                />
              )}
            </div>
            <Pagination
              page={safePage}
              total={filteredAudit.length}
              pageSize={auditPageSize}
              onPage={setAuditPage}
            />
          </div>
        </section>
      </>
    );
  };

  const renderClassroom = () => {
    const upcomingBookings = scopedBookings
      .filter((booking) => !isPastBooking(booking))
      .sort(
        (left, right) =>
          bookingInstant(left).getTime() - bookingInstant(right).getTime(),
      );
    const historicalBookings = scopedBookings
      .filter((booking) => isPastBooking(booking))
      .sort(
        (left, right) =>
          bookingInstant(right).getTime() - bookingInstant(left).getTime(),
      );
    const visibleClassrooms =
      classroomView === "upcoming" ? upcomingBookings : historicalBookings;
    const roomBooking =
      visibleClassrooms.find((booking) => booking.id === selectedBookingId) ??
      visibleClassrooms[0];
    const historicalRoom = roomBooking ? isPastBooking(roomBooking) : false;
    const roomStudent = roomBooking
      ? studentById(roomBooking.studentId)
      : undefined;
    const roomTeacher = roomBooking
      ? teacherById(roomBooking.teacherId)
      : undefined;
    const classroomStatus = classroomRuntime?.running
      ? { label: "课堂进行中", tone: "green" as Tone }
      : classroomRuntime?.recordings.some((recording) => recording.playbackUrl)
        ? { label: "录播已就绪", tone: "blue" as Tone }
        : roomBooking?.classroom?.status === "ended"
          ? { label: "课堂已结束", tone: "neutral" as Tone }
          : roomBooking?.classroom?.meetingId
            ? { label: "待开课", tone: "amber" as Tone }
            : { label: "未创建", tone: "neutral" as Tone };
    const playback = classroomRuntime?.recordings.find(
      (recording) => recording.playbackUrl,
    );
    return (
      <>
        <ViewHeading
          eyebrow="BiggerBlueButton 托管课堂"
          title="网上教室"
          copy="从排课直接创建一对一课堂。老师与学生使用不同权限链接，支持音视频、屏幕共享、互动白板、投票、分组讨论和自动录播。"
          actions={
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={classroomBusy || (isTeacherView && (!currentTeacher || !scopedStudents.length))}
                onClick={() => setModal("temporaryClassroom")}
              >
                <Video size={17} /> 立即开临时课堂
              </button>
              {roomBooking ? (
                historicalRoom ? (
                  roomBooking.classroom?.meetingId ? (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={classroomBusy}
                      onClick={() => void refreshClassroom(roomBooking)}
                    >
                      <RefreshCw size={17} /> 刷新历史录播
                    </button>
                  ) : (
                    <button className="secondary-button" type="button" disabled>
                      <Clock3 size={17} /> 历史课程只读
                    </button>
                  )
                ) : !roomBooking.classroom?.meetingId ? (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={classroomBusy}
                    onClick={() => void createClassroom(roomBooking)}
                  >
                    <Video size={17} />{" "}
                    {classroomBusy ? "正在连接课堂…" : "创建在线教室"}
                  </button>
                ) : roomBooking.classroom.status === "ended" ? (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={classroomBusy}
                    onClick={() => void refreshClassroom(roomBooking)}
                  >
                    <RefreshCw size={17} /> 刷新录播
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={classroomBusy}
                    onClick={() => void joinTeacherClassroom(roomBooking)}
                  >
                    <ExternalLink size={17} />{" "}
                    {classroomBusy ? "正在处理…" : "老师进入教室"}
                  </button>
                )
              ) : (
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => openNewBooking()}
                >
                  <CalendarPlus size={17} /> 先创建约课
                </button>
              )}
            </>
          }
        />
        <section className="panel classroom-hub">
          <ViewTabs
            value={classroomView}
            items={[
              {
                id: "upcoming",
                label: "待开课与进行中",
                count: upcomingBookings.length,
              },
              {
                id: "history",
                label: "历史与录播",
                count: historicalBookings.length,
              },
            ]}
            onChange={(value) => {
              const nextView = value as "upcoming" | "history";
              const nextBooking =
                nextView === "upcoming"
                  ? upcomingBookings[0]
                  : historicalBookings[0];
              setClassroomView(nextView);
              if (nextBooking) {
                setSelectedBookingId(nextBooking.id);
                setSelectedStudentId(nextBooking.studentId);
              }
              setClassroomRuntime(null);
              setMobilePreview(null);
            }}
            label="课堂保存视图"
          />
          {visibleClassrooms.length ? (
            <div className="classroom-hub-layout">
              <article className="classroom-room-list">
                <div className="collection-head classroom-grid-row">
                  <span>课程</span>
                  <span>时间</span>
                  <span>教室</span>
                </div>
                {visibleClassrooms.slice(0, 12).map((booking) => {
                  const student = studentById(booking.studentId);
                  const status =
                    booking.classroom?.status === "running"
                      ? "进行中"
                      : booking.classroom?.status === "ended"
                        ? "已结束"
                        : booking.classroom?.meetingId
                          ? "待开课"
                          : "未创建";
                  return (
                    <button
                      className={`collection-row classroom-grid-row ${roomBooking?.id === booking.id ? "selected" : ""}`}
                      type="button"
                      key={booking.id}
                      onClick={() => {
                        setSelectedBookingId(booking.id);
                        setSelectedBookingDate(booking.date);
                        setSelectedBookingDateId(booking.id);
                        setSelectedStudentId(booking.studentId);
                        setClassroomRuntime(null);
                        setMobilePreview("classroom");
                      }}
                    >
                      <span>
                        <strong>{student?.name ?? booking.studentId}</strong>
                        <small>
                          {booking.course ?? student?.course ?? booking.kind}
                        </small>
                      </span>
                      <span>
                        <strong>
                          {formatInstant(
                            bookingInstant(booking),
                            scheduleTimezone,
                            displayPreferences,
                          )}
                        </strong>
                        <small>{timezoneLabel(scheduleTimezone, displayPreferences.language)}</small>
                      </span>
                      <StatusPill
                        tone={
                          status === "进行中"
                            ? "green"
                            : status === "待开课"
                              ? "amber"
                              : status === "已结束"
                                ? "blue"
                                : "neutral"
                        }
                      >
                        {status}
                      </StatusPill>
                    </button>
                  );
                })}
              </article>
              {roomBooking && (
                <aside
                  className={`classroom-room-preview ${mobilePreview === "classroom" ? "mobile-detail-open" : ""}`}
                >
                  <button
                    className="mobile-preview-close"
                    type="button"
                    aria-label="关闭课堂详情"
                    onClick={() => setMobilePreview(null)}
                  >
                    <ChevronLeft size={20} /> 返回课堂列表
                  </button>
                  <div className="preview-header">
                    <div>
                      <p className="eyebrow">
                        {roomBooking.id} · {roomTeacher?.name ?? "老师待关联"}
                      </p>
                      <h2>{roomStudent?.name ?? "学生"}</h2>
                    </div>
                    <StatusPill tone={classroomStatus.tone}>
                      {classroomStatus.label}
                    </StatusPill>
                  </div>
                  <div className="classroom-link-preview">
                    <Video size={24} />
                    <span>
                      <strong>一对一网上教室</strong>
                      <small>
                        {classroomRuntime?.running
                          ? `${classroomRuntime.participantCount} 人在线 · ${classroomRuntime.moderatorCount} 位老师`
                          : "老师与学生使用独立权限链接"}
                      </small>
                    </span>
                  </div>
                  <div className="classroom-auto-room-note">
                    <ShieldCheck size={16} />
                    <span>
                      <strong>排课已自动关联网上教室</strong>
                      <small>第一次进入或复制学生链接时，系统会自动连接课堂服务；无需重复创建。</small>
                    </span>
                  </div>
                  {temporaryClassroomLink?.bookingId === roomBooking.id && (
                    <div className="classroom-share-link">
                      <label>
                        学生邀请链接
                        <input aria-label="学生邀请链接" value={temporaryClassroomLink.url} readOnly />
                      </label>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => void navigator.clipboard.writeText(temporaryClassroomLink.url)
                          .then(() => notify("学生进入链接已复制"))
                          .catch(() => notify("复制失败，请手动选择并复制链接"))}
                      >
                        <Copy size={16} /> 复制链接
                      </button>
                      <a className="secondary-button" href={temporaryClassroomLink.url} target="_blank" rel="noreferrer">
                        <ExternalLink size={16} /> 打开学生端
                      </a>
                    </div>
                  )}
                  <div className="detail-section">
                    <span>课程时间</span>
                    <strong>
                      {formatInstant(
                        bookingInstant(roomBooking),
                        scheduleTimezone,
                        displayPreferences,
                      )}
                    </strong>
                    <p>
                      {timezoneLabel(scheduleTimezone, displayPreferences.language)} · {roomBooking.duration}{" "}
                      {displayPreferences.language === "en-AU" ? "min" : "分钟"}
                    </p>
                  </div>
                  <div className="detail-section">
                    <span>可用课堂工具</span>
                    <div className="classroom-tool-tags">
                      <span>音视频</span>
                      <span>屏幕共享</span>
                      <span>互动白板</span>
                      <span>投票</span>
                      <span>分组讨论</span>
                      <span>自动录播</span>
                    </div>
                  </div>
                  {historicalRoom ? (
                    <div className="classroom-recording-pending">
                      <Clock3 size={16} />
                      <span>
                        <strong>历史课程只读</strong>
                        <small>
                          不能重新创建、加入或生成学生链接；如有旧教室记录，只能刷新和打开录播。
                        </small>
                      </span>
                    </div>
                  ) : !roomBooking.classroom?.meetingId ? (
                    <button
                      className="primary-button full"
                      type="button"
                      disabled={classroomBusy}
                      onClick={() => void createClassroom(roomBooking)}
                    >
                      <Video size={16} />{" "}
                      {classroomBusy ? "正在创建…" : "创建在线教室"}
                    </button>
                  ) : (
                    <>
                      {roomBooking.classroom.status !== "ended" && (
                        <button
                          className="primary-button full"
                          type="button"
                          disabled={classroomBusy}
                          onClick={() => void joinTeacherClassroom(roomBooking)}
                        >
                          <ExternalLink size={16} />{" "}
                          {classroomBusy ? "正在处理…" : "老师进入教室"}
                        </button>
                      )}
                      {roomBooking.classroom.status !== "ended" && (
                        <button
                          className="secondary-button full"
                          type="button"
                          disabled={classroomBusy}
                          onClick={() =>
                            void copyStudentClassroomLink(roomBooking)
                          }
                        >
                          <Copy size={16} />{" "}
                          {classroomBusy ? "正在处理…" : "复制学生进入链接"}
                        </button>
                      )}
                      {!historicalRoom && (
                        <button
                          className="secondary-button full"
                          type="button"
                          disabled={classroomBusy}
                          onClick={() => void refreshClassroom(roomBooking)}
                        >
                          <RefreshCw size={16} /> 刷新教室状态
                        </button>
                      )}
                      {(classroomRuntime?.running ||
                        roomBooking.classroom.status === "running") && (
                        <button
                          className="danger-button full"
                          type="button"
                          disabled={classroomBusy}
                          onClick={() => void endClassroom(roomBooking)}
                        >
                          <ShieldCheck size={16} /> 结束课堂并结课
                        </button>
                      )}
                      {playback?.playbackUrl && (
                        <a
                          className="secondary-button full classroom-recording-link"
                          href={playback.playbackUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <ExternalLink size={16} /> 打开课堂录播
                        </a>
                      )}
                      {!playback?.playbackUrl &&
                        roomBooking.classroom.status === "ended" && (
                          <div className="classroom-recording-pending">
                            <Clock3 size={16} />
                            <span>
                              <strong>录播处理中</strong>
                              <small>
                                供应商处理完成后会在这里出现回放链接
                              </small>
                            </span>
                          </div>
                        )}
                    </>
                  )}
                  {historicalRoom && roomBooking.classroom?.meetingId && (
                    <button
                      className="secondary-button full"
                      type="button"
                      disabled={classroomBusy}
                      onClick={() => void refreshClassroom(roomBooking)}
                    >
                      <RefreshCw size={16} /> 刷新历史录播
                    </button>
                  )}
                  {historicalRoom && playback?.playbackUrl && (
                    <a
                      className="secondary-button full classroom-recording-link"
                      href={playback.playbackUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink size={16} /> 打开课堂录播
                    </a>
                  )}
                  {classroomBusy && (
                    <div className="classroom-recording-pending">
                      <Clock3 size={16} />
                      <span>
                        <strong>正在连接课堂服务</strong>
                        <small>
                          通常需要 10–30 秒，请不要重复点击或关闭新标签页
                        </small>
                      </span>
                    </div>
                  )}
                </aside>
              )}
            </div>
          ) : (
            <EmptyState
              title={
                classroomView === "upcoming"
                  ? "没有待开课课程"
                  : "没有历史课堂记录"
              }
              detail={
                classroomView === "upcoming"
                  ? "先为学生创建未来排课，系统会从排课生成对应的在线教室。"
                  : "已结束课程及其录播会显示在这里。"
              }
            />
          )}
        </section>
      </>
    );
  };

  const renderAccounts = () => {
    const accounts = [
      { name: "Admin", operator: "Nixon", role: "超级管理员", permissions: ["全局学生与老师", "排课与运营", "课时与薪资", "账号与权限"] },
      { name: DEMO_LIMITED_ADMIN_USER, operator: DEMO_LIMITED_ADMIN_USER, role: "运营管理员", permissions: ["全局学生与老师", "排课与运营", "同步来源", "账号与权限"] },
      ...DEMO_STAFF_USERS.map((name) => ({ name, operator: name, role: "教务账号", permissions: ["负责学生", "老师与排课", "LP 与续课", "文件与消息"] })),
      ...DEMO_TEACHER_USERS.map((name) => ({ name, operator: name, role: "老师账号", permissions: ["自己的学生", "自己的排课", "网上教室", "学生资料只读"] })),
    ];
    const selectedAccount =
      accounts.find((account) => account.name === selectedAccountName) ??
      accounts[0];
    return (
      <>
        <ViewHeading
          eyebrow="账号权限"
          title="账号与权限"
          copy="集中查看管理员、运营管理员、教务和老师账号及其权限范围。"
          actions={
            <button
              className="secondary-button"
              type="button"
              onClick={() =>
                notify("正式上线时可接 Supabase Auth、强密码与密码重置邮件")
              }
            >
              <UserPlus size={17} /> 新增账号
            </button>
          }
        />
        <section className="panel account-admin-shell">
          <div className="account-admin-layout">
            <article className="account-list">
              <div className="collection-head account-grid-row">
                <span>账号</span>
                <span>角色</span>
                <span>登录方式</span>
              </div>
              {accounts.map((account) => (
                <button
                  className={`collection-row account-grid-row ${selectedAccount.name === account.name ? "selected" : ""}`}
                  type="button"
                  key={account.name}
                  onClick={() => setSelectedAccountName(account.name)}
                >
                  <span className="table-person">
                    <Avatar
                      initials={
                        account.name === "Admin" ? "AD" : initials(account.name)
                      }
                      tone={
                        account.role === "老师账号"
                          ? "green"
                          : account.role === "教务账号"
                            ? "blue"
                            : "purple"
                      }
                    />
                    <span>
                      <strong>{account.name}</strong>
                      <small>状态：已启用</small>
                    </span>
                  </span>
                  <StatusPill
                    tone={
                      account.role === "老师账号"
                        ? "green"
                        : account.role === "教务账号"
                          ? "blue"
                          : "purple"
                    }
                  >
                    {account.role}
                  </StatusPill>
                  <span>
                    受控登录
                  </span>
                </button>
              ))}
            </article>
            <aside className="account-preview">
              <div className="preview-header">
                <div>
                  <p className="eyebrow">账号权限</p>
                  <h2>{selectedAccount.name}</h2>
                </div>
                <StatusPill tone="green">已启用</StatusPill>
              </div>
              <div className="student-facts account-facts">
                <span>
                  <small>角色</small>
                  <strong>{selectedAccount.role}</strong>
                  <em>演示权限组</em>
                </span>
                <span>
                  <small>登录方式</small>
                  <strong>
                    受控登录
                  </strong>
                  <em>
                    登录凭证不在页面显示
                  </em>
                </span>
              </div>
              <div className="detail-section">
                <span>可访问功能</span>
                <div className="permission-list">
                  {selectedAccount.permissions.map((permission) => (
                    <p key={permission}>
                      <CheckCircle2 size={15} /> {permission}
                    </p>
                  ))}
                </div>
              </div>
              <div className="account-actions">
                <button
                  className="primary-button full"
                  type="button"
                  onClick={() => switchOperator(selectedAccount.operator)}
                >
                  <UserCog size={16} /> 查看此账号视图
                </button>
              </div>
              <div className="form-notice">
                <CircleAlert size={16} />{" "}
                正式启用附件前需要独立账号、强密码和可审计的密码重置流程。
              </div>
            </aside>
          </div>
        </section>
      </>
    );
  };

  const renderView = () => {
    if (!canViewPayroll && active === "payroll") return renderDashboard();
    if (
      !isAdminView &&
      !(isTeacherView ? teacherSectionIds : staffSectionIds).has(active)
    )
      return renderDashboard();
    switch (active) {
      case "dashboard":
        return renderDashboard();
      case "students":
        return renderStudents();
      case "teachers":
        return renderTeachers();
      case "schedule":
        return renderSchedule();
      case "classroom":
        return renderClassroom();
      case "courses":
        return renderCourses();
      case "lp":
        return renderLp();
      case "operations":
        return renderOperations();
      case "renewals":
        return renderRenewals();
      case "payroll":
        return renderPayroll();
      case "messages":
        return renderMessages();
      case "files":
        return renderFiles();
      case "sync":
        return renderSync();
      case "reports":
        return renderReports();
      case "settings":
        return renderSettings();
      case "accounts":
        return renderAccounts();
      case "audit":
        return renderAudit();
    }
  };

  const submitStudent = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const course = String(data.get("course") ?? "").trim();
    if (!name || !course) return;
    const segment = String(data.get("segment") ?? "试听") as StudentSegment;
    const guardian = String(data.get("guardian") ?? "").trim();
    const guardianWechat = String(data.get("guardianWechat") ?? "").trim();
    if (segment === "试听" && !guardian && !guardianWechat) {
      notify("试听学生请填写家长 / 沟通对象或家长微信名其中一项");
      return;
    }
    const lpNeed = String(
      data.get("lpNeed") ?? (segment === "试听" ? "试听LP" : "无需LP"),
    ) as LpNeed;
    const newStudent: Student = {
      id: id("STU"),
      name,
      initials: initials(name),
      status: segment === "试听" ? "待排课" : "在读",
      segment,
      owner: String(data.get("owner") ?? "思佳"),
      planner: String(data.get("planner") ?? "待分配"),
      course,
      grade: String(data.get("grade") ?? "待确认"),
      gradeBaseYear: new Date().getFullYear(),
      location: String(data.get("location") ?? "VIC"),
      timezone: cleanTimezone(data.get("timezone")),
      guardian: guardian || "待补充",
      guardianWechat: guardianWechat || undefined,
      teacher: "待匹配",
      next:
        segment === "试听"
          ? "完成试听交接"
          : lpNeed === "无需LP"
            ? "确认首次排课"
            : `创建${lpNeed}`,
      nextTone: "blue",
      files: 0,
      lpNeed,
      reportProgress: "未记录",
      followUp: "未记录",
      notes: String(data.get("notes") ?? "无特殊备注"),
      remainingHours: data.get("remainingHours")
        ? Number(data.get("remainingHours"))
        : undefined,
    };
    setStudents((current) => [newStudent, ...current]);
    setSelectedStudentId(newStudent.id);
    const generatedTasks: Task[] = [
      {
        id: id("TSK"),
        title:
          segment === "试听" ? "完成试听交接与老师匹配" : "确认首次排课与资料",
        owner: newStudent.owner,
        studentId: newStudent.id,
        ...taskTiming(isoDateInTimezone(new Date(), "Australia/Melbourne")),
        category: segment === "试听" ? "试听" : "排课",
        trigger: "新建学生记录",
        ruleKey: "student.initial-handover",
        anchorBookingId: `student:${newStudent.id}`,
      },
    ];
    if (lpNeed !== "无需LP")
      generatedTasks.push({
        id: id("TSK"),
        title: `创建${lpNeed}`,
        owner: newStudent.owner,
        studentId: newStudent.id,
        ...taskTiming(shiftIsoDate(isoDateInTimezone(new Date(), "Australia/Melbourne"), 1), "Australia/Melbourne", "amber"),
        category: "LP",
        trigger: "建档时选择需要 LP",
        ruleKey: "student.create-lp",
        anchorBookingId: `student:${newStudent.id}`,
      });
    setTasks((current) => sortTasksByDueAt(upsertTasksByRule(current, generatedTasks)));
    addAudit("新建学生档案", `${newStudent.name} · ${newStudent.id}`, "green");
    setModal(null);
    setActive("students");
    notify("学生档案和首个试听任务已创建");
  };

  const submitStudentEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const course = String(data.get("course") ?? "").trim();
    if (!name || !course) {
      notify("学生姓名和课程不能为空");
      return;
    }
    const guardian = String(data.get("guardian") ?? "").trim();
    const guardianWechat = String(data.get("guardianWechat") ?? "").trim();
    const trialStudent = selectedStudent.segment === "试听" || selectedStudent.status === "试听中" || selectedStudent.status === "待排课";
    if (trialStudent && !guardian && !guardianWechat) {
      notify("试听学生请填写家长 / 沟通对象或家长微信名其中一项");
      return;
    }
    const before = selectedStudent;
    setStudents((current) =>
      current.map((student) =>
        student.id === selectedStudent.id
          ? {
              ...student,
              name,
              initials: initials(name),
              course,
              grade: String(data.get("grade") ?? "待确认"),
              owner: isAdminView
                ? String(data.get("owner") ?? student.owner)
                : student.owner,
              planner: String(
                data.get("planner") ?? student.planner ?? "待分配",
              ),
              guardian: guardian || "待补充",
              guardianWechat: guardianWechat || undefined,
              notes: String(data.get("notes") ?? "无特殊备注"),
              location: String(
                data.get("location") ?? student.location ?? "VIC",
              ),
              timezone: cleanTimezone(data.get("timezone")),
            }
          : student,
      ),
    );
    addAudit(
      "编辑学生档案",
      `${before.name}（${before.id}）· ${isAdminView ? "姓名/课程/负责人" : "姓名/课程"}资料已更新`,
      "blue",
    );
    setModal(null);
    notify("学生档案已更新");
  };

  const submitStudentEvidence = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (evidenceUploadBusy) return;
    const data = new FormData(event.currentTarget);
    const attachment = data.get("attachment");
    const title =
      String(data.get("title") ?? "家长沟通记录").trim() || "家长沟通记录";
    if (!(attachment instanceof File) || attachment.size === 0) {
      notify("请选择需要归档的图片");
      return;
    }
    setEvidenceUploadBusy(true);
    try {
      const upload = new FormData();
      upload.set("studentId", selectedStudent.id);
      upload.set("file", attachment);
      const response = await fetch("/api/fu-attachments", {
        method: "POST",
        body: upload,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.id || !body.url)
        throw new Error(body.error || "沟通截图上传失败");
      const fileRecord: FileRecord = {
        id: `EVID-${body.id}`,
        studentId: selectedStudent.id,
        title: `${title} · ${body.fileName || attachment.name}`,
        type: "课堂反馈",
        source: String(body.url),
        addedAt: `今天 ${nowLabel()}`,
      };
      setFiles((current) => [fileRecord, ...current]);
      setStudents((current) =>
        current.map((student) =>
          student.id === selectedStudent.id
            ? {
                ...student,
                files: student.files + 1,
              }
            : student,
        ),
      );
      addAudit(
        "归档学生沟通截图",
        `${selectedStudent.name} · ${title} · ${body.fileName || attachment.name}`,
        "green",
      );
      setModal(null);
      notify("沟通截图已归档到学生档案");
    } catch (error) {
      notify(error instanceof Error ? error.message : "沟通截图上传失败");
    } finally {
      setEvidenceUploadBusy(false);
    }
  };

  const submitStudentFollowUp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const parsed = parseFollowUpFormData(new FormData(event.currentTarget));
      const followUp: StudentFollowUp = { id: id("FUH"), followedUpAt: parsed.followedUpAt, note: parsed.note, recordedBy: operatorLabel(sessionOperator) };
      setStudents((current) => current.map((student) => student.id === selectedStudent.id ? {
        ...student,
        followUp: followUp.followedUpAt,
        followUpHistory: appendStudentFollowUp(student.followUpHistory ?? [], followUp),
      } : student));
      addAudit("记录学生跟进", `${selectedStudent.name} · ${formatFollowUpTime(followUp.followedUpAt, displayPreferences)}${followUp.note ? ` · ${followUp.note}` : ""}`, "green");
      setModal(null);
      notify("跟进日期已追加到历史");
    } catch (error) {
      notify(error instanceof Error ? error.message : "跟进记录无效");
    }
  };

  const submitLessonPackage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const parsed = parseLessonPackageFormData(new FormData(event.currentTarget));
      const purchasedAt = new Date().toISOString();
      setStudents((current) => current.map((student) => {
        if (student.id !== selectedStudent.id) return student;
        let packages = [...(student.lessonPackages ?? [])];
        if (parsed.packageMode === "new") {
          const packageId = id("PKG");
          packages.push(createStudentLessonPackage({
            id: packageId,
            name: parsed.newPackageName,
            subjectIds: parsed.subjectIds,
            initialPurchase: { id: id("PUR"), purchasedAt, hours: parsed.totalHours, note: [parsed.purchaseNote, parsed.bonusHours ? `含赠送 ${parsed.bonusHours} 课时` : ""].filter(Boolean).join(" · ") || undefined },
          }));
          for (const subjectId of parsed.subjectIds) packages = bindSubjectToLessonPackage(packages, packageId, subjectId);
        } else {
          packages = packages.map((lessonPackage) => lessonPackage.id === parsed.packageId ? addLessonPackageHours(lessonPackage, {
            id: id("PUR"),
            purchasedAt,
            hours: parsed.totalHours,
            note: [parsed.purchaseNote, parsed.bonusHours ? `含赠送 ${parsed.bonusHours} 课时` : ""].filter(Boolean).join(" · ") || undefined,
          }) : lessonPackage);
          for (const subjectId of parsed.subjectIds) packages = bindSubjectToLessonPackage(packages, parsed.packageId, subjectId);
        }
        const remainingHours = packages.reduce((sum, lessonPackage) => sum + getLessonPackageBalance(lessonPackage).remainingHours, 0);
        return { ...student, lessonPackages: packages, remainingHours, contractHours: packages.reduce((sum, lessonPackage) => sum + getLessonPackageBalance(lessonPackage).totalHours, 0) };
      }));
      addAudit("录入学生课包", `${selectedStudent.name} · ${parsed.packageMode === "new" ? parsed.newPackageName : parsed.packageId} · +${parsed.totalHours} 课时`, "green");
      setModal(null);
      notify("课包与购买记录已保存");
    } catch (error) {
      notify(error instanceof Error ? error.message : "课包内容无效");
    }
  };

  const submitExam = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const parsed = parseExamFormData(new FormData(event.currentTarget));
      const exam: StudentExamRecord = { id: id("EXM"), subject: parsed.subject, examType: parsed.examType, examMonth: parsed.examMonth, examDate: parsed.examDate };
      const resultDate = estimateExamResultDate(exam);
      setStudents((current) => current.map((student) => student.id === selectedStudent.id ? {
        ...student,
        exams: sortStudentExams([...(student.exams ?? []), exam]),
        examSubject: exam.subject,
        examDate: exam.examDate,
        resultDate: resultDate ?? undefined,
      } : student));
      const taskDefinitions = buildExamTaskDefinitions(exam, { includeRecall: parsed.includeRecall, resultDate: resultDate ?? undefined });
      const examTasks: Task[] = taskDefinitions.map((definition) => {
        const dueAt = zonedDateTimeToUtc(definition.dueDate, "18:00", "Australia/Melbourne");
        return { id: id("TSK"), title: definition.title, owner: definition.assigneeRole === "course_planner" ? (selectedStudent.planner ?? "Tara") : selectedStudent.owner, studentId: selectedStudent.id, due: formatInstant(dueAt, "Australia/Melbourne", displayPreferences), dueAt: dueAt.toISOString(), status: statusForDueAt(dueAt, new Date()), tone: definition.kind === "exam_results_follow_up" ? "purple" : "amber", category: "考试", trigger: `${exam.subject} 考试记录`, ruleKey: definition.key, anchorBookingId: `exam:${exam.id}` };
      });
      setTasks((current) => sortTasksByDueAt(upsertTasksByRule(current, examTasks)));
      addAudit("记录学生考试", `${selectedStudent.name} · ${exam.subject} · ${exam.examDate ?? exam.examMonth}`, "amber");
      setModal(null);
      notify(examTasks.length ? `考试已保存，并生成 ${examTasks.length} 项提醒` : "考试月份已保存；确定日期后再生成提醒");
    } catch (error) {
      notify(error instanceof Error ? error.message : "考试内容无效");
    }
  };

  const submitTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const studentId = String(data.get("studentId") ?? selectedStudent.id);
    const title = String(data.get("title") ?? "").trim();
    if (!title) return;
    const dueInput = String(data.get("dueAt") ?? "").trim();
    const dueParts = dueInput.match(/^(\d{4}-\d{2}-\d{2})T([0-2]\d:[0-5]\d)$/);
    const parsedDue = dueParts ? zonedDateTimeToUtc(dueParts[1], dueParts[2], "Australia/Melbourne") : null;
    if (!parsedDue || Number.isNaN(parsedDue.getTime())) {
      notify("请选择准确的截止日期和时间");
      return;
    }
    const task: Task = {
      id: id("TSK"),
      title,
      owner: String(data.get("owner") ?? "思佳"),
      studentId,
      due: formatInstant(parsedDue, "Australia/Melbourne", displayPreferences),
      dueAt: parsedDue.toISOString(),
      status: statusForDueAt(parsedDue, new Date()),
      tone: "blue",
      category: String(data.get("category") ?? "资料") as TaskCategory,
      trigger: "人工创建",
    };
    setTasks((current) => sortTasksByDueAt([...current, task]));
    addAudit(
      "创建内部任务",
      `${title} · ${studentById(studentId)?.name}`,
      "blue",
    );
    setModal(null);
    notify("任务已加入强提醒队列");
  };

  const submitNewPayroll = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const existingTeacherId = String(data.get("teacherId") ?? "").trim();
    const newTeacherName = String(data.get("newTeacherName") ?? "").trim();
    const month = String(data.get("month") ?? payrollMonthSelection).trim();
    const currency = String(data.get("currency") ?? "AUD") as PayrollRow["currency"];
    const rate = Number(data.get("rate") ?? 0);
    if (!month || (!existingTeacherId && !newTeacherName)) {
      notify("请选择老师和薪资月份，或填写新老师姓名");
      return;
    }
    if (!Number.isFinite(rate) || rate < 0) {
      notify("请填写有效的课时费");
      return;
    }
    let teacherId = existingTeacherId;
    let teacherName = teacherById(existingTeacherId)?.name ?? newTeacherName;
    if (newTeacherName) {
      const duplicateTeacher = teachers.find((teacher) => teacher.name.trim().toLowerCase() === newTeacherName.toLowerCase());
      if (duplicateTeacher) {
        teacherId = duplicateTeacher.id;
        teacherName = duplicateTeacher.name;
      } else {
        teacherId = id("TEA");
        const newTeacher: Teacher = {
          id: teacherId,
          name: newTeacherName,
          initials: initials(newTeacherName),
          subjects: ["待确认"],
          timezone: "Australia/Melbourne",
          availability: "待补充",
          load: 0,
          capacity: 0,
          acceptsStudents: false,
          note: "由薪资页面新增，教师资料待补充",
          availabilityStatus: "待确认",
        };
        setTeachers((current) => [newTeacher, ...current]);
      }
    }
    if (!teacherId || !teacherName) {
      notify("没有找到所选老师");
      return;
    }
    if (payroll.some((row) => row.teacherId === teacherId && row.month === month)) {
      notify("该老师在所选月份已经有薪资记录");
      return;
    }
    const payrollRow: PayrollRow = {
      id: id("PAY"),
      teacherId,
      teacherName,
      month,
      section: String(data.get("section") ?? "教师薪资").trim() || "教师薪资",
      currency,
      lessons: 0,
      trialLessons: 0,
      teacherTotalHours: 0,
      amount: 0,
      teacherTotalAmount: 0,
      status: "需核对",
      note: "手动新增，待导入或核对本月课时明细",
      paymentNote: String(data.get("paymentNote") ?? "").trim(),
      bankName: String(data.get("bankName") ?? "").trim(),
      bankAccount: String(data.get("bankAccount") ?? "").trim(),
      rateRange: rate > 0 ? [rate] : [],
      sourceHours: null,
      sourceLessonCount: null,
      sourceNoShowHours: null,
      hourVariance: null,
      lineCount: 0,
      lines: [],
      source: "薪资页面手动新增",
    };
    setPayroll((current) => [payrollRow, ...current]);
    setPayrollMonthSelection(month);
    setSelectedPayrollId(payrollRow.id);
    setPayrollPage(1);
    addAudit("新增老师薪资记录", `${teacherName} · ${month} · ${currency}`, "green");
    setModal(null);
    notify("老师薪资记录已新增，待导入或核对本月课时");
  };

  const submitPayrollEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!payrollDraft) return;
    const data = new FormData(event.currentTarget);
    const teacherName = String(data.get("teacherName") ?? "").trim();
    const month = String(data.get("month") ?? "").trim();
    const currency = String(data.get("currency") ?? payrollDraft.currency ?? "AUD") as PayrollRow["currency"];
    const fallbackRate = Number(data.get("defaultRate") ?? 0);
    if (!teacherName || !month || !Number.isFinite(fallbackRate) || fallbackRate < 0) {
      notify("请填写有效的老师姓名、薪资月份和课时费");
      return;
    }
    if (payroll.some((row) => row.id !== payrollDraft.id && row.teacherId === payrollDraft.teacherId && row.month === month)) {
      notify("该老师在所选月份已经有薪资记录");
      return;
    }
    const updatedLines = (payrollDraft.lines ?? []).map((line, index) => {
      const submittedRate = Number(data.get(`lineRate-${index}`) ?? line.rate);
      const rate = Number.isFinite(submittedRate) && submittedRate >= 0 ? submittedRate : line.rate;
      return { ...line, rate, subtotal: Number((line.hours * rate).toFixed(2)) };
    });
    const payrollHours = payrollDraft.teacherTotalHours ?? payrollDraft.lessons + payrollDraft.trialLessons;
    const amount = updatedLines.length
      ? Number(updatedLines.reduce((total, line) => total + line.subtotal, 0).toFixed(2))
      : Number((payrollHours * fallbackRate).toFixed(2));
    const rateRange = Array.from(new Set((updatedLines.length ? updatedLines.map((line) => line.rate) : [fallbackRate]).filter((rate) => rate > 0))).sort((a, b) => a - b);
    const wasLocked = payrollDraft.status === "已锁定";
    setPayroll((current) => current.map((row) => row.id === payrollDraft.id ? {
      ...row,
      teacherName,
      month,
      currency,
      section: String(data.get("section") ?? row.section ?? "教师薪资").trim() || "教师薪资",
      bankName: String(data.get("bankName") ?? "").trim(),
      bankAccount: String(data.get("bankAccount") ?? "").trim(),
      paymentNote: String(data.get("paymentNote") ?? "").trim(),
      rateRange,
      lines: updatedLines,
      amount,
      teacherTotalAmount: amount,
      status: "需核对",
      lockedBy: undefined,
      lockedAt: undefined,
    } : row));
    addAudit(
      "修改老师薪资与费率",
      `${teacherName} · ${month} · ${formatMoney(amount, currency)}${wasLocked ? " · 原锁定记录已重置" : ""}`,
      "amber",
    );
    setPayrollMonthSelection(month);
    setPayrollDraft(null);
    setModal(null);
    notify(wasLocked ? "薪资已更新并重置为需核对" : "薪资与费率已更新，等待重新核对");
  };

  const submitLp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    let parsedLp: ReturnType<typeof parseLpWorkflowFormData>;
    try {
      parsedLp = parseLpWorkflowFormData(data);
    } catch (error) {
      notify(error instanceof Error ? error.message : "LP 表单内容无效");
      return;
    }
    const provisional = data.get("provisional") === "on";
    let studentId = String(data.get("studentId") ?? selectedStudent.id);
    const workflowType = parsedLp.workflowType;
    const owner = isAdminView ? parsedLp.fields.responsibleOperations : selectedStudent.owner;
    const planner = String(
      data.get("planner") ?? selectedStudent.planner ?? "Tara",
    );
    let provisionalStudent: Student | undefined;
    let workflowStudent: Student | undefined;
    if (provisional) {
      if (!isAdminView) {
        notify("无姓名临时建档需要管理员处理，避免出现未保存的学生记录");
        return;
      }
      const provisionalCourse = String(
        data.get("provisionalCourse") ?? "",
      ).trim();
      const provisionalName = String(data.get("provisionalName") ?? "").trim();
      if (!provisionalCourse) {
        notify("暂未有姓名时，至少要填写科目/课程");
        return;
      }
      studentId = id("STU-TEMP");
      const displayName = provisionalName || `姓名待补 · ${provisionalCourse}`;
      provisionalStudent = {
        id: studentId,
        name: displayName,
        initials: provisionalName ? initials(provisionalName) : "待",
        status: "待确认",
        segment: workflowType === "学生直报（无试听）" ? "已报名" : "试听",
        owner,
        planner,
        course: provisionalCourse,
        grade: "待确认",
        gradeBaseYear: new Date().getFullYear(),
        location: "VIC",
        timezone: "Australia/Melbourne",
        guardian: "待补充",
        teacher: "待匹配",
        next: "补充学生姓名并完成 LP",
        nextTone: "amber",
        files: 0,
        lpNeed:
          lpWorkflowOptions.find((option) => option.id === workflowType)
            ?.lpNeed ?? "待确认",
        reportProgress: "未记录",
        followUp: "未记录",
        notes: "临时 LP 档案，姓名待补",
      };
      workflowStudent = provisionalStudent;
      setStudents((current) => [provisionalStudent!, ...current]);
      addAudit(
        "创建临时学生档案",
        `${displayName} · ${provisionalCourse} · ${owner}`,
        "amber",
      );
    } else {
      const existingStudent = studentById(studentId);
      workflowStudent = existingStudent
        ? { ...existingStudent, owner, planner }
        : undefined;
      setStudents((current) =>
        current.map((student) =>
          student.id === studentId ? { ...student, owner, planner } : student,
        ),
      );
    }
    if (
      !createLpWorkflow(
        studentId,
        workflowType,
        parsedLp.fields as unknown as LpFieldValues,
        workflowStudent,
      )
    ) {
      notify("没有找到该学生，未创建 LP 工作流");
      return;
    }
    if (workflowType === "学生直报（无试听）") {
      const purchasedHours = Number(parsedLp.fields.purchasedHours ?? 0);
      const bonusHours = Number(parsedLp.fields.bonusHours ?? 0);
      const totalHours = purchasedHours + bonusHours;
      const subject = String(parsedLp.fields.subject ?? workflowStudent?.course ?? "").trim();
      if (totalHours > 0 && subject) {
        const packageId = id("PKG");
        const purchaseId = id("PUR");
        const lessonPackage = createStudentLessonPackage({
          id: packageId,
          name: `${subject} · 直报课包`,
          subjectIds: [subject],
          initialPurchase: {
            id: purchaseId,
            purchasedAt: new Date().toISOString(),
            hours: totalHours,
            note: bonusHours > 0 ? `购买 ${purchasedHours} · 赠送 ${bonusHours}` : `购买 ${purchasedHours}`,
          },
        });
        setStudents((current) => current.map((student) => {
          if (student.id !== studentId) return student;
          const lessonPackages = bindSubjectToLessonPackage([...(student.lessonPackages ?? []), lessonPackage], packageId, subject);
          const remainingHours = lessonPackages.reduce((sum, entry) => sum + getLessonPackageBalance(entry).remainingHours, 0);
          const contractHours = lessonPackages.reduce((sum, entry) => sum + getLessonPackageBalance(entry).totalHours, 0);
          return { ...student, lessonPackages, remainingHours, contractHours };
        }));
        addAudit("直报录入课时", `${workflowStudent?.name ?? studentId} · ${subject} · ${purchasedHours}+${bonusHours}`, "green");
      }
    }
    setSelectedStudentId(studentId);
    setModal(null);
    setActive("lp");
    notify("已创建 LP 工作流和对应强提醒");
  };

  const submitLpRevision = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!lpRevisionDraft) return;
    const data = new FormData(event.currentTarget);
    const documentUrl = String(data.get("documentUrl") ?? "").trim();
    const revisionNote = String(data.get("revisionNote") ?? "").trim();
    if (!documentUrl) {
      notify("请填写本次 LP 版本的腾讯文档链接");
      return;
    }
    try {
      const parsed = new URL(documentUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
    } catch {
      notify("请填写完整的 http 或 https 链接");
      return;
    }
    const changedAt = new Date().toISOString();
    setLpItems((current) => current.map((entry) => {
      if (entry.id !== lpRevisionDraft.id) return entry;
      const revised = reviseLpWorkflow({
        id: entry.id,
        type: entry.workflowType ?? "试听 LP",
        stage: entry.stage,
        fields: entry.fields ?? {},
        revisionNumber: entry.revisionNumber ?? 1,
        revisions: entry.revisions ?? [],
        audit: entry.stageAudit ?? [],
      }, { documentUrl }, { id: id("LPR"), at: changedAt, actor: operatorLabel(sessionOperator), note: revisionNote });
      return { ...entry, fields: revised.fields, revisionNumber: revised.revisionNumber, revisions: [...revised.revisions] };
    }));
    const fileRecord: FileRecord = { id: id("FIL"), studentId: lpRevisionDraft.studentId, title: `${lpRevisionDraft.title} · 版本 ${(lpRevisionDraft.revisionNumber ?? 1) + 1}`, type: "Learning Plan", source: documentUrl, addedAt: changedAt };
    setFiles((current) => [fileRecord, ...current]);
    setStudents((current) => current.map((student) => student.id === lpRevisionDraft.studentId ? { ...student, files: student.files + 1 } : student));
    addAudit("修订 LP", `${lpRevisionDraft.title} · 版本 ${(lpRevisionDraft.revisionNumber ?? 1) + 1}${revisionNote ? ` · ${revisionNote}` : ""}`, "purple");
    setLpRevisionDraft(null);
    setModal(null);
    notify("LP 新版本和修订历史已保存");
  };

  const submitAva = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const teacherId = String(data.get("teacherId") ?? selectedTeacher.id);
    const day = Number(data.get("day") ?? 1);
    const start = String(data.get("start") ?? "16:00");
    const end = String(data.get("end") ?? "18:00");
    if (!teacherById(teacherId)) {
      notify("请从老师清单中选择需要录入 AVA 的老师");
      return;
    }
    if (!start || !end || start >= end) {
      notify("请填写有效的 AVA 起止时间");
      return;
    }
    const isEditing = avaDraft?.teacherId === teacherId;
    setTeachers((current) =>
      current.map((teacher) => {
        if (teacher.id !== teacherId) return teacher;
        const availabilitySlots = isEditing
          ? (teacher.availabilitySlots ?? []).map((slot, index) =>
              index === avaDraft.slotIndex ? { day, start, end } : slot,
            )
          : [...(teacher.availabilitySlots ?? []), { day, start, end }];
        return {
          ...teacher,
          availabilitySlots,
          availabilityUpdated: `手动${isEditing ? "修改" : "结构化"} · 今天 ${nowLabel()}`,
          availability: availabilitySlotsText(availabilitySlots),
        };
      }),
    );
    const teacher = teacherById(teacherId);
    setSelectedTeacherId(teacherId);
    addAudit(
      isEditing ? "修改老师 AVA" : "结构化老师 AVA",
      `${teacher?.name ?? teacherId} · ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][day]} ${start}-${end}`,
      isEditing ? "blue" : "green",
    );
    setAvaDraft(null);
    setModal(null);
    notify(
      isEditing
        ? "AVA 已更新并重新用于排课检查"
        : "AVA 已加入可约日历，可参与排课和代课筛选",
    );
  };

  const submitBooking = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const studentId = String(data.get("studentId") ?? "").trim();
    const teacherId = isTeacherView
      ? (currentTeacher?.id ?? "")
      : String(data.get("teacherId") ?? "").trim();
    const date = String(data.get("date") ?? "");
    const start = String(data.get("start") ?? "");
    const duration = Number(data.get("duration") ?? 60);
    const inputTimezone = cleanTimezone(data.get("timezone"));
    const kind = String(data.get("kind") ?? "常规课") as Booking["kind"];
    const packageId = String(data.get("packageId") ?? bookingDraft?.packageId ?? "").trim();
    const recurring = data.get("recurring") === "on";
    const repeatCountRaw = String(data.get("repeatCount") ?? "").trim();
    const parsedRepeatCount = Number(repeatCountRaw);
  const repeatCount: number | undefined = recurring
      ? repeatCountRaw && Number.isFinite(parsedRepeatCount)
        ? Math.max(1, Math.min(104, parsedRepeatCount))
        : bookingDraft?.recurring && bookingDraft.repeatCount == null
          ? undefined
          : undefined
      : 1;
    const submittedAt = new Date();
    const student = studentById(studentId);
    const teacher = teacherById(teacherId);
    if (!student) {
      notify("请从学生清单选择需要排课的学生。");
      return;
    }
    if (!teacher) {
      notify("请从老师清单选择需要排课的老师。");
      return;
    }
    if (isTeacherView && !scopedStudentIds.has(studentId)) {
      notify("老师账号只能为自己的学生安排课程。");
      return;
    }
    if (!teacherId) {
      notify("当前老师账号没有匹配到老师档案，请联系管理员。");
      return;
    }
    if (!date || !start) {
      notify("请填写课程日期和开始时间。");
      return;
    }
    const studentPackages = student.lessonPackages ?? [];
    if (kind !== "试听" && studentPackages.length) {
      const lessonPackage = studentPackages.find((item) => item.id === packageId);
      if (!lessonPackage) {
        notify("请选择本节课要使用的课包。");
        return;
      }
      if (!lessonPackage.subjectIds.includes(student.course)) {
        notify(`课包“${lessonPackage.name}”未绑定 ${student.course}。`);
        return;
      }
    }
    const firstTeacherStudentBooking = !bookingDraft && !bookings.some((item) => item.teacherId === teacherId && item.studentId === studentId);
    const movingTeacherOrStudent = Boolean(bookingDraft && (bookingDraft.teacherId !== teacherId || bookingDraft.studentId !== studentId));
    const newTeacherStudentBooking = movingTeacherOrStudent && !bookings.some((item) => item.id !== bookingDraft?.id && item.teacherId === teacherId && item.studentId === studentId);
    const targetCapacityAvailable = teacher.newStudentCapacity === undefined || teacher.newStudentCapacity > 0;
    if (kind !== "代课" && firstTeacherStudentBooking && teacher.newStudentCapacity !== undefined && teacher.newStudentCapacity <= 0) {
      notify(`${teacher.name} 的可接新生数量为 0，请先选择其他老师或由教务调整数量。`);
      return;
    }
    if (bookingDraft && movingTeacherOrStudent && !isAdminView) {
      notify("更换老师或学生需要管理员处理，以保持可接新生数量准确。");
      return;
    }
    if (bookingDraft && kind !== "代课" && newTeacherStudentBooking && !targetCapacityAvailable) {
      notify(`${teacher.name} 的可接新生数量为 0，请先选择其他老师或由教务调整数量。`);
      return;
    }
    if (
      recurring &&
      repeatCount == null &&
      !(bookingDraft?.recurring && bookingDraft.repeatCount == null)
    ) {
      notify("固定课程必须明确填写本轮节数，系统不会自动假设 12 节。");
      return;
    }
    const validationCount = recurring ? (repeatCount ?? 104) : 1;
    const proposedDates = Array.from({ length: validationCount }, (_, index) =>
      shiftIsoDate(date, index * 7),
    );
    const conflictDate = proposedDates.find((occurrenceDate) =>
      scheduleConflict(
        studentId,
        teacherId,
        occurrenceDate,
        start,
        duration,
        inputTimezone,
        bookingDraft?.id,
      ),
    );
    if (conflictDate) {
      notify(`${conflictDate} 的学生或老师已有重叠课程，请调整本轮排课。`);
      return;
    }
    if (kind === "试听" && !teacher.acceptsStudents) {
      notify(`${teacher.name} 当前不是“可接新生”状态，不能安排试听。`);
      return;
    }
    const unavailableDate = proposedDates.find(
      (occurrenceDate) =>
        !teacherAvailableAt(
          teacher,
          occurrenceDate,
          start,
          duration,
          inputTimezone,
        ),
    );
    if (unavailableDate) {
      notify(
        `${unavailableDate} 不在 ${teacher.name} 的结构化 AVA 内，请调整本轮排课。`,
      );
      return;
    }
    const bookingId = bookingDraft?.id ?? id("LES");
    const booking: Booking = {
      id: bookingId,
      studentId,
      teacherId,
      date,
      start,
      duration,
      kind,
      status: "待确认",
      timezone: inputTimezone,
      recurring,
      repeatCount,
      requestedAt: bookingDraft?.requestedAt ?? submittedAt.toISOString(),
      packageId: packageId || undefined,
      course: student.course,
      classroom: {
        meetingId: `yinling-${bookingId}`,
        status: "ready",
        createdAt: submittedAt.toISOString(),
      },
    };
    if (isPastBooking(booking) && !bookingDraft) {
      notify("不能创建已经过去的课程，请检查日期、时间和录入时区。");
      return;
    }
    if (kind === "试听" && bookingInstant(booking).getTime() <= submittedAt.getTime()) {
      notify("试听开始时间必须晚于当前时间，才能生成准确提醒。");
      return;
    }
    if (bookingDraft && isPastBooking(bookingDraft)) {
      notify("历史课程已经归档，不能再编辑课程系列。");
      return;
    }
    const scheduleSummary = `${student.name} · ${date} ${start} · ${teacher.name} · ${recurring ? (repeatCount == null ? "旧版长期" : `${repeatCount} 节固定课`) : "单次课"}`;
    const previousBooking = bookingDraft ? { ...bookingDraft } : undefined;
    const previousStudent = { ...student };
    const previousBookingTasks = bookingDraft ? tasks.filter((task) => task.anchorBookingId === bookingDraft.id) : [];
    const requestWorkflowBeforeEdit = bookingDraft && kind === "试听"
      ? [...lpItems]
          .filter((item) => item.studentId === studentId && (item.workflowType === "试听 LP" || item.workflowType === "换老师试听"))
          .find((item) => tasks.some((task) => task.anchorBookingId === item.id))
      : undefined;
    const previousRequestTasks = requestWorkflowBeforeEdit
      ? tasks.filter((task) => task.studentId === studentId && task.anchorBookingId === requestWorkflowBeforeEdit.id)
      : [];
    requestConfirmation({
      title: bookingDraft ? "确认修改整个课程系列" : "确认创建排课",
      detail: scheduleSummary,
      items: [
        `录入时区：${timezoneLabel(inputTimezone)}；每节 ${duration} 分钟`,
        recurring
          ? `会创建或更新 ${repeatCount ?? "长期"} 个每周时段`
          : "只创建 1 个课程时段",
        bookingDraft
          ? "会重新检查整组课程的冲突与老师 AVA"
          : isTeacherView
            ? "创建后等待教务确认"
            : "创建后会生成 LP、N-2 和课后检查任务",
      ],
      confirmLabel: bookingDraft ? "保存整个系列" : "确认创建",
      onConfirm: () => {
        if (bookingDraft && previousBooking) {
          const previousTeacher = teacherById(previousBooking.teacherId);
          const targetTeacherBeforeEdit = teacherById(teacher.id);
          const previousTeacherStudentBooking = bookings.some((entry) => entry.id !== previousBooking.id && entry.teacherId === previousBooking.teacherId && entry.studentId === previousBooking.studentId);
          const previousCapacityAssigned = Boolean(previousTeacher?.capacityAssignments?.includes(previousBooking.studentId));
          const shouldReleasePreviousCapacity = movingTeacherOrStudent && previousCapacityAssigned && !previousTeacherStudentBooking;
          const shouldAssignTargetCapacity = isAdminView && booking.kind !== "代课" && newTeacherStudentBooking && teacher.newStudentCapacity !== undefined;
          booking.classroom = bookingDraft.classroom;
          setBookings((current) =>
            current.map((entry) =>
              entry.id === bookingDraft.id ? { ...entry, ...booking } : entry,
            ),
          );
          if (booking.kind === "试听") {
            const requestWorkflow = requestWorkflowBeforeEdit;
            setTasks((current) => requestWorkflow
              ? linkTrialRequestTasksToBooking(current, {
                  requestAnchorBookingId: requestWorkflow.id,
                  anchorBookingId: booking.id,
                  studentId,
                  owner: student.owner,
                  requestedAt: booking.requestedAt ?? submittedAt.toISOString(),
                  trialStartsAt: bookingInstant(booking),
                  now: submittedAt,
                  idFactory: () => id("TSK"),
                })
              : reconcileTrialBookingTasks(current, {
                  anchorBookingId: booking.id,
                  studentId,
                  owner: student.owner,
                  requestedAt: booking.requestedAt ?? submittedAt.toISOString(),
                  trialStartsAt: bookingInstant(booking),
                  now: submittedAt,
                  idFactory: () => id("TSK"),
                }));
          } else if (previousBooking.kind === "试听") {
            setTasks((current) => closeTasksForBooking(current, booking.id, new Date(), "试听已改为其他课程类型"));
          }
          if (shouldReleasePreviousCapacity || shouldAssignTargetCapacity) {
            setTeachers((current) => current.map((entry) => {
              if (shouldReleasePreviousCapacity && previousTeacher && entry.id === previousTeacher.id) {
                return {
                  ...entry,
                  newStudentCapacity: entry.newStudentCapacity === undefined ? undefined : entry.newStudentCapacity + 1,
                  capacityAssignments: (entry.capacityAssignments ?? []).filter((assignment) => assignment !== previousBooking.studentId),
                };
              }
              if (shouldAssignTargetCapacity && entry.id === teacher.id) {
                return {
                  ...entry,
                  newStudentCapacity: Math.max(0, (entry.newStudentCapacity ?? 0) - 1),
                  capacityAssignments: Array.from(new Set([...(entry.capacityAssignments ?? []), studentId])),
                };
              }
              return entry;
            }));
          }
          addAudit("编辑排课", scheduleSummary, "blue");
          notify("课程已更新并重新完成冲突检查", () => {
            setBookings((current) =>
              current.map((entry) =>
                entry.id === previousBooking.id ? previousBooking : entry,
              ),
            );
            const taskSnapshotById = new Map(
              [...previousBookingTasks, ...previousRequestTasks].map((task) => [task.id, task]),
            );
            setTasks((current) => sortTasksByDueAt([
              ...current.filter((task) => task.anchorBookingId !== previousBooking.id && !taskSnapshotById.has(task.id)),
              ...taskSnapshotById.values(),
            ].map((task) => ({ ...task }))));
            if (shouldReleasePreviousCapacity || shouldAssignTargetCapacity) {
              setTeachers((current) => current.map((entry) => {
                if (previousTeacher && entry.id === previousTeacher.id) return previousTeacher;
                if (targetTeacherBeforeEdit && entry.id === targetTeacherBeforeEdit.id) return targetTeacherBeforeEdit;
                return entry;
              }));
            }
            addAudit(
              "撤销编辑排课",
              `${student.name} · 恢复原课程系列`,
              "amber",
            );
          });
        } else {
          setBookings((current) => [...current, booking]);
          const requestWorkflow = kind === "试听" ? [...lpItems]
            .filter((item) => item.studentId === studentId && (item.workflowType === "试听 LP" || item.workflowType === "换老师试听"))
            .find((item) => tasks.some((task) => task.anchorBookingId === item.id)) : undefined;
          const previousRequestTasksForCreate = requestWorkflow
            ? tasks.filter((task) => task.studentId === studentId && task.anchorBookingId === requestWorkflow.id)
            : [];
          const generatedTasks = kind === "试听"
            ? generateTrialBookingTasks({
                anchorBookingId: booking.id,
                studentId,
                owner: student.owner,
                requestedAt: booking.requestedAt ?? submittedAt.toISOString(),
                trialStartsAt: bookingInstant(booking),
                now: submittedAt,
                idFactory: () => id("TSK"),
              })
            : [];
          if (generatedTasks.length) setTasks((current) => requestWorkflow
            ? linkTrialRequestTasksToBooking(current, {
                requestAnchorBookingId: requestWorkflow.id,
                anchorBookingId: booking.id,
                studentId,
                owner: student.owner,
                requestedAt: booking.requestedAt ?? submittedAt.toISOString(),
                trialStartsAt: bookingInstant(booking),
                now: submittedAt,
                idFactory: () => id("TSK"),
              })
            : reconcileTrialBookingTasks(current, {
                anchorBookingId: booking.id,
                studentId,
                owner: student.owner,
                requestedAt: booking.requestedAt ?? submittedAt.toISOString(),
                trialStartsAt: bookingInstant(booking),
                now: submittedAt,
                idFactory: () => id("TSK"),
              }));
          if (!isTeacherView)
            setStudents((current) =>
              current.map((item) =>
                item.id === studentId
                  ? {
                      ...item,
                      teacher: teacher.name,
                      status: kind === "试听" ? "试听中" : item.status,
                      next: "完成 LP 与 N-2 检查",
                      nextTone: "amber",
                    }
                  : item,
              ),
            );
          if (isAdminView && kind !== "代课" && firstTeacherStudentBooking && teacher.newStudentCapacity !== undefined) {
            setTeachers((current) => current.map((item) => item.id === teacher.id ? {
              ...item,
              newStudentCapacity: Math.max(0, (item.newStudentCapacity ?? 0) - 1),
              capacityAssignments: Array.from(new Set([...(item.capacityAssignments ?? []), studentId])),
            } : item));
          }
          addAudit("创建排课", scheduleSummary, "green");
          notify(
            isTeacherView
              ? "约课已创建，等待教务确认"
              : kind === "试听" ? "试听排课已创建，准确提醒时间已生成" : "排课已创建",
            isAdminView ? () => {
              const generatedTaskIds = new Set(
                generatedTasks.map((task) => task.id),
              );
              setBookings((current) =>
                current.filter((entry) => entry.id !== booking.id),
              );
              if (generatedTaskIds.size) setTasks((current) => sortTasksByDueAt([
                ...current.filter((task) => task.anchorBookingId !== booking.id && !generatedTaskIds.has(task.id)),
                ...previousRequestTasksForCreate.filter((task) => !current.some((entry) => entry.id === task.id && entry.anchorBookingId !== booking.id)),
              ]));
              if (requestWorkflow) {
                setTasks((current) => restoreTrialRequestTasksToWorkflow(current, {
                  bookingAnchorBookingId: booking.id,
                  requestAnchorBookingId: requestWorkflow.id,
                  studentId,
                }));
              }
              if (!isTeacherView)
                setStudents((current) =>
                  current.map((item) =>
                    item.id === previousStudent.id ? previousStudent : item,
                  ),
                );
              if (isAdminView && kind !== "代课" && firstTeacherStudentBooking && teacher.newStudentCapacity !== undefined) {
                setTeachers((current) => current.map((item) => item.id === teacher.id ? {
                  ...item,
                  newStudentCapacity: teacher.newStudentCapacity,
                  capacityAssignments: (item.capacityAssignments ?? []).filter((assignment) => assignment !== studentId),
                } : item));
              }
              addAudit("撤销创建排课", scheduleSummary, "amber");
            } : undefined,
          );
        }
        setSelectedBookingId(booking.id);
        setSelectedBookingDate(date);
        setSelectedBookingDateId(booking.id);
        setBookingDraft(null);
        setBookingPrefillStudentId(null);
        setBookingPrefillTeacherId(null);
        setModal(null);
        setActive("schedule");
      },
    });
  };

  const submitOperation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isTeacherView) {
      notify("老师账号不能创建教务异常，请联系负责教务处理");
      return;
    }
    const data = new FormData(event.currentTarget);
    const studentId = String(data.get("studentId") ?? selectedStudent.id);
    const type = String(data.get("type") ?? "调课") as Operation["type"];
    const detail = String(data.get("detail") ?? "").trim();
    const teacherId = String(data.get("teacherId") ?? "");
    const eventStart = String(data.get("eventStart") ?? "");
    const eventEnd = String(data.get("eventEnd") ?? "");
    if (!detail) return;
    if (
      (type === "请假" ||
        type === "老师请假" ||
        type === "代课" ||
        type === "老师离职") &&
      !teacherById(teacherId)
    ) {
      notify("请从老师清单选择涉及老师后再记录请假、代课或离职");
      return;
    }

    const teacherAbsence = Boolean(
      teacherId &&
        (type === "请假" || type === "老师请假" || type === "老师离职"),
    );
    const substitution = Boolean(teacherId && type === "代课");
    const teacherImpact = teacherAbsence || substitution;
    if (teacherImpact && (!eventStart || !eventEnd || eventStart > eventEnd)) {
      notify("请填写有效的影响起止日期，再生成请假、代课或离职任务");
      return;
    }
    if (!teacherImpact && !studentById(studentId)) {
      notify("请从学生清单选择需要记录异常的学生");
      return;
    }

    const affectedOccurrences = teacherImpact
      ? bookings
          .filter(
            (booking) =>
              booking.teacherId === teacherId &&
              (!substitution || booking.studentId === studentId) &&
              (!operationDraft?.sourceBookingId ||
                booking.id === operationDraft.sourceBookingId),
          )
          .flatMap((booking) =>
            bookingOccurrencesWithinRange(booking, eventStart, eventEnd),
          )
      : [];
    if (teacherImpact && !affectedOccurrences.length) {
      notify("在所选日期范围内未找到受影响课程，未创建任务。");
      return;
    }

    const affectedStudentIds = Array.from(
      new Set(affectedOccurrences.map((booking) => booking.studentId)),
    );
    const targetStudentIds = teacherImpact ? affectedStudentIds : [studentId];
    const createdAt = `今天 ${nowLabel()}`;
    const generatedOperations = targetStudentIds.map((targetId) => {
      const relatedOccurrences = affectedOccurrences.filter(
        (booking) => booking.studentId === targetId,
      );
      const candidateLists = relatedOccurrences.map((booking) =>
        substitutionCandidates(booking, teacherId).map((teacher) => teacher.id),
      );
      const candidateIds = candidateLists.length
        ? candidateLists
            .slice(1)
            .reduce(
              (shared, candidates) =>
                shared.filter((teacherId) => candidates.includes(teacherId)),
              candidateLists[0],
            )
        : [];
      return {
        id: id("OPS"),
        studentId: targetId,
        type,
        detail,
        status: "待处理" as const,
        createdAt,
        teacherId: teacherImpact ? teacherId : undefined,
        eventStart: teacherImpact ? eventStart : undefined,
        eventEnd: teacherImpact ? eventEnd : undefined,
        affectedLessonCount: relatedOccurrences.length || undefined,
        recommendedTeacherIds: candidateIds,
        sourceBookingId: substitution
          ? operationDraft?.sourceBookingId
          : undefined,
      };
    });
    const generatedTasks: Task[] = targetStudentIds.flatMap(
      (targetId): Task[] => {
        const student = studentById(targetId);
        const relatedOccurrences = affectedOccurrences
          .filter((booking) => booking.studentId === targetId)
          .sort((left, right) => left.date.localeCompare(right.date));
        const affectedDates = relatedOccurrences.map((booking) => booking.date);
        const lastAffectedDate = affectedDates.at(-1) ?? eventEnd;
        const handoverBaseDate =
          affectedDates.length > 1 ? affectedDates.at(-2)! : lastAffectedDate;
        if (
          teacherImpact &&
          (type === "请假" || type === "老师请假" || type === "代课")
        )
          return [
            {
              id: id("TSK"),
              title: "选择可代课老师",
              owner: "Tiffany",
              studentId: targetId,
              ...taskTiming(
                isoDateInTimezone(new Date(), "Australia/Melbourne"),
                "Australia/Melbourne",
                "red",
              ),
              category: "排课",
              trigger: "老师请假：候选代课老师筛选",
            },
            {
              id: id("TSK"),
              title: "确认最终推荐老师并交龙老师确认",
              owner: "思佳",
              studentId: targetId,
              ...taskTiming(
                shiftIsoDate(eventStart, -14),
                "Australia/Melbourne",
                "amber",
              ),
              category: "排课",
              trigger: "老师请假：最终推荐确认",
            },
            {
              id: id("TSK"),
              title: "完成家长沟通并记录请假/代课原因",
              owner: student?.owner ?? "待分配",
              studentId: targetId,
              ...taskTiming(
                shiftIsoDate(eventStart, -7),
                "Australia/Melbourne",
                "red",
              ),
              category: "资料",
              trigger: "老师请假：教务必须写明原因",
            },
            {
              id: id("TSK"),
              title: "请原老师补充代课 LP 指定内容与资料",
              owner: student?.owner ?? "待分配",
              studentId: targetId,
              ...taskTiming(
                shiftIsoDate(lastAffectedDate, 1),
                "Australia/Melbourne",
                "blue",
              ),
              category: "LP",
              trigger: "老师请假：代课 LP 交接",
            },
          ];
        if (teacherAbsence && type === "老师离职")
          return [
            {
              id: id("TSK"),
              title: "筛选并确认推荐老师名单",
              owner: "Tiffany",
              studentId: targetId,
              ...taskTiming(
                shiftIsoDate(eventEnd, -14),
                "Australia/Melbourne",
                "red",
              ),
              category: "排课",
              trigger: "老师离职：推荐老师名单",
            },
            {
              id: id("TSK"),
              title: "开启新老师沟通",
              owner: student?.owner ?? "待分配",
              studentId: targetId,
              ...taskTiming(
                shiftIsoDate(eventEnd, -14),
                "Australia/Melbourne",
                "amber",
              ),
              category: "排课",
              trigger: "老师离职：新老师沟通",
            },
            {
              id: id("TSK"),
              title: "确认 Handover Notes 与原老师约定 DDL",
              owner: student?.owner ?? "待分配",
              studentId: targetId,
              ...taskTiming(
                shiftIsoDate(handoverBaseDate, 1),
                "Australia/Melbourne",
                "blue",
              ),
              category: "LP",
              trigger: "老师离职：交接资料",
            },
            {
              id: id("TSK"),
              title: "告知家长并记录最终安排",
              owner: student?.owner ?? "待分配",
              studentId: targetId,
              ...taskTiming(
                shiftIsoDate(handoverBaseDate, 1),
                "Australia/Melbourne",
                "red",
              ),
              category: "资料",
              trigger: "老师离职：家长沟通",
            },
            {
              id: id("TSK"),
              title: "向龙老师汇报离职交接进度",
              owner: "思佳",
              studentId: targetId,
              ...taskTiming(
                shiftIsoDate(eventEnd, -7),
                "Australia/Melbourne",
                "amber",
              ),
              category: "排课",
              trigger: "老师离职：管理确认",
            },
          ];
        return [
          {
            id: id("TSK"),
            title: `${type}：${detail}`,
            owner: student?.owner ?? "待分配",
            studentId: targetId,
            ...taskTiming(isoDateInTimezone(new Date(), "Australia/Melbourne"), "Australia/Melbourne", "amber"),
            category: "请假代课" as const,
            trigger: `${type} 记录后自动生成`,
          },
        ];
      },
    );
    const operationByStudent = new Map(generatedOperations.map((operation) => [operation.studentId, operation]));
    const operationTasks = generatedTasks.map((task, index) => {
      const operation = operationByStudent.get(task.studentId);
      return {
        ...task,
        category: "请假代课" as const,
        ruleKey: task.ruleKey ?? `operation.${type}.${index}`,
        anchorBookingId: task.anchorBookingId ?? operation?.id ?? `operation:${task.studentId}`,
      };
    });
    setOperations((current) => [...generatedOperations, ...current]);
    setTasks((current) => sortTasksByDueAt(upsertTasksByRule(current, operationTasks)));
    setSelectedOperationId(generatedOperations[0].id);
    setSelectedStudentId(generatedOperations[0].studentId);
    const teacher = teacherById(teacherId);
    addAudit(
      "记录教务异常",
      teacherImpact
        ? `${teacher?.name ?? "老师"} · ${type} · 影响 ${affectedOccurrences.length} 节课`
        : `${studentById(studentId)?.name} · ${type}`,
      "amber",
    );
    setOperationDraft(null);
    setModal(null);
    setActive("operations");
    notify(
      teacherImpact
        ? `已识别 ${affectedOccurrences.length} 节受影响课程，并生成 ${operationTasks.length} 项后续任务`
        : "异常已记录，并生成后续处理任务",
    );
  };

  const submitRenewalFollowUp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renewalDraft || renewalUploadBusy) return;

    const data = new FormData(event.currentTarget);
    const student = studentById(renewalDraft.studentId);
    if (!student) {
      notify("未找到关联学生，未保存本次跟进");
      return;
    }

    const result = String(data.get("result") ?? "已跟进") as RenewalStatus;
    const businessStatus = String(data.get("businessStatus") ?? "not_renewed_active") as RenewalBusinessStatus;
    const note = String(data.get("note") ?? "").trim();
    const renewalDateNote = String(data.get("renewalDateNote") ?? "").trim();
    const attemptedAtInput = String(data.get("attemptedAt") ?? currentLocalDateTimeValue());
    const attemptedAtParts = attemptedAtInput.match(/^(\d{4}-\d{2}-\d{2})T([0-2]\d:[0-5]\d)$/);
    if (!attemptedAtParts) {
      notify("请选择有效的本次操作时间");
      return;
    }
    const attemptedAt = zonedDateTimeToUtc(attemptedAtParts[1], attemptedAtParts[2], displayPreferences.timezone).toISOString();
    const attachment = data.get("attachment");
    let attachmentId: string | undefined;
    let attachmentTitle: string | undefined;

    setRenewalUploadBusy(true);
    try {
      if (attachment instanceof File && attachment.size > 0) {
        const upload = new FormData();
        upload.set("studentId", renewalDraft.studentId);
        upload.set("file", attachment);
        const response = await fetch("/api/fu-attachments", { method: "POST", body: upload });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.id || !body.url) throw new Error(body.error || "聊天截图上传失败");

        attachmentId = String(body.id);
        attachmentTitle = String(body.fileName || attachment.name);
        const fileRecord: FileRecord = {
          id: `FU-${attachmentId}`,
          studentId: renewalDraft.studentId,
          title: `续课 FU · ${formatFollowUpTime(attemptedAt, displayPreferences)} · ${attachmentTitle}`,
          type: "续课 FU",
          source: String(body.url),
          addedAt: `今天 ${nowLabel()}`,
        };
        setFiles((current) => current.some((item) => item.id === fileRecord.id) ? current : [fileRecord, ...current]);
        setStudents((current) => current.map((item) => item.id === renewalDraft.studentId ? { ...item, files: item.files + 1 } : item));
      }

      const contacted = result === "已跟进" || result === "等待家长";
      const updated: Renewal = {
        ...renewalDraft,
        status: result,
        businessStatus,
        lastAttemptAt: attemptedAt,
        lastContactedAt: contacted ? attemptedAt : renewalDraft.lastContactedAt,
        followUpNote: note,
        renewalDateNote,
        followUpAttachmentId: attachmentId,
        followUpAttachmentTitle: attachmentTitle,
      };
      setRenewals((current) => current.some((item) => item.id === updated.id)
        ? current.map((item) => item.id === updated.id ? updated : item)
        : [updated, ...current]);
      if (contacted) {
        const followUp: StudentFollowUp = { id: id("FUH"), followedUpAt: attemptedAt, note: note ? `续课：${result} · ${note}` : `续课：${result}`, recordedBy: operatorLabel(sessionOperator) };
        setStudents((current) => current.map((item) => item.id === updated.studentId ? {
          ...item,
          followUp: attemptedAt,
          followUpHistory: appendStudentFollowUp(item.followUpHistory ?? [], followUp),
        } : item));
      }
      addAudit(
        "记录续课跟进",
        `${student.name} · ${RENEWAL_STATUS_LABELS[businessStatus]} · ${result} · ${formatFollowUpTime(attemptedAt, displayPreferences)}${attachmentTitle ? ` · 已归档截图 ${attachmentTitle}` : ""}${note ? ` · ${note}` : ""}`,
        result === "本次未跟进" ? "amber" : businessStatus === "renewed" ? "green" : "blue",
      );
      setModal(null);
      setRenewalDraft(null);
      notify(attachmentTitle ? "跟进结果和聊天截图已保存到学生 FU 档案" : "跟进结果和时间已保存");
    } catch (error) {
      notify(error instanceof Error ? error.message : "续课跟进保存失败");
    } finally {
      setRenewalUploadBusy(false);
    }
  };

  const submitFile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isTeacherView) { notify("老师账号只能查看学生资料"); return; }
    const data = new FormData(event.currentTarget); const studentId = String(data.get("studentId") ?? selectedStudent.id); const title = String(data.get("title") ?? "").trim(); if (!title) return;
    const file: FileRecord = { id: id("FIL"), studentId, title, type: String(data.get("type") ?? "其他") as FileRecord["type"], source: String(data.get("source") ?? "人工登记") || "人工登记", addedAt: `今天 ${nowLabel()}` };
    setFiles((current) => [file, ...current]); setStudents((current) => current.map((student) => student.id === studentId ? { ...student, files: student.files + 1 } : student)); addAudit("登记资料链接", `${title} · ${studentById(studentId)?.name}`, "blue"); setModal(null); notify("已在文件索引中登记资料");
  };

  const submitTemplate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const studentId = String(data.get("studentId") ?? selectedStudent.id); const kind = String(data.get("kind") ?? "内部提醒"); const body = String(data.get("body") ?? "").trim(); if (!body) return;
    const message: Message = { id: id("MSG"), studentId, kind, recipient: String(data.get("recipient") ?? "内部负责人"), body, status: "待人工确认", createdAt: `今天 ${nowLabel()}` };
    setMessages((current) => [message, ...current]); setSelectedMessageId(message.id); addAudit("创建消息待确认", `${kind} · ${studentById(studentId)?.name}`, "blue"); setModal(null); setActive("messages"); notify("消息已加入队列，等待人工确认");
  };

  return (
    <main ref={interfaceRootRef} className="app-shell" data-interface-language={displayPreferences.language} data-text-size={displayPreferences.textSize} data-list-density={displayPreferences.density} data-motion-preference={displayPreferences.motion}>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">吟</span><div><strong>吟领教务</strong><small>Learning Operations</small></div></div>
        <div className="workspace-switch"><span className="workspace-dot" /> {isAdminView ? `${operatorLabel(currentOperator)} ${displayPreferences.language === "en-AU" ? "admin view" : "管理视图"}` : isTeacherView ? `${currentOperator} ${displayPreferences.language === "en-AU" ? "teaching workspace" : "老师工作台"}` : `${currentOperator} ${displayPreferences.language === "en-AU" ? "workspace" : "工作视图"}`} <ChevronDown size={15} /></div>
        <button className="new-button" type="button" onClick={() => setModal(isTeacherView ? "booking" : "task")}><Plus size={17} /> {isTeacherView ? (displayPreferences.language === "en-AU" ? "New booking" : "新建约课") : (displayPreferences.language === "en-AU" ? "New" : "新建")}</button>
        <nav aria-label="主要导航">
          <p>{displayTerm("学生与教务", displayPreferences.language)}</p>
          {visibleNavigation.filter((item) => item.group === "work").map((item) => {
            const Icon = item.icon;
            return <button className={active === item.id ? "nav-item active" : "nav-item"} type="button" key={item.id} onClick={() => setActive(item.id)}><Icon size={18} /><span>{item.label}</span>{item.id === "dashboard" && <b>{scopedTasks.filter((task) => task.status !== "done").length}</b>}</button>;
          })}
          <p>{displayTerm("运营与系统", displayPreferences.language)}</p>
          {visibleNavigation.filter((item) => item.group === "support").map((item) => {
            const Icon = item.icon;
            return <button className={active === item.id ? "nav-item active" : "nav-item"} type="button" key={item.id} onClick={() => setActive(item.id)}><Icon size={18} /><span>{item.label}</span></button>;
          })}
        </nav>
        <div className="sidebar-foot"><StatusPill tone={sharedSyncState === "synced" ? "green" : sharedSyncState === "saving" ? "blue" : "amber"}>{sharedSyncState === "synced" ? (displayPreferences.language === "en-AU" ? "Shared online" : "多人共享在线") : sharedSyncState === "saving" ? interfaceText.syncing : (displayPreferences.language === "en-AU" ? "Sync needs review" : "同步需检查")}</StatusPill><span>{dataSnapshot.label}</span></div>
      </aside>
      <section className="main-stage">
        <header className="topbar">
          <div className="breadcrumb"><span>吟领教育</span><ChevronRight size={15} /><strong>{navigation.find((item) => item.id === active)?.label}</strong></div>
          <div className="top-actions">
            <button className="top-search" type="button" onClick={() => setGlobalSearchOpen(true)}><Search size={16} /> {interfaceText.search} <kbd>Cmd K</kbd></button>
            <IconButton label={displayPreferences.language === "en-AU" ? "View reminders" : "查看提醒"} onClick={() => setActive("dashboard")}><ListTodo size={18} /></IconButton>
            <span className={`live-sync ${sharedSyncState}`} title={sharedSyncMessage}><i />{sharedSyncState === "synced" ? interfaceText.synced : sharedSyncState === "saving" ? interfaceText.syncing : sharedSyncState === "conflict" ? interfaceText.conflict : interfaceText.offline}</span>
            <div className="operator-menu-wrap" ref={operatorMenuRef}>
              <button className="operator" type="button" aria-haspopup="menu" aria-expanded={operatorMenuOpen} onClick={() => setOperatorMenuOpen((open) => !open)}>
                <Avatar initials={isAdminView ? "AD" : currentOperator.slice(0, 2).toUpperCase()} tone={operatorProfile(currentOperator).tone} />
                <span className="operator-copy"><small>{operatorProfile(currentOperator).role}</small><strong>{operatorLabel(currentOperator)}</strong></span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {operatorMenuOpen ? <section className="operator-menu" role="menu" aria-label={interfaceText.switchView}>
                <header><span>{interfaceText.switchView}</span><small>{interfaceText.switchDetail}</small></header>
                <div className="operator-menu-list">
                  {operatorOptions.map((operator) => {
                    const profile = operatorProfile(operator);
                    const selected = operator === currentOperator;
                    return <button className={selected ? "operator-menu-item selected" : "operator-menu-item"} type="button" role="menuitemradio" aria-checked={selected} key={operator} onClick={() => { requestOperatorSwitch(operator); setOperatorMenuOpen(false); }}>
                      <Avatar initials={operator === "Nixon" || operator === DEMO_LIMITED_ADMIN_USER ? "AD" : operator.slice(0, 2).toUpperCase()} tone={profile.tone} />
                      <span className="operator-menu-copy"><strong>{operatorLabel(operator)}</strong><small>{profile.role}</small></span>
                      <span className="operator-menu-scope">{profile.scope}</span>
                      {selected ? <Check size={15} aria-hidden="true" /> : null}
                    </button>;
                  })}
                </div>
                <footer className="operator-menu-footer">
                  <button className="operator-preferences" type="button" onClick={() => { setDisplayPreferencesOpen(true); setOperatorMenuOpen(false); }}><Settings size={15} aria-hidden="true" />{interfaceText.profilePreferences}</button>
                  <button className="operator-logout" type="button" disabled={logoutBusy} onClick={() => void logout()}><LogOut size={15} aria-hidden="true" />{logoutBusy ? (displayPreferences.language === "en-AU" ? "Signing out" : "正在退出") : interfaceText.logOut}</button>
                </footer>
              </section> : null}
            </div>
          </div>
        </header>
        <div className="content">{renderView()}</div>
      </section>
      <nav className="mobile-bottom-nav" aria-label="手机主导航">
        {visibleMobileNavigation.map((item) => {
          const Icon = item.icon;
          return <button className={active === item.id ? "active" : ""} type="button" key={item.id} onClick={() => navigateMobile(item.id)}><Icon size={21} /><span>{item.id === "students" ? (displayPreferences.language === "en-AU" ? "Students" : "学生") : item.id === "messages" ? (displayPreferences.language === "en-AU" ? "Messages" : "消息") : item.label}</span></button>;
        })}
        <button className={mobileMenuOpen || !visibleMobileNavigation.some((item) => item.id === active) ? "active" : ""} type="button" onClick={() => setMobileMenuOpen(true)}><MoreHorizontal size={22} /><span>{displayPreferences.language === "en-AU" ? "More" : "更多"}</span></button>
      </nav>

      {mobileMenuOpen && <div className="mobile-nav-backdrop" role="presentation" onMouseDown={() => setMobileMenuOpen(false)}>
        <section className="mobile-nav-drawer" role="dialog" aria-modal="true" aria-label={displayPreferences.language === "en-AU" ? "All functions" : "全部功能"} onMouseDown={(event) => event.stopPropagation()}>
          <header><div><p className="eyebrow">{displayPreferences.language === "en-AU" ? "ALL FUNCTIONS" : "全部功能"}</p><h2>{displayPreferences.language === "en-AU" ? "Where to work" : "去哪里处理工作"}</h2></div><IconButton label={displayPreferences.language === "en-AU" ? "Close menu" : "关闭功能菜单"} onClick={() => setMobileMenuOpen(false)}><X size={19} /></IconButton></header>
          <label className="mobile-operator-picker"><span>{interfaceText.currentView}</span><select value={currentOperator} onChange={(event) => requestOperatorSwitch(event.target.value)} aria-label={displayPreferences.language === "en-AU" ? "Switch current operator" : "切换当前操作人"}>{operatorOptions.map((operator) => <option value={operator} key={operator}>{operatorLabel(operator)} · {operatorProfile(operator).role}</option>)}</select></label>
          <div className="mobile-nav-grid">
            {visibleNavigation.map((item) => {
              const Icon = item.icon;
              return <button className={active === item.id ? "active" : ""} type="button" key={item.id} onClick={() => navigateMobile(item.id)}><Icon size={20} /><span><strong>{item.label}</strong><small>{displayTerm(item.group === "work" ? "学生与教务" : "运营与系统", displayPreferences.language)}</small></span><ChevronRight size={16} /></button>;
            })}
          </div>
          <button className="mobile-preferences-button" type="button" onClick={() => { setDisplayPreferencesOpen(true); setMobileMenuOpen(false); }}><Settings size={18} aria-hidden="true" />{interfaceText.profilePreferences}</button>
          <button className="mobile-logout-button" type="button" disabled={logoutBusy} onClick={() => void logout()}><LogOut size={18} aria-hidden="true" />{logoutBusy ? (displayPreferences.language === "en-AU" ? "Signing out" : "正在退出") : interfaceText.logOut}</button>
        </section>
      </div>}

      {displayPreferencesOpen && <div className="dialog-backdrop display-preferences-backdrop" role="presentation" onMouseDown={() => setDisplayPreferencesOpen(false)}>
        <section className="dialog display-preferences-dialog" role="dialog" aria-modal="true" aria-labelledby="display-preferences-title" onMouseDown={(event) => event.stopPropagation()}>
          <header className="dialog-header"><div><p className="eyebrow">{displayPreferences.language === "en-AU" ? "PERSONAL DISPLAY" : "个人显示设置"}</p><h2 id="display-preferences-title">{interfaceText.profilePreferences}</h2></div><IconButton label={interfaceText.close} onClick={() => setDisplayPreferencesOpen(false)}><X size={18} /></IconButton></header>
          <p className="display-preferences-intro">{interfaceText.profilePreferencesDetail}</p>
          <div className="display-preferences-grid">
            <label>{interfaceText.language}<select value={displayPreferences.language} onChange={(event) => updateDisplayPreferences({ language: event.target.value as DisplayPreferences["language"] })}><option value="zh-CN">{interfaceText.chinese}</option><option value="en-AU">{interfaceText.english}</option></select></label>
            <label>{interfaceText.timezone}<select value={displayPreferences.timezone} onChange={(event) => updateDisplayPreferences({ timezone: cleanTimezone(event.target.value) })}>{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{displayPreferences.language === "en-AU" ? option.en : option.zh}</option>)}</select></label>
            <label>{interfaceText.textSize}<select value={displayPreferences.textSize} onChange={(event) => updateDisplayPreferences({ textSize: event.target.value as DisplayPreferences["textSize"] })}><option value="default">{interfaceText.normal}</option><option value="large">{interfaceText.large}</option><option value="extra-large">{interfaceText.extraLarge}</option></select></label>
            <label>{interfaceText.timeFormat}<select value={displayPreferences.timeFormat} onChange={(event) => updateDisplayPreferences({ timeFormat: event.target.value as DisplayPreferences["timeFormat"] })}><option value="24h">24-hour (14:30)</option><option value="12h">12-hour (2:30 pm)</option></select></label>
            <label>{interfaceText.dateFormat}<select value={displayPreferences.dateFormat} onChange={(event) => updateDisplayPreferences({ dateFormat: event.target.value as DisplayPreferences["dateFormat"] })}><option value="dmy">DD/MM/YYYY</option><option value="ymd">YYYY/MM/DD</option></select></label>
            <label>{interfaceText.density}<select value={displayPreferences.density} onChange={(event) => updateDisplayPreferences({ density: event.target.value as DisplayPreferences["density"] })}><option value="comfortable">{interfaceText.comfortable}</option><option value="compact">{interfaceText.compact}</option></select></label>
            <label className="span-2">{interfaceText.motion}<select value={displayPreferences.motion} onChange={(event) => updateDisplayPreferences({ motion: event.target.value as DisplayPreferences["motion"] })}><option value="standard">{interfaceText.standardMotion}</option><option value="reduced">{interfaceText.reducedMotion}</option></select></label>
          </div>
          <footer className="display-preferences-actions"><button className="secondary-button" type="button" onClick={() => updateDisplayPreferences(defaultDisplayPreferences(isDemoTeacher(sessionOperator)))}>{interfaceText.reset}</button><button className="primary-button" type="button" onClick={() => setDisplayPreferencesOpen(false)}>{interfaceText.close}</button></footer>
        </section>
      </div>}
      {toast && <div className="toast" role="status" aria-live="polite"><CheckCircle2 size={17} /><span>{toast.message}</span>{toast.onAction && <button className="toast-action" type="button" onClick={() => { const action = toast.onAction; setToast(null); action?.(); }}>{toast.actionLabel ?? "撤销"}</button>}</div>}

      {confirmRequest && <div className="dialog-backdrop confirm-backdrop" role="presentation" onMouseDown={() => { if (!confirmBusy) setConfirmRequest(null); }}>
        <section className="dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-detail" onMouseDown={(event) => event.stopPropagation()}>
          <header className="dialog-header"><div><p className="eyebrow">确认后写入共享资料</p><h2 id="confirm-title">{confirmRequest.title}</h2></div><IconButton label="取消操作" onClick={() => { if (!confirmBusy) setConfirmRequest(null); }}><X size={18} /></IconButton></header>
          <form onSubmit={(event) => { event.preventDefault(); void confirmRequestedAction(); }}>
            <div className="confirm-body"><p id="confirm-detail">{confirmRequest.detail}</p>{confirmRequest.items?.length ? <ul className="confirm-impact-list">{confirmRequest.items.map((item) => <li key={item}>{item}</li>)}</ul> : null}</div>
            <footer className="confirm-actions"><button className="secondary-button" type="button" disabled={confirmBusy} onClick={() => setConfirmRequest(null)}>取消</button><button className={confirmRequest.tone === "danger" ? "danger-button" : "primary-button"} type="submit" disabled={confirmBusy}>{confirmBusy ? "正在处理…" : confirmRequest.confirmLabel}</button></footer>
          </form>
        </section>
      </div>}

      {globalSearchOpen && <div className="global-search-backdrop" role="presentation" onMouseDown={() => setGlobalSearchOpen(false)}>
        <section className="global-search-dialog" role="dialog" aria-modal="true" aria-label="全局搜索" onMouseDown={(event) => event.stopPropagation()}>
          <header>
            <div><p className="eyebrow">全局搜索</p><h2>快速进入正在处理的记录</h2></div>
            <IconButton label="关闭搜索" onClick={() => setGlobalSearchOpen(false)}><X size={18} /></IconButton>
          </header>
          <label className="global-search-input"><Search size={19} /><input autoFocus value={globalQuery} onChange={(event) => setGlobalQuery(event.target.value)} placeholder="输入学生姓名、老师姓名、课程或编号" /><kbd>Esc</kbd></label>
          {globalQuery.trim() ? <div className="global-result-list">
            {globalResults.length ? globalResults.map((result) => <button type="button" key={`${result.type}-${result.id}`} className="global-result" onClick={result.action}>
              <span className={`global-result-badge ${result.type === "学生" ? "green" : "blue"}`}>{result.type}</span>
              <span><strong>{result.title}</strong><small>{result.detail}</small></span>
              <ChevronRight size={17} />
            </button>) : <EmptyState title="没有找到匹配记录" detail="可以尝试姓名、课程、学生编号或老师编号。" />}
          </div> : <div className="global-quick-links">
            <p>常用入口</p>
            <div>
              <button type="button" onClick={() => { setActive("students"); setGlobalSearchOpen(false); }}>学生档案</button>
              <button type="button" onClick={() => { setActive("schedule"); setGlobalSearchOpen(false); }}>排课中心</button>
              <button type="button" onClick={() => { setActive(isTeacherView ? "classroom" : "operations"); setGlobalSearchOpen(false); }}>{isTeacherView ? "网上教室" : "运营队列"}</button>
            </div>
          </div>}
        </section>
      </div>}

      {modal === "student" && <Dialog title="新建学生档案" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitStudent}>
          <label>学生姓名<input name="name" autoFocus placeholder="例如 Olivia Chen" required /></label>
          <label>课程 / 年级<input name="course" placeholder="例如 Year 10 English" required /></label>
          <label>学员类型<select name="segment"><option>试听</option><option>已报名</option></select></label>
          <label>当前年级<input name="grade" placeholder="例如 Year 8" /></label>
          <label>负责人<select name="owner">{teamOwnerOptions.map((owner) => <option key={owner}>{owner}</option>)}</select></label>
          <label>规划老师<select name="planner"><option>待分配</option><option value="Tara">龙老师</option><option>Eileen</option></select></label>
          <label>所在地<select name="location"><option value="VIC">VIC</option><option value="NSW">NSW</option><option value="SA">SA</option><option value="QLD">QLD</option><option value="WA">WA</option><option value="CHN">中国</option></select></label>
          <label>学生时区<select name="timezone">{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
          <label>LP 类型<select name="lpNeed"><option>试听LP</option><option>新生LP</option><option>老生新LP</option><option>代课LP</option><option>LP修改</option><option>无需LP</option></select></label>
          <label>剩余课时<input name="remainingHours" type="number" min="0" step="0.5" placeholder="未导入可留空" /></label>
          <label>家长 / 沟通对象<input name="guardian" placeholder="例如 Chen 先生" /></label>
          <label>家长微信名<input name="guardianWechat" placeholder="例如 Daisy" /></label>
          <label className="span-2">注意事项<textarea name="notes" rows={3} placeholder="特殊安排、Report 或跟进时需要注意的内容" /></label>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><UserPlus size={16} /> 创建档案</button></footer>
        </form>
      </Dialog>}

      {modal === "studentEdit" && <Dialog title="编辑学生档案" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitStudentEdit}>
          <label>学生姓名<input name="name" autoFocus defaultValue={selectedStudent.name} required /></label>
          <label>课程 / 年级<input name="course" defaultValue={selectedStudent.course} required /></label>
          <label>当前年级<input name="grade" defaultValue={selectedStudent.grade ?? ""} /></label>
          <label>负责人<select name="owner" defaultValue={selectedStudent.owner} disabled={!isAdminView}>{teamOwnerOptions.map((owner) => <option key={owner}>{owner}</option>)}</select>{!isAdminView && <small>负责人调整需由管理员处理</small>}</label>
          <label>规划老师<select name="planner" defaultValue={selectedStudent.planner ?? "待分配"}><option>待分配</option><option value="Tara">龙老师</option><option>Eileen</option></select></label>
          <label>所在地<select name="location" defaultValue={selectedStudent.location ?? "VIC"}><option value="VIC">VIC</option><option value="NSW">NSW</option><option value="SA">SA</option><option value="QLD">QLD</option><option value="WA">WA</option><option value="CHN">中国</option></select></label>
          <label>学生时区<select name="timezone" defaultValue={cleanTimezone(selectedStudent.timezone)}>{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
          <label>家长 / 沟通对象<input name="guardian" defaultValue={selectedStudent.guardian === "待补充" ? "" : selectedStudent.guardian} /></label>
          <label>家长微信名<input name="guardianWechat" defaultValue={selectedStudent.guardianWechat ?? ""} /></label>
          <label className="span-2">注意事项<textarea name="notes" rows={3} defaultValue={selectedStudent.notes ?? ""} /></label>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><Check size={16} /> 保存修改</button></footer>
        </form>
      </Dialog>}

      {modal === "studentEvidence" && <Dialog title="上传沟通或家长反馈" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitStudentEvidence}>
          <label>关联学生<input value={`${selectedStudent.name} · ${selectedStudent.id}`} disabled /></label>
          <label>记录名称<input name="title" defaultValue="家长沟通记录" required /></label>
          <label className="span-2 upload-field">图片文件<input name="attachment" type="file" accept="image/png,image/jpeg,image/webp" required /><small>支持 PNG、JPG、WebP，最多 4MB。文件使用现有私有存储和学生权限范围。</small></label>
          <footer><button className="secondary-button" type="button" disabled={evidenceUploadBusy} onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit" disabled={evidenceUploadBusy}><FilePlus2 size={16} /> {evidenceUploadBusy ? "正在上传..." : "上传并归档"}</button></footer>
        </form>
      </Dialog>}

      {modal === "studentRecords" && <Dialog title={`${selectedStudent.name} · 学生资料`} onClose={() => setModal(null)} wide>
        <StudentRecordsPanel student={selectedStudent} files={scopedFiles} initialSection={studentRecordKind} canAdd={!isTeacherView} callbacks={{
          onAdd: (section) => addStudentRecord(section),
          onOpenFile: (file) => { if (/^https?:\/\//.test(file.source) || file.source.startsWith("/api/")) window.open(file.source, "_blank", "noopener,noreferrer"); },
        }} />
      </Dialog>}

      {modal === "studentFollowUp" && <Dialog title="记录最近跟进" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitStudentFollowUp}><FollowUpForm initialFollowedUpAt={new Date().toISOString()} /><footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><Check size={16} /> 保存跟进</button></footer></form>
      </Dialog>}

      {modal === "lessonPackage" && <Dialog title="录入课包与课时" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitLessonPackage}><LessonPackageForm existingPackages={(selectedStudent.lessonPackages ?? []).map((lessonPackage) => ({ value: lessonPackage.id, label: lessonPackage.name }))} subjectOptions={Array.from(new Set([...courses.map((course) => course.name), selectedStudent.course])).map((value) => ({ value }))} initialSubjectIds={[selectedStudent.course]} /><footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><Check size={16} /> 保存课包</button></footer></form>
      </Dialog>}

      {modal === "exam" && <Dialog title="记录学生考试" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitExam}><ExamForm subjectOptions={Array.from(new Set([...courses.map((course) => course.name), selectedStudent.course])).map((value) => ({ value }))} initialSubject={selectedStudent.course} initialMonth={new Date().toISOString().slice(0, 7)} /><footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><CalendarPlus size={16} /> 保存考试</button></footer></form>
      </Dialog>}

      {modal === "task" && <Dialog title="添加内部任务" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitTask}>
          <label className="span-2">任务内容<input name="title" autoFocus placeholder="例如确认家长是否收到上课链接" required /></label>
          <label>关联学生<input name="studentId" list="task-student-options" defaultValue={selectedStudent.id} placeholder="输入姓名或学生 ID 搜索" /><datalist id="task-student-options">{recordStudents.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.course}</option>)}</datalist></label>
          <label>负责人<select name="owner">{teamOwnerOptions.map((owner) => <option key={owner}>{owner}</option>)}</select></label>
          <label>截止时间（墨尔本）<input name="dueAt" type="datetime-local" defaultValue={currentDateTimeValueInTimezone("Australia/Melbourne")} required /></label>
          <label>任务分类<select name="category"><option>资料</option><option>试听</option><option>LP</option><option>排课</option><option>课后</option><option>续课</option><option>考试</option><option>请假代课</option><option>薪资</option></select></label>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><Plus size={16} /> 加入队列</button></footer>
        </form>
      </Dialog>}

      {modal === "payrollNew" && <Dialog title="新增老师薪资记录" onClose={() => setModal(null)} wide>
        <form className="form-grid" onSubmit={submitNewPayroll}>
          <label>现有老师<select name="teacherId" defaultValue=""><option value="">请选择现有老师</option>{[...teachers].sort((a, b) => a.name.localeCompare(b.name)).map((teacher) => <option value={teacher.id} key={teacher.id}>{teacher.name} · {teacher.id}</option>)}</select></label>
          <label>新老师姓名（仅新增老师时填写）<input name="newTeacherName" placeholder="例如 Olivia Chen" /></label>
          <label>薪资月份<input name="month" type="month" defaultValue={activePayrollMonth} required /></label>
          <label>教师类别<input name="section" defaultValue="教师薪资" placeholder="例如 国内教师" /></label>
          <label>币种<select name="currency" defaultValue="AUD"><option value="AUD">澳币</option><option value="CNY">人民币</option></select></label>
          <label>初始课时费<input name="rate" type="number" min="0" step="0.01" defaultValue="0" /></label>
          <label>银行名称<input name="bankName" placeholder="可稍后补充" /></label>
          <label>银行账户<input name="bankAccount" placeholder="可稍后补充" /></label>
          <label className="span-2">付款说明<textarea name="paymentNote" rows={3} placeholder="费率规则、线下课程或其他说明" /></label>
          <div className="form-notice span-2"><CircleAlert size={16} /> 选择现有老师，或填写新老师姓名。新老师会同时加入老师资源表，教学科目和 AVA 可随后补充；新增薪资记录会先标记为“需核对”。</div>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><UserPlus size={16} /> 添加薪资记录</button></footer>
        </form>
      </Dialog>}

      {modal === "payrollEdit" && payrollDraft && <Dialog title="编辑老师与费率" onClose={() => { setPayrollDraft(null); setModal(null); }} wide>
        <form className="form-grid" onSubmit={submitPayrollEdit}>
          <label>薪资显示姓名<input name="teacherName" autoFocus defaultValue={teacherById(payrollDraft.teacherId)?.name ?? payrollDraft.teacherName ?? payrollDraft.teacherId} required /></label>
          <label>薪资月份<input name="month" type="month" defaultValue={payrollDraft.month ?? activePayrollMonth} required /></label>
          <label>教师类别<input name="section" defaultValue={payrollDraft.section ?? "教师薪资"} /></label>
          <label>币种<select name="currency" defaultValue={payrollDraft.currency ?? "AUD"}><option value="AUD">澳币</option><option value="CNY">人民币</option></select></label>
          <label>默认课时费<input name="defaultRate" type="number" min="0" step="0.01" defaultValue={payrollDraft.rateRange?.[0] ?? payrollDraft.lines?.[0]?.rate ?? 0} required /></label>
          <label>银行名称<input name="bankName" defaultValue={payrollDraft.bankName ?? ""} /></label>
          <label>银行账户<input name="bankAccount" defaultValue={payrollDraft.bankAccount ?? ""} /></label>
          <label className="span-2">付款说明<textarea name="paymentNote" rows={3} defaultValue={payrollDraft.paymentNote ?? payrollDraft.note} /></label>
          {(payrollDraft.lines?.length ?? 0) > 0 && <div className="span-2 payroll-rate-editor"><header><strong>学生费率</strong><small>修改后系统会重新计算每位学生小计和老师总额。</small></header>{payrollDraft.lines?.map((line, index) => <label className="payroll-rate-row" key={`${line.studentName}-${line.sourceRow ?? index}`}><span><strong>{line.studentName}</strong><small>{formatHours(line.hours)}</small></span><span>{line.isTrial ? "试听" : "常规课"}</span><input name={`lineRate-${index}`} type="number" min="0" step="0.01" defaultValue={line.rate} aria-label={`${line.studentName} 课时费`} /></label>)}</div>}
          {payrollDraft.status === "已锁定" && <div className="form-notice span-2"><CircleAlert size={16} /> 当前记录已锁定；修改后将清除锁定并重新核对。</div>}
          <footer><button className="secondary-button" type="button" onClick={() => { setPayrollDraft(null); setModal(null); }}>取消</button><button className="primary-button" type="submit"><Check size={16} /> 保存薪资修改</button></footer>
        </form>
      </Dialog>}

      {modal === "lp" && <Dialog title="创建 LP 工作流" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitLp}>
          <label>关联学生<input name="studentId" list="lp-student-options" defaultValue={selectedStudent.id} placeholder="输入姓名或学生 ID 搜索" /><datalist id="lp-student-options">{recordStudents.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.course}</option>)}</datalist></label>
          <label>规划老师<select name="planner" defaultValue={selectedStudent.planner ?? "Tara"}><option value="Tara">龙老师</option><option>Eileen</option></select></label>
          {isAdminView && <><label className="checkbox-field span-2"><input name="provisional" type="checkbox" /> 暂未有学生姓名，先按科目创建临时档案</label>
          <label>临时姓名（可留空）<input name="provisionalName" placeholder="之后可在学生档案补充" /></label>
          <label>科目 / 课程<input name="provisionalCourse" placeholder="临时建档时必填，例如 Year 9 English" /></label></>}
          <LpWorkflowFields
            initialType={lpDraftType}
            initialValues={{ responsibleOperations: selectedStudent.owner, assignedTeacher: selectedStudent.teacher === "待匹配" ? "" : selectedStudent.teacher, subject: selectedStudent.course, locationTimezone: selectedStudent.timezone }}
            responsibleOperationsOptions={teamOwnerOptions.map((value) => ({ value }))}
            teacherOptions={recordTeachers.map((teacher) => ({ value: teacher.name, label: `${teacher.name} · ${teacher.id}` }))}
            subjectOptions={Array.from(new Set([...courses.map((course) => course.name), selectedStudent.course])).map((value) => ({ value }))}
            timezoneOptions={timezoneOptions.map((option) => ({ value: option.id, label: option.label }))}
            onTypeChange={setLpDraftType}
          />
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><BookOpen size={16} /> 创建 LP</button></footer>
        </form>
      </Dialog>}

      {modal === "lpRevision" && lpRevisionDraft && <Dialog title="新增 LP 修订版本" onClose={() => { setLpRevisionDraft(null); setModal(null); }}>
        <form className="form-grid" onSubmit={submitLpRevision}>
          <label className="span-2">腾讯文档链接<input name="documentUrl" type="url" autoFocus defaultValue={typeof lpRevisionDraft.fields?.documentUrl === "string" ? lpRevisionDraft.fields.documentUrl : ""} required /></label>
          <label className="span-2">修订说明<textarea name="revisionNote" rows={3} required /></label>
          <div className="span-2"><LpRevisionHistory revisions={lpRevisionDraft.revisions ?? []} stageAudit={lpRevisionDraft.stageAudit ?? []} /></div>
          <footer><button className="secondary-button" type="button" onClick={() => { setLpRevisionDraft(null); setModal(null); }}>取消</button><button className="primary-button" type="submit"><Check size={16} /> 保存新版本</button></footer>
        </form>
      </Dialog>}

      {modal === "ava" && <Dialog title={avaDraft ? "修改老师 AVA" : "结构化录入老师 AVA"} onClose={() => { setAvaDraft(null); setModal(null); }}>
        <form className="form-grid" onSubmit={submitAva}>
          <label className="span-2">老师<input name="teacherId" list="ava-teacher-options" defaultValue={avaDraft?.teacherId ?? selectedTeacher.id} readOnly={Boolean(avaDraft)} placeholder="输入老师姓名或 ID 搜索" /><datalist id="ava-teacher-options">{recordTeachers.map((teacher) => <option value={teacher.id} key={teacher.id}>{teacher.name} · {teacher.availabilityTimezone ?? teacher.timezone}</option>)}</datalist></label>
          <label>星期<select name="day" defaultValue={String(avaDraft?.slot.day ?? 1)}><option value="1">周一</option><option value="2">周二</option><option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option><option value="0">周日</option></select></label>
          <label>原始 AVA 时区<select name="timezone" defaultValue={cleanTimezone(selectedTeacher.availabilityTimezone ?? selectedTeacher.timezone)} disabled>{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
          <label>开始时间<input name="start" type="time" defaultValue={avaDraft?.slot.start ?? "16:00"} required /></label>
          <label>结束时间<input name="end" type="time" defaultValue={avaDraft?.slot.end ?? "18:00"} required /></label>
          <div className="form-notice span-2"><CircleAlert size={16} /> 只录入已由老师确认的固定可约时段。保存后会显示在 AVA 日历，并成为排课与代课筛选的依据。</div>
          <footer><button className="secondary-button" type="button" onClick={() => { setAvaDraft(null); setModal(null); }}>取消</button><button className="primary-button" type="submit"><Clock3 size={16} /> {avaDraft ? "保存修改" : "保存可约时段"}</button></footer>
        </form>
      </Dialog>}

      {modal === "teacherCapacity" && teacherCapacityDraft && <Dialog title="可接新生数量" onClose={() => { setTeacherCapacityDraft(null); setModal(null); }}>
        <form className="form-grid" onSubmit={submitTeacherCapacity}>
          <label>老师<input value={teacherCapacityDraft.name} disabled /></label>
          <label>剩余可接人数<input name="newStudentCapacity" type="number" min="0" step="1" defaultValue={teacherCapacityDraft.newStudentCapacity ?? 0} required /></label>
          <footer><button className="secondary-button" type="button" onClick={() => { setTeacherCapacityDraft(null); setModal(null); }}>取消</button><button className="primary-button" type="submit"><Check size={16} /> 保存</button></footer>
        </form>
      </Dialog>}

      {modal === "booking" && <Dialog title={bookingDraft ? "编辑排课" : "新建排课"} onClose={() => { setBookingDraft(null); setBookingPrefillStudentId(null); setBookingPrefillTeacherId(null); setModal(null); }}>
        <form className="form-grid" onSubmit={submitBooking}>
          <label>学生<input name="studentId" list="booking-student-options" defaultValue={bookingDraft?.studentId ?? bookingPrefillStudentId ?? ""} disabled={Boolean(bookingDraft && !isAdminView)} placeholder="必须从清单选择学生" required />{bookingDraft && !isAdminView ? <input name="studentId" type="hidden" value={bookingDraft.studentId} /> : null}<datalist id="booking-student-options">{(isTeacherView ? scopedStudents : recordStudents).map((student) => <option value={student.id} key={student.id}>{student.name} · {student.course}</option>)}</datalist></label>
          {isTeacherView ? <label>老师<input value={currentTeacher?.name ?? currentOperator} disabled /><input name="teacherId" type="hidden" value={currentTeacher?.id ?? ""} /></label> : <label>老师<input name="teacherId" list="booking-teacher-options" defaultValue={bookingDraft?.teacherId ?? bookingPrefillTeacherId ?? ""} disabled={Boolean(bookingDraft && !isAdminView)} placeholder="必须从清单选择老师" required />{bookingDraft && !isAdminView ? <input name="teacherId" type="hidden" value={bookingDraft.teacherId} /> : null}<datalist id="booking-teacher-options">{recordTeachers.map((teacher) => <option value={teacher.id} key={teacher.id}>{teacher.name} · {teacher.subjects.join("/")} · {teacher.availabilityStatus ?? "待确认"}</option>)}</datalist></label>}
          <label>日期<input name="date" type="date" min={bookingDraft ? undefined : isoDateInTimezone(new Date(), scheduleTimezone)} defaultValue={bookingDraft?.date ?? isoDateInTimezone(new Date(), scheduleTimezone)} required /></label>
          <label>开始时间<input name="start" type="time" defaultValue={bookingDraft?.start ?? "16:00"} required /></label>
          <label>录入时区<select name="timezone" defaultValue={bookingDraft?.timezone ?? scheduleTimezone}>{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
          <label>课程类型<select name="kind" defaultValue={bookingDraft?.kind ?? "常规课"}><option>常规课</option><option>试听</option><option>代课</option></select></label>
          <label>课包<select name="packageId" defaultValue={bookingDraft?.packageId ?? ""}><option value="">试听或暂无课包</option>{(studentById(bookingDraft?.studentId ?? bookingPrefillStudentId ?? selectedStudent.id)?.lessonPackages ?? []).map((lessonPackage) => <option value={lessonPackage.id} key={lessonPackage.id}>{lessonPackage.name} · 剩余 {getLessonPackageBalance(lessonPackage).remainingHours} 小时</option>)}</select></label>
          <label>课程时长<select name="duration" defaultValue={String(bookingDraft?.duration ?? 60)}><option value="60">60 分钟</option><option value="90">90 分钟</option><option value="120">120 分钟</option></select></label>
          <label className="checkbox-field"><input name="recurring" type="checkbox" defaultChecked={bookingDraft?.recurring ?? false} /> 每周固定课程</label>
          <label>本轮排课节数<input name="repeatCount" type="number" min="1" max="104" defaultValue={bookingDraft ? bookingDraft.repeatCount : 1} placeholder={bookingDraft?.recurring && bookingDraft.repeatCount == null ? "旧版长期" : "1"} /><small>{bookingDraft?.recurring && bookingDraft.repeatCount == null ? "当前是旧版长期课程；留空保存会继续保持长期" : "仅勾选固定课时使用；必须明确填写 1-104 节"}</small></label>
          <div className="form-notice span-2"><CircleAlert size={16} /> 提交后会先显示学生、老师、时区、次数和影响范围；确认后才写入。系统不会默认创建试听或 12 节固定课。</div>
          <footer><button className="secondary-button" type="button" onClick={() => { setBookingDraft(null); setBookingPrefillStudentId(null); setBookingPrefillTeacherId(null); setModal(null); }}>取消</button><button className="primary-button" type="submit"><CalendarPlus size={16} /> {bookingDraft ? "检查修改范围" : "检查创建范围"}</button></footer>
        </form>
      </Dialog>}

      {modal === "temporaryClassroom" && <Dialog title="立即开临时课堂" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitTemporaryClassroom}>
          <label>学生<input name="studentId" list="temporary-classroom-students" defaultValue={selectedStudent?.id === "STU-NONE" ? "" : selectedStudent?.id ?? ""} placeholder="从清单选择学生" required /><datalist id="temporary-classroom-students">{(isTeacherView ? scopedStudents : recordStudents).map((student) => <option value={student.id} key={student.id}>{student.name} · {student.course}</option>)}</datalist></label>
          {isTeacherView ? <label>老师<input value={currentTeacher?.name ?? currentOperator} disabled /><input name="teacherId" type="hidden" value={currentTeacher?.id ?? ""} /></label> : <label>老师<input name="teacherId" list="temporary-classroom-teachers" defaultValue={selectedTeacher?.id ?? ""} placeholder="从清单选择老师" required /><datalist id="temporary-classroom-teachers">{recordTeachers.map((teacher) => <option value={teacher.id} key={teacher.id}>{teacher.name} · {teacher.subjects.join("/")}</option>)}</datalist></label>}
          <label>课程名称<input name="course" defaultValue={selectedStudent?.course ? `${selectedStudent.course}（临时课堂）` : "临时课堂"} /></label>
          <label>课程时长<select name="duration" defaultValue="60"><option value="30">30 分钟</option><option value="45">45 分钟</option><option value="60">60 分钟</option><option value="90">90 分钟</option><option value="120">120 分钟</option></select></label>
          <div className="form-notice span-2"><CircleAlert size={16} /> 保存后会生成一条可追溯的临时排课，并自动准备学生邀请链接。老师进入、结束课堂和录播仍使用同一套网上教室流程。</div>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit" disabled={classroomBusy}><Video size={16} /> 创建并生成链接</button></footer>
        </form>
      </Dialog>}

      {modal === "operation" && <Dialog title="记录调课、请假、代课或离职" onClose={() => { setOperationDraft(null); setModal(null); }}>
        <form className="form-grid" onSubmit={submitOperation}>
          <label>学生<input name="studentId" list="operation-student-options" defaultValue={operationDraft?.studentId ?? selectedStudent.id} placeholder="输入姓名或学生 ID 搜索" /><datalist id="operation-student-options">{recordStudents.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.owner}</option>)}</datalist></label>
          <label>类型<select name="type" defaultValue={operationDraft?.type ?? "调课"}><option>调课</option><option>学生请假</option><option>老师请假</option><option>停课</option><option>代课</option><option>换老师</option><option>老师离职</option></select></label>
          <label>涉及老师（老师请假/代课/离职必填）<input name="teacherId" list="operation-teacher-options" defaultValue={operationDraft?.teacherId ?? ""} placeholder="输入老师姓名或 ID" /><datalist id="operation-teacher-options">{recordTeachers.map((teacher) => <option value={teacher.id} key={teacher.id}>{teacher.name} · {teacher.subjects.join("/")}</option>)}</datalist></label>
          <label>影响起始日期<input name="eventStart" type="date" defaultValue={operationDraft?.eventStart ?? isoDateInTimezone(new Date(), "Australia/Melbourne")} /></label>
          <label>影响结束 / 离职日<input name="eventEnd" type="date" defaultValue={operationDraft?.eventEnd ?? shiftIsoDate(isoDateInTimezone(new Date(), "Australia/Melbourne"), 1)} /></label>
          <label className="span-2">原因与处理说明<textarea name="detail" rows={4} defaultValue={operationDraft?.detail ?? ""} placeholder="记录请假原因、原时间、可选时间或需要的后续确认" required /></label>
          <div className="form-notice span-2"><CircleAlert size={16} /> 录入老师和影响日期后，系统会找出受影响课程，并仅从科目匹配且有结构化 AVA 的老师中给出候选。最终人选、扣课和对外通知仍由人工决定。</div>
          <footer><button className="secondary-button" type="button" onClick={() => { setOperationDraft(null); setModal(null); }}>取消</button><button className="primary-button" type="submit"><ClipboardCheck size={16} /> 记录并生成任务</button></footer>
        </form>
      </Dialog>}

      {modal === "renewal" && renewalDraft && <Dialog title="记录续课跟进" onClose={() => { setModal(null); setRenewalDraft(null); }}>
        <form className="form-grid renewal-followup-form" onSubmit={submitRenewalFollowUp}>
          <label>学生<input value={studentById(renewalDraft.studentId)?.name ?? renewalDraft.studentId} disabled /></label>
          <label>续课状态<select name="businessStatus" defaultValue={renewalDraft.businessStatus ?? normalizeRenewalBusinessStatus(renewalDraft.status)}>{Object.entries(RENEWAL_STATUS_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label>本次结果<select name="result" defaultValue={renewalDraft.status === "本次未跟进" ? "本次未跟进" : renewalDraft.status === "等待家长" ? "等待家长" : "已跟进"}><option>已跟进</option><option>本次未跟进</option><option>等待家长</option></select></label>
          <label>本次操作时间<input name="attemptedAt" type="datetime-local" defaultValue={currentLocalDateTimeValue()} required /></label>
          <label>上次成功跟进<input value={formatFollowUpTime(renewalDraft.lastContactedAt, displayPreferences)} disabled /></label>
          <label className="span-2">续课日期备注<input name="renewalDateNote" defaultValue={renewalDraft.renewalDateNote ?? ""} placeholder="不足一节、下一节日期或需续费科目" /></label>
          <label className="span-2">跟进说明<textarea name="note" rows={3} defaultValue={renewalDraft.followUpNote ?? ""} placeholder="例如：已联系家长，等待确认下月课时；或本次电话未接通" /></label>
          <label className="span-2 upload-field">聊天记录截图（可选）<input name="attachment" type="file" accept="image/png,image/jpeg,image/webp" /></label>
          <footer><button className="secondary-button" type="button" disabled={renewalUploadBusy} onClick={() => { setModal(null); setRenewalDraft(null); }}>取消</button><button className="primary-button" type="submit" disabled={renewalUploadBusy}><ClipboardCheck size={16} /> {renewalUploadBusy ? "正在保存..." : "保存跟进记录"}</button></footer>
        </form>
      </Dialog>}

      {modal === "file" && <Dialog title="登记资料链接" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitFile}>
          <label>关联学生<input name="studentId" list="file-student-options" defaultValue={selectedStudent.id} placeholder="输入姓名或学生 ID 搜索" /><datalist id="file-student-options">{recordStudents.map((student) => <option value={student.id} key={student.id}>{student.name}</option>)}</datalist></label>
          <label>资料类型<select name="type" defaultValue={studentRecordKind === "lp" ? "Learning Plan" : studentRecordKind === "report" ? "Report 资料" : studentRecordKind === "fu" ? "FU" : "资料链接"}><option>Learning Plan</option><option>学校资料</option><option>Report 资料</option><option>成绩单</option><option>FU</option><option>课堂反馈</option><option>续课 FU</option><option>资料链接</option><option>其他</option></select></label>
          <label className="span-2">资料名称<input name="title" autoFocus placeholder="例如 2026 Semester 2 Learning Plan" required /></label>
          <label className="span-2">来源链接或说明<input name="source" placeholder="例如 Google Drive · https://..." /></label>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><FilePlus2 size={16} /> 登记资料</button></footer>
        </form>
      </Dialog>}

      {modal === "template" && <Dialog title="新建消息待确认" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitTemplate}>
          <label>关联学生<input name="studentId" list="message-student-options" defaultValue={selectedStudent.id} placeholder="输入姓名或学生 ID 搜索" /><datalist id="message-student-options">{recordStudents.map((student) => <option value={student.id} key={student.id}>{student.name}</option>)}</datalist></label>
          <label>消息类型<input name="kind" defaultValue="内部提醒" required /></label>
          <label className="span-2">收件对象<input name="recipient" defaultValue="内部负责人" required /></label>
          <label className="span-2">消息正文<textarea name="body" rows={5} placeholder="输入需要人工确认的消息内容" required /></label>
          <div className="form-notice span-2"><CircleAlert size={16} /> 此操作只创建待确认队列，不会通过企业微信向任何人发送消息。</div>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><MessageSquare size={16} /> 创建待确认消息</button></footer>
        </form>
      </Dialog>}
    </main>
  );
}

function ViewHeading({ eyebrow, title, copy, actions }: { eyebrow: string; title: string; copy?: string; actions: ReactNode }) { return <section className="view-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{copy ? <p className="view-copy">{copy}</p> : null}</div><div className="heading-actions">{actions}</div></section>; }
function Metric({ tone, icon, value, label, detail, onClick }: { tone: Tone; icon: ReactNode; value: string; label: string; detail: string; onClick?: () => void }) { return <button className={`metric-card ${tone}`} type="button" onClick={onClick}><span className="metric-icon">{icon}</span><span><strong>{value}</strong><b>{label}</b><small>{detail}</small></span><ArrowRight size={17} /></button>; }
function ScheduleList({ bookings, studentById, teacherById, onOpen }: { bookings: Booking[]; studentById: (id: string) => Student | undefined; teacherById: (id: string) => Teacher | undefined; onOpen: (booking: Booking) => void }) { if (!bookings.length) return <div className="empty-inline"><CalendarDays size={20} /> 今天没有课程</div>; return <div className="schedule-list">{bookings.slice(0, 6).map((booking) => <button className="schedule-row" type="button" key={`${booking.id}-${booking.date}`} onClick={() => onOpen(booking)}><span className="schedule-time"><strong>{booking.start}</strong><small>{booking.date.slice(5).replace("-", "/")}</small></span><span className={`schedule-line ${booking.status === "待确认" ? "amber" : booking.kind === "试听" ? "blue" : "green"}`} /><span className="schedule-copy"><strong>{studentById(booking.studentId)?.name}</strong><small>{teacherById(booking.teacherId)?.name} · {booking.kind} · {booking.status}</small></span><ChevronRight size={16} /></button>)}</div>; }
function RiskRow({ tone, title, detail, action }: { tone: Tone; title: string; detail: string; action: () => void }) { return <button className="risk-row" type="button" onClick={action}><span className={`risk-icon ${tone}`}><CircleAlert size={16} /></span><span><strong>{title}</strong><small>{detail}</small></span><ChevronRight size={15} /></button>; }
function TeacherAvaBoard({ teacher, teachers, bookings, studentById, targetTimezone, preferences, view, monthOffset, onView, onMonthOffset, onTeacherChange, onAddAva, onEditAva, onDeleteAva }: { teacher: Teacher; teachers: Teacher[]; bookings: Booking[]; studentById: (id: string) => Student | undefined; targetTimezone: string; preferences: DisplayPreferences; view: "week" | "month"; monthOffset: number; onView: (view: "week" | "month") => void; onMonthOffset: (offset: number) => void; onTeacherChange: (teacherId: string) => void; onAddAva: () => void; onEditAva: (slotIndex: number) => void; onDeleteAva: (slotIndex: number) => void }) {
  const english = preferences.language === "en-AU";
  const weekDates = weekDatesForTimezone(targetTimezone, preferences);
  const month = monthDatesForTimezone(targetTimezone, monthOffset, preferences);
  const visibleDates = view === "week" ? weekDates.map((day) => day.date) : month.days.map((day) => day.date);
  const slots = displayAvaSlotsForDates(teacher, targetTimezone, visibleDates, preferences);
  const teacherBookings = bookings.filter((booking) => booking.teacherId === teacher.id).flatMap((booking) => bookingOccurrencesWithinRange(booking, visibleDates[0], visibleDates.at(-1)!).map((occurrence) => {
    const parts = zonedParts(bookingInstant(occurrence), cleanTimezone(targetTimezone));
    return { booking: occurrence, date: `${parts.year}-${parts.month}-${parts.day}`, time: formatClock(bookingInstant(occurrence), targetTimezone, preferences) };
  }));
  const renderSlot = (slot: (typeof slots)[number], index: number) => <p className="ava-slot" key={`${slot.date}-${slot.start}-${index}`}><span>{english ? "Available" : "可约"} {slot.start}-{slot.end}</span><span className="ava-slot-actions"><button type="button" aria-label={`${english ? "Edit" : "修改"} ${slot.start}-${slot.end}`} title={english ? "Edit available time" : "修改固定可约时段"} onClick={() => onEditAva(slot.slotIndex)}><Pencil size={12} /></button><button type="button" aria-label={`${english ? "Delete" : "删除"} ${slot.start}-${slot.end}`} title={english ? "Delete available time" : "删除固定可约时段"} onClick={() => onDeleteAva(slot.slotIndex)}><X size={13} /></button></span></p>;
  const renderBookings = (date: string) => teacherBookings.filter((entry) => entry.date === date).map(({ booking, time }) => <p className="ava-booked" key={booking.occurrenceKey}>{english ? "Booked" : "已占用"} {time} · {studentById(booking.studentId)?.name ?? (english ? "Student" : "学生")}</p>);
  const weekdays = english ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] : ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  return <section className="ava-workbench" aria-label={english ? "Teacher availability calendar" : "老师 AVA 日历"}>
    <header><div><p className="eyebrow">{english ? "Teacher availability · booked times" : "老师 AVA · 已占用时段"}</p><h2>{english ? "Available times" : "可约时间表"}</h2><span>{english ? "Green is available and grey is booked. Times are converted automatically for " : "浅绿色为可约，灰色为已排课；按 "}{timezoneLabel(targetTimezone, preferences.language)}{english ? "." : " 自动换算。"}</span></div><div className="ava-actions"><div className="segmented"><button className={view === "week" ? "active" : ""} type="button" onClick={() => onView("week")}>{english ? "This week" : "本周"}</button><button className={view === "month" && monthOffset === 0 ? "active" : ""} type="button" onClick={() => { onView("month"); onMonthOffset(0); }}>{english ? "This month" : "本月"}</button><button className={view === "month" && monthOffset === 1 ? "active" : ""} type="button" onClick={() => { onView("month"); onMonthOffset(1); }}>{english ? "Next month" : "下月"}</button></div><select className="filter-select" value={teacher.id} onChange={(event) => onTeacherChange(event.target.value)} aria-label={english ? "Teacher availability" : "选择老师查看 AVA"}>{teachers.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</select><button className="secondary-button" type="button" onClick={onAddAva}><Plus size={16} /> {english ? "Add availability" : "录入 AVA"}</button></div></header>
    {!teacher.availabilitySlots?.length ? <div className="ava-unstructured"><CircleAlert size={18} /><div><strong>{english ? "This teacher's availability is still unstructured text, so a safe booking calendar cannot be generated." : "这位老师的 AVA 仍是原始文本，不能安全地生成可约日历。"}</strong><span>{teacher.availability || (english ? "No availability received yet" : "尚未收到可用时间")}</span><small>{english ? "Enter confirmed weekday, start, and end times before using availability for booking conflicts or cover-teacher matching." : "录入结构化的星期、开始和结束时间后，系统才会用于排课冲突和代课候选筛选。"}</small></div></div> : view === "week" ? <div className="ava-week-grid">{weekDates.map((day) => { const daySlots = slots.filter((slot) => slot.date === day.date); return <article key={day.date}><strong>{day.label}</strong><span>{timezoneLabel(targetTimezone, preferences.language)}</span><div>{daySlots.length ? daySlots.map(renderSlot) : <p className="ava-empty-day">{english ? "No available times" : "无可约时段"}</p>}{renderBookings(day.date)}</div></article>; })}</div> : <div className="ava-month"><header><button className="icon-button" type="button" aria-label={english ? "Previous month" : "上一个月"} onClick={() => onMonthOffset(monthOffset - 1)}><ChevronLeft size={16} /></button><strong>{month.label}</strong><button className="icon-button" type="button" aria-label={english ? "Next month" : "下一个月"} onClick={() => onMonthOffset(monthOffset + 1)}><ChevronRight size={16} /></button></header><div className="ava-month-weekdays">{weekdays.map((day) => <span key={day}>{day}</span>)}</div><div className="ava-month-grid">{month.days.map((day) => { const daySlots = slots.filter((slot) => slot.date === day.date); return <article className={day.inMonth ? "" : "outside"} key={day.date}><strong>{day.day}</strong><div>{daySlots.map(renderSlot)}{renderBookings(day.date)}</div></article>; })}</div></div>}
  </section>;
}
function StudentDetail({ student, tasks, bookings, files, teacherById, preferences, mobileOpen, canEditStatus = true, onClose, onRecord, onSchedule, onEdit, onEvidence, onStatus }: { student: Student; tasks: Task[]; bookings: Booking[]; files: FileRecord[]; studentById: (id: string) => Student | undefined; teacherById: (id: string) => Teacher | undefined; preferences: DisplayPreferences; mobileOpen: boolean; canEditStatus?: boolean; onClose: () => void; onRecord: (section: StudentRecordPanelSection) => void; onSchedule: () => void; onEdit: () => void; onEvidence: () => void; onStatus: (status: Student["status"]) => void }) {
  const english = preferences.language === "en-AU";
  const studentTasks = tasks.filter((task) => task.studentId === student.id && task.status !== "done");
  const nextBooking = bookings
    .filter(
      (booking) =>
        booking.studentId === student.id && !isPastBooking(booking),
    )
    .sort(
      (left, right) =>
        bookingInstant(left).getTime() - bookingInstant(right).getTime(),
    )[0];
  const lowHours = isActiveStudent(student) && student.remainingHours !== undefined && student.remainingHours < 5;
  return <aside className={`student-detail ${mobileOpen ? "mobile-detail-open" : ""}`}>
    <button className="mobile-preview-close" type="button" aria-label={english ? "Close student details" : "关闭学生详情"} onClick={onClose}><ChevronLeft size={20} /> {english ? "Back to students" : "返回学生列表"}</button>
    <div className="detail-top"><Avatar initials={student.initials} tone={statusTone(student.status)} /><div><p>{student.id}</p><h2>{student.name}</h2><StatusPill tone={statusTone(student.status)}>{displayTerm(student.segment ?? "已报名", preferences.language)} · {displayTerm(student.status, preferences.language)}</StatusPill></div></div>
    <div className="student-facts"><span><small>{english ? "Current grade" : "当前年级"}</small><strong>{currentGrade(student)}</strong>{student.gradeBaseYear && student.gradeBaseYear < new Date().getFullYear() ? <em>{english ? `Automatically progressed from the ${student.gradeBaseYear} record` : `由 ${student.gradeBaseYear} 年记录自动升级`}</em> : null}</span><span><small>{english ? "Location / timezone" : "所在地 / 时区"}</small><strong>{student.location ?? (english ? "To be confirmed" : "待确认")}</strong><em>{timezoneLabel(student.timezone, preferences.language)}</em></span><span><small>{english ? "Operations owner" : "负责教务"}</small><strong>{student.owner}</strong><em>{english ? `Plan: ${student.planner ?? "Unassigned"}` : `规划：${student.planner ?? "待分配"}`}</em></span><span><small>{english ? "Remaining / contract lessons" : "剩余 / 合约课时"}</small><strong className={lowHours ? "low-hours" : ""}>{student.remainingHours === undefined ? (english ? "Pending import" : "待导入") : `${student.remainingHours} / ${student.contractHours ?? "?"} ${english ? "lessons" : "节"}`}</strong><em>{student.contractEffectiveDate ? (english ? `Effective ${student.contractEffectiveDate}` : `生效 ${student.contractEffectiveDate}`) : lowHours ? (english ? "High-priority reminder active" : "已进入强提醒") : student.status === "停课" || student.status === "非在读" || student.status === "不活跃" ? (english ? "No reminder for this status" : "当前状态不提醒") : (english ? "Threshold: 5 lessons" : "阈值 5 节")}</em></span></div>
    {student.jwbSyncStatus && <div className="detail-section source-detail"><span>教务宝只读同步</span><strong>{student.jwbSyncStatus} · {student.jwbSyncedAt}</strong><p>课时与合约数据来自只读镜像；本系统不会回写教务宝。</p></div>}
    <div className="detail-section"><span>{english ? "Course and teacher" : "课程与老师"}</span><strong>{student.course}</strong><p>{student.teacher}</p></div>
    <div className="detail-section"><span>{english ? "Family contact" : "家长联系"}</span><strong>{student.guardian}</strong>{student.guardianWechat ? <p>{student.guardianWechat}</p> : null}</div>
    <div className="detail-section student-record-entry-grid"><button type="button" onClick={() => onRecord("lp")}><strong>LP / 学校资料</strong><span>{files.filter((file) => file.studentId === student.id && (file.type === "Learning Plan" || file.type === "学校资料")).length}</span></button><button type="button" onClick={() => onRecord("report")}><strong>Report 资料</strong><span>{files.filter((file) => file.studentId === student.id && (file.type === "Report 资料" || file.type === "成绩单")).length}</span></button><button type="button" onClick={() => onRecord("fu")}><strong>FU</strong><span>{files.filter((file) => file.studentId === student.id && (file.type === "FU" || file.type === "续课 FU" || file.type === "课堂反馈")).length}</span></button><button type="button" onClick={() => onRecord("followUp")}><strong>最近跟进</strong><span>{student.followUpHistory?.length ?? (student.followUp ? 1 : 0)}</span></button></div>
    <div className="detail-section split"><button className="inline-link" type="button" onClick={() => onRecord("lessonPackages")}>课包 {student.lessonPackages?.length ?? 0}</button><button className="inline-link" type="button" onClick={() => onRecord("exams")}>考试 {student.exams?.length ?? (student.examDate || student.examSubject ? 1 : 0)}</button></div>
    <div className="detail-section"><span>特殊备注</span><strong>{student.notes ?? "无特殊备注"}</strong></div>
    {canEditStatus && <div className="student-detail-actions"><button className="secondary-button" type="button" onClick={onEdit}><UserCog size={15} /> 编辑档案</button><button className="secondary-button" type="button" onClick={onEvidence}><FilePlus2 size={15} /> 上传沟通/反馈</button></div>}
    {canEditStatus ? <label className="status-select">{english ? "Student status" : "学生状态"}<select value={student.status} onChange={(event) => onStatus(event.target.value as Student["status"])}>{["待确认", "待排课", "试听中", "在读", "待续课", "停课", "非在读", "不活跃"].map((status) => <option value={status} key={status}>{displayTerm(status, preferences.language)}</option>)}</select></label> : <div className="detail-section"><span>{english ? "Student status" : "学生状态"}</span><strong>{displayTerm(student.status, preferences.language)}</strong><p>{english ? "Teacher access is read-only. Contact the operations owner to update this record." : "老师账号只读；如需调整请联系负责教务。"}</p></div>}
    <div className="timeline"><div className="timeline-title"><strong>{english ? "Next steps and timeline" : "下一步与时间线"}</strong><small>{studentTasks.length} {english ? "open tasks" : "项待办"}</small></div>{studentTasks.slice(0, 3).map((task) => <div className="timeline-item" key={task.id}><i className={task.tone} /><span><strong>{task.title}</strong><small>{task.due} · {task.owner}</small></span></div>)}{nextBooking && <div className="timeline-item"><i className="green" /><span><strong>{english ? "Next lesson" : "下一节"}: {formatInstant(bookingInstant(nextBooking), student.timezone, preferences)}</strong><small>{teacherById(nextBooking.teacherId)?.name} · {displayTerm(nextBooking.kind, preferences.language)}</small></span></div>}</div>
    <button className="primary-button full" type="button" onClick={onSchedule}><CalendarPlus size={16} /> {english ? "Schedule a lesson for this student" : "为此学生安排课程"}</button>
  </aside>;
}
function TimeLine({ label, time, detail }: { label: string; time: string; detail: string }) { return <div className="booking-line"><span>{label}</span><strong>{time}</strong><small>{detail}</small></div>; }
function SummaryCard({ icon, tone, title, text }: { icon: ReactNode; tone: Tone; title: string; text: string }) { return <article><span className={`sync-icon ${tone}`}>{icon}</span><span><strong>{title}</strong><small>{text}</small></span></article>; }
function OwnershipRow({ title, detail, tone, label }: { title: string; detail: string; tone: Tone; label: string }) { return <div className="ownership-row"><span><strong>{title}</strong><small>{detail}</small></span><StatusPill tone={tone}>{label}</StatusPill></div>; }
function ReportCard({ value, label, detail, tone }: { value: string; label: string; detail: string; tone: Tone }) { return <article className={`report-card ${tone}`}><strong>{value}</strong><span>{label}</span><small>{detail}</small></article>; }
function DataIssue({ title, count, tone }: { title: string; count: string; tone: Tone }) { return <div className="issue-row"><span className={`risk-icon ${tone}`}><CircleAlert size={16} /></span><span><strong>{title}</strong><small>{count}</small></span></div>; }
