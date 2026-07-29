"use client";

import {
  AlertTriangle,
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
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_LIMITED_ADMIN_USER, DEMO_STAFF_USERS, DEMO_TEACHER_USERS, isDemoTeacher } from "@/lib/demo-users";

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
type TaskStatus = "overdue" | "today" | "upcoming" | "waiting" | "done";
type ModalKind = "student" | "studentEdit" | "studentEvidence" | "task" | "booking" | "operation" | "renewal" | "file" | "template" | "lp" | "ava" | null;
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
type LpWorkflowType = "试听 LP" | "老生新 LP" | "直报 LP" | "二次试听" | "老生 LP 修改" | "代课 LP";

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
};

type Task = {
  id: string;
  title: string;
  owner: string;
  studentId: string;
  due: string;
  status: TaskStatus;
  tone: Tone;
  category: "试听" | "LP" | "排课" | "课后" | "续课" | "薪资" | "资料";
  trigger: string;
  result?: string;
};

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
  stage: "待资料" | "写作中" | "待审核" | "已发老师" | "待备课确认" | "完成";
  owner: string;
  due: string;
  needsParentFollowUp?: boolean;
  needsTeacherPrep?: boolean;
  publishedDate?: string;
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

type RenewalStatus = "待跟进" | "已联系" | "已跟进" | "本次未跟进" | "等待家长" | "已确认";

type Renewal = {
  id: string;
  studentId: string;
  remaining: number;
  estimate: string;
  status: RenewalStatus;
  owner: string;
  lastAttemptAt?: string;
  lastContactedAt?: string;
  followUpNote?: string;
  followUpAttachmentId?: string;
  followUpAttachmentTitle?: string;
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
  type: "Learning Plan" | "成绩单" | "课堂反馈" | "续课 FU" | "资料链接" | "其他";
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

const navigation: Array<{ id: Section; label: string; icon: typeof LayoutDashboard; group: "work" | "support" }> = [
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

const staffSectionIds = new Set<Section>(["dashboard", "students", "teachers", "schedule", "courses", "lp", "operations", "renewals", "messages", "files"]);
const teacherSectionIds = new Set<Section>(["dashboard", "students", "schedule", "classroom", "files"]);
const noPayrollAdminSectionIds = new Set<Section>(navigation.filter((item) => item.id !== "payroll").map((item) => item.id));

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

const defaultRules: Rules = { lpDays: "N-3", feedbackHours: "24", renewalDays: "8", escalation: "逾期 4 小时后通知主管", lowHours: "5", examDays: "30" };
const lpStages: LpItem["stage"][] = ["待资料", "写作中", "待审核", "已发老师", "待备课确认", "完成"];
const lpWorkflowOptions: Array<{ id: LpWorkflowType; lpNeed: LpNeed; title: string; detail: string }> = [
  { id: "试听 LP", lpNeed: "试听LP", title: "试听 LP", detail: "试听资料、老师备课、收费与试听后跟进" },
  { id: "老生新 LP", lpNeed: "老生新LP", title: "老生新 LP", detail: "老生新增课程或新老师的交接" },
  { id: "直报 LP", lpNeed: "新生LP", title: "学生报名（直报）", detail: "直报学生的课程、频率、来源与交接" },
  { id: "二次试听", lpNeed: "试听LP", title: "二次试听", detail: "记录重听原因、注意事项与备课要求" },
  { id: "老生 LP 修改", lpNeed: "LP修改", title: "老生 LP 修改", detail: "课程或课时安排变动后的强提醒" },
  { id: "代课 LP", lpNeed: "代课LP", title: "代课 LP", detail: "原老师指定内容、资料和新老师交接" },
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

function nowLabel() {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

function currentLocalDateTimeValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 16);
}

function formatFollowUpTime(value?: string) {
  if (!value) return "暂无成功跟进记录";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}（历史记录未含具体时间）`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

let uniqueSequence = 0;

function id(prefix: string) {
  uniqueSequence += 1;
  return `${prefix}-${Date.now().toString().slice(-6)}-${uniqueSequence}`;
}

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "新";
}

const timezoneOptions = [
  { id: "Australia/Melbourne", label: "墨尔本" },
  { id: "Australia/Adelaide", label: "阿德莱德" },
  { id: "Australia/Sydney", label: "悉尼" },
  { id: "Australia/Brisbane", label: "布里斯班" },
  { id: "Australia/Perth", label: "珀斯" },
  { id: "Asia/Shanghai", label: "中国" },
];

function timezoneLabel(value: string) {
  const timezone = cleanTimezone(value);
  return timezoneOptions.find((option) => option.id === timezone)?.label ?? timezone;
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

function formatInstant(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: cleanTimezone(timezone),
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
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

function formatClock(date: Date, timezone: string) {
  const parts = zonedParts(date, cleanTimezone(timezone));
  return `${parts.hour}:${parts.minute}`;
}

function isoDateInTimezone(date: Date, timezone: string) {
  const parts = zonedParts(date, cleanTimezone(timezone));
  return `${parts.year}-${parts.month}-${parts.day}`;
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

function weekDatesForTimezone(timezone: string) {
  const today = isoDateInTimezone(new Date(), timezone);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday = shiftIsoDate(today, weekday === 0 ? -6 : 1 - weekday);
  return Array.from({ length: 7 }, (_, index) => {
    const date = shiftIsoDate(monday, index);
    const dateAtNoon = new Date(`${date}T12:00:00Z`);
    return { date, label: new Intl.DateTimeFormat("zh-CN", { weekday: "short", day: "numeric", timeZone: "UTC" }).format(dateAtNoon) };
  });
}

function monthDatesForTimezone(timezone: string, monthOffset: number) {
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
    label: new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", timeZone: "UTC" }).format(monthStart),
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

function taskTiming(due: string, timezone = "Australia/Melbourne", futureTone: Tone = "blue") {
  const today = isoDateInTimezone(new Date(), timezone);
  const status: TaskStatus = due < today ? "overdue" : due === today ? "today" : "upcoming";
  return { due, status, tone: status === "overdue" ? "red" : status === "today" ? "amber" : futureTone };
}

function displayAvaSlotsForDates(teacher: Teacher, targetTimezone: string, dates: string[]) {
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
      results.push({ date: displayedDate, start: formatClock(start, targetTimezone), end: formatClock(end, targetTimezone), slotIndex });
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

function availabilityInTimezone(teacher: Teacher, targetTimezone: string) {
  if (!teacher.availabilitySlots?.length) return `${teacher.availability}（原文，待结构化）`;
  const targetWeek = weekDatesForTimezone(targetTimezone);
  return teacher.availabilitySlots.map((slot) => {
    const dayOffset = slot.day === 0 ? 6 : slot.day - 1;
    const date = targetWeek[dayOffset]?.date ?? targetWeek[0].date;
    const sourceTimezone = cleanTimezone(teacher.availabilityTimezone ?? teacher.timezone);
    const start = zonedDateTimeToUtc(date, slot.start, sourceTimezone);
    const end = zonedDateTimeToUtc(date, slot.end, sourceTimezone);
    return `${formatInstant(start, targetTimezone)}-${new Intl.DateTimeFormat("zh-CN", { timeZone: targetTimezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(end)}`;
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

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header"><div><p className="eyebrow">本地演示数据</p><h2>{title}</h2></div><IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton></header>
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

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="collection-empty"><Search size={22} /><strong>{title}</strong><span>{detail}</span></div>;
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
  const [syncSources] = useState<SyncSource[]>(initialData?.syncSources ?? []);
  const [selectedStudentId, setSelectedStudentId] = useState(defaults.defaultSelectedStudentId);
  const [selectedTeacherId, setSelectedTeacherId] = useState(defaults.defaultSelectedTeacherId);
  const [selectedMessageId, setSelectedMessageId] = useState("MSG-001");
  const [taskFilter, setTaskFilter] = useState<"all" | "mine" | "overdue">("all");
  const [search, setSearch] = useState("");
  const [studentView, setStudentView] = useState("all");
  const [studentOwner, setStudentOwner] = useState("all");
  const [studentPage, setStudentPage] = useState(1);
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [teacherQuery, setTeacherQuery] = useState("");
  const [teacherView, setTeacherView] = useState("available");
  const [teacherSubject, setTeacherSubject] = useState("all");
  const [teacherPage, setTeacherPage] = useState(1);
  const [scheduleMode, setScheduleMode] = useState<"week" | "agenda">("agenda");
  const [scheduleFilter, setScheduleFilter] = useState("all");
  const [scheduleDay, setScheduleDay] = useState("all");
  const [scheduleDensity, setScheduleDensity] = useState<"compact" | "comfortable">("comfortable");
  const [schedulePage, setSchedulePage] = useState(1);
  const [scheduleTimezone, setScheduleTimezone] = useState("Australia/Melbourne");
  const [selectedBookingId, setSelectedBookingId] = useState("LES-001");
  const [selectedBookingDate, setSelectedBookingDate] = useState<string | null>(null);
  const [selectedBookingDateId, setSelectedBookingDateId] = useState<string | null>(null);
  const [selectedBookingIds, setSelectedBookingIds] = useState<string[]>([]);
  const [bookingDraft, setBookingDraft] = useState<Booking | null>(null);
  const [operationDraft, setOperationDraft] = useState<Partial<Operation> | null>(null);
  const [classroomRuntime, setClassroomRuntime] = useState<ClassroomRuntime | null>(null);
  const [classroomBusy, setClassroomBusy] = useState(false);
  const [courseQuery, setCourseQuery] = useState("");
  const [coursePage, setCoursePage] = useState(1);
  const [selectedCourseId, setSelectedCourseId] = useState(defaults.defaultCourses[0]?.id ?? "");
  const [lpMode, setLpMode] = useState<"board" | "table">("board");
  const [lpFilter, setLpFilter] = useState("active");
  const [avaView, setAvaView] = useState<"week" | "month">("week");
  const [avaMonthOffset, setAvaMonthOffset] = useState(0);
  const [avaDraft, setAvaDraft] = useState<{ teacherId: string; slotIndex: number; slot: AvailabilitySlot } | null>(null);
  const [operationFilter, setOperationFilter] = useState("open");
  const [selectedOperationId, setSelectedOperationId] = useState("OPS-001");
  const [renewalFilter, setRenewalFilter] = useState("attention");
  const [renewalPage, setRenewalPage] = useState(1);
  const [renewalDraft, setRenewalDraft] = useState<Renewal | null>(null);
  const [renewalUploadBusy, setRenewalUploadBusy] = useState(false);
  const [evidenceUploadBusy, setEvidenceUploadBusy] = useState(false);
  const [payrollFilter, setPayrollFilter] = useState("all");
  const [payrollCurrency, setPayrollCurrency] = useState("all");
  const [payrollPage, setPayrollPage] = useState(1);
  const [selectedPayrollId, setSelectedPayrollId] = useState("");
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
  const [toast, setToast] = useState("");
  const importInputRef = useRef<HTMLInputElement>(null);
  const operatorMenuRef = useRef<HTMLDivElement>(null);
  const operatorLabel = (operator: string) => operator === "Nixon" ? "Admin" : operator;

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
  const currentTeacher = useMemo(() => isTeacherView ? recordTeachers.find((teacher) => teacher.name.trim().toLocaleLowerCase() === currentOperator.trim().toLocaleLowerCase()) : undefined, [currentOperator, isTeacherView, recordTeachers]);
  const teacherBookingStudentIds = useMemo(() => new Set(currentTeacher ? bookings.filter((booking) => booking.teacherId === currentTeacher.id).map((booking) => booking.studentId) : []), [bookings, currentTeacher]);
  const visibleNavigation = useMemo(() => isAdminView ? navigation.filter((item) => canViewPayroll || noPayrollAdminSectionIds.has(item.id)) : navigation.filter((item) => isTeacherView ? teacherSectionIds.has(item.id) : staffSectionIds.has(item.id)), [canViewPayroll, isAdminView, isTeacherView]);
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
  const selectedMessage = scopedMessages.find((message) => message.id === selectedMessageId) ?? scopedMessages[0];
  const selectedBookingSeries = scopedBookings.find((booking) => booking.id === selectedBookingId) ?? scopedBookings[0];
  const selectedBooking = selectedBookingSeries && selectedBookingDate && selectedBookingDateId === selectedBookingSeries.id
    ? { ...selectedBookingSeries, date: selectedBookingDate }
    : selectedBookingSeries;
  const selectedOperation = scopedOperations.find((operation) => operation.id === selectedOperationId) ?? scopedOperations[0];
  const activeLowHourStudents = useMemo(() => scopedStudents.filter((student) => isActiveStudent(student) && student.remainingHours !== undefined && student.remainingHours < Number(rules.lowHours || 5)), [scopedStudents, rules.lowHours]);
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

  const addAudit = (action: string, detail: string, tone: Tone = "blue") => {
    const optimisticEntry: AuditEntry = { id: id("AUD"), time: `今天 ${nowLabel()}`, actor: currentOperator, action, detail, tone };
    setAudit((current) => [optimisticEntry, ...current]);
    void fetch("/api/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, detail, tone }),
    }).then(async (response) => {
      if (response.ok) return;
      const body = await response.json().catch(() => ({}));
      notify(body.error || "操作审计保存失败");
    }).catch(() => notify("操作审计保存失败"));
  };

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  };

  const completeTask = (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task || task.status === "done") return;
    setTasks((current) => current.map((item) => item.id === taskId ? { ...item, status: "done", tone: "green", due: "已完成", result: "已由当前操作员确认完成" } : item));
    addAudit("完成强提醒任务", `${task.title} · ${studentById(task.studentId)?.name ?? "未关联学生"}`, "green");
    notify("已完成并写入操作记录");
  };

  const visibleTasks = useMemo(() => {
    const filtered = scopedTasks.filter((task) => task.status !== "done");
    if (taskFilter === "overdue") return filtered.filter((task) => task.status === "overdue");
    if (taskFilter === "mine") return filtered.filter((task) => task.owner === currentOperator || scopedStudentIds.has(task.studentId));
    return filtered;
  }, [currentOperator, scopedStudentIds, scopedTasks, taskFilter]);

  const switchOperator = (operator: string) => {
    const teacherView = isDemoTeacher(operator);
    const adminScope = operator === "Nixon" || operator === DEMO_LIMITED_ADMIN_USER;
    const teacher = teacherView ? recordTeachers.find((item) => item.name.trim().toLocaleLowerCase() === operator.trim().toLocaleLowerCase()) : undefined;
    const teacherStudentIds = new Set(teacher ? bookings.filter((booking) => booking.teacherId === teacher.id).map((booking) => booking.studentId) : []);
    const allowedStudents = adminScope ? recordStudents : teacherView ? recordStudents.filter((student) => student.teacher.trim().toLocaleLowerCase() === operator.trim().toLocaleLowerCase() || teacherStudentIds.has(student.id)) : recordStudents.filter((student) => student.owner === operator);
    setCurrentOperator(operator);
    setTaskFilter(adminScope ? "all" : "mine");
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

    const poll = async () => {
      if (polling || document.hidden) return;
      polling = true;
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
        if (!stopped) reportSharedSync(navigator.onLine ? "error" : "offline", error instanceof Error ? error.message : "共享同步暂时不可用");
      } finally {
        polling = false;
      }
    };

    const interval = window.setInterval(poll, 2500);
    const onVisible = () => { if (!document.hidden) void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    void poll();
    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
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

  const createLpWorkflow = (studentId: string, workflowType: LpWorkflowType, needsParentFollowUp: boolean, needsTeacherPrep: boolean, studentOverride?: Student) => {
    const student = studentOverride ?? studentById(studentId);
    if (!student) return false;
    const option = lpWorkflowOptions.find((item) => item.id === workflowType) ?? lpWorkflowOptions[0];
    const item: LpItem = {
      id: id("LP"),
      studentId,
      title: `${option.title} · ${student.name}`,
      workflowType,
      stage: "待资料",
      owner: student.owner,
      due: workflowType === "老生 LP 修改" ? "发布当天" : workflowType === "试听 LP" || workflowType === "二次试听" ? "试听前 N-3" : "发布后 24 小时",
      needsParentFollowUp,
      needsTeacherPrep,
      publishedDate: workflowType === "老生 LP 修改" ? isoDateInTimezone(new Date(), "Australia/Melbourne") : undefined,
    };
    const generated: Task[] = [
      { id: id("TSK"), title: `${option.title}：核对交接信息`, owner: student.owner, studentId, due: "发布后立即", status: "today", tone: "blue", category: "LP", trigger: `${option.title} 创建后自动生成` },
    ];
    if (workflowType === "老生 LP 修改") generated.push({ id: id("TSK"), title: "确认 LP 修改已发布", owner: student.owner, studentId, due: "发布当天", status: "today", tone: "red", category: "LP", trigger: "老生 LP 修改强提醒" });
    if (needsParentFollowUp) generated.push(
      { id: id("TSK"), title: "跟进家长指定内容", owner: student.owner, studentId, due: "发布后立即", status: "today", tone: "red", category: "资料", trigger: `${option.title}：需要跟进家长指定内容` },
      { id: id("TSK"), title: "确认家长在 48 小时内完成指定资料/试卷", owner: student.owner, studentId, due: "发布后 48 小时", status: "upcoming", tone: "amber", category: "资料", trigger: `${option.title}：家长指定内容时限` },
    );
    if (needsTeacherPrep) generated.push({ id: id("TSK"), title: "确认老师备课内容与资料", owner: student.owner, studentId, due: "课前 N-1", status: "upcoming", tone: "amber", category: "LP", trigger: `${option.title}：需要跟进老师备课` });
    if (workflowType === "试听 LP" || workflowType === "二次试听") {
      generated.push(
        { id: id("TSK"), title: "最迟 24 小时内完成试听排课", owner: student.owner, studentId, due: "发布后 24 小时", status: "today", tone: "red", category: "排课", trigger: `${option.title} 排课时限` },
        { id: id("TSK"), title: "将 LP 发审核群并发给老师", owner: student.owner, studentId, due: "试听前 N-2", status: "upcoming", tone: "amber", category: "LP", trigger: `${option.title} 课前资料交接` },
        { id: id("TSK"), title: "试听收费确认", owner: student.planner ?? "Tara", studentId, due: "试听前 N-3", status: "upcoming", tone: "blue", category: "试听", trigger: `${option.title} 收费提醒` },
        { id: id("TSK"), title: "试听当天课后跟进", owner: student.planner ?? "Tara", studentId, due: "试听当天（墨尔本时间）", status: "waiting", tone: "purple", category: "试听", trigger: `${option.title} 课后跟进` },
      );
    }
    setLpItems((current) => [item, ...current]);
    setTasks((current) => [...generated, ...current]);
    setStudents((current) => current.map((entry) => entry.id === studentId ? { ...entry, lpNeed: option.lpNeed, next: `${option.title} 已创建`, nextTone: "amber" } : entry));
    addAudit("创建 LP 工作流", `${student.name} · ${option.title} · ${generated.length} 项强提醒`, "green");
    return true;
  };

  const createWorkflowTasks = (studentId: string, isTrial: boolean) => {
    const prefix = isTrial ? "试听" : "新课程";
    const generated: Task[] = [
      { id: id("TSK"), title: "确认 LP 资料与目标", owner: studentById(studentId)?.owner ?? "待分配", studentId, due: "开课前 N-3", status: "upcoming", tone: "blue", category: "LP", trigger: `${prefix}排课后自动生成` },
      { id: id("TSK"), title: "确认收费、资料与老师备课", owner: studentById(studentId)?.owner ?? "待分配", studentId, due: "开课前 N-2", status: "upcoming", tone: "amber", category: "试听", trigger: `${prefix}排课后自动生成` },
      { id: id("TSK"), title: "课后反馈与作业检查", owner: studentById(studentId)?.owner ?? "待分配", studentId, due: "课后 24 小时", status: "waiting", tone: "purple", category: "课后", trigger: `${prefix}排课后自动生成` },
    ];
    setTasks((current) => [...generated, ...current]);
  };

  const assignTeacher = (teacher: Teacher) => {
    if (!selectedStudent) return;
    setSelectedTeacherId(teacher.id);
    setStudents((current) => current.map((student) => student.id === selectedStudent.id ? { ...student, teacher: teacher.name, next: "确认试听排课", nextTone: "amber" } : student));
    addAudit("选择候选老师", `${selectedStudent.name} → ${teacher.name}，等待排课确认`, "green");
    notify(`${teacher.name} 已选为候选老师`);
  };

  const toggleStudentSelection = (studentId: string) => {
    setSelectedStudentIds((current) => current.includes(studentId) ? current.filter((idValue) => idValue !== studentId) : [...current, studentId]);
  };

  const bulkAssignStudents = (owner: string) => {
    if (!selectedStudentIds.length) return;
    setStudents((current) => current.map((student) => selectedStudentIds.includes(student.id) ? { ...student, owner } : student));
    addAudit("批量分配学生", `${selectedStudentIds.length} 位学生 → ${owner}`, "blue");
    notify(`已将 ${selectedStudentIds.length} 位学生分配给 ${owner}`);
    setSelectedStudentIds([]);
  };

  const advanceLp = (item: LpItem) => {
    const currentIndex = lpStages.indexOf(item.stage);
    const nextStage = lpStages[Math.min(currentIndex + 1, lpStages.length - 1)];
    if (nextStage === item.stage) return;
    setLpItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, stage: nextStage } : entry));
    addAudit("推进 LP 阶段", `${item.title}：${item.stage} → ${nextStage}`, "green");
    notify(`已推进到「${nextStage}」`);
  };

  const setLpStage = (item: LpItem, stage: LpItem["stage"]) => {
    if (stage === item.stage) return;
    setLpItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, stage } : entry));
    addAudit("调整 LP 阶段", `${item.title}：${item.stage} → ${stage}`, stage === "完成" ? "green" : "blue");
    notify(`LP 已调整到「${stage}」`);
  };

  const retreatLp = (item: LpItem) => {
    const currentIndex = lpStages.indexOf(item.stage);
    if (currentIndex <= 0) return;
    setLpStage(item, lpStages[currentIndex - 1]);
  };

  const openBookingEditor = (booking: Booking) => {
    setBookingDraft(booking);
    setSelectedStudentId(booking.studentId);
    setSelectedTeacherId(booking.teacherId);
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
    setBookings((current) => current.map((booking) => selectedBookingIds.includes(booking.id) ? { ...booking, status } : booking));
    addAudit("批量更新课程", `${selectedBookingIds.length} 节课程 → ${status}`, status === "已完成" ? "green" : "blue");
    notify(`已更新 ${selectedBookingIds.length} 节课程`);
    setSelectedBookingIds([]);
  };

  const deleteAvaSlot = (teacherId: string, slotIndex: number) => {
    const teacher = teacherById(teacherId);
    const slot = teacher?.availabilitySlots?.[slotIndex];
    if (!teacher || !slot) return;
    setTeachers((current) => current.map((entry) => {
      if (entry.id !== teacherId) return entry;
      const availabilitySlots = (entry.availabilitySlots ?? []).filter((_, index) => index !== slotIndex);
      return { ...entry, availabilitySlots, availability: availabilitySlotsText(availabilitySlots), availabilityUpdated: `手动修改 · 今天 ${nowLabel()}` };
    }));
    addAudit("删除老师 AVA", `${teacher.name} · ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][slot.day]} ${slot.start}-${slot.end}`, "amber");
    notify("该固定可约时段已删除");
  };

  const editAvaSlot = (teacherId: string, slotIndex: number) => {
    const slot = teacherById(teacherId)?.availabilitySlots?.[slotIndex];
    if (!slot) return;
    setAvaDraft({ teacherId, slotIndex, slot });
    setSelectedTeacherId(teacherId);
    setModal("ava");
  };

  const recordMessage = () => {
    if (!selectedMessage || selectedMessage.status === "已记录发送") return;
    setMessages((current) => current.map((message) => message.id === selectedMessage.id ? { ...message, status: "已记录发送" } : message));
    addAudit("记录消息发送", `${selectedMessage.kind} → ${selectedMessage.recipient}`, "green");
    notify("已记录发送。Demo 不会向真实企业微信发送消息。");
  };

  const resetDemo = () => {
    window.location.reload();
  };

  const exportDemo = () => {
    const payload = { meta: { schemaVersion: 3, dataSnapshot }, students, teachers, tasks, bookings, courses, lpItems, operations, renewals, payroll, messages, files, audit, rules };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "yinling-education-demo-data.json";
    link.click();
    URL.revokeObjectURL(url);
    addAudit("导出本地演示数据", "已下载 JSON 副本", "blue");
    notify("已导出本地演示数据");
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
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    setClassroomBusy(true);
    try {
      const result = await classroomRequest({ action: "teacher-join", bookingId: booking.id });
      if (!result.url) throw new Error("无法生成老师进入链接");
      const meetingId = String(result.meetingId || booking.classroom?.meetingId || "");
      if (meetingId) persistClassroom(booking.id, meetingId, "ready");
      if (popup) popup.location.href = result.url;
      else window.open(result.url, "_blank", "noopener,noreferrer");
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
    setClassroomBusy(true);
    try {
      const result = await classroomRequest({ action: "student-link", bookingId: booking.id });
      if (!result.url) throw new Error("无法生成学生进入链接");
      const meetingId = String(result.meetingId || booking.classroom?.meetingId || "");
      if (meetingId) persistClassroom(booking.id, meetingId, "ready");
      await navigator.clipboard.writeText(result.url);
      addAudit("复制学生教室链接", `${studentById(booking.studentId)?.name ?? booking.studentId} · ${booking.id}`, "blue");
      notify("学生进入链接已复制");
    } catch (error) {
      notify(error instanceof Error ? error.message : "学生链接生成失败");
    } finally {
      setClassroomBusy(false);
    }
  };

  const endClassroom = async (booking: Booking) => {
    setClassroomBusy(true);
    try {
      const result = await classroomRequest({ action: "end", bookingId: booking.id });
      persistClassroom(booking.id, String(result.meetingId || booking.classroom?.meetingId || ""), "ended");
      setClassroomRuntime((current) => current ? { ...current, running: false, participantCount: 0, moderatorCount: 0 } : current);
      addAudit("结束在线教室", `${studentById(booking.studentId)?.name ?? booking.studentId} · ${booking.id}`, "green");
      notify("课堂已结束，排课已自动结课；录播处理完成后会显示回放");
    } catch (error) {
      notify(error instanceof Error ? error.message : "在线教室结束失败");
    } finally {
      setClassroomBusy(false);
    }
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
    const pendingBookings = scopedBookings.filter((booking) => booking.status === "待确认");
    const totalMinutes = scopedBookings.reduce((sum, booking) => sum + booking.duration, 0);
    const todayLabel = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(new Date());
    return <>
      <ViewHeading eyebrow={todayLabel} title="我的教学工作台" copy={`${currentOperator} 老师的学生、排课与网上教室。这里只显示与当前老师直接关联的真实资料。`} actions={<><button className="secondary-button" type="button" onClick={() => setActive("students")}><Users size={17} /> 我的学生</button><button className="primary-button" type="button" onClick={() => setModal("booking")}><CalendarPlus size={17} /> 新建约课</button></>} />
      <section className="command-strip teacher-command-strip" aria-label="老师快捷操作">
        <button type="button" onClick={() => setModal("booking")}><CalendarPlus size={18} /><span><strong>安排课程</strong><small>从自己的学生中选择并检查时间冲突</small></span><ChevronRight size={16} /></button>
        <button type="button" onClick={() => setActive("schedule")}><CalendarDays size={18} /><span><strong>查看课表</strong><small>按学生、老师和墨尔本时间核对</small></span><ChevronRight size={16} /></button>
        <button type="button" onClick={() => setActive("classroom")}><Video size={18} /><span><strong>网上教室</strong><small>创建课堂、发送学生链接并查看录播</small></span><ChevronRight size={16} /></button>
      </section>
      <section className="metric-grid teacher-metric-grid" aria-label="我的教学概览">
        <Metric tone="green" icon={<Users size={21} />} value={scopedStudents.length.toString()} label="我的学生" detail="仅显示当前老师关联学生" onClick={() => setActive("students")} />
        <Metric tone="blue" icon={<CalendarDays size={21} />} value={scopedBookings.length.toString()} label="课程记录" detail="当前已导入的排课" onClick={() => setActive("schedule")} />
        <Metric tone="amber" icon={<Clock3 size={21} />} value={pendingBookings.length.toString()} label="待确认" detail="需要确认的课程" onClick={() => setActive("schedule")} />
        <Metric tone="purple" icon={<Video size={21} />} value={`${Math.round(totalMinutes / 60)}h`} label="排课时长" detail="按当前课程记录汇总" onClick={() => setActive("classroom")} />
      </section>
      <section className="teacher-dashboard-grid">
        <article className="panel teacher-roster-panel"><div className="panel-header"><div><p className="eyebrow">学生管理</p><h2>我的学生</h2></div><IconButton label="打开学生列表" onClick={() => setActive("students")}><Users size={18} /></IconButton></div><div className="teacher-student-list">{scopedStudents.slice(0, 8).map((student) => <button type="button" key={student.id} onClick={() => goToStudent(student.id)}><Avatar initials={student.initials} tone={statusTone(student.status)} /><span><strong>{student.name}</strong><small>{student.course} · {student.status}</small></span><ChevronRight size={16} /></button>)}{!scopedStudents.length && <EmptyState title="暂无关联学生" detail="管理员为老师关联学生或导入排课后，这里会自动出现。" />}</div></article>
        <article className="panel today-panel"><div className="panel-header"><div><p className="eyebrow">我的排课</p><h2>接下来课程</h2></div><IconButton label="打开排课" onClick={() => setActive("schedule")}><CalendarDays size={18} /></IconButton></div>{scopedBookings.length ? <ScheduleList bookings={scopedBookings} studentById={studentById} teacherById={teacherById} onOpen={(booking) => { setSelectedBookingId(booking.id); setSelectedBookingDate(booking.date); setSelectedBookingDateId(booking.id); setSelectedStudentId(booking.studentId); setActive("schedule"); }} /> : <EmptyState title="暂无排课" detail="点击“新建约课”为自己的学生安排课程。" />}<button className="text-button" type="button" onClick={() => setActive("classroom")}><Video size={16} /> 管理在线教室</button></article>
      </section>
    </>;
  };

  const renderDashboard = () => {
    if (isTeacherView) return renderTeacherDashboard();
    const operatorTasks = scopedTasks;
    const operatorStudents = scopedStudents;
    const operatorStudentIds = new Set(operatorStudents.map((student) => student.id));
    const operatorBookings = currentOperator === "Nixon" ? bookings : bookings.filter((booking) => operatorStudentIds.has(booking.studentId));
    const todayDate = isoDateInTimezone(new Date(), "Australia/Melbourne");
    const operatorTodayBookings = operatorBookings
      .flatMap((booking) => bookingOccurrencesWithinRange(booking, shiftIsoDate(todayDate, -1), shiftIsoDate(todayDate, 1)))
      .filter((booking) => isoDateInTimezone(bookingInstant(booking), "Australia/Melbourne") === todayDate);
    const operatorLowHourStudents = activeLowHourStudents.filter((student) => operatorStudentIds.has(student.id));
    const operatorExamStudents = examReminderStudents.filter((student) => operatorStudentIds.has(student.id));
    const operatorDstBookings = dstRiskBookings.filter((booking) => operatorStudentIds.has(booking.studentId));
    const overdue = operatorTasks.filter((task) => task.status === "overdue").length;
    const today = operatorTasks.filter((task) => task.status === "today").length;
    const lowHours = operatorLowHourStudents.length;
    const nearestExam = operatorExamStudents[0];
    const firstLowHours = operatorLowHourStudents[0];
    const pendingAva = recordTeachers.filter((teacher) => (teacher.availabilityStatus ?? "待确认") === "待确认").length;
    const todayLabel = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(new Date());
    return <>
      <ViewHeading eyebrow={todayLabel} title="今天先处理什么" copy={`${currentOperator === "Nixon" ? "全局管理视图" : `${currentOperator} 的个人工作视图`} · 所有提醒都指向学生、触发原因、负责人和下一步动作。当前使用：${dataSnapshot.label}。`} actions={<><button className="secondary-button" type="button" onClick={() => setActive("schedule")}><CalendarDays size={17} /> 查看排课</button><button className="primary-button" type="button" onClick={() => setModal("student")}><UserPlus size={17} /> 新建学生</button></>} />
      <section className="command-strip" aria-label="快速工作流">
        <button type="button" onClick={() => setModal("booking")}><CalendarPlus size={18} /><span><strong>安排课程</strong><small>检查时区、老师与学生冲突</small></span><ChevronRight size={16} /></button>
        <button type="button" onClick={() => setActive("lp")}><BookOpen size={18} /><span><strong>处理 LP</strong><small>审核、发送与老师备课确认</small></span><ChevronRight size={16} /></button>
        <button type="button" onClick={() => setModal("operation")}><RefreshCw size={18} /><span><strong>记录异常</strong><small>调课、请假、代课或换老师</small></span><ChevronRight size={16} /></button>
        {canViewPayroll && <button type="button" onClick={() => setActive("payroll")}><Wallet size={18} /><span><strong>核对薪资</strong><small>先处理异常，再人工锁定</small></span><ChevronRight size={16} /></button>}
      </section>
      <section className="metric-grid" aria-label="今日工作概览">
        <Metric tone="blue" icon={<ListTodo size={21} />} value={visibleTasks.length.toString()} label="待处理" detail={`今天到期 ${today} 项`} onClick={() => { setTaskFilter("all"); }} />
        <Metric tone="red" icon={<AlertTriangle size={21} />} value={overdue.toString()} label="已逾期" detail="需要立即处理" onClick={() => { setTaskFilter("overdue"); }} />
        <Metric tone="amber" icon={<Clock3 size={21} />} value={lowHours.toString()} label="低于 5 课时" detail="只统计在读/待续课" onClick={() => setActive("renewals")} />
        <Metric tone="green" icon={<CheckCircle2 size={21} />} value={`${Math.round((operatorTasks.filter((task) => task.status === "done").length / Math.max(operatorTasks.length, 1)) * 100)}%`} label="已完成" detail={currentOperator === "Nixon" ? "全局任务" : `${currentOperator} 的任务`} onClick={() => setActive(isAdminView ? "audit" : "dashboard")} />
      </section>
      <section className="dashboard-grid">
        <article className="panel task-panel">
          <div className="panel-header"><div><p className="eyebrow">强提醒队列</p><h2>优先处理</h2></div><div className="segmented" role="group" aria-label="筛选任务">{([ ["all", "全部"], ["mine", "我的"], ["overdue", "逾期"] ] as const).map(([filter, label]) => <button className={taskFilter === filter ? "active" : ""} key={filter} type="button" onClick={() => setTaskFilter(filter)}>{label}</button>)}</div></div>
          <TaskList tasks={visibleTasks} studentById={studentById} onComplete={completeTask} onOpen={(task) => goToStudent(task.studentId)} />
          <button className="text-button" type="button" onClick={() => setModal("task")}><Plus size={16} /> 添加内部任务</button>
        </article>
        <article className="panel today-panel"><div className="panel-header"><div><p className="eyebrow">墨尔本今日 · 按学生当地时间</p><h2>今日课程</h2></div><IconButton label="打开排课" onClick={() => setActive("schedule")}><CalendarDays size={18} /></IconButton></div><ScheduleList bookings={operatorTodayBookings} studentById={studentById} teacherById={teacherById} onOpen={(booking) => goToStudent(booking.studentId, "schedule")} /><div className="panel-foot"><MapPin size={15} /> 排课页会同时显示学生、老师与公司时间</div></article>
        <article className="panel risk-panel"><div className="panel-header"><div><p className="eyebrow">需要人工判断</p><h2>风险与缺口</h2></div><StatusPill tone="amber">{lowHours + operatorExamStudents.length + operatorDstBookings.length + pendingAva} 项</StatusPill></div>{firstLowHours ? <RiskRow tone="red" title={`${firstLowHours.name} 仅剩 ${firstLowHours.remainingHours} 课时`} detail="仅在读或待续课学生进入强提醒" action={() => goToStudent(firstLowHours.id, "renewals")} /> : <RiskRow tone="green" title="当前没有低课时学生" detail="非在读与不活跃学生已排除" action={() => setActive("renewals")} />}{nearestExam ? <RiskRow tone="amber" title={`${nearestExam.name} 的考试进入 30 天窗口`} detail={`${nearestExam.examSubject ?? "考试"} · ${nearestExam.examDate}`} action={() => goToStudent(nearestExam.id)} /> : <RiskRow tone="green" title="考试提醒窗口正常" detail="当前没有 30 天内考试" action={() => setActive("renewals")} />}{operatorDstBookings.length ? <RiskRow tone="purple" title={`${operatorDstBookings.length} 节长期课受夏令时影响`} detail="学生与老师时差会变化，需在转换日前复核" action={() => setActive("schedule")} /> : <RiskRow tone="blue" title="长期课时差检查通过" detail="IANA 时区会自动处理夏令时" action={() => setActive("schedule")} />}<RiskRow tone="blue" title={`${pendingAva} 位老师的 AVA 待结构化`} detail="保留原文，但排课前必须人工确认" action={() => setActive("teachers")} /></article>
      </section>
    </>;
  };

  const renderStudents = () => {
    const viewItems = [
      { id: "all", label: isAdminView ? "全部学生" : isTeacherView ? "我的学生" : "我负责的学生", count: scopedStudents.length },
      ...(!isTeacherView ? [{ id: "mine", label: currentOperator === "Nixon" ? "我负责的" : `${currentOperator} 负责`, count: scopedStudents.filter((student) => student.owner === currentOperator).length }] : []),
      { id: "trial", label: "试听与待排课", count: scopedStudents.filter((student) => student.status === "试听中" || student.status === "待排课").length },
      { id: "enrolled", label: "已报名在读", count: scopedStudents.filter((student) => student.segment === "已报名" && isActiveStudent(student)).length },
      { id: "lp", label: "需要 LP", count: scopedStudents.filter(requiresLp).length },
      { id: "renewal", label: "待续课", count: scopedStudents.filter((student) => student.status === "待续课").length },
      { id: "paused", label: "暂停/非在读", count: scopedStudents.filter((student) => student.status === "停课" || student.status === "非在读" || student.status === "不活跃").length },
    ];
    const pageIds = pagedStudents.map((student) => student.id);
    const pageSelected = pageIds.length > 0 && pageIds.every((studentId) => selectedStudentIds.includes(studentId));
    return <>
      <ViewHeading eyebrow={isTeacherView ? "老师个人视图 · 学生与约课" : "学生 CRM · 试听、已报名与 LP 分流"} title={isTeacherView ? "我的学生" : "学生档案"} copy={isTeacherView ? "查看自己负责授课的学生资料，并直接为学生安排课程。学生状态由教务维护。" : "按学员状态、负责教务和 LP 类型筛选；年级按基准年份自动推进，Report、跟进、考试与特殊备注集中在同一档案。"} actions={<><button className="secondary-button" type="button" onClick={() => setGlobalSearchOpen(true)}><Search size={17} /> 查找学生</button>{!isTeacherView && <button className="primary-button" type="button" onClick={() => setModal("student")}><UserPlus size={17} /> 新建学生</button>}</>} />
      <section className="panel collection-shell student-collection">
        <ViewTabs value={studentView} items={viewItems} onChange={(value) => { setStudentView(value); setStudentPage(1); setSelectedStudentIds([]); }} label="学生保存视图" />
        <ListToolbar query={search} onQuery={(value) => { setSearch(value); setStudentPage(1); }} placeholder="搜索姓名、ID、课程、老师或负责人" count={`${filteredStudents.length} 位学生`}>
          {isAdminView && <select className="filter-select" value={studentOwner} onChange={(event) => { setStudentOwner(event.target.value); setStudentPage(1); }} aria-label="按负责教务筛选"><option value="all">全部教务</option>{ownerOptions.map((owner) => <option key={owner}>{owner}</option>)}</select>}
          <button className="toolbar-button" type="button" onClick={() => { setSearch(""); setStudentOwner("all"); setStudentView("all"); setStudentPage(1); }}><Filter size={15} /> 清除筛选</button>
          <button className="toolbar-button" type="button" onClick={() => notify("当前列配置已保存在此浏览器") }><ArrowUpDown size={15} /> 姓名排序</button>
        </ListToolbar>
        {selectedStudentIds.length > 0 && <div className="bulk-bar"><strong>已选 {selectedStudentIds.length} 位</strong><span>批量分配负责人</span>{teamOwnerOptions.map((owner) => <button type="button" key={owner} onClick={() => bulkAssignStudents(owner)}>{owner}</button>)}<button className="bulk-clear" type="button" onClick={() => setSelectedStudentIds([])}>取消选择</button></div>}
        <div className="master-detail-layout">
          <article className="collection-main">
            <div className="collection-head student-grid"><input type="checkbox" disabled={!isAdminView} checked={pageSelected} aria-label="选择本页学生" onChange={() => setSelectedStudentIds(pageSelected ? selectedStudentIds.filter((studentId) => !pageIds.includes(studentId)) : Array.from(new Set([...selectedStudentIds, ...pageIds])))} /><span>学生 / 年级 / 课程</span><span>学员状态 / 老师</span><span>负责教务</span><span>下一步</span></div>
            <div className="collection-viewport">
              {pagedStudents.length ? pagedStudents.map((student) => <div className={`collection-row student-grid ${selectedStudent.id === student.id ? "selected" : ""}`} key={student.id}><input type="checkbox" disabled={!isAdminView} checked={selectedStudentIds.includes(student.id)} aria-label={`选择 ${student.name}`} onChange={() => toggleStudentSelection(student.id)} /><button className="row-primary table-person" type="button" onClick={() => openStudentPreview(student.id)}><Avatar initials={student.initials} tone={statusTone(student.status)} /><span><strong>{student.name}</strong><small>{student.id} · {currentGrade(student)} · {student.course}</small></span></button><button className="row-cell stacked" type="button" onClick={() => openStudentPreview(student.id)}><StatusPill tone={statusTone(student.status)}>{student.segment ?? "已报名"} · {student.status}</StatusPill><small>{student.teacher}</small></button><button className="row-cell" type="button" onClick={() => openStudentPreview(student.id)}>{student.owner}</button><button className="row-cell" type="button" onClick={() => openStudentPreview(student.id)}><StatusPill tone={student.nextTone}>{student.next}</StatusPill></button></div>) : <EmptyState title="没有符合条件的学生" detail="调整搜索或切换保存视图后再试。" />}
            </div>
            <Pagination page={safeStudentPage} total={filteredStudents.length} pageSize={pageSize} onPage={setStudentPage} />
          </article>
          <StudentDetail student={selectedStudent} tasks={scopedTasks} bookings={scopedBookings} files={scopedFiles} studentById={studentById} teacherById={teacherById} mobileOpen={mobilePreview === "student"} canEditStatus={!isTeacherView} onClose={() => setMobilePreview(null)} onFiles={() => { setMobilePreview(null); setActive("files"); }} onSchedule={() => { setMobilePreview(null); setBookingDraft(null); setModal("booking"); }} onEdit={() => setModal("studentEdit")} onEvidence={() => setModal("studentEvidence")} onStatus={(status) => { setStudents((current) => current.map((student) => student.id === selectedStudent.id ? { ...student, status } : student)); addAudit("更新学生状态", `${selectedStudent.name} → ${status}`, "blue"); notify("学生状态已更新"); }} />
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
    return <>
      <ViewHeading eyebrow="教师总表 · 中小学与大学合并检索" title="老师资源库" copy="跨部门老师只保留一份主档，可按标准科目、接新状态和 AVA 搜索；原始 AVA 未结构化时明确提示人工确认。" actions={<button className="primary-button" type="button" onClick={() => setModal("booking")}><CalendarPlus size={17} /> 用当前候选排课</button>} />
      <section className="matching-context"><div><span>当前匹配学生</span><strong>{selectedStudent.name}</strong><small>{selectedStudent.course} · {selectedStudent.timezone}</small></div><button type="button" onClick={() => setActive("students")}>更换学生 <ChevronRight size={15} /></button></section>
      <TeacherAvaBoard teacher={selectedTeacher} teachers={recordTeachers} bookings={bookings} studentById={studentById} targetTimezone={scheduleTimezone} view={avaView} monthOffset={avaMonthOffset} onView={setAvaView} onMonthOffset={setAvaMonthOffset} onTeacherChange={setSelectedTeacherId} onAddAva={() => { setAvaDraft(null); setModal("ava"); }} onEditAva={(slotIndex) => editAvaSlot(selectedTeacher.id, slotIndex)} onDeleteAva={(slotIndex) => deleteAvaSlot(selectedTeacher.id, slotIndex)} />
      <section className="panel collection-shell">
        <ViewTabs value={teacherView} items={viewItems} onChange={(value) => { setTeacherView(value); setTeacherPage(1); }} label="老师保存视图" />
        <ListToolbar query={teacherQuery} onQuery={(value) => { setTeacherQuery(value); setTeacherPage(1); }} placeholder="搜索老师、科目、ID 或时区" count={`${filteredTeachers.length} 位老师`}>
          <select className="filter-select" value={teacherSubject} onChange={(event) => { setTeacherSubject(event.target.value); setTeacherPage(1); }} aria-label="按标准科目筛选"><option value="all">全部科目</option>{teacherSubjectOptions.map((subject) => <option key={subject}>{subject}</option>)}</select>
          <button className="toolbar-button" type="button" onClick={() => { setTeacherQuery(""); setTeacherSubject("all"); setTeacherView("available"); }}><Filter size={15} /> 清除筛选</button>
        </ListToolbar>
        <div className="master-detail-layout teacher-layout">
          <article className="collection-main">
            <div className="collection-head teacher-grid-row"><span>老师 / 科目</span><span>匹配</span><span>已排 / 容量</span><span>AVA</span><span>状态</span></div>
            <div className="collection-viewport">
              {pagedTeachers.length ? pagedTeachers.map((teacher) => {
                const ava = availabilitySummary(teacher);
                return <button className={`collection-row teacher-grid-row ${selectedTeacher.id === teacher.id ? "selected" : ""}`} type="button" key={teacher.id} onClick={() => { setSelectedTeacherId(teacher.id); setMobilePreview("teacher"); }}><span className="table-person"><Avatar initials={teacher.initials} tone={teacher.acceptsStudents ? "green" : "neutral"} /><span><strong>{teacher.name}</strong><small>{teacher.subjects.slice(0, 2).join(" · ")} · {(teacher.departments ?? []).join("/")}</small></span></span><strong className="match-score">{teacherMatch(teacher)}%</strong><span className="teacher-load"><strong>{teacher.capacity > 0 ? `${teacher.load}/${teacher.capacity} 节` : "待确认"}</strong><small>{teacher.capacity > 0 ? `${Math.max(0, teacher.capacity - teacher.load)} 节余量` : "未导入实际课时"}</small></span><span className={`teacher-availability ${ava.raw ? "raw" : ""}`}><strong>{ava.title}</strong><small>{ava.detail}</small></span><StatusPill tone={teacher.acceptsStudents ? "green" : teacher.availabilityStatus === "待确认" ? "amber" : "neutral"}>{teacher.availabilityStatus ?? (teacher.acceptsStudents ? "可接新生" : "暂停接新")}</StatusPill></button>;
              }) : <EmptyState title="没有匹配的老师" detail="切换视图或清除搜索条件。" />}
            </div>
            <Pagination page={safeTeacherPage} total={filteredTeachers.length} pageSize={teacherPageSize} onPage={setTeacherPage} />
          </article>
          <aside className={`record-preview teacher-preview ${mobilePreview === "teacher" ? "mobile-detail-open" : ""}`}><button className="mobile-preview-close" type="button" aria-label="关闭老师详情" onClick={() => setMobilePreview(null)}><ChevronLeft size={20} /> 返回老师列表</button><div className="detail-top"><Avatar initials={selectedTeacher.initials} tone={selectedTeacher.acceptsStudents ? "green" : "neutral"} /><div><p>{selectedTeacher.id} · {(selectedTeacher.departments ?? ["待确认"]).join(" / ")}</p><h2>{selectedTeacher.name}</h2><StatusPill tone={selectedTeacher.acceptsStudents ? "green" : selectedTeacher.availabilityStatus === "待确认" ? "amber" : "neutral"}>{selectedTeacher.availabilityStatus ?? (selectedTeacher.acceptsStudents ? "可接新生" : "暂停接新")}</StatusPill></div></div><div className="match-hero"><span>与 {selectedStudent.name} 的匹配度</span><strong>{teacherMatch(selectedTeacher)}%</strong><small>{selectedTeacher.note}</small></div><div className="detail-section"><span>可教科目</span><div className="teacher-tags">{selectedTeacher.subjects.map((subject) => <span key={subject}>{subject}</span>)}</div><p>{selectedTeacher.subjectDetail ?? "以教师总表原始范围为准"}</p></div><div className="detail-section split"><div><span>地区 / 时区</span><strong>{selectedTeacher.location ?? "待确认"} · {timezoneLabel(selectedTeacher.timezone)}</strong></div><div><span>可接余量</span><strong>{selectedTeacher.capacity > 0 ? `${Math.max(0, selectedTeacher.capacity - selectedTeacher.load)} 节` : "待确认"}</strong></div></div><div className="detail-section availability-converter"><span>AVA 换算显示</span><select className="filter-select" value={scheduleTimezone} onChange={(event) => setScheduleTimezone(event.target.value)} aria-label="AVA 显示时区">{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select><strong className={`availability-value ${(selectedTeacher.availabilitySlots?.length ?? 0) ? "structured" : "raw"}`}>{availabilityInTimezone(selectedTeacher, scheduleTimezone)}</strong><p>来源：{selectedTeacher.availabilityUpdated ?? "教师总表"} · 原时区 {timezoneLabel(selectedTeacher.availabilityTimezone ?? selectedTeacher.timezone)}</p></div><button className="primary-button full" type="button" disabled={!selectedTeacher.acceptsStudents} onClick={() => assignTeacher(selectedTeacher)}><Check size={16} /> 选择为候选老师</button><button className="secondary-button full" type="button" onClick={() => { setTeachers((current) => current.map((item) => item.id === selectedTeacher.id ? { ...item, acceptsStudents: !item.acceptsStudents, availabilityStatus: item.acceptsStudents ? "暂停接新" : "可接新生" } : item)); addAudit("更新老师接新状态", `${selectedTeacher.name}：${selectedTeacher.acceptsStudents ? "暂停接新" : "开放接新"}`, "blue"); notify("老师接新状态已更新"); }}>{selectedTeacher.acceptsStudents ? "暂停接新" : "开放接新"}</button></aside>
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
    const selectedCourse = courses.find((course) => course.id === selectedCourseId) ?? pagedCourses[0] ?? courses[0];
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
          {selectedCourse ? <aside className="record-preview course-preview"><div className="preview-header"><div><p className="eyebrow">课程档案</p><h2>{selectedCourse.name}</h2></div><StatusPill tone="green">{selectedCourse.status}</StatusPill></div><div className="detail-section"><span>课程分类</span><strong>{categoryFor(selectedCourse.name)}</strong><p>来源：{selectedCourse.source}</p></div><div className="detail-section split"><div><span>本周排课</span><strong>{selectedCourseBookings.length} 节</strong></div><div><span>关联学生</span><strong>{new Set(selectedCourseBookings.map((booking) => booking.studentId)).size} 人</strong></div></div><div className="detail-section"><span>课包与收费规则</span><strong>待结构化导入</strong><p>当前不会根据课程名称猜测价格、课时或扣课规则。</p></div>{selectedCourseBookings.length ? <button className="primary-button full" type="button" onClick={() => { const booking = selectedCourseBookings[0]; setSelectedBookingId(booking.id); setSelectedBookingDate(booking.date); setSelectedBookingDateId(booking.id); setActive("schedule"); }}><CalendarDays size={16} /> 查看本周排课</button> : <button className="secondary-button full" type="button" onClick={() => setModal("booking")}><CalendarPlus size={16} /> 为课程安排排课</button>}</aside> : <EmptyState title="没有课程记录" detail="清除搜索条件后重试。" />}
        </div>
      </section>
    </>;
  };

  const renderSchedule = () => {
    const weekDays = weekDatesForTimezone(scheduleTimezone);
    const weekRangeLabel = `${weekDays[0]?.date.replaceAll("-", "/")} - ${weekDays.at(-1)?.date.replaceAll("-", "/")}`;
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
    if (!selectedBooking) {
      return <>
        <ViewHeading eyebrow={isTeacherView ? "老师个人课表 · 时区自动换算" : "统一时点 + IANA 时区 + AVA 占用锁定"} title={isTeacherView ? "我的排课" : "排课与时区检查"} copy={isTeacherView ? "这里只显示自己的课程；创建约课时会固定当前老师，并检查学生、老师时间冲突和 AVA。" : "排课统一保存为准确时点；可以一键切换墨尔本、阿德莱德、悉尼、布里斯班、珀斯和中国时间，并检查重叠、结构化 AVA 与夏令时风险。"} actions={<button className="primary-button" type="button" onClick={() => { setBookingDraft(null); setModal("booking"); }}><CalendarPlus size={17} /> 新建约课</button>} />
        <section className="panel collection-shell"><EmptyState title="暂无真实排课数据" detail="当前 Supabase 只导入了学生和老师档案；排课数据导入后会在这里显示。" /></section>
      </>;
    }
    const bookingStudent = studentById(selectedBooking.studentId) ?? selectedStudent;
    const bookingTeacher = teacherById(selectedBooking.teacherId) ?? selectedTeacher;
    const selectedInstant = bookingInstant(selectedBooking);
    const selectedDstRisk = bookingHasDstRisk(selectedBookingSeries ?? selectedBooking, bookingStudent, bookingTeacher);
    return <>
      <ViewHeading eyebrow={isTeacherView ? "老师个人课表 · 时区自动换算" : "统一时点 + IANA 时区 + AVA 占用锁定"} title={isTeacherView ? "我的排课" : "排课与时区检查"} copy={isTeacherView ? "这里只显示自己的课程；创建约课时会固定当前老师，并检查学生、老师时间冲突和 AVA。" : "排课统一保存为准确时点；可以一键切换墨尔本、阿德莱德、悉尼、布里斯班、珀斯和中国时间，并检查重叠、结构化 AVA 与夏令时风险。"} actions={<button className="primary-button" type="button" onClick={() => { setBookingDraft(null); setModal("booking"); }}><CalendarPlus size={17} /> 新建约课</button>} />
      <section className="panel schedule-shell">
        <div className="calendar-toolbar"><div className="segmented"><button className={scheduleMode === "week" ? "active" : ""} type="button" onClick={() => setScheduleMode("week")}>周视图</button><button className={scheduleMode === "agenda" ? "active" : ""} type="button" onClick={() => { setScheduleMode("agenda"); setSchedulePage(1); }}>日程列表</button></div><strong>{weekRangeLabel}</strong><div className="toolbar-actions"><select className="filter-select" value={scheduleDay} onChange={(event) => { setScheduleDay(event.target.value); setSchedulePage(1); }} aria-label="排课日期筛选"><option value="all">全部日期</option>{weekDays.map((day) => <option value={day.date} key={day.date}>{day.label}</option>)}</select>{scheduleMode === "week" && <select className="filter-select" value={scheduleDensity} onChange={(event) => setScheduleDensity(event.target.value as "compact" | "comfortable")} aria-label="周视图显示密度"><option value="comfortable">放大显示</option><option value="compact">紧凑显示</option></select>}<select className="filter-select" value={scheduleTimezone} onChange={(event) => { setScheduleTimezone(event.target.value); setSchedulePage(1); }} aria-label="排课显示时区">{timezoneOptions.map((option) => <option value={option.id} key={option.id}>显示：{option.label}</option>)}</select><select className="filter-select" value={scheduleFilter} onChange={(event) => { setScheduleFilter(event.target.value); setSchedulePage(1); }} aria-label="排课筛选"><option value="all">全部课程</option><option value="pending">待确认</option><option value="trial">仅试听</option><option value="dst">夏令时需复核</option></select></div></div>
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
                        <span><strong>{day.label}</strong><small>{timezoneLabel(scheduleTimezone)}</small></span>
                        <b>{dayBookings.length} 节</b>
                      </header>
                      <div className="week-day-events">
                        {dayBookings.length ? dayBookings.map((booking) => {
                          const student = studentById(booking.studentId);
                          const teacher = teacherById(booking.teacherId);
                          const local = zonedParts(bookingInstant(booking), scheduleTimezone);
                          const displayTime = `${local.hour}:${local.minute}`;

                          return (
                            <button
                              className={`week-event ${selectedBooking.id === booking.id && selectedBooking.date === booking.date ? "selected" : ""} ${booking.status === "待确认" ? "amber" : booking.kind === "试听" ? "blue" : "green"}`}
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
                              <span><strong>{displayTime}</strong><small>{booking.duration} 分钟</small></span>
                              <b>{student?.name}</b>
                              <small>{booking.course ?? booking.kind}</small>
                              <em>{teacher?.name}</em>
                            </button>
                          );
                        }) : <div className="week-day-empty">当天没有符合条件的课程</div>}
                      </div>
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="agenda-list">
                {selectedBookingIds.length > 0 && <div className="bulk-bar"><strong>已选 {selectedBookingIds.length} 个课程系列 <small>周期课会整组更新</small></strong><button type="button" onClick={() => bulkUpdateBookingStatus("待确认")}>整组设为待确认</button><button type="button" onClick={() => bulkUpdateBookingStatus("已确认")}>整组设为已确认</button><button type="button" onClick={() => bulkUpdateBookingStatus("已完成")}>整组设为已完成</button><button className="bulk-clear" type="button" onClick={() => setSelectedBookingIds([])}>取消选择</button></div>}
                <div className="collection-head agenda-select-grid"><input type="checkbox" aria-label="选择本页全部课程系列；周期课会整组更新" checked={pagedScheduleBookings.length > 0 && pagedScheduleBookings.every((booking) => selectedBookingIds.includes(booking.id))} onChange={(event) => setSelectedBookingIds((current) => event.target.checked ? Array.from(new Set([...current, ...pagedScheduleBookings.map((booking) => booking.id)])) : current.filter((idValue) => !pagedScheduleBookings.some((booking) => booking.id === idValue)))} /><span>显示时间</span><span>学生 / 课程</span><span>老师</span><span>类型</span><span>状态</span></div>
                <div className="collection-viewport">
                  {pagedScheduleBookings.length ? pagedScheduleBookings.map((booking) => {
                    const student = studentById(booking.studentId);
                    const teacher = teacherById(booking.teacherId);
                    const instant = bookingInstant(booking);
                    const bookingSeries = scopedBookings.find((entry) => entry.id === booking.id) ?? booking;
                    const hasRisk = student && teacher ? bookingHasDstRisk(bookingSeries, student, teacher) : false;

                    return <div className={`collection-row agenda-select-row ${selectedBooking.id === booking.id && selectedBooking.date === booking.date ? "selected" : ""}`} key={booking.occurrenceKey}>
                      <input type="checkbox" aria-label={`选择 ${student?.name ?? "课程"} 的整个课程系列`} title={booking.recurring ? "周期课状态按整个系列更新" : "选择该课程"} checked={selectedBookingIds.includes(booking.id)} onChange={() => toggleBookingSelection(booking.id)} />
                      <button className="agenda-row-main" type="button" onClick={() => { setSelectedBookingId(booking.id); setSelectedBookingDate(booking.date); setSelectedBookingDateId(booking.id); setSelectedStudentId(booking.studentId); setSelectedTeacherId(booking.teacherId); setMobilePreview("booking"); }}>
                        <span><strong>{formatInstant(instant, scheduleTimezone)}</strong><small>{timezoneLabel(scheduleTimezone)} · {booking.duration} 分钟</small></span>
                        <span><strong>{student?.name}</strong><small>{booking.course ?? student?.course}</small></span>
                        <span>{teacher?.name}<small>{timezoneLabel(teacher?.timezone ?? "Australia/Melbourne")}</small></span>
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
            <div className="panel-header"><div><p className="eyebrow">{selectedBooking.source ?? "课程预览"}</p><h2>{bookingStudent.name}</h2><small>{selectedBooking.course ?? bookingStudent.course}</small></div><StatusPill tone={selectedBooking.status === "待确认" ? "amber" : "green"}>{selectedBooking.status}</StatusPill></div>
            <TimeLine label={`学生时间 · ${timezoneLabel(bookingStudent.timezone)}`} time={formatInstant(selectedInstant, bookingStudent.timezone)} detail={cleanTimezone(bookingStudent.timezone)} />
            <TimeLine label={`老师时间 · ${timezoneLabel(bookingTeacher.timezone)}`} time={formatInstant(selectedInstant, bookingTeacher.timezone)} detail={bookingTeacher.name} />
            <TimeLine label="墨尔本基准时间" time={formatInstant(selectedInstant, "Australia/Melbourne")} detail="系统按日期自动处理夏令时" />
            <TimeLine label={`当前查看 · ${timezoneLabel(scheduleTimezone)}`} time={formatInstant(selectedInstant, scheduleTimezone)} detail={`来源时段：${selectedBooking.sourceTiming ?? "人工录入"}`} />
            <div className={`check-list ${selectedDstRisk ? "warning" : ""}`}><span><CircleCheck size={16} /> 课程时段没有检测到重叠</span><span><CircleCheck size={16} /> 已关联学生与老师内部 ID</span>{selectedDstRisk ? <span><CircleAlert size={16} /> 长期课未来会发生相对时差变化，需教务复核</span> : <span><CircleCheck size={16} /> 长期课未发现相对时差变化</span>}</div>
            {selectedBooking.status === "待确认" && <button className="primary-button full" type="button" onClick={() => { setBookings((current) => current.map((booking) => booking.id === selectedBooking.id ? { ...booking, status: "已确认" } : booking)); addAudit("确认排课", `${bookingStudent.name} · ${formatInstant(selectedInstant, bookingStudent.timezone)}`, "green"); notify("课程已确认"); }}>确认课程</button>}
            <div className="booking-action-grid">
              <button className="secondary-button" type="button" onClick={() => openBookingEditor(selectedBookingSeries ?? selectedBooking)}><Pencil size={15} /> 编辑整个课程系列</button>
              {!isTeacherView && <><button className="secondary-button" type="button" onClick={() => openBookingOperation(selectedBooking, "学生请假")}><UserRoundX size={15} /> 学生请假</button>
              <button className="secondary-button" type="button" onClick={() => openBookingOperation(selectedBooking, "老师请假")}><CalendarOff size={15} /> 老师请假</button>
              <button className="secondary-button" type="button" onClick={() => openBookingOperation(selectedBooking, "代课")}><RefreshCw size={15} /> 启动代课</button></>}
            </div>
            {!selectedBooking.classroom?.meetingId ? <button className="primary-button full" type="button" disabled={classroomBusy} onClick={() => void createClassroom(selectedBooking)}><Video size={16} /> {classroomBusy ? "正在创建…" : "创建在线教室"}</button> : selectedBooking.classroom.status === "ended" ? <button className="secondary-button full" type="button" onClick={() => { setActive("classroom"); setMobilePreview(null); }}><Video size={16} /> 查看录播与课堂记录</button> : <>
              <button className="primary-button full" type="button" disabled={classroomBusy} onClick={() => void joinTeacherClassroom(selectedBooking)}><ExternalLink size={16} /> 老师进入教室</button>
              <button className="secondary-button full" type="button" disabled={classroomBusy} onClick={() => void copyStudentClassroomLink(selectedBooking)}><Link2 size={16} /> 复制学生链接</button>
              <button className="secondary-button full" type="button" onClick={() => { setActive("classroom"); setMobilePreview(null); }}><Video size={16} /> 查看教室与录播</button>
            </>}
            <button className="secondary-button full" type="button" onClick={() => goToStudent(bookingStudent.id)}>打开学生档案</button>
          </aside>
        </div>
      </section>
    </>;
  };

  const renderLp = () => {
    const visibleLp = scopedLpItems.filter((item) => lpFilter === "review" ? item.stage === "待审核" : lpFilter === "waiting" ? item.stage === "待资料" || item.stage === "待备课确认" : lpFilter === "complete" ? item.stage === "完成" : lpFilter === "active" ? item.stage !== "完成" : true);
    const viewItems = [{ id: "active", label: "进行中", count: scopedLpItems.filter((item) => item.stage !== "完成").length }, { id: "review", label: "待审核", count: scopedLpItems.filter((item) => item.stage === "待审核").length }, { id: "waiting", label: "等待资料/确认", count: scopedLpItems.filter((item) => item.stage === "待资料" || item.stage === "待备课确认").length }, { id: "complete", label: "已完成", count: scopedLpItems.filter((item) => item.stage === "完成").length }, { id: "all", label: "全部", count: scopedLpItems.length }];
    const stageTone = (stage: LpItem["stage"]): Tone => stage === "完成" ? "green" : stage === "待审核" ? "amber" : stage === "已发老师" ? "blue" : "purple";
    const stageControls = (item: LpItem, compact = false) => (
      <div className={compact ? "lp-row-actions" : "lp-card-actions"}>
        <button className="icon-button" type="button" disabled={item.stage === lpStages[0]} aria-label="退回上一阶段" title="退回上一阶段" onClick={() => retreatLp(item)}><ChevronLeft size={15} /></button>
        <select className="lp-stage-select" value={item.stage} aria-label={`${item.title} 当前阶段`} onChange={(event) => setLpStage(item, event.target.value as LpItem["stage"])}>
          {lpStages.map((stage) => <option value={stage} key={stage}>{stage}</option>)}
        </select>
        <button className="icon-button" type="button" disabled={item.stage === lpStages.at(-1)} aria-label="推进下一阶段" title="推进下一阶段" onClick={() => advanceLp(item)}><ChevronRight size={15} /></button>
      </div>
    );

    return <>
      <ViewHeading eyebrow="Learning Plan · 类型、时限与审批" title="试听与 LP 工作流" copy="创建时可先用科目占位，之后补录学生姓名；规划人与教务负责人分开管理，所有阶段都可前进、回退或直接调整。" actions={<button className="primary-button" type="button" onClick={() => setModal("lp")}><Plus size={17} /> 创建 LP 工作流</button>} />
      <section className="lp-template-strip" aria-label="LP 模板说明">
        {lpWorkflowOptions.map((option) => <article key={option.id}><strong>{option.title}</strong><span>{option.detail}</span></article>)}
      </section>
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
    const isLeaveOperation = (operation: Operation) => ["请假", "学生请假", "老师请假", "代课", "停课", "老师离职"].includes(operation.type);
    const visibleOperations = scopedOperations.filter((operation) => operationFilter === "open" ? operation.status === "待处理" : operationFilter === "confirmed" ? operation.status === "已确认" : operationFilter === "leave" ? isLeaveOperation(operation) : true);
    if (!selectedOperation) {
      return <>
        <ViewHeading eyebrow="结构化异常处理" title="调课、请假、代课与离职" copy="老师请假或离职时，按日期找出受影响课程，给出可用代课候选，并将每位学生的沟通和交接任务分配到负责人。" actions={<button className="primary-button" type="button" onClick={() => setModal("operation")}><CalendarPlus size={17} /> 记录异常</button>} />
        <section className="panel collection-shell"><EmptyState title="暂无真实异常记录" detail="当前 Supabase 没有导入调课、请假、代课或离职记录。" /></section>
      </>;
    }
    const operationStudent = studentById(selectedOperation.studentId) ?? selectedStudent;
    const operationTeacher = selectedOperation.teacherId ? teacherById(selectedOperation.teacherId) : undefined;
    const recommendedTeachers = (selectedOperation.recommendedTeacherIds ?? []).map((teacherId) => teacherById(teacherId)).filter((teacher): teacher is Teacher => Boolean(teacher));
    return <>
      <ViewHeading eyebrow="结构化异常处理" title="调课、请假、代课与离职" copy="老师请假或离职时，按日期找出受影响课程，给出可用代课候选，并将每位学生的沟通和交接任务分配到负责人。" actions={<button className="primary-button" type="button" onClick={() => setModal("operation")}><CalendarPlus size={17} /> 记录异常</button>} />
      <section className="panel collection-shell"><ViewTabs value={operationFilter} items={[{ id: "open", label: "待处理", count: scopedOperations.filter((item) => item.status === "待处理").length }, { id: "confirmed", label: "已确认", count: scopedOperations.filter((item) => item.status === "已确认").length }, { id: "leave", label: "请假、代课与离职", count: scopedOperations.filter(isLeaveOperation).length }, { id: "all", label: "全部", count: scopedOperations.length }]} onChange={setOperationFilter} label="异常保存视图" /><div className="master-detail-layout operations-layout"><article className="collection-main"><div className="collection-head operation-grid-row"><span>记录</span><span>学生</span><span>创建时间</span><span>状态</span></div><div className="collection-viewport">{visibleOperations.length ? visibleOperations.map((operation) => { const student = studentById(operation.studentId); return <button className={`collection-row operation-grid-row ${selectedOperation.id === operation.id ? "selected" : ""}`} type="button" key={operation.id} onClick={() => { setSelectedOperationId(operation.id); setSelectedStudentId(operation.studentId); setMobilePreview("operation"); }}><span><strong>{operation.type}</strong><small>{operation.detail}</small></span><span>{student?.name}<small>{student?.course}</small></span><span>{operation.createdAt}</span><StatusPill tone={operation.status === "已确认" ? "green" : "amber"}>{operation.status}</StatusPill></button>; }) : <EmptyState title="当前视图没有异常记录" detail="切换视图或新建一条异常处理记录。" />}</div>{visibleOperations.length < 4 && <div className="operations-queue-insight"><div><span>当前视图</span><strong>{visibleOperations.length} 条待处理记录</strong><small>切换上方状态标签即可查看其他异常。</small></div><div><span>队列概览</span><strong>{scopedOperations.filter((item) => item.status === "待处理").length} 待处理 · {scopedOperations.filter((item) => item.status === "已确认").length} 已确认</strong><small>每次确认都会保留在操作审计中。</small></div><div><span>处理顺序</span><strong>先确认老师影响，再处理代课与沟通</strong><small>请假和离职会自动生成负责人截止任务。</small></div></div>}</article><aside className={`record-preview ${mobilePreview === "operation" ? "mobile-detail-open" : ""}`}><button className="mobile-preview-close" type="button" aria-label="关闭异常详情" onClick={() => setMobilePreview(null)}><ChevronLeft size={20} /> 返回异常列表</button><div className="preview-header"><div><p className="eyebrow">异常记录</p><h2>{selectedOperation.type} · {operationStudent.name}</h2></div><StatusPill tone={selectedOperation.status === "已确认" ? "green" : "amber"}>{selectedOperation.status}</StatusPill></div><div className="detail-section"><span>处理说明</span><strong>{selectedOperation.detail}</strong><p>{selectedOperation.createdAt} · {operationStudent.owner} 负责</p></div>{operationTeacher && <div className="detail-section"><span>原老师与影响范围</span><strong>{operationTeacher.name} · {selectedOperation.affectedLessonCount ?? 0} 节受影响课程</strong><p>{selectedOperation.eventStart || "日期待确认"} 至 {selectedOperation.eventEnd || "日期待确认"}</p></div>}{operationTeacher && <div className="detail-section"><span>代课候选</span>{recommendedTeachers.length ? <div className="operation-recommendations">{recommendedTeachers.map((teacher) => <button className={selectedOperation.chosenTeacherId === teacher.id ? "selected-choice" : "choice-button"} type="button" key={teacher.id} onClick={() => { setOperations((current) => current.map((entry) => entry.id === selectedOperation.id ? { ...entry, chosenTeacherId: teacher.id } : entry)); addAudit("选择代课推荐老师", `${operationStudent.name} · ${teacher.name}`, "green"); notify(`${teacher.name} 已标记为推荐老师，尚未自动排课`); }}><span><strong>{teacher.name}</strong><small>{teacher.subjects.slice(0, 2).join(" · ")}</small></span>{selectedOperation.chosenTeacherId === teacher.id ? <Check size={16} /> : <ChevronRight size={16} />}</button>)}</div> : <p>没有找到同时满足科目和结构化 AVA 的候选。请先补全 AVA 后再选择，不会猜测老师可用时间。</p>}</div>}<div className="detail-section"><span>确认前检查</span><ul className="compact-rules"><li>学生与老师的新时间是否都确认</li><li>是否影响课时、薪资或代课安排</li><li>是否需要生成对外消息待办</li></ul></div>{selectedOperation.status === "待处理" && <button className="primary-button full" type="button" onClick={() => { setOperations((current) => current.map((entry) => entry.id === selectedOperation.id ? { ...entry, status: "已确认" } : entry)); addAudit("确认异常处理", `${selectedOperation.type} · ${operationStudent.name}`, "green"); notify("已确认，后续任务仍保留在工作台"); }}>确认处理</button>}<button className="secondary-button full" type="button" onClick={() => goToStudent(operationStudent.id)}>查看学生档案</button></aside></div></section>
    </>;
  };

  const renderRenewals = () => {
    const renewalRows: Renewal[] = [
      ...scopedRenewals
        .filter((renewal) => {
          const student = studentById(renewal.studentId);
          return Boolean(student && isActiveStudent(student));
        })
        .map((renewal) => ({ ...renewal, remaining: studentById(renewal.studentId)?.remainingHours ?? renewal.remaining })),
      ...activeLowHourStudents.filter((student) => !scopedRenewals.some((renewal) => renewal.studentId === student.id)).map((student) => ({ id: `REN-AUTO-${student.id}`, studentId: student.id, remaining: student.remainingHours ?? 0, estimate: student.renewalDate || student.renewalMonth || "待确认", status: "待跟进" as const, owner: student.owner })),
    ];
    const visibleRenewals = renewalRows.filter((renewal) => renewalFilter === "attention"
      ? renewal.status === "待跟进" || renewal.status === "等待家长" || renewal.status === "本次未跟进"
      : renewalFilter === "contacted"
        ? renewal.status === "已联系" || renewal.status === "已跟进"
        : renewalFilter === "missed"
          ? renewal.status === "本次未跟进"
          : renewalFilter === "confirmed"
            ? renewal.status === "已确认"
            : true);
    const renewalPageSize = 10;
    const safeRenewalPage = Math.min(renewalPage, Math.max(1, Math.ceil(visibleRenewals.length / renewalPageSize)));
    const pagedRenewals = visibleRenewals.slice((safeRenewalPage - 1) * renewalPageSize, safeRenewalPage * renewalPageSize);
    return <>
      <ViewHeading eyebrow="低课时与考试节点 · 自动避免遗漏" title="考试与续课" copy={`剩余课时低于 ${rules.lowHours} 的在读/待续课学生进入强提醒；停课、非在读与不活跃学生自动排除。考试在提前 ${rules.examDays} 天和考试当天提醒负责教务。`} actions={<button className="secondary-button" type="button" onClick={() => setModal("task")}><Plus size={17} /> 添加跟进</button>} />
      <section className="exam-reminder-strip"><div><span className="risk-icon amber"><CalendarDays size={17} /></span><span><strong>{examReminderStudents.length} 位学生进入考试提醒窗口</strong><small>考试当天仍会保留一条“考后关心”任务，完成后写入跟进记录。</small></span></div>{examReminderStudents.slice(0, 4).map((student) => <button type="button" key={student.id} onClick={() => goToStudent(student.id)}><strong>{student.name}</strong><small>{student.examSubject || "考试"} · {student.examDate}</small><ChevronRight size={15} /></button>)}</section>
      <section className="panel collection-shell renewal-collection">
        <ViewTabs
          value={renewalFilter}
          items={[
            { id: "attention", label: "需要关注", count: renewalRows.filter((item) => item.status === "待跟进" || item.status === "等待家长" || item.status === "本次未跟进").length },
            { id: "contacted", label: "已跟进", count: renewalRows.filter((item) => item.status === "已联系" || item.status === "已跟进").length },
            { id: "missed", label: "本次未跟进", count: renewalRows.filter((item) => item.status === "本次未跟进").length },
            { id: "confirmed", label: "已确认", count: renewalRows.filter((item) => item.status === "已确认").length },
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
              const lastContactedAt = renewal.lastContactedAt || (/^\d{4}-\d{2}-\d{2}$/.test(student?.followUp ?? "") ? student?.followUp : undefined);
              const displayStatus = renewal.status === "已联系" ? "已跟进" : renewal.status;
              return <div className="collection-row renewal-grid-row" key={renewal.id}>
                <button className="row-primary table-person" type="button" onClick={() => goToStudent(renewal.studentId)}><Avatar initials={student?.initials ?? "?"} tone={lowHours ? "red" : statusTone(renewal.status)} /><span><strong>{student?.name}</strong><small>{student?.course} · {student?.status}</small></span></button>
                <strong className={lowHours ? "low-hours" : ""}>{renewal.remaining} 节</strong>
                <span>{renewal.estimate}</span>
                <span>{renewal.owner}</span>
                <span className="renewal-status-cell"><StatusPill tone={statusTone(renewal.status)}>{displayStatus}</StatusPill><small>{renewal.lastAttemptAt ? `本次 ${formatFollowUpTime(renewal.lastAttemptAt)}` : `上次成功 ${formatFollowUpTime(lastContactedAt)}`}</small>{renewal.status === "本次未跟进" && <small>上次成功 {formatFollowUpTime(lastContactedAt)}</small>}</span>
                <button className="compact-button" type="button" onClick={() => { setRenewalDraft({ ...renewal, lastContactedAt }); setModal("renewal"); }}>记录跟进</button>
              </div>;
            }) : <EmptyState title="当前没有续课记录" detail="非在读学生不会因为低课时进入此列表。" />}
          </div>
          <Pagination page={safeRenewalPage} total={visibleRenewals.length} pageSize={renewalPageSize} onPage={setRenewalPage} />
        </div>
      </section>
    </>;
  };

  const renderPayroll = () => {
    const visiblePayroll = payroll.filter((row) => {
      const matchesStatus = payrollFilter === "review" ? row.status === "需核对" : payrollFilter === "ready" ? row.status === "可审核" : payrollFilter === "locked" ? row.status === "已锁定" : true;
      const matchesCurrency = payrollCurrency === "all" || row.currency === payrollCurrency;
      return matchesStatus && matchesCurrency;
    });
    const payrollPageSize = 10;
    const safePayrollPage = Math.min(payrollPage, Math.max(1, Math.ceil(visiblePayroll.length / payrollPageSize)));
    const pagedPayroll = visiblePayroll.slice((safePayrollPage - 1) * payrollPageSize, safePayrollPage * payrollPageSize);
    const selectedPayroll = pagedPayroll.find((row) => row.id === selectedPayrollId) ?? pagedPayroll[0] ?? visiblePayroll[0] ?? payroll[0];
    const payrollMonth = Array.from(new Set(payroll.map((row) => row.month).filter(Boolean))).join("、") || "待导入";
    const cnyTotal = payroll.filter((row) => row.currency === "CNY").reduce((total, row) => total + row.amount, 0);
    const audTotal = payroll.filter((row) => row.currency !== "CNY").reduce((total, row) => total + row.amount, 0);
    const totalHours = payroll.reduce((total, row) => total + (row.teacherTotalHours ?? row.lessons + row.trialLessons), 0);
    const lockPayrollRow = (targetId: string) => {
      const row = payroll.find((item) => item.id === targetId);
      const teacherName = row ? teacherById(row.teacherId)?.name ?? row.teacherName ?? row.teacherId : "未知老师";
      setPayroll((current) => current.map((item) => item.id === targetId ? { ...item, status: "已锁定", lockedBy: currentOperator, lockedAt: `今天 ${nowLabel()}`, note: item.note.includes("已锁定") ? item.note : `${item.note}；已由 ${currentOperator} 人工锁定` } : item));
      addAudit("锁定薪资记录", `${teacherName} · ${row ? formatMoney(row.amount, row.currency) : ""}`, "green");
      notify("已锁定本月薪资记录");
    };

    return <>
    <ViewHeading eyebrow="教务宝课时证据 + 人工费率表" title="课时与薪资" copy={`当前显示 ${payrollMonth} 薪资。系统保留每位老师的学生明细、课时费、教务宝匹配差异和人工锁定记录。`} actions={<button className="secondary-button" type="button" onClick={() => setActive("sync")}><Database size={17} /> 查看数据来源</button>} />
    <section className="metric-grid payroll-metrics"><Metric tone="blue" icon={<FileText size={21} />} value={formatHours(totalHours)} label="薪资表课时" detail={`${payroll.reduce((total, row) => total + (row.lineCount ?? row.lines?.length ?? 0), 0)} 条学生明细`} /><Metric tone="amber" icon={<CircleAlert size={21} />} value={`${payroll.filter((row) => row.status === "需核对").length}`} label="需要核对" detail="姓名、课时或费率例外" /><Metric tone="green" icon={<Wallet size={21} />} value={formatMoney(cnyTotal, "CNY")} label="人民币薪资" detail="国内教师合计" /><Metric tone="purple" icon={<ShieldCheck size={21} />} value={formatMoney(audTotal, "AUD")} label="澳币薪资" detail={`${payroll.filter((row) => row.status === "已锁定").length} 条已锁定`} /></section>
    <section className="panel collection-shell"><div className="view-bar"><ViewTabs value={payrollFilter} items={[{ id: "all", label: "全部", count: payroll.length }, { id: "review", label: "需核对", count: payroll.filter((item) => item.status === "需核对").length }, { id: "ready", label: "可审核", count: payroll.filter((item) => item.status === "可审核").length }, { id: "locked", label: "已锁定", count: payroll.filter((item) => item.status === "已锁定").length }]} onChange={(value) => { setPayrollFilter(value); setPayrollPage(1); }} label="薪资保存视图" /><div className="toolbar-actions"><select className="filter-select" value={payrollCurrency} onChange={(event) => { setPayrollCurrency(event.target.value); setPayrollPage(1); }} aria-label="薪资币种筛选"><option value="all">全部币种</option><option value="CNY">人民币</option><option value="AUD">澳币</option></select><button className="secondary-button" type="button" disabled={!payroll.some((row) => row.status === "可审核")} onClick={() => { const count = payroll.filter((row) => row.status === "可审核").length; setPayroll((current) => current.map((row) => row.status === "可审核" ? { ...row, status: "已锁定", lockedBy: currentOperator, lockedAt: `今天 ${nowLabel()}`, note: row.note.includes("批量锁定") ? row.note : `${row.note}；已批量锁定` } : row)); addAudit("批量锁定薪资", `${count} 条可审核记录`, "green"); notify(`已锁定 ${count} 条可审核记录`); }}><ShieldCheck size={16} /> 批量锁定可审核</button></div></div>{payroll.length ? <div className="master-detail-layout payroll-layout"><article className="collection-main"><div className="collection-head payroll-grid-row"><span>老师</span><span>薪资表课时</span><span>教务宝课时</span><span>建议金额</span><span>状态</span></div><div className="collection-viewport">{pagedPayroll.length ? pagedPayroll.map((row) => { const teacher = teacherById(row.teacherId); const teacherName = teacher?.name ?? row.teacherName ?? row.teacherId; const salaryHours = row.teacherTotalHours ?? row.lessons + row.trialLessons; const hasVariance = row.hourVariance !== null && row.hourVariance !== undefined && Math.abs(row.hourVariance) > 0.01; return <button className={`collection-row payroll-grid-row ${selectedPayroll?.id === row.id ? "selected" : ""}`} type="button" key={row.id} onClick={() => setSelectedPayrollId(row.id)}><span className="table-person"><Avatar initials={teacher?.initials ?? initials(teacherName)} tone={row.status === "需核对" ? "amber" : "blue"} /><span><strong>{teacherName}</strong><small>{row.section ?? "教师薪资"} · {payrollCurrencyLabel(row.currency)}</small></span></span><span><strong>{formatHours(salaryHours)}</strong><small>{row.lineCount ?? row.lines?.length ?? 0} 条明细</small></span><span className={hasVariance ? "low-hours" : ""}>{formatHours(row.sourceHours)}<small>{hasVariance ? `差异 ${formatHours(row.hourVariance)}` : row.sourceHours === null || row.sourceHours === undefined ? "未匹配" : "已匹配"}</small></span><strong>{formatMoney(row.amount, row.currency)}</strong><StatusPill tone={statusTone(row.status)}>{row.status}</StatusPill></button>; }) : <EmptyState title="当前筛选下没有薪资记录" detail="切换状态或币种筛选查看其他记录。" />}</div><Pagination page={safePayrollPage} total={visiblePayroll.length} pageSize={payrollPageSize} onPage={setPayrollPage} /></article>{selectedPayroll && <aside className="record-preview payroll-preview"><div className="preview-header"><div><p className="eyebrow">{selectedPayroll.month ?? "薪资月份待确认"} · {selectedPayroll.section ?? "教师薪资"}</p><h2>{teacherById(selectedPayroll.teacherId)?.name ?? selectedPayroll.teacherName ?? selectedPayroll.teacherId}</h2></div><StatusPill tone={statusTone(selectedPayroll.status)}>{selectedPayroll.status}</StatusPill></div><div className="student-facts payroll-facts"><span><small>薪资表课时</small><strong>{formatHours(selectedPayroll.teacherTotalHours ?? selectedPayroll.lessons + selectedPayroll.trialLessons)}</strong><em>常规 {formatHours(selectedPayroll.lessons)} · 试听 {formatHours(selectedPayroll.trialLessons)}</em></span><span><small>教务宝课时</small><strong>{formatHours(selectedPayroll.sourceHours)}</strong><em>{selectedPayroll.sourceLessonCount === null || selectedPayroll.sourceLessonCount === undefined ? "未匹配汇总" : `${selectedPayroll.sourceLessonCount} 节课`}</em></span><span><small>建议金额</small><strong>{formatMoney(selectedPayroll.amount, selectedPayroll.currency)}</strong><em>{payrollCurrencyLabel(selectedPayroll.currency)}</em></span><span><small>付款信息</small><strong>{maskAccount(selectedPayroll.bankAccount)}</strong><em>{selectedPayroll.bankName || "银行待确认"}</em></span></div><div className="detail-section"><span>费率与说明</span><strong>{selectedPayroll.rateRange?.length ? selectedPayroll.rateRange.map((rate) => formatMoney(rate, selectedPayroll.currency)).join("、") : "费率待确认"}</strong><p>{selectedPayroll.paymentNote || selectedPayroll.note}</p></div><div className="detail-section"><span>学生明细</span><div className="payroll-line-list">{(selectedPayroll.lines ?? []).slice(0, 12).map((line) => <div className="payroll-line" key={`${line.studentName}-${line.sourceRow}`}><span><strong>{line.studentName}</strong><small>{line.note || (line.isTrial ? "试听" : "常规课")}</small></span><span>{formatHours(line.hours)}</span><span>{formatMoney(line.rate, selectedPayroll.currency)}</span><strong>{formatMoney(line.subtotal, selectedPayroll.currency)}</strong></div>)}{(selectedPayroll.lines?.length ?? 0) > 12 && <p className="muted-cell">还有 {(selectedPayroll.lines?.length ?? 0) - 12} 条明细，已保存在系统数据中。</p>}</div></div>{selectedPayroll.status !== "已锁定" ? <button className="primary-button full" type="button" onClick={() => lockPayrollRow(selectedPayroll.id)}><ShieldCheck size={16} /> 人工锁定此老师薪资</button> : <div className="detail-section"><span>锁定记录</span><strong>{selectedPayroll.lockedBy ?? "已锁定"}</strong><p>{selectedPayroll.lockedAt ?? selectedPayroll.note}</p></div>}</aside>}</div> : <EmptyState title="暂无真实薪资数据" detail="导入教务宝课时导出和当前薪资表后，这里会显示老师薪资、学生明细和核对状态。" />}</section>
    </>;
  };

  const renderMessages = () => {
    const visibleMessages = scopedMessages.filter((message) => {
      const matchesQuery = `${message.kind} ${message.recipient} ${studentById(message.studentId)?.name ?? ""}`.toLowerCase().includes(messageQuery.trim().toLowerCase());
      if (!matchesQuery) return false;
      if (messageFilter === "open") return message.status !== "已记录发送";
      if (messageFilter === "confirm") return message.status === "待人工确认";
      if (messageFilter === "sent") return message.status === "已记录发送";
      if (messageFilter === "internal") return message.status === "仅内部";
      return true;
    });
    if (!selectedMessage) {
      return <>
        <ViewHeading eyebrow="按学生关系路由 · 发送前确认" title="消息队列" copy="像收件箱一样集中搜索和筛选；左侧选择消息，右侧确认收件对象和内容，避免在长列表中误操作。" actions={<button className="primary-button" type="button" onClick={() => setModal("template")}><Plus size={17} /> 新建消息</button>} />
        <section className="panel collection-shell"><EmptyState title="暂无真实消息记录" detail="当前 Supabase 没有导入消息队列；后续接入企业微信后会在这里显示。" /></section>
      </>;
    }
    return <>
      <ViewHeading eyebrow="按学生关系路由 · 发送前确认" title="消息队列" copy="像收件箱一样集中搜索和筛选；左侧选择消息，右侧确认收件对象和内容，避免在长列表中误操作。" actions={<button className="primary-button" type="button" onClick={() => setModal("template")}><Plus size={17} /> 新建消息</button>} />
      <section className="panel collection-shell"><ViewTabs value={messageFilter} items={[{ id: "open", label: "待处理", count: scopedMessages.filter((item) => item.status !== "已记录发送").length }, { id: "confirm", label: "待人工确认", count: scopedMessages.filter((item) => item.status === "待人工确认").length }, { id: "internal", label: "仅内部", count: scopedMessages.filter((item) => item.status === "仅内部").length }, { id: "sent", label: "已记录发送", count: scopedMessages.filter((item) => item.status === "已记录发送").length }, { id: "all", label: "全部", count: scopedMessages.length }]} onChange={setMessageFilter} label="消息保存视图" /><ListToolbar query={messageQuery} onQuery={setMessageQuery} placeholder="搜索学生、消息类型或收件对象" count={`${visibleMessages.length} 条消息`} /><div className="master-detail-layout message-layout"><article className="collection-main"><div className="collection-viewport message-list">{visibleMessages.length ? visibleMessages.map((message) => { const student = studentById(message.studentId); return <button className={`message-list-row ${selectedMessage.id === message.id ? "selected" : ""}`} type="button" key={message.id} onClick={() => { setSelectedMessageId(message.id); setMobilePreview("message"); }}><span className={`route-icon ${message.status === "待人工确认" ? "amber" : "blue"}`}><MessageCircle size={18} /></span><span><strong>{message.kind}</strong><small>{student?.name} · {message.recipient}</small><em>{message.body}</em></span><span><StatusPill tone={message.status === "待人工确认" ? "amber" : message.status === "已记录发送" ? "green" : "blue"}>{message.status}</StatusPill><small>{message.createdAt}</small></span></button>; }) : <EmptyState title="没有符合条件的消息" detail="切换视图或清除搜索。" />}</div><div className="send-log"><strong>安全边界</strong><p><CircleAlert size={15} /> 当前只记录发送意图，未连接企业微信 API。</p></div></article><aside className={`record-preview message-preview ${mobilePreview === "message" ? "mobile-detail-open" : ""}`}><button className="mobile-preview-close" type="button" aria-label="关闭消息详情" onClick={() => setMobilePreview(null)}><ChevronLeft size={20} /> 返回消息列表</button><div className="preview-header"><div><p className="eyebrow">发送前预览</p><h2>{selectedMessage.kind}</h2></div><StatusPill tone={selectedMessage.status === "待人工确认" ? "amber" : selectedMessage.status === "已记录发送" ? "green" : "blue"}>{selectedMessage.status}</StatusPill></div><div className="route-summary"><span>关联学生<strong>{studentById(selectedMessage.studentId)?.name}</strong></span><span>收件对象<strong>{selectedMessage.recipient}</strong></span><span>创建时间<strong>{selectedMessage.createdAt}</strong></span></div><div className="message-bubble">{selectedMessage.body}</div><div className="preview-foot"><CircleAlert size={16} /> 真实外部消息仍需企业微信权限、收件对象映射与人工确认。</div><button className="primary-button full" type="button" disabled={selectedMessage.status === "已记录发送"} onClick={recordMessage}><Send size={16} /> {selectedMessage.status === "已记录发送" ? "已记录发送" : "记录为已发送"}</button></aside></div></section>
    </>;
  };

  const renderFiles = () => {
    const visibleFiles = scopedFiles.filter((file) => {
      const matchesQuery = `${file.title} ${file.type} ${file.source} ${studentById(file.studentId)?.name ?? ""}`.toLowerCase().includes(fileQuery.trim().toLowerCase());
      return matchesQuery && (fileFilter === "all" || file.type === fileFilter);
    });
    return <>
      <ViewHeading eyebrow="资料索引 · 不依赖文件名猜测" title="文件中心" copy="用类型视图和搜索定位资料；每条文件记录直接关联学生，不需要进入不断变长的文件夹树。" actions={<button className="primary-button" type="button" onClick={() => setModal("file")}><FilePlus2 size={17} /> 登记文件</button>} />
      <section className="panel collection-shell"><ViewTabs value={fileFilter} items={[{ id: "all", label: "全部", count: scopedFiles.length }, { id: "Learning Plan", label: "Learning Plan", count: scopedFiles.filter((item) => item.type === "Learning Plan").length }, { id: "成绩单", label: "成绩单", count: scopedFiles.filter((item) => item.type === "成绩单").length }, { id: "课堂反馈", label: "课堂反馈", count: scopedFiles.filter((item) => item.type === "课堂反馈").length }, { id: "续课 FU", label: "续课 FU", count: scopedFiles.filter((item) => item.type === "续课 FU").length }, { id: "资料链接", label: "资料链接", count: scopedFiles.filter((item) => item.type === "资料链接").length }]} onChange={setFileFilter} label="文件保存视图" /><ListToolbar query={fileQuery} onQuery={setFileQuery} placeholder="搜索资料名、学生、类型或来源" count={`${visibleFiles.length} 项资料`} /><div className="collection-main"><div className="collection-head file-grid-row"><span>资料</span><span>关联学生</span><span>类型</span><span>来源</span><span>加入时间</span></div><div className="collection-viewport">{visibleFiles.length ? visibleFiles.map((file) => { const student = studentById(file.studentId); const linkedSource = file.source.startsWith("/") || /^https?:\/\//.test(file.source); return <div className="collection-row file-grid-row" key={file.id}><span className="file-title"><span className="file-icon"><FileText size={17} /></span><strong>{file.title}</strong></span><button className="inline-link" type="button" onClick={() => goToStudent(file.studentId)}>{student?.name} <ChevronRight size={14} /></button><StatusPill tone={file.type === "Learning Plan" ? "blue" : file.type === "续课 FU" ? "green" : "neutral"}>{file.type}</StatusPill>{linkedSource ? <a className="inline-link file-source-link" href={file.source} target="_blank" rel="noreferrer">查看截图 <ExternalLink size={13} /></a> : <small>{file.source}</small>}<span>{file.addedAt}</span></div>; }) : <EmptyState title="没有找到资料" detail="调整类型视图或搜索关键词。" />}</div></div></section>
    </>;
  };

  const renderSync = () => <>
    <ViewHeading eyebrow="Supabase 主数据 · 腾讯文档只读镜像" title="同步与导入" copy="站内新增和修改只写入 Supabase，并实时共享给其他在线成员。腾讯文档当前只读取和留存镜像，不会从本系统回写或删除原文档内容。" actions={<><input className="visually-hidden" ref={importInputRef} type="file" accept="application/json" onChange={importLocalSnapshot} /><button className="secondary-button" type="button" onClick={() => importInputRef.current?.click()}><FilePlus2 size={17} /> 导入到共享数据库</button><button className="primary-button" type="button" onClick={() => window.location.reload()}><RefreshCw size={17} /> 刷新同步状态</button></>} />
    <section className="sync-workspace"><section className="sync-summary source-summary"><SummaryCard icon={<Users size={19} />} tone="green" title={`${recordStudents.length} 位有效学生`} text="Supabase 多人共享学生档案" /><SummaryCard icon={<GraduationCap size={19} />} tone="blue" title={`${recordTeachers.length} 位去重老师`} text="中小学、大学及近期 AVA 汇总" /><SummaryCard icon={<RefreshCw size={19} />} tone="amber" title={`${syncSources.length} 个腾讯来源`} text="当前均为只读镜像，不向腾讯文档写回" /></section><section className="data-snapshot-bar"><span><Database size={17} /><strong>{dataSnapshot.label}</strong><small>{dataSnapshot.students} 位学生 · {dataSnapshot.teachers} 位老师 · 最近导入 {dataSnapshot.importedAt}</small></span><StatusPill tone={sharedSyncState === "synced" ? "green" : sharedSyncState === "saving" ? "blue" : "amber"}>{sharedSyncState === "synced" ? "多人共享在线" : sharedSyncState === "saving" ? "正在保存" : "同步需检查"}</StatusPill></section><section className="sync-layout"><article className="panel ownership-panel"><div className="panel-header"><div><p className="eyebrow">数据所有权</p><h2>系统现在如何保存</h2></div><StatusPill tone="green">已启用</StatusPill></div><OwnershipRow title="学生、老师、排课、任务与业务记录" detail="Supabase 为站内唯一写入目标，所有在线成员共享最新版本" tone="green" label="系统主数据" /><OwnershipRow title="腾讯文档" detail="只读取、只做镜像；本系统不会修改腾讯文档" tone="blue" label="只读来源" /><OwnershipRow title="并发修改" detail="保存前检查版本；发现别人先修改时不会静默覆盖" tone="amber" label="防覆盖" /><OwnershipRow title="外部消息" detail="未连接企业微信前只生成待确认记录，不自动发送" tone="purple" label="人工确认" /></article><aside className="panel source-panel"><div className="panel-header"><div><p className="eyebrow">腾讯文档来源</p><h2>最近读取状态</h2></div><StatusPill tone={syncSources.length ? "green" : "amber"}>{syncSources.length ? `${syncSources.length} 个来源` : "等待首次镜像"}</StatusPill></div>{syncSources.length ? <div className="source-list">{syncSources.map((source) => <div className="source-row" key={source.source_id}><span><strong>{source.title}</strong><small>{source.row_count} 行 · {source.synced_at ? new Date(source.synced_at).toLocaleString("zh-CN") : "未同步"}</small></span><StatusPill tone={source.status === "synced" ? "green" : "amber"}>{source.status === "synced" ? "只读已同步" : source.status}</StatusPill></div>)}</div> : <EmptyState title="尚未写入腾讯文档镜像" detail="系统仍以 Supabase 现有资料正常运行；完成只读读取后会在这里显示来源和时间。" />}</aside></section></section>
  </>;
  const renderReports = () => {
    const reportTasks = tasks.filter((task) => reportOwner === "all" || task.owner === reportOwner);
    const reportStudents = recordStudents.filter((student) => reportOwner === "all" || student.owner === reportOwner);
    const completed = reportTasks.filter((task) => task.status === "done").length;
    const trialCount = reportStudents.filter((student) => student.status === "试听中").length;
    const activeTeachers = recordTeachers.filter((teacher) => teacher.acceptsStudents).length;
    const missingFiles = reportStudents.filter((student) => student.files < 5).length;
    return <>
      <ViewHeading eyebrow="运营结果而非单纯运行成功" title="运营报表" copy="先选择负责人再看同一口径指标；生产版还会提供日期范围和团队视图。" actions={<><select className="filter-select header-filter" value={reportOwner} onChange={(event) => setReportOwner(event.target.value)} aria-label="报表负责人"><option value="all">全部负责人</option>{teamOwnerOptions.map((owner) => <option key={owner}>{owner}</option>)}</select><button className="secondary-button" type="button" onClick={exportDemo}><Download size={17} /> 导出数据</button></>} />
      <section className="report-grid"><ReportCard value={`${completed}/${reportTasks.length}`} label="任务完成" detail={reportOwner === "all" ? "全部负责人" : reportOwner} tone="green" /><ReportCard value={`${trialCount}`} label="进行中的试听" detail="需要持续关注" tone="amber" /><ReportCard value={`${activeTeachers}/${teachers.length}`} label="可接新老师" detail="当前可用资源" tone="blue" /><ReportCard value={`${missingFiles}`} label="资料待补" detail="文件索引少于 5 项" tone="red" /></section>
      <section className="two-column"><article className="panel chart-panel"><div className="panel-header"><div><p className="eyebrow">负责人负载</p><h2>待处理任务</h2></div><StatusPill tone="blue">动态计算</StatusPill></div>{teamOwnerOptions.map((owner) => { const count = tasks.filter((task) => task.owner === owner && task.status !== "done").length; return <div className="bar-row" key={owner}><span>{owner}</span><div><i style={{ width: `${Math.max(12, count * 24)}%` }} /></div><strong>{count} 项</strong></div>; })}</article><article className="panel chart-panel"><div className="panel-header"><div><p className="eyebrow">需要留意</p><h2>数据质量</h2></div><StatusPill tone="amber">人工复核</StatusPill></div><DataIssue title="试听资料缺少索引" count={`${missingFiles} 位学生`} tone="red" />{canViewPayroll && <DataIssue title="薪资规则例外" count={`${payroll.filter((row) => row.status === "需核对").length} 条记录`} tone="amber" />}<DataIssue title="同步冲突" count={sharedSyncState === "conflict" ? "1 项需重新载入" : "0 项待处理"} tone="blue" /><DataIssue title="未确认排课" count={`${bookings.filter((booking) => booking.status === "待确认").length} 节`} tone="purple" /></article></section>
    </>;
  };

  const renderSettings = () => <>
    <ViewHeading eyebrow="规则应可读、可改、可审计" title="规则设置" copy="按提醒、数据和集成分区；每项规则都明确当前是否真正生效。" actions={<button className="secondary-button" type="button" onClick={resetDemo}><RefreshCw size={17} /> 重新载入共享数据</button>} />
    <section className="panel settings-shell"><ViewTabs value={settingsTab} items={[{ id: "reminders", label: "提醒规则" }, { id: "data", label: "数据与备份" }, { id: "integrations", label: "外部集成" }]} onChange={setSettingsTab} label="设置分类" />{settingsTab === "reminders" && <article className="settings-panel settings-form"><div className="settings-intro"><div><p className="eyebrow">强提醒规则</p><h2>时间节点</h2></div><StatusPill tone="amber">多人共享</StatusPill></div><div className="settings-fields"><label>LP 默认提前<input value={rules.lpDays} onChange={(event) => setRules((current) => ({ ...current, lpDays: event.target.value }))} /></label><label>课后反馈检查（小时）<input value={rules.feedbackHours} onChange={(event) => setRules((current) => ({ ...current, feedbackHours: event.target.value }))} /></label><label>续课预销售提前（天）<input value={rules.renewalDays} onChange={(event) => setRules((current) => ({ ...current, renewalDays: event.target.value }))} /></label><label>低课时阈值<input type="number" min="1" value={rules.lowHours} onChange={(event) => setRules((current) => ({ ...current, lowHours: event.target.value }))} /></label><label>考试提前提醒（天）<input type="number" min="1" value={rules.examDays} onChange={(event) => setRules((current) => ({ ...current, examDays: event.target.value }))} /></label><label>逾期升级规则<input value={rules.escalation} onChange={(event) => setRules((current) => ({ ...current, escalation: event.target.value }))} /></label></div><button className="primary-button settings-save" type="button" onClick={() => { addAudit("保存强提醒规则", `LP ${rules.lpDays}、课后 ${rules.feedbackHours}h、低课时 ${rules.lowHours}、考试 ${rules.examDays} 天`, "green"); notify("规则已保存到 Supabase，并同步给其他在线成员"); }}><Check size={17} /> 保存规则</button></article>}{settingsTab === "data" && <article className="settings-panel"><div className="settings-intro"><div><p className="eyebrow">数据安全</p><h2>真实资料与共享保存</h2></div><StatusPill tone="amber">私有访问</StatusPill></div><div className="settings-list"><OwnershipRow title="当前存储" detail="站内业务数据写入 Supabase，在线成员读取同一版本" tone="green" label="已启用" /><OwnershipRow title="真实资料来源" detail="学生总表、教师总表与教务宝只读镜像；缺失字段保留待确认" tone="green" label="已加载" /><OwnershipRow title="数据导出" detail="可随时导出 JSON 副本" tone="green" label="可用" /><OwnershipRow title="共享数据库" detail="Supabase 已启用版本检查与共享写入；冲突不会静默覆盖" tone="green" label="已启用" /></div><div className="button-row"><button className="secondary-button" type="button" onClick={() => setActive("sync")}><FilePlus2 size={16} /> 打开共享导入</button><button className="secondary-button" type="button" onClick={exportDemo}><Download size={16} /> 导出当前数据</button></div></article>}{settingsTab === "integrations" && <article className="settings-panel"><div className="settings-intro"><div><p className="eyebrow">连接状态</p><h2>外部系统</h2></div><StatusPill tone="blue">部分连接</StatusPill></div><div className="integration-list"><OwnershipRow title="企业微信" detail="需要应用权限、员工与客户群映射" tone="amber" label="待 PoC" /><OwnershipRow title="教务宝" detail="学生课时、课程目录与本周排课已只读镜像；不会回写教务宝" tone="green" label="只读已接入" /><OwnershipRow title="腾讯表格" detail="已完成只读来源识别与 Supabase 镜像，不向腾讯文档回写" tone="green" label="只读已接入" /><OwnershipRow title="BiggerBlueButton" detail="已连接托管课堂 API；支持独立老师/学生链接、互动白板、投票、分组讨论和自动录播" tone="green" label="已接入" /></div><button className="secondary-button" type="button" onClick={() => setActive("sync")}><RefreshCw size={16} /> 查看同步状态</button></article>}</section>
  </>;

  const renderAudit = () => {
    const filteredAudit = audit.filter((entry) => {
      const matchesQuery = `${entry.actor} ${entry.action} ${entry.detail}`.toLowerCase().includes(auditQuery.trim().toLowerCase());
      return matchesQuery && (auditFilter === "all" || (auditFilter === "system" ? entry.actor === "系统" : auditFilter === "manual" ? entry.actor !== "系统" : entry.tone === auditFilter));
    });
    const auditPageSize = 8;
    const safePage = Math.min(auditPage, Math.max(1, Math.ceil(filteredAudit.length / auditPageSize)));
    const pagedAudit = filteredAudit.slice((safePage - 1) * auditPageSize, safePage * auditPageSize);
    return <>
      <ViewHeading eyebrow="完整操作留痕" title="操作审计" copy="搜索操作者、动作或关联结果；分页后仍保留统一记录口径。" actions={<button className="secondary-button" type="button" onClick={exportDemo}><Download size={17} /> 导出数据</button>} />
      <section className="panel collection-shell"><ViewTabs value={auditFilter} items={[{ id: "all", label: "全部", count: audit.length }, { id: "manual", label: "人工操作", count: audit.filter((entry) => entry.actor !== "系统").length }, { id: "system", label: "系统事件", count: audit.filter((entry) => entry.actor === "系统").length }, { id: "amber", label: "需关注", count: audit.filter((entry) => entry.tone === "amber").length }]} onChange={(value) => { setAuditFilter(value); setAuditPage(1); }} label="审计保存视图" /><ListToolbar query={auditQuery} onQuery={(value) => { setAuditQuery(value); setAuditPage(1); }} placeholder="搜索操作者、动作或详情" count={`${filteredAudit.length} 条记录`} /><div className="collection-main"><div className="collection-head audit-grid-row"><span>时间</span><span>操作者</span><span>动作</span><span>详情</span></div><div className="collection-viewport">{pagedAudit.length ? pagedAudit.map((entry) => <div className="collection-row audit-grid-row" key={entry.id}><span>{entry.time}</span><span>{entry.actor}</span><span><StatusPill tone={entry.tone}>{entry.action}</StatusPill></span><span>{entry.detail}</span></div>) : <EmptyState title="没有审计记录" detail="调整筛选或搜索条件。" />}</div><Pagination page={safePage} total={filteredAudit.length} pageSize={auditPageSize} onPage={setAuditPage} /></div></section>
    </>;
  };

  const renderClassroom = () => {
    const roomBooking = selectedBooking ?? scopedBookings[0];
    const roomStudent = roomBooking ? studentById(roomBooking.studentId) : undefined;
    const roomTeacher = roomBooking ? teacherById(roomBooking.teacherId) : undefined;
    const classroomStatus = classroomRuntime?.running
      ? { label: "课堂进行中", tone: "green" as Tone }
      : classroomRuntime?.recordings.some((recording) => recording.playbackUrl)
        ? { label: "录播已就绪", tone: "blue" as Tone }
        : roomBooking?.classroom?.status === "ended"
          ? { label: "课堂已结束", tone: "neutral" as Tone }
          : roomBooking?.classroom?.meetingId
            ? { label: "待开课", tone: "amber" as Tone }
            : { label: "未创建", tone: "neutral" as Tone };
    const playback = classroomRuntime?.recordings.find((recording) => recording.playbackUrl);
    return <>
      <ViewHeading eyebrow="BiggerBlueButton 托管课堂" title="网上教室" copy="从排课直接创建一对一课堂。老师与学生使用不同权限链接，支持音视频、屏幕共享、互动白板、投票、分组讨论和自动录播。" actions={roomBooking ? !roomBooking.classroom?.meetingId ? <button className="primary-button" type="button" disabled={classroomBusy} onClick={() => void createClassroom(roomBooking)}><Video size={17} /> 创建在线教室</button> : roomBooking.classroom.status === "ended" ? <button className="secondary-button" type="button" disabled={classroomBusy} onClick={() => void refreshClassroom(roomBooking)}><RefreshCw size={17} /> 刷新录播</button> : <button className="primary-button" type="button" disabled={classroomBusy} onClick={() => void joinTeacherClassroom(roomBooking)}><ExternalLink size={17} /> 老师进入教室</button> : <button className="primary-button" type="button" onClick={() => setModal("booking")}><CalendarPlus size={17} /> 先创建约课</button>} />
      <section className="panel classroom-hub">
        {scopedBookings.length ? <div className="classroom-hub-layout">
          <article className="classroom-room-list"><div className="collection-head classroom-grid-row"><span>课程</span><span>时间</span><span>教室</span></div>{scopedBookings.slice(0, 12).map((booking) => { const student = studentById(booking.studentId); const status = booking.classroom?.status === "running" ? "进行中" : booking.classroom?.status === "ended" ? "已结束" : booking.classroom?.meetingId ? "待开课" : "未创建"; return <button className={`collection-row classroom-grid-row ${roomBooking?.id === booking.id ? "selected" : ""}`} type="button" key={booking.id} onClick={() => { setSelectedBookingId(booking.id); setSelectedBookingDate(booking.date); setSelectedBookingDateId(booking.id); setSelectedStudentId(booking.studentId); setClassroomRuntime(null); setMobilePreview("classroom"); }}><span><strong>{student?.name ?? booking.studentId}</strong><small>{booking.course ?? student?.course ?? booking.kind}</small></span><span><strong>{formatInstant(bookingInstant(booking), scheduleTimezone)}</strong><small>{timezoneLabel(scheduleTimezone)}</small></span><StatusPill tone={status === "进行中" ? "green" : status === "待开课" ? "amber" : status === "已结束" ? "blue" : "neutral"}>{status}</StatusPill></button>; })}</article>
          {roomBooking && <aside className={`classroom-room-preview ${mobilePreview === "classroom" ? "mobile-detail-open" : ""}`}>
            <button className="mobile-preview-close" type="button" aria-label="关闭课堂详情" onClick={() => setMobilePreview(null)}><ChevronLeft size={20} /> 返回课堂列表</button>
            <div className="preview-header"><div><p className="eyebrow">{roomBooking.id} · {roomTeacher?.name ?? "老师待关联"}</p><h2>{roomStudent?.name ?? "学生"}</h2></div><StatusPill tone={classroomStatus.tone}>{classroomStatus.label}</StatusPill></div>
            <div className="classroom-link-preview"><Video size={24} /><span><strong>一对一网上教室</strong><small>{classroomRuntime?.running ? `${classroomRuntime.participantCount} 人在线 · ${classroomRuntime.moderatorCount} 位老师` : "老师与学生使用独立权限链接"}</small></span></div>
            <div className="detail-section"><span>课程时间</span><strong>{formatInstant(bookingInstant(roomBooking), scheduleTimezone)}</strong><p>{timezoneLabel(scheduleTimezone)} · {roomBooking.duration} 分钟</p></div>
            <div className="detail-section"><span>可用课堂工具</span><div className="classroom-tool-tags"><span>音视频</span><span>屏幕共享</span><span>互动白板</span><span>投票</span><span>分组讨论</span><span>自动录播</span></div></div>
            {!roomBooking.classroom?.meetingId ? <button className="primary-button full" type="button" disabled={classroomBusy} onClick={() => void createClassroom(roomBooking)}><Video size={16} /> {classroomBusy ? "正在创建…" : "创建在线教室"}</button> : <>
              {roomBooking.classroom.status !== "ended" && <button className="primary-button full" type="button" disabled={classroomBusy} onClick={() => void joinTeacherClassroom(roomBooking)}><ExternalLink size={16} /> 老师进入教室</button>}
              {roomBooking.classroom.status !== "ended" && <button className="secondary-button full" type="button" disabled={classroomBusy} onClick={() => void copyStudentClassroomLink(roomBooking)}><Copy size={16} /> 复制学生进入链接</button>}
              <button className="secondary-button full" type="button" disabled={classroomBusy} onClick={() => void refreshClassroom(roomBooking)}><RefreshCw size={16} /> 刷新教室状态</button>
              {(classroomRuntime?.running || roomBooking.classroom.status === "running") && <button className="danger-button full" type="button" disabled={classroomBusy} onClick={() => void endClassroom(roomBooking)}><ShieldCheck size={16} /> 结束课堂并结课</button>}
              {playback?.playbackUrl && <a className="secondary-button full classroom-recording-link" href={playback.playbackUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} /> 打开课堂录播</a>}
              {!playback?.playbackUrl && roomBooking.classroom.status === "ended" && <div className="classroom-recording-pending"><Clock3 size={16} /><span><strong>录播处理中</strong><small>供应商处理完成后会在这里出现回放链接</small></span></div>}
            </>}
          </aside>}
        </div> : <EmptyState title="还没有可用课程" detail="先为学生创建排课，系统会从排课生成对应的在线教室。" />}
      </section>
    </>;
  };

  const renderAccounts = () => {
    const accounts = [
      { name: "Admin", operator: "Nixon", role: "超级管理员", login: "管理员独立密码", permissions: ["全局学生与老师", "排课与运营", "课时与薪资", "账号与权限"] },
      { name: DEMO_LIMITED_ADMIN_USER, operator: DEMO_LIMITED_ADMIN_USER, role: "运营管理员", login: "独立密码", permissions: ["全局学生与老师", "排课与运营", "同步来源", "账号与权限"] },
      ...DEMO_STAFF_USERS.map((name) => ({ name, operator: name, role: "教务账号", login: name, permissions: ["负责学生", "老师与排课", "LP 与续课", "文件与消息"] })),
      ...DEMO_TEACHER_USERS.map((name) => ({ name, operator: name, role: "老师账号", login: name, permissions: ["自己的学生", "自己的排课", "网上教室", "学生资料只读"] })),
    ];
    const selectedAccount = accounts.find((account) => account.name === selectedAccountName) ?? accounts[0];
    const copyCredential = async () => {
      if (selectedAccount.operator === "Nixon" || selectedAccount.operator === DEMO_LIMITED_ADMIN_USER) { notify("管理员密码不会在页面中显示或复制"); return; }
      await navigator.clipboard.writeText(selectedAccount.login);
      addAudit("复制演示登录凭证", `${selectedAccount.name} · ${selectedAccount.role}`, "blue");
      notify(`${selectedAccount.name} 的演示登录名已复制`);
    };
    return <>
      <ViewHeading eyebrow="演示账号 · 正式上线前再升级强密码" title="账号与权限" copy="集中查看管理员、运营管理员、教务和老师账号。演示阶段教务和老师使用姓名登录；管理员使用独立密码。" actions={<button className="secondary-button" type="button" onClick={() => notify("正式上线时可接 Supabase Auth、强密码与密码重置邮件")}><UserPlus size={17} /> 新增账号</button>} />
      <section className="panel account-admin-shell">
        <div className="account-admin-layout">
          <article className="account-list"><div className="collection-head account-grid-row"><span>账号</span><span>角色</span><span>登录方式</span></div>{accounts.map((account) => <button className={`collection-row account-grid-row ${selectedAccount.name === account.name ? "selected" : ""}`} type="button" key={account.name} onClick={() => setSelectedAccountName(account.name)}><span className="table-person"><Avatar initials={account.name === "Admin" ? "AD" : initials(account.name)} tone={account.role === "老师账号" ? "green" : account.role === "教务账号" ? "blue" : "purple"} /><span><strong>{account.name}</strong><small>状态：已启用</small></span></span><StatusPill tone={account.role === "老师账号" ? "green" : account.role === "教务账号" ? "blue" : "purple"}>{account.role}</StatusPill><span>{account.operator === "Nixon" || account.operator === DEMO_LIMITED_ADMIN_USER ? "独立密码" : "姓名登录"}</span></button>)}</article>
          <aside className="account-preview"><div className="preview-header"><div><p className="eyebrow">账号权限</p><h2>{selectedAccount.name}</h2></div><StatusPill tone="green">已启用</StatusPill></div><div className="student-facts account-facts"><span><small>角色</small><strong>{selectedAccount.role}</strong><em>演示权限组</em></span><span><small>登录方式</small><strong>{selectedAccount.operator === "Nixon" || selectedAccount.operator === DEMO_LIMITED_ADMIN_USER ? "独立密码" : "姓名登录"}</strong><em>{selectedAccount.operator === "Nixon" || selectedAccount.operator === DEMO_LIMITED_ADMIN_USER ? "密码不在页面显示" : "当前演示阶段"}</em></span></div><div className="detail-section"><span>可访问功能</span><div className="permission-list">{selectedAccount.permissions.map((permission) => <p key={permission}><CheckCircle2 size={15} /> {permission}</p>)}</div></div><div className="account-actions"><button className="primary-button full" type="button" onClick={() => switchOperator(selectedAccount.operator)}><UserCog size={16} /> 查看此账号视图</button><button className="secondary-button full" type="button" onClick={copyCredential}><Copy size={16} /> {selectedAccount.operator === "Nixon" || selectedAccount.operator === DEMO_LIMITED_ADMIN_USER ? "管理员密码保持隐藏" : "复制演示登录名"}</button></div><div className="form-notice"><CircleAlert size={16} /> 正式上线前会把姓名登录替换成独立账号、强密码和可审计的密码重置流程。</div></aside>
        </div>
      </section>
    </>;
  };

  const renderView = () => {
    if (!canViewPayroll && active === "payroll") return renderDashboard();
    if (!isAdminView && !(isTeacherView ? teacherSectionIds : staffSectionIds).has(active)) return renderDashboard();
    switch (active) {
      case "dashboard": return renderDashboard();
      case "students": return renderStudents();
      case "teachers": return renderTeachers();
      case "schedule": return renderSchedule();
      case "classroom": return renderClassroom();
      case "courses": return renderCourses();
      case "lp": return renderLp();
      case "operations": return renderOperations();
      case "renewals": return renderRenewals();
      case "payroll": return renderPayroll();
      case "messages": return renderMessages();
      case "files": return renderFiles();
      case "sync": return renderSync();
      case "reports": return renderReports();
      case "settings": return renderSettings();
      case "accounts": return renderAccounts();
      case "audit": return renderAudit();
    }
  };

  const submitStudent = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const course = String(data.get("course") ?? "").trim();
    if (!name || !course) return;
    const segment = String(data.get("segment") ?? "试听") as StudentSegment;
    const lpNeed = String(data.get("lpNeed") ?? (segment === "试听" ? "试听LP" : "无需LP")) as LpNeed;
    const newStudent: Student = { id: id("STU"), name, initials: initials(name), status: segment === "试听" ? "待排课" : "在读", segment, owner: String(data.get("owner") ?? "思佳"), planner: String(data.get("planner") ?? "待分配"), course, grade: String(data.get("grade") ?? "待确认"), gradeBaseYear: new Date().getFullYear(), location: String(data.get("location") ?? "VIC"), timezone: cleanTimezone(data.get("timezone")), guardian: String(data.get("guardian") ?? "待补充"), teacher: "待匹配", next: segment === "试听" ? "完成试听交接" : lpNeed === "无需LP" ? "确认首次排课" : `创建${lpNeed}`, nextTone: "blue", files: 0, lpNeed, reportProgress: "未记录", followUp: "未记录", notes: String(data.get("notes") ?? "无特殊备注"), remainingHours: data.get("remainingHours") ? Number(data.get("remainingHours")) : undefined };
    setStudents((current) => [newStudent, ...current]);
    setSelectedStudentId(newStudent.id);
    const generatedTasks: Task[] = [{ id: id("TSK"), title: segment === "试听" ? "完成试听交接与老师匹配" : "确认首次排课与资料", owner: newStudent.owner, studentId: newStudent.id, due: "今天", status: "today", tone: "blue", category: segment === "试听" ? "试听" : "排课", trigger: "新建学生记录" }];
    if (lpNeed !== "无需LP") generatedTasks.push({ id: id("TSK"), title: `创建${lpNeed}`, owner: newStudent.owner, studentId: newStudent.id, due: "开课前 N-3", status: "upcoming", tone: "amber", category: "LP", trigger: "建档时选择需要 LP" });
    setTasks((current) => [...generatedTasks, ...current]);
    addAudit("新建学生档案", `${newStudent.name} · ${newStudent.id}`, "green");
    setModal(null); setActive("students"); notify("学生档案和首个试听任务已创建");
  };

  const submitStudentEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const course = String(data.get("course") ?? "").trim();
    if (!name || !course) { notify("学生姓名和课程不能为空"); return; }
    const before = selectedStudent;
    setStudents((current) => current.map((student) => student.id === selectedStudent.id ? {
      ...student,
      name,
      initials: initials(name),
      course,
      grade: String(data.get("grade") ?? "待确认"),
      owner: isAdminView ? String(data.get("owner") ?? student.owner) : student.owner,
      planner: String(data.get("planner") ?? student.planner ?? "待分配"),
      guardian: String(data.get("guardian") ?? "待补充"),
      notes: String(data.get("notes") ?? "无特殊备注"),
      location: String(data.get("location") ?? student.location ?? "VIC"),
      timezone: cleanTimezone(data.get("timezone")),
    } : student));
    addAudit("编辑学生档案", `${before.name}（${before.id}）· ${isAdminView ? "姓名/课程/负责人" : "姓名/课程"}资料已更新`, "blue");
    setModal(null);
    notify("学生档案已更新");
  };

  const submitStudentEvidence = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (evidenceUploadBusy) return;
    const data = new FormData(event.currentTarget);
    const attachment = data.get("attachment");
    const title = String(data.get("title") ?? "家长沟通记录").trim() || "家长沟通记录";
    if (!(attachment instanceof File) || attachment.size === 0) { notify("请选择需要归档的图片"); return; }
    setEvidenceUploadBusy(true);
    try {
      const upload = new FormData();
      upload.set("studentId", selectedStudent.id);
      upload.set("file", attachment);
      const response = await fetch("/api/fu-attachments", { method: "POST", body: upload });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.id || !body.url) throw new Error(body.error || "沟通截图上传失败");
      const fileRecord: FileRecord = { id: `EVID-${body.id}`, studentId: selectedStudent.id, title: `${title} · ${body.fileName || attachment.name}`, type: "课堂反馈", source: String(body.url), addedAt: `今天 ${nowLabel()}` };
      setFiles((current) => [fileRecord, ...current]);
      setStudents((current) => current.map((student) => student.id === selectedStudent.id ? { ...student, files: student.files + 1, followUp: new Date().toISOString() } : student));
      addAudit("归档学生沟通截图", `${selectedStudent.name} · ${title} · ${body.fileName || attachment.name}`, "green");
      setModal(null);
      notify("沟通截图已归档到学生档案");
    } catch (error) {
      notify(error instanceof Error ? error.message : "沟通截图上传失败");
    } finally {
      setEvidenceUploadBusy(false);
    }
  };

  const submitTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const studentId = String(data.get("studentId") ?? selectedStudent.id);
    const title = String(data.get("title") ?? "").trim();
    if (!title) return;
    const task: Task = { id: id("TSK"), title, owner: String(data.get("owner") ?? "思佳"), studentId, due: String(data.get("due") ?? "待设定"), status: "today", tone: "blue", category: String(data.get("category") ?? "资料") as Task["category"], trigger: "人工创建" };
    setTasks((current) => [task, ...current]); addAudit("创建内部任务", `${title} · ${studentById(studentId)?.name}`, "blue"); setModal(null); notify("任务已加入强提醒队列");
  };

  const submitLp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const provisional = data.get("provisional") === "on";
    let studentId = String(data.get("studentId") ?? selectedStudent.id);
    const workflowType = String(data.get("workflowType") ?? "试听 LP") as LpWorkflowType;
    const owner = isAdminView ? String(data.get("owner") ?? selectedStudent.owner ?? "思佳") : selectedStudent.owner;
    const planner = String(data.get("planner") ?? selectedStudent.planner ?? "Tara");
    let provisionalStudent: Student | undefined;
    let workflowStudent: Student | undefined;
    if (provisional) {
      if (!isAdminView) { notify("无姓名临时建档需要管理员处理，避免出现未保存的学生记录"); return; }
      const provisionalCourse = String(data.get("provisionalCourse") ?? "").trim();
      const provisionalName = String(data.get("provisionalName") ?? "").trim();
      if (!provisionalCourse) { notify("暂未有姓名时，至少要填写科目/课程"); return; }
      studentId = id("STU-TEMP");
      const displayName = provisionalName || `姓名待补 · ${provisionalCourse}`;
      provisionalStudent = { id: studentId, name: displayName, initials: provisionalName ? initials(provisionalName) : "待", status: "待确认", segment: workflowType === "直报 LP" ? "已报名" : "试听", owner, planner, course: provisionalCourse, grade: "待确认", gradeBaseYear: new Date().getFullYear(), location: "VIC", timezone: "Australia/Melbourne", guardian: "待补充", teacher: "待匹配", next: "补充学生姓名并完成 LP", nextTone: "amber", files: 0, lpNeed: lpWorkflowOptions.find((option) => option.id === workflowType)?.lpNeed ?? "待确认", reportProgress: "未记录", followUp: "未记录", notes: "临时 LP 档案，姓名待补" };
      workflowStudent = provisionalStudent;
      setStudents((current) => [provisionalStudent!, ...current]);
      addAudit("创建临时学生档案", `${displayName} · ${provisionalCourse} · ${owner}`, "amber");
    } else {
      const existingStudent = studentById(studentId);
      workflowStudent = existingStudent ? { ...existingStudent, owner, planner } : undefined;
      setStudents((current) => current.map((student) => student.id === studentId ? { ...student, owner, planner } : student));
    }
    if (!createLpWorkflow(studentId, workflowType, data.get("parentFollowUp") === "on", data.get("teacherPrep") === "on", workflowStudent)) {
      notify("没有找到该学生，未创建 LP 工作流");
      return;
    }
    setSelectedStudentId(studentId);
    setModal(null);
    setActive("lp");
    notify("已创建 LP 工作流和对应强提醒");
  };

  const submitAva = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const teacherId = String(data.get("teacherId") ?? selectedTeacher.id);
    const day = Number(data.get("day") ?? 1);
    const start = String(data.get("start") ?? "16:00");
    const end = String(data.get("end") ?? "18:00");
    if (!teacherById(teacherId)) { notify("请从老师清单中选择需要录入 AVA 的老师"); return; }
    if (!start || !end || start >= end) { notify("请填写有效的 AVA 起止时间"); return; }
    const isEditing = avaDraft?.teacherId === teacherId;
    setTeachers((current) => current.map((teacher) => {
      if (teacher.id !== teacherId) return teacher;
      const availabilitySlots = isEditing
        ? (teacher.availabilitySlots ?? []).map((slot, index) => index === avaDraft.slotIndex ? { day, start, end } : slot)
        : [...(teacher.availabilitySlots ?? []), { day, start, end }];
      return {
        ...teacher,
        availabilitySlots,
        availabilityUpdated: `手动${isEditing ? "修改" : "结构化"} · 今天 ${nowLabel()}`,
        availability: availabilitySlotsText(availabilitySlots),
      };
    }));
    const teacher = teacherById(teacherId);
    setSelectedTeacherId(teacherId);
    addAudit(isEditing ? "修改老师 AVA" : "结构化老师 AVA", `${teacher?.name ?? teacherId} · ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][day]} ${start}-${end}`, isEditing ? "blue" : "green");
    setAvaDraft(null);
    setModal(null);
    notify(isEditing ? "AVA 已更新并重新用于排课检查" : "AVA 已加入可约日历，可参与排课和代课筛选");
  };

  const submitBooking = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const studentId = String(data.get("studentId") ?? selectedStudent.id);
    const teacherId = isTeacherView ? currentTeacher?.id ?? "" : String(data.get("teacherId") ?? selectedTeacher.id);
    const date = String(data.get("date") ?? ""); const start = String(data.get("start") ?? ""); const duration = Number(data.get("duration") ?? 60);
    const inputTimezone = cleanTimezone(data.get("timezone"));
    const kind = String(data.get("kind") ?? "试听") as Booking["kind"];
    const recurring = data.get("recurring") === "on";
    const repeatCountRaw = String(data.get("repeatCount") ?? "").trim();
    const parsedRepeatCount = Number(repeatCountRaw);
    const repeatCount: number | undefined = recurring
      ? repeatCountRaw && Number.isFinite(parsedRepeatCount)
        ? Math.max(1, Math.min(104, parsedRepeatCount))
        : bookingDraft?.recurring && bookingDraft.repeatCount == null
          ? undefined
          : 12
      : 1;
    if (isTeacherView && !scopedStudentIds.has(studentId)) { notify("老师账号只能为自己的学生安排课程。"); return; }
    if (!teacherId) { notify("当前老师账号没有匹配到老师档案，请联系管理员。"); return; }
    if (!date || !start) { notify("请填写课程日期和开始时间。"); return; }
    const validationCount = recurring ? repeatCount ?? 104 : 1;
    const proposedDates = Array.from({ length: validationCount }, (_, index) => shiftIsoDate(date, index * 7));
    const conflictDate = proposedDates.find((occurrenceDate) => scheduleConflict(studentId, teacherId, occurrenceDate, start, duration, inputTimezone, bookingDraft?.id));
    if (conflictDate) { notify(`${conflictDate} 的学生或老师已有重叠课程，请调整本轮排课。`); return; }
    const teacher = teacherById(teacherId); const student = studentById(studentId);
    if (kind === "试听" && teacher && !teacher.acceptsStudents) { notify(`${teacher.name} 当前不是“可接新生”状态，不能安排试听。`); return; }
    const unavailableDate = teacher ? proposedDates.find((occurrenceDate) => !teacherAvailableAt(teacher, occurrenceDate, start, duration, inputTimezone)) : undefined;
    if (teacher && unavailableDate) { notify(`${unavailableDate} 不在 ${teacher.name} 的结构化 AVA 内，请调整本轮排课。`); return; }
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
      classroom: { meetingId: `yinling-${bookingId}`, status: "ready", createdAt: new Date().toISOString() },
    };
    if (bookingDraft) {
      booking.classroom = bookingDraft.classroom;
      setBookings((current) => current.map((entry) => entry.id === bookingDraft.id ? { ...entry, ...booking } : entry));
      setSelectedBookingId(booking.id);
      setSelectedBookingDate(date);
      setSelectedBookingDateId(booking.id);
      addAudit("编辑排课", `${student?.name} · ${date} ${start} · ${teacher?.name} · ${recurring ? repeatCount == null ? "长期" : `${repeatCount} 节` : "单次"}`, "blue");
      setBookingDraft(null);
      setModal(null);
      setActive("schedule");
      notify("课程已更新并重新完成冲突检查");
      return;
    }
    setBookings((current) => [...current, booking]);
    setSelectedBookingId(booking.id);
    setSelectedBookingDate(date);
    setSelectedBookingDateId(booking.id);
    if (!isTeacherView) {
      setStudents((current) => current.map((item) => item.id === studentId ? { ...item, teacher: teacher?.name ?? "待匹配", status: kind === "试听" ? "试听中" : item.status, next: "完成 LP 与 N-2 检查", nextTone: "amber" } : item));
      createWorkflowTasks(studentId, kind === "试听");
    }
    addAudit("创建排课", `${student?.name} · ${date} ${start} · ${teacher?.name} · ${recurring ? repeatCount == null ? "长期" : `${repeatCount} 节` : "单次"}`, "green");
    setModal(null); setActive("schedule"); notify(isTeacherView ? "约课已创建，等待教务确认" : "排课和在线教室已创建，并生成 LP、N-2 和课后检查任务");
  };

  const submitOperation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isTeacherView) { notify("老师账号不能创建教务异常，请联系负责教务处理"); return; }
    const data = new FormData(event.currentTarget);
    const studentId = String(data.get("studentId") ?? selectedStudent.id);
    const type = String(data.get("type") ?? "调课") as Operation["type"];
    const detail = String(data.get("detail") ?? "").trim();
    const teacherId = String(data.get("teacherId") ?? "");
    const eventStart = String(data.get("eventStart") ?? "");
    const eventEnd = String(data.get("eventEnd") ?? "");
    if (!detail) return;
    if ((type === "请假" || type === "老师请假" || type === "代课" || type === "老师离职") && !teacherById(teacherId)) { notify("请从老师清单选择涉及老师后再记录请假、代课或离职"); return; }

    const teacherAbsence = Boolean(teacherId && (type === "请假" || type === "老师请假" || type === "老师离职"));
    const substitution = Boolean(teacherId && type === "代课");
    const teacherImpact = teacherAbsence || substitution;
    if (teacherImpact && (!eventStart || !eventEnd || eventStart > eventEnd)) { notify("请填写有效的影响起止日期，再生成请假、代课或离职任务"); return; }
    if (!teacherImpact && !studentById(studentId)) { notify("请从学生清单选择需要记录异常的学生"); return; }

    const affectedOccurrences = teacherImpact
      ? bookings
        .filter((booking) => booking.teacherId === teacherId
          && (!substitution || booking.studentId === studentId)
          && (!operationDraft?.sourceBookingId || booking.id === operationDraft.sourceBookingId))
        .flatMap((booking) => bookingOccurrencesWithinRange(booking, eventStart, eventEnd))
      : [];
    if (teacherImpact && !affectedOccurrences.length) { notify("在所选日期范围内未找到受影响课程，未创建任务。"); return; }

    const affectedStudentIds = Array.from(new Set(affectedOccurrences.map((booking) => booking.studentId)));
    const targetStudentIds = teacherImpact ? affectedStudentIds : [studentId];
    const createdAt = `今天 ${nowLabel()}`;
    const generatedOperations = targetStudentIds.map((targetId) => {
      const relatedOccurrences = affectedOccurrences.filter((booking) => booking.studentId === targetId);
      const candidateLists = relatedOccurrences.map((booking) => substitutionCandidates(booking, teacherId).map((teacher) => teacher.id));
      const candidateIds = candidateLists.length
        ? candidateLists.slice(1).reduce((shared, candidates) => shared.filter((teacherId) => candidates.includes(teacherId)), candidateLists[0])
        : [];
      return { id: id("OPS"), studentId: targetId, type, detail, status: "待处理" as const, createdAt, teacherId: teacherImpact ? teacherId : undefined, eventStart: teacherImpact ? eventStart : undefined, eventEnd: teacherImpact ? eventEnd : undefined, affectedLessonCount: relatedOccurrences.length || undefined, recommendedTeacherIds: candidateIds, sourceBookingId: substitution ? operationDraft?.sourceBookingId : undefined };
    });
    const generatedTasks: Task[] = targetStudentIds.flatMap((targetId): Task[] => {
      const student = studentById(targetId);
      const relatedOccurrences = affectedOccurrences.filter((booking) => booking.studentId === targetId).sort((left, right) => left.date.localeCompare(right.date));
      const affectedDates = relatedOccurrences.map((booking) => booking.date);
      const lastAffectedDate = affectedDates.at(-1) ?? eventEnd;
      const handoverBaseDate = affectedDates.length > 1 ? affectedDates.at(-2)! : lastAffectedDate;
      if (teacherImpact && (type === "请假" || type === "老师请假" || type === "代课")) return [
        { id: id("TSK"), title: "选择可代课老师", owner: "Tiffany", studentId: targetId, ...taskTiming(isoDateInTimezone(new Date(), "Australia/Melbourne"), "Australia/Melbourne", "red"), category: "排课", trigger: "老师请假：候选代课老师筛选" },
        { id: id("TSK"), title: "确认最终推荐老师并交龙老师确认", owner: "思佳", studentId: targetId, ...taskTiming(shiftIsoDate(eventStart, -14), "Australia/Melbourne", "amber"), category: "排课", trigger: "老师请假：最终推荐确认" },
        { id: id("TSK"), title: "完成家长沟通并记录请假/代课原因", owner: student?.owner ?? "待分配", studentId: targetId, ...taskTiming(shiftIsoDate(eventStart, -7), "Australia/Melbourne", "red"), category: "资料", trigger: "老师请假：教务必须写明原因" },
        { id: id("TSK"), title: "请原老师补充代课 LP 指定内容与资料", owner: student?.owner ?? "待分配", studentId: targetId, ...taskTiming(shiftIsoDate(lastAffectedDate, 1), "Australia/Melbourne", "blue"), category: "LP", trigger: "老师请假：代课 LP 交接" },
      ];
      if (teacherAbsence && type === "老师离职") return [
        { id: id("TSK"), title: "筛选并确认推荐老师名单", owner: "Tiffany", studentId: targetId, ...taskTiming(shiftIsoDate(eventEnd, -14), "Australia/Melbourne", "red"), category: "排课", trigger: "老师离职：推荐老师名单" },
        { id: id("TSK"), title: "开启新老师沟通", owner: student?.owner ?? "待分配", studentId: targetId, ...taskTiming(shiftIsoDate(eventEnd, -14), "Australia/Melbourne", "amber"), category: "排课", trigger: "老师离职：新老师沟通" },
        { id: id("TSK"), title: "确认 Handover Notes 与原老师约定 DDL", owner: student?.owner ?? "待分配", studentId: targetId, ...taskTiming(shiftIsoDate(handoverBaseDate, 1), "Australia/Melbourne", "blue"), category: "LP", trigger: "老师离职：交接资料" },
        { id: id("TSK"), title: "告知家长并记录最终安排", owner: student?.owner ?? "待分配", studentId: targetId, ...taskTiming(shiftIsoDate(handoverBaseDate, 1), "Australia/Melbourne", "red"), category: "资料", trigger: "老师离职：家长沟通" },
        { id: id("TSK"), title: "向龙老师汇报离职交接进度", owner: "思佳", studentId: targetId, ...taskTiming(shiftIsoDate(eventEnd, -7), "Australia/Melbourne", "amber"), category: "排课", trigger: "老师离职：管理确认" },
      ];
      return [{ id: id("TSK"), title: `${type}：${detail}`, owner: student?.owner ?? "待分配", studentId: targetId, due: "待人工确认", status: "today" as const, tone: "amber" as const, category: "排课" as const, trigger: `${type} 记录后自动生成` }];
    });
    setOperations((current) => [...generatedOperations, ...current]);
    setTasks((current) => [...generatedTasks, ...current]);
    setSelectedOperationId(generatedOperations[0].id);
    setSelectedStudentId(generatedOperations[0].studentId);
    const teacher = teacherById(teacherId);
    addAudit("记录教务异常", teacherImpact ? `${teacher?.name ?? "老师"} · ${type} · 影响 ${affectedOccurrences.length} 节课` : `${studentById(studentId)?.name} · ${type}`, "amber");
    setOperationDraft(null); setModal(null); setActive("operations");
    notify(teacherImpact ? `已识别 ${affectedOccurrences.length} 节受影响课程，并生成 ${generatedTasks.length} 项后续任务` : "异常已记录，并生成后续处理任务");
  };

  const submitRenewalFollowUp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renewalDraft || renewalUploadBusy) return;

    const data = new FormData(event.currentTarget);
    const student = studentById(renewalDraft.studentId);
    if (!student || !isActiveStudent(student)) {
      notify("该学生当前不是在读/待续课状态，未保存本次跟进");
      return;
    }

    const result = String(data.get("result") ?? "已跟进") as RenewalStatus;
    const note = String(data.get("note") ?? "").trim();
    const attemptedAtInput = String(data.get("attemptedAt") ?? currentLocalDateTimeValue());
    const attemptedAtDate = new Date(attemptedAtInput);
    const attemptedAt = Number.isNaN(attemptedAtDate.getTime()) ? new Date().toISOString() : attemptedAtDate.toISOString();
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
          title: `续课 FU · ${formatFollowUpTime(attemptedAt)} · ${attachmentTitle}`,
          type: "续课 FU",
          source: String(body.url),
          addedAt: `今天 ${nowLabel()}`,
        };
        setFiles((current) => current.some((item) => item.id === fileRecord.id) ? current : [fileRecord, ...current]);
        setStudents((current) => current.map((item) => item.id === renewalDraft.studentId ? { ...item, files: item.files + 1 } : item));
      }

      const contacted = result !== "本次未跟进";
      const updated: Renewal = {
        ...renewalDraft,
        status: result,
        lastAttemptAt: attemptedAt,
        lastContactedAt: contacted ? attemptedAt : renewalDraft.lastContactedAt,
        followUpNote: note,
        followUpAttachmentId: attachmentId,
        followUpAttachmentTitle: attachmentTitle,
      };
      setRenewals((current) => current.some((item) => item.id === updated.id)
        ? current.map((item) => item.id === updated.id ? updated : item)
        : [updated, ...current]);
      if (contacted) {
        setStudents((current) => current.map((item) => item.id === updated.studentId ? { ...item, followUp: attemptedAt } : item));
      }
      addAudit(
        "记录续课跟进",
        `${student.name} · ${result} · ${formatFollowUpTime(attemptedAt)}${attachmentTitle ? ` · 已归档截图 ${attachmentTitle}` : ""}${note ? ` · ${note}` : ""}`,
        result === "本次未跟进" ? "amber" : result === "已确认" ? "green" : "blue",
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
    event.preventDefault(); const data = new FormData(event.currentTarget); const studentId = String(data.get("studentId") ?? selectedStudent.id); const title = String(data.get("title") ?? "").trim(); if (!title) return;
    const file: FileRecord = { id: id("FIL"), studentId, title, type: String(data.get("type") ?? "其他") as FileRecord["type"], source: String(data.get("source") ?? "人工登记") || "人工登记", addedAt: `今天 ${nowLabel()}` };
    setFiles((current) => [file, ...current]); setStudents((current) => current.map((student) => student.id === studentId ? { ...student, files: student.files + 1 } : student)); addAudit("登记资料链接", `${title} · ${studentById(studentId)?.name}`, "blue"); setModal(null); notify("已在文件索引中登记资料");
  };

  const submitTemplate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const studentId = String(data.get("studentId") ?? selectedStudent.id); const kind = String(data.get("kind") ?? "内部提醒"); const body = String(data.get("body") ?? "").trim(); if (!body) return;
    const message: Message = { id: id("MSG"), studentId, kind, recipient: String(data.get("recipient") ?? "内部负责人"), body, status: "待人工确认", createdAt: `今天 ${nowLabel()}` };
    setMessages((current) => [message, ...current]); setSelectedMessageId(message.id); addAudit("创建消息待确认", `${kind} · ${studentById(studentId)?.name}`, "blue"); setModal(null); setActive("messages"); notify("消息已加入队列，等待人工确认");
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">吟</span><div><strong>吟领教务</strong><small>Learning Operations</small></div></div>
        <div className="workspace-switch"><span className="workspace-dot" /> {isAdminView ? `${operatorLabel(currentOperator)} 管理视图` : isTeacherView ? `${currentOperator} 老师工作台` : `${currentOperator} 工作视图`} <ChevronDown size={15} /></div>
        <button className="new-button" type="button" onClick={() => setModal(isTeacherView ? "booking" : "task")}><Plus size={17} /> {isTeacherView ? "新建约课" : "新建"}</button>
        <nav aria-label="主要导航">
          <p>学生与教务</p>
          {visibleNavigation.filter((item) => item.group === "work").map((item) => {
            const Icon = item.icon;
            return <button className={active === item.id ? "nav-item active" : "nav-item"} type="button" key={item.id} onClick={() => setActive(item.id)}><Icon size={18} /><span>{item.label}</span>{item.id === "dashboard" && <b>{scopedTasks.filter((task) => task.status !== "done").length}</b>}</button>;
          })}
          <p>运营与系统</p>
          {visibleNavigation.filter((item) => item.group === "support").map((item) => {
            const Icon = item.icon;
            return <button className={active === item.id ? "nav-item active" : "nav-item"} type="button" key={item.id} onClick={() => setActive(item.id)}><Icon size={18} /><span>{item.label}</span></button>;
          })}
        </nav>
        <div className="sidebar-foot"><StatusPill tone={sharedSyncState === "synced" ? "green" : sharedSyncState === "saving" ? "blue" : "amber"}>{sharedSyncState === "synced" ? "多人共享在线" : sharedSyncState === "saving" ? "正在保存" : "同步需检查"}</StatusPill><span>{dataSnapshot.label}</span></div>
      </aside>
      <section className="main-stage">
        <header className="topbar">
          <div className="breadcrumb"><span>吟领教育</span><ChevronRight size={15} /><strong>{navigation.find((item) => item.id === active)?.label}</strong></div>
          <div className="top-actions">
            <button className="top-search" type="button" onClick={() => setGlobalSearchOpen(true)}><Search size={16} /> 搜索学生、老师或 ID <kbd>Cmd K</kbd></button>
            <IconButton label="查看提醒" onClick={() => setActive("dashboard")}><ListTodo size={18} /></IconButton>
            <span className={`live-sync ${sharedSyncState}`} title={sharedSyncMessage}><i />{sharedSyncState === "synced" ? "已同步" : sharedSyncState === "saving" ? "保存中" : sharedSyncState === "conflict" ? "有冲突" : "离线"}</span>
            <div className="operator-menu-wrap" ref={operatorMenuRef}>
              <button className="operator" type="button" aria-haspopup="menu" aria-expanded={operatorMenuOpen} onClick={() => setOperatorMenuOpen((open) => !open)}>
                <Avatar initials={isAdminView ? "AD" : currentOperator.slice(0, 2).toUpperCase()} tone={operatorProfile(currentOperator).tone} />
                <span className="operator-copy"><small>{operatorProfile(currentOperator).role}</small><strong>{operatorLabel(currentOperator)}</strong></span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {operatorMenuOpen ? <section className="operator-menu" role="menu" aria-label="切换工作身份">
                <header><span>切换工作身份</span><small>不同身份看到不同的工作范围</small></header>
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
                  <button className="operator-logout" type="button" disabled={logoutBusy} onClick={() => void logout()}><LogOut size={15} aria-hidden="true" />{logoutBusy ? "正在退出" : "退出登录"}</button>
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
          return <button className={active === item.id ? "active" : ""} type="button" key={item.id} onClick={() => navigateMobile(item.id)}><Icon size={21} /><span>{item.label === "学生档案" ? "学生" : item.label === "消息队列" ? "消息" : item.label}</span></button>;
        })}
        <button className={mobileMenuOpen || !visibleMobileNavigation.some((item) => item.id === active) ? "active" : ""} type="button" onClick={() => setMobileMenuOpen(true)}><MoreHorizontal size={22} /><span>更多</span></button>
      </nav>

      {mobileMenuOpen && <div className="mobile-nav-backdrop" role="presentation" onMouseDown={() => setMobileMenuOpen(false)}>
        <section className="mobile-nav-drawer" role="dialog" aria-modal="true" aria-label="全部功能" onMouseDown={(event) => event.stopPropagation()}>
          <header><div><p className="eyebrow">全部功能</p><h2>去哪里处理工作</h2></div><IconButton label="关闭功能菜单" onClick={() => setMobileMenuOpen(false)}><X size={19} /></IconButton></header>
          <label className="mobile-operator-picker"><span>当前工作视图</span><select value={currentOperator} onChange={(event) => requestOperatorSwitch(event.target.value)} aria-label="切换当前操作人">{operatorOptions.map((operator) => <option value={operator} key={operator}>{operatorLabel(operator)} · {operatorProfile(operator).role}</option>)}</select></label>
          <div className="mobile-nav-grid">
            {visibleNavigation.map((item) => {
              const Icon = item.icon;
              return <button className={active === item.id ? "active" : ""} type="button" key={item.id} onClick={() => navigateMobile(item.id)}><Icon size={20} /><span><strong>{item.label}</strong><small>{item.group === "work" ? "学生与教务" : "运营与系统"}</small></span><ChevronRight size={16} /></button>;
            })}
          </div>
          <button className="mobile-logout-button" type="button" disabled={logoutBusy} onClick={() => void logout()}><LogOut size={18} aria-hidden="true" />{logoutBusy ? "正在退出" : "退出登录"}</button>
        </section>
      </div>}
      {toast && <div className="toast"><CheckCircle2 size={17} /> {toast}</div>}

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
          <label className="span-2">家长 / 沟通对象<input name="guardian" placeholder="例如 Chen 先生 · 企业微信客户群" /></label>
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
          <label className="span-2">家长 / 沟通对象<input name="guardian" defaultValue={selectedStudent.guardian} /></label>
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

      {modal === "task" && <Dialog title="添加内部任务" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitTask}>
          <label className="span-2">任务内容<input name="title" autoFocus placeholder="例如确认家长是否收到上课链接" required /></label>
          <label>关联学生<input name="studentId" list="task-student-options" defaultValue={selectedStudent.id} placeholder="输入姓名或学生 ID 搜索" /><datalist id="task-student-options">{recordStudents.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.course}</option>)}</datalist></label>
          <label>负责人<select name="owner">{teamOwnerOptions.map((owner) => <option key={owner}>{owner}</option>)}</select></label>
          <label>截止时间<input name="due" defaultValue="今天" /></label>
          <label>任务分类<select name="category"><option>资料</option><option>试听</option><option>LP</option><option>排课</option><option>课后</option><option>续课</option><option>薪资</option></select></label>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><Plus size={16} /> 加入队列</button></footer>
        </form>
      </Dialog>}

      {modal === "lp" && <Dialog title="创建 LP 工作流" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitLp}>
          <label>关联学生<input name="studentId" list="lp-student-options" defaultValue={selectedStudent.id} placeholder="输入姓名或学生 ID 搜索" /><datalist id="lp-student-options">{recordStudents.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.course}</option>)}</datalist></label>
          <label>LP 类型<select name="workflowType">{lpWorkflowOptions.map((option) => <option value={option.id} key={option.id}>{option.title}</option>)}</select></label>
          <label>规划老师<select name="planner" defaultValue={selectedStudent.planner ?? "Tara"}><option value="Tara">龙老师</option><option>Eileen</option></select></label>
          <label>负责教务<select name="owner" defaultValue={selectedStudent.owner} disabled={!isAdminView}>{teamOwnerOptions.map((owner) => <option key={owner}>{owner}</option>)}</select>{!isAdminView && <small>负责教务调整需由管理员处理</small>}</label>
          {isAdminView && <><label className="checkbox-field span-2"><input name="provisional" type="checkbox" /> 暂未有学生姓名，先按科目创建临时档案</label>
          <label>临时姓名（可留空）<input name="provisionalName" placeholder="之后可在学生档案补充" /></label>
          <label>科目 / 课程<input name="provisionalCourse" placeholder="临时建档时必填，例如 Year 9 English" /></label></>}
          <label className="checkbox-field span-2"><input name="parentFollowUp" type="checkbox" /> 需要跟进家长指定内容（创建后立即生成强提醒）</label>
          <label className="checkbox-field span-2"><input name="teacherPrep" type="checkbox" defaultChecked /> 需要跟进老师备课内容（课前 N-1 强提醒）</label>
          <div className="form-notice span-2"><CircleAlert size={16} /> {isAdminView ? "试听、二次试听和直报可先不填姓名；系统会建立“姓名待补”的临时档案，之后在学生详情编辑。" : "如学生尚未建档，请先由管理员建立临时档案。"}试听流程仍会生成 24 小时排课、N-3、N-2 和 N-1 提醒。</div>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><BookOpen size={16} /> 创建并生成提醒</button></footer>
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

      {modal === "booking" && <Dialog title={bookingDraft ? "编辑排课" : "新建排课"} onClose={() => { setBookingDraft(null); setModal(null); }}>
        <form className="form-grid" onSubmit={submitBooking}>
          <label>学生<input name="studentId" list="booking-student-options" defaultValue={bookingDraft?.studentId ?? selectedStudent.id} placeholder="输入姓名或学生 ID 搜索" /><datalist id="booking-student-options">{(isTeacherView ? scopedStudents : recordStudents).map((student) => <option value={student.id} key={student.id}>{student.name} · {student.course}</option>)}</datalist></label>
          {isTeacherView ? <label>老师<input value={currentTeacher?.name ?? currentOperator} disabled /><input name="teacherId" type="hidden" value={currentTeacher?.id ?? ""} /></label> : <label>老师<input name="teacherId" list="booking-teacher-options" defaultValue={bookingDraft?.teacherId ?? selectedTeacher.id} placeholder="输入姓名或老师 ID 搜索" /><datalist id="booking-teacher-options">{recordTeachers.map((teacher) => <option value={teacher.id} key={teacher.id}>{teacher.name} · {teacher.subjects.join("/")} · {teacher.availabilityStatus ?? "待确认"}</option>)}</datalist></label>}
          <label>日期<input name="date" type="date" defaultValue={bookingDraft?.date ?? isoDateInTimezone(new Date(), scheduleTimezone)} required /></label>
          <label>开始时间<input name="start" type="time" defaultValue={bookingDraft?.start ?? "16:00"} required /></label>
          <label>录入时区<select name="timezone" defaultValue={bookingDraft?.timezone ?? scheduleTimezone}>{timezoneOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
          <label>课程类型<select name="kind" defaultValue={bookingDraft?.kind ?? "试听"}><option>试听</option><option>常规课</option><option>代课</option></select></label>
          <label>课程时长<select name="duration" defaultValue={String(bookingDraft?.duration ?? 60)}><option value="60">60 分钟</option><option value="90">90 分钟</option><option value="120">120 分钟</option></select></label>
          <label className="checkbox-field"><input name="recurring" type="checkbox" defaultChecked={bookingDraft?.recurring ?? true} /> 每周固定课程</label>
          <label>本轮排课节数<input name="repeatCount" type="number" min="1" max="104" defaultValue={bookingDraft ? bookingDraft.repeatCount : 12} placeholder={bookingDraft?.recurring && bookingDraft.repeatCount == null ? "长期" : "12"} /><small>{bookingDraft?.recurring && bookingDraft.repeatCount == null ? "当前是旧版长期课程；留空保存会继续保持长期" : "固定课按周生成，1-104 节"}</small></label>
          <div className="form-notice span-2"><CircleAlert size={16} /> 提交前会检查学生/老师重叠并验证老师 AVA；成功后自动生成在线教室、LP、N-2 和课后任务。</div>
          <footer><button className="secondary-button" type="button" onClick={() => { setBookingDraft(null); setModal(null); }}>取消</button><button className="primary-button" type="submit"><CalendarPlus size={16} /> {bookingDraft ? "检查并保存" : "检查并创建"}</button></footer>
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
          <label>本次结果<select name="result" defaultValue={renewalDraft.status === "本次未跟进" ? "本次未跟进" : renewalDraft.status === "等待家长" ? "等待家长" : renewalDraft.status === "已确认" ? "已确认" : "已跟进"}><option>已跟进</option><option>本次未跟进</option><option>等待家长</option><option>已确认</option></select></label>
          <label>本次操作时间<input name="attemptedAt" type="datetime-local" defaultValue={currentLocalDateTimeValue()} required /></label>
          <label>上次成功跟进<input value={formatFollowUpTime(renewalDraft.lastContactedAt)} disabled /></label>
          <label className="span-2">跟进说明<textarea name="note" rows={3} defaultValue={renewalDraft.followUpNote ?? ""} placeholder="例如：已联系家长，等待确认下月课时；或本次电话未接通" /></label>
          <label className="span-2 upload-field">聊天记录截图（可选）<input name="attachment" type="file" accept="image/png,image/jpeg,image/webp" /><small>支持 PNG、JPG、WebP，最多 4MB。上传后自动归档到该学生的“续课 FU”。</small></label>
          <div className="form-notice span-2"><CircleAlert size={16} /> “本次未跟进”只记录本次尝试，不会覆盖上次成功跟进时间。停课、非在读或不活跃学生不会出现在续课列表。</div>
          <footer><button className="secondary-button" type="button" disabled={renewalUploadBusy} onClick={() => { setModal(null); setRenewalDraft(null); }}>取消</button><button className="primary-button" type="submit" disabled={renewalUploadBusy}><ClipboardCheck size={16} /> {renewalUploadBusy ? "正在保存..." : "保存跟进记录"}</button></footer>
        </form>
      </Dialog>}

      {modal === "file" && <Dialog title="登记资料链接" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitFile}>
          <label>关联学生<input name="studentId" list="file-student-options" defaultValue={selectedStudent.id} placeholder="输入姓名或学生 ID 搜索" /><datalist id="file-student-options">{recordStudents.map((student) => <option value={student.id} key={student.id}>{student.name}</option>)}</datalist></label>
          <label>资料类型<select name="type"><option>Learning Plan</option><option>成绩单</option><option>课堂反馈</option><option>续课 FU</option><option>资料链接</option><option>其他</option></select></label>
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

function ViewHeading({ eyebrow, title, copy, actions }: { eyebrow: string; title: string; copy: string; actions: ReactNode }) { return <section className="view-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="view-copy">{copy}</p></div><div className="heading-actions">{actions}</div></section>; }
function Metric({ tone, icon, value, label, detail, onClick }: { tone: Tone; icon: ReactNode; value: string; label: string; detail: string; onClick?: () => void }) { return <button className={`metric-card ${tone}`} type="button" onClick={onClick}><span className="metric-icon">{icon}</span><span><strong>{value}</strong><b>{label}</b><small>{detail}</small></span><ArrowRight size={17} /></button>; }
function TaskList({ tasks, studentById, onComplete, onOpen }: { tasks: Task[]; studentById: (id: string) => Student | undefined; onComplete: (id: string) => void; onOpen: (task: Task) => void }) { if (!tasks.length) return <div className="empty-inline"><CircleCheck size={20} /> 当前筛选下没有待处理事项</div>; return <div className="task-list">{tasks.map((task) => <div className="task-row" key={task.id}><span className={`task-dot ${task.tone}`} /><button className="task-copy" type="button" onClick={() => onOpen(task)}><strong>{task.title}</strong><span>{studentById(task.studentId)?.name ?? "未关联学生"} · {task.owner}</span><small>{task.trigger}</small></button><span className={`due-label ${task.status}`}>{task.due}</span><button className="complete-button" type="button" title="标记完成" onClick={() => onComplete(task.id)}><Check size={16} /></button></div>)}</div>; }
function ScheduleList({ bookings, studentById, teacherById, onOpen }: { bookings: Booking[]; studentById: (id: string) => Student | undefined; teacherById: (id: string) => Teacher | undefined; onOpen: (booking: Booking) => void }) { if (!bookings.length) return <div className="empty-inline"><CalendarDays size={20} /> 今天没有课程</div>; return <div className="schedule-list">{bookings.slice(0, 6).map((booking) => <button className="schedule-row" type="button" key={`${booking.id}-${booking.date}`} onClick={() => onOpen(booking)}><span className="schedule-time"><strong>{booking.start}</strong><small>{booking.date.slice(5).replace("-", "/")}</small></span><span className={`schedule-line ${booking.status === "待确认" ? "amber" : booking.kind === "试听" ? "blue" : "green"}`} /><span className="schedule-copy"><strong>{studentById(booking.studentId)?.name}</strong><small>{teacherById(booking.teacherId)?.name} · {booking.kind} · {booking.status}</small></span><ChevronRight size={16} /></button>)}</div>; }
function RiskRow({ tone, title, detail, action }: { tone: Tone; title: string; detail: string; action: () => void }) { return <button className="risk-row" type="button" onClick={action}><span className={`risk-icon ${tone}`}><CircleAlert size={16} /></span><span><strong>{title}</strong><small>{detail}</small></span><ChevronRight size={15} /></button>; }
function TeacherAvaBoard({ teacher, teachers, bookings, studentById, targetTimezone, view, monthOffset, onView, onMonthOffset, onTeacherChange, onAddAva, onEditAva, onDeleteAva }: { teacher: Teacher; teachers: Teacher[]; bookings: Booking[]; studentById: (id: string) => Student | undefined; targetTimezone: string; view: "week" | "month"; monthOffset: number; onView: (view: "week" | "month") => void; onMonthOffset: (offset: number) => void; onTeacherChange: (teacherId: string) => void; onAddAva: () => void; onEditAva: (slotIndex: number) => void; onDeleteAva: (slotIndex: number) => void }) {
  const weekDates = weekDatesForTimezone(targetTimezone);
  const month = monthDatesForTimezone(targetTimezone, monthOffset);
  const visibleDates = view === "week" ? weekDates.map((day) => day.date) : month.days.map((day) => day.date);
  const slots = displayAvaSlotsForDates(teacher, targetTimezone, visibleDates);
  const teacherBookings = bookings.filter((booking) => booking.teacherId === teacher.id).flatMap((booking) => bookingOccurrencesWithinRange(booking, visibleDates[0], visibleDates.at(-1)!).map((occurrence) => {
    const parts = zonedParts(bookingInstant(occurrence), cleanTimezone(targetTimezone));
    return { booking: occurrence, date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  }));
  const renderSlot = (slot: (typeof slots)[number], index: number) => <p className="ava-slot" key={`${slot.date}-${slot.start}-${index}`}><span>可约 {slot.start}-{slot.end}</span><span className="ava-slot-actions"><button type="button" aria-label={`修改 ${slot.start}-${slot.end} 可约时段`} title="修改固定可约时段" onClick={() => onEditAva(slot.slotIndex)}><Pencil size={12} /></button><button type="button" aria-label={`删除 ${slot.start}-${slot.end} 可约时段`} title="删除固定可约时段" onClick={() => onDeleteAva(slot.slotIndex)}><X size={13} /></button></span></p>;
  const renderBookings = (date: string) => teacherBookings.filter((entry) => entry.date === date).map(({ booking, time }) => <p className="ava-booked" key={booking.occurrenceKey}>已占用 {time} · {studentById(booking.studentId)?.name ?? "学生"}</p>);
  return <section className="ava-workbench" aria-label="老师 AVA 日历">
    <header><div><p className="eyebrow">老师 AVA · 已占用时段</p><h2>可约时间表</h2><span>浅绿色为可约，灰色为已排课；按 {timezoneLabel(targetTimezone)} 自动换算。</span></div><div className="ava-actions"><div className="segmented"><button className={view === "week" ? "active" : ""} type="button" onClick={() => onView("week")}>本周</button><button className={view === "month" && monthOffset === 0 ? "active" : ""} type="button" onClick={() => { onView("month"); onMonthOffset(0); }}>本月</button><button className={view === "month" && monthOffset === 1 ? "active" : ""} type="button" onClick={() => { onView("month"); onMonthOffset(1); }}>下月</button></div><select className="filter-select" value={teacher.id} onChange={(event) => onTeacherChange(event.target.value)} aria-label="选择老师查看 AVA">{teachers.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</select><button className="secondary-button" type="button" onClick={onAddAva}><Plus size={16} /> 录入 AVA</button></div></header>
    {!teacher.availabilitySlots?.length ? <div className="ava-unstructured"><CircleAlert size={18} /><div><strong>这位老师的 AVA 仍是原始文本，不能安全地生成可约日历。</strong><span>{teacher.availability || "尚未收到可用时间"}</span><small>录入结构化的星期、开始和结束时间后，系统才会用于排课冲突和代课候选筛选。</small></div></div> : view === "week" ? <div className="ava-week-grid">{weekDates.map((day) => { const daySlots = slots.filter((slot) => slot.date === day.date); return <article key={day.date}><strong>{day.label}</strong><span>{timezoneLabel(targetTimezone)}</span><div>{daySlots.length ? daySlots.map(renderSlot) : <p className="ava-empty-day">无可约时段</p>}{renderBookings(day.date)}</div></article>; })}</div> : <div className="ava-month"><header><button className="icon-button" type="button" aria-label="上一个月" onClick={() => onMonthOffset(monthOffset - 1)}><ChevronLeft size={16} /></button><strong>{month.label}</strong><button className="icon-button" type="button" aria-label="下一个月" onClick={() => onMonthOffset(monthOffset + 1)}><ChevronRight size={16} /></button></header><div className="ava-month-weekdays">{["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((day) => <span key={day}>{day}</span>)}</div><div className="ava-month-grid">{month.days.map((day) => { const daySlots = slots.filter((slot) => slot.date === day.date); return <article className={day.inMonth ? "" : "outside"} key={day.date}><strong>{day.day}</strong><div>{daySlots.map(renderSlot)}{renderBookings(day.date)}</div></article>; })}</div></div>}
  </section>;
}
function StudentDetail({ student, tasks, bookings, files, teacherById, mobileOpen, canEditStatus = true, onClose, onFiles, onSchedule, onEdit, onEvidence, onStatus }: { student: Student; tasks: Task[]; bookings: Booking[]; files: FileRecord[]; studentById: (id: string) => Student | undefined; teacherById: (id: string) => Teacher | undefined; mobileOpen: boolean; canEditStatus?: boolean; onClose: () => void; onFiles: () => void; onSchedule: () => void; onEdit: () => void; onEvidence: () => void; onStatus: (status: Student["status"]) => void }) {
  const studentTasks = tasks.filter((task) => task.studentId === student.id && task.status !== "done");
  const nextBooking = bookings.find((booking) => booking.studentId === student.id);
  const lowHours = isActiveStudent(student) && student.remainingHours !== undefined && student.remainingHours < 5;
  return <aside className={`student-detail ${mobileOpen ? "mobile-detail-open" : ""}`}>
    <button className="mobile-preview-close" type="button" aria-label="关闭学生详情" onClick={onClose}><ChevronLeft size={20} /> 返回学生列表</button>
    <div className="detail-top"><Avatar initials={student.initials} tone={statusTone(student.status)} /><div><p>{student.id}</p><h2>{student.name}</h2><StatusPill tone={statusTone(student.status)}>{student.segment ?? "已报名"} · {student.status}</StatusPill></div><IconButton label="更多学生操作"><MoreHorizontal size={18} /></IconButton></div>
    <div className="student-facts"><span><small>当前年级</small><strong>{currentGrade(student)}</strong>{student.gradeBaseYear && student.gradeBaseYear < new Date().getFullYear() ? <em>由 {student.gradeBaseYear} 年记录自动升级</em> : null}</span><span><small>所在地 / 时区</small><strong>{student.location ?? "待确认"}</strong><em>{timezoneLabel(student.timezone)}</em></span><span><small>负责教务</small><strong>{student.owner}</strong><em>规划：{student.planner ?? "待分配"}</em></span><span><small>剩余 / 合约课时</small><strong className={lowHours ? "low-hours" : ""}>{student.remainingHours === undefined ? "待导入" : `${student.remainingHours} / ${student.contractHours ?? "?"} 节`}</strong><em>{student.contractEffectiveDate ? `生效 ${student.contractEffectiveDate}` : lowHours ? "已进入强提醒" : student.status === "停课" || student.status === "非在读" || student.status === "不活跃" ? "当前状态不提醒" : "阈值 5 节"}</em></span></div>
    {student.jwbSyncStatus && <div className="detail-section source-detail"><span>教务宝只读同步</span><strong>{student.jwbSyncStatus} · {student.jwbSyncedAt}</strong><p>课时与合约数据来自只读镜像；本系统不会回写教务宝。</p></div>}
    <div className="detail-section"><span>课程与老师</span><strong>{student.course}</strong><p>{student.teacher}</p></div>
    <div className="detail-section split"><div><span>LP 类型</span><strong>{student.lpNeed ?? "未设置"}</strong></div><div><span>资料</span><button className="inline-link" type="button" onClick={onFiles}>{files.filter((file) => file.studentId === student.id).length || student.files} 项索引 <ChevronRight size={14} /></button></div></div>
    <div className="detail-section split"><div><span>Report 进度</span><strong>{student.reportProgress ?? "未记录"}</strong></div><div><span>最近跟进</span><strong>{student.followUp ?? "未记录"}</strong></div></div>
    {(student.examDate || student.examSubject) && <div className="detail-section"><span>考试节点</span><strong>{student.examSubject || "考试科目待确认"} · {student.examDate || "日期待确认"}</strong><p>{student.resultDate ? `预计出分 ${student.resultDate}` : "考前 30 天与考试当天提醒"}</p></div>}
    <div className="detail-section"><span>特殊备注</span><strong>{student.notes ?? "无特殊备注"}</strong></div>
    <div className="detail-section"><span>家长与沟通路由</span><strong>{student.guardian}</strong></div>
    {canEditStatus && <div className="student-detail-actions"><button className="secondary-button" type="button" onClick={onEdit}><UserCog size={15} /> 编辑档案</button><button className="secondary-button" type="button" onClick={onEvidence}><FilePlus2 size={15} /> 上传沟通/反馈</button></div>}
    {canEditStatus ? <label className="status-select">学生状态<select value={student.status} onChange={(event) => onStatus(event.target.value as Student["status"])}>{["待确认", "待排课", "试听中", "在读", "待续课", "停课", "非在读", "不活跃"].map((status) => <option key={status}>{status}</option>)}</select></label> : <div className="detail-section"><span>学生状态</span><strong>{student.status}</strong><p>老师账号只读；如需调整请联系负责教务。</p></div>}
    <div className="timeline"><div className="timeline-title"><strong>下一步与时间线</strong><small>{studentTasks.length} 项待办</small></div>{studentTasks.slice(0, 3).map((task) => <div className="timeline-item" key={task.id}><i className={task.tone} /><span><strong>{task.title}</strong><small>{task.due} · {task.owner}</small></span></div>)}{nextBooking && <div className="timeline-item"><i className="green" /><span><strong>下一节：{formatInstant(bookingInstant(nextBooking), student.timezone)}</strong><small>{teacherById(nextBooking.teacherId)?.name} · {nextBooking.kind}</small></span></div>}</div>
    <button className="primary-button full" type="button" onClick={onSchedule}><CalendarPlus size={16} /> 为此学生安排课程</button>
  </aside>;
}
function TimeLine({ label, time, detail }: { label: string; time: string; detail: string }) { return <div className="booking-line"><span>{label}</span><strong>{time}</strong><small>{detail}</small></div>; }
function SummaryCard({ icon, tone, title, text }: { icon: ReactNode; tone: Tone; title: string; text: string }) { return <article><span className={`sync-icon ${tone}`}>{icon}</span><span><strong>{title}</strong><small>{text}</small></span></article>; }
function OwnershipRow({ title, detail, tone, label }: { title: string; detail: string; tone: Tone; label: string }) { return <div className="ownership-row"><span><strong>{title}</strong><small>{detail}</small></span><StatusPill tone={tone}>{label}</StatusPill></div>; }
function ReportCard({ value, label, detail, tone }: { value: string; label: string; detail: string; tone: Tone }) { return <article className={`report-card ${tone}`}><strong>{value}</strong><span>{label}</span><small>{detail}</small></article>; }
function DataIssue({ title, count, tone }: { title: string; count: string; tone: Tone }) { return <div className="issue-row"><span className={`risk-icon ${tone}`}><CircleAlert size={16} /></span><span><strong>{title}</strong><small>{count}</small></span></div>; }
