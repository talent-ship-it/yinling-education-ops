"use client";

import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CalendarDays,
  CalendarPlus,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  Clock3,
  Database,
  Download,
  FilePlus2,
  FileText,
  FolderOpen,
  GraduationCap,
  LayoutDashboard,
  ListChecks,
  ListTodo,
  LoaderCircle,
  MapPin,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";

type Section =
  | "dashboard"
  | "students"
  | "teachers"
  | "schedule"
  | "lp"
  | "operations"
  | "renewals"
  | "payroll"
  | "messages"
  | "files"
  | "sync"
  | "reports"
  | "settings"
  | "audit";

type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "purple";
type TaskStatus = "overdue" | "today" | "upcoming" | "waiting" | "done";
type ModalKind = "student" | "task" | "booking" | "operation" | "file" | "template" | null;

type Student = {
  id: string;
  name: string;
  initials: string;
  status: "待排课" | "试听中" | "在读" | "待续课" | "停课";
  owner: string;
  course: string;
  timezone: string;
  guardian: string;
  teacher: string;
  next: string;
  nextTone: Tone;
  files: number;
  examDate?: string;
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
};

type LpItem = {
  id: string;
  studentId: string;
  title: string;
  stage: "待资料" | "写作中" | "待审核" | "已发老师" | "待备课确认" | "完成";
  owner: string;
  due: string;
};

type Operation = {
  id: string;
  studentId: string;
  type: "调课" | "请假" | "停课" | "代课" | "换老师";
  detail: string;
  status: "待处理" | "已确认";
  createdAt: string;
};

type Renewal = {
  id: string;
  studentId: string;
  remaining: number;
  estimate: string;
  status: "待跟进" | "已联系" | "等待家长" | "已确认";
  owner: string;
};

type PayrollRow = {
  id: string;
  teacherId: string;
  lessons: number;
  trialLessons: number;
  amount: number;
  status: "需核对" | "可审核" | "已锁定";
  note: string;
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
  type: "Learning Plan" | "成绩单" | "课堂反馈" | "资料链接" | "其他";
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
};

const navigation: Array<{ id: Section; label: string; icon: typeof LayoutDashboard; group: "work" | "support" }> = [
  { id: "dashboard", label: "工作台", icon: LayoutDashboard, group: "work" },
  { id: "students", label: "学生档案", icon: Users, group: "work" },
  { id: "teachers", label: "老师资源", icon: GraduationCap, group: "work" },
  { id: "schedule", label: "排课", icon: CalendarDays, group: "work" },
  { id: "lp", label: "试听与 LP", icon: BookOpen, group: "work" },
  { id: "operations", label: "调课与代课", icon: CalendarPlus, group: "work" },
  { id: "renewals", label: "考试与续课", icon: ListChecks, group: "work" },
  { id: "payroll", label: "课时与薪资", icon: Wallet, group: "support" },
  { id: "messages", label: "消息队列", icon: MessageSquare, group: "support" },
  { id: "files", label: "文件中心", icon: FolderOpen, group: "support" },
  { id: "sync", label: "同步与导入", icon: RefreshCw, group: "support" },
  { id: "reports", label: "运营报表", icon: SlidersHorizontal, group: "support" },
  { id: "settings", label: "规则设置", icon: Settings, group: "support" },
  { id: "audit", label: "操作审计", icon: ShieldCheck, group: "support" },
];

const initialStudents: Student[] = [
  { id: "STU-0248", name: "Olivia Chen", initials: "OC", status: "试听中", owner: "思佳", course: "Year 10 English", timezone: "Australia/Melbourne · UTC+10", guardian: "Chen 先生 · 企业微信客户群", teacher: "待匹配", next: "确认 N-2 资料与收费", nextTone: "red", files: 4 },
  { id: "STU-0194", name: "Lucas Wang", initials: "LW", status: "在读", owner: "Tiffany", course: "IB Mathematics AA HL", timezone: "Australia/Sydney · UTC+10", guardian: "Wang 女士 · 企业微信客户", teacher: "Daniel Wu", next: "发送 LP 给老师", nextTone: "amber", files: 9, examDate: "2026-11-03" },
  { id: "STU-0231", name: "Sophie Liu", initials: "SL", status: "在读", owner: "Abby", course: "VCE Chemistry", timezone: "Australia/Melbourne · UTC+10", guardian: "Liu 女士 · 企业微信客户群", teacher: "Amelia Brown", next: "更新考试节点", nextTone: "blue", files: 7, examDate: "2026-10-29" },
  { id: "STU-0176", name: "Ethan Zhao", initials: "EZ", status: "待续课", owner: "思佳", course: "Year 12 Physics", timezone: "Australia/Perth · UTC+8", guardian: "Zhao 女士 · 企业微信客户", teacher: "Michael Yu", next: "续课 N-8 跟进", nextTone: "amber", files: 6 },
];

const initialTeachers: Teacher[] = [
  { id: "TEA-011", name: "Amelia Brown", initials: "AB", subjects: ["Year 10 English", "VCE English"], timezone: "Australia/Melbourne · UTC+10", availability: "周六 15:00-20:00", load: 8, capacity: 12, acceptsStudents: true, note: "长期时段匹配，试听经验充足" },
  { id: "TEA-027", name: "Grace Lin", initials: "GL", subjects: ["Year 7-10 English", "写作"], timezone: "Australia/Sydney · UTC+10", availability: "周六 16:00-19:00", load: 10, capacity: 12, acceptsStudents: true, note: "科目匹配，当前负载偏高" },
  { id: "TEA-042", name: "Rachel Song", initials: "RS", subjects: ["Year 9-10 English"], timezone: "Australia/Brisbane · UTC+10", availability: "周六 14:00-17:00", load: 4, capacity: 10, acceptsStudents: false, note: "需确认家长对老师背景的偏好" },
  { id: "TEA-053", name: "Daniel Wu", initials: "DW", subjects: ["IB Mathematics AA HL", "IB Mathematics AI"], timezone: "Australia/Sydney · UTC+10", availability: "周四 17:00-21:00", load: 7, capacity: 10, acceptsStudents: true, note: "IB 课程规划完成，长期时段稳定" },
];

const initialTasks: Task[] = [
  { id: "TSK-001", title: "确认 N-2 资料与收费状态", owner: "思佳", studentId: "STU-0248", due: "今天 10:30", status: "overdue", tone: "red", category: "试听", trigger: "试听前 N-2：资料与收费检查" },
  { id: "TSK-002", title: "发送 LP 给老师并确认备课", owner: "Tiffany", studentId: "STU-0194", due: "今天 14:00", status: "today", tone: "amber", category: "LP", trigger: "LP 审核通过后" },
  { id: "TSK-003", title: "跟进家长：考试日期已变更", owner: "Abby", studentId: "STU-0231", due: "今天 16:30", status: "today", tone: "blue", category: "续课", trigger: "考试日期更新" },
  { id: "TSK-004", title: "核对教务宝未结课记录", owner: "思佳", studentId: "STU-0176", due: "明天 11:00", status: "upcoming", tone: "amber", category: "薪资", trigger: "导入后数据质量检查" },
  { id: "TSK-005", title: "等待老师确认长期可上课时间", owner: "Tara", studentId: "STU-0248", due: "等待回复", status: "waiting", tone: "blue", category: "排课", trigger: "试听老师匹配" },
];

const initialBookings: Booking[] = [
  { id: "LES-001", studentId: "STU-0248", teacherId: "TEA-011", date: "2026-07-20", start: "16:00", duration: 60, kind: "试听", status: "待确认", timezone: "Australia/Melbourne" },
  { id: "LES-002", studentId: "STU-0231", teacherId: "TEA-011", date: "2026-07-20", start: "18:00", duration: 60, kind: "常规课", status: "已确认", timezone: "Australia/Melbourne" },
  { id: "LES-003", studentId: "STU-0194", teacherId: "TEA-053", date: "2026-07-21", start: "19:00", duration: 60, kind: "常规课", status: "已确认", timezone: "Australia/Sydney" },
  { id: "LES-004", studentId: "STU-0176", teacherId: "TEA-027", date: "2026-07-22", start: "17:00", duration: 60, kind: "常规课", status: "已确认", timezone: "Australia/Perth" },
];

const initialLp: LpItem[] = [
  { id: "LP-001", studentId: "STU-0248", title: "试听资料与长期时间", stage: "待资料", owner: "思佳", due: "今天 11:00" },
  { id: "LP-002", studentId: "STU-0194", title: "IB 数学 Learning Plan", stage: "已发老师", owner: "Tiffany", due: "今天 14:00" },
  { id: "LP-003", studentId: "STU-0231", title: "VCE Chemistry 考试节点更新", stage: "待审核", owner: "Abby", due: "今天 16:30" },
  { id: "LP-004", studentId: "STU-0176", title: "续课目标与复习节奏", stage: "写作中", owner: "思佳", due: "明天 11:00" },
];

const initialOperations: Operation[] = [
  { id: "OPS-001", studentId: "STU-0231", type: "调课", detail: "考试日期调整后，需要确认周一晚间时间", status: "待处理", createdAt: "今天 09:20" },
  { id: "OPS-002", studentId: "STU-0176", type: "换老师", detail: "下月起需要可稳定授课的物理老师", status: "已确认", createdAt: "昨天 16:10" },
];

const initialRenewals: Renewal[] = [
  { id: "REN-001", studentId: "STU-0176", remaining: 8, estimate: "2026-08-02", status: "待跟进", owner: "思佳" },
  { id: "REN-002", studentId: "STU-0194", remaining: 14, estimate: "2026-08-15", status: "已联系", owner: "Tiffany" },
  { id: "REN-003", studentId: "STU-0231", remaining: 5, estimate: "2026-07-28", status: "等待家长", owner: "Abby" },
];

const initialPayroll: PayrollRow[] = [
  { id: "PAY-001", teacherId: "TEA-011", lessons: 14, trialLessons: 1, amount: 1330, status: "需核对", note: "1 节试听费率待确认" },
  { id: "PAY-002", teacherId: "TEA-027", lessons: 11, trialLessons: 0, amount: 990, status: "可审核", note: "已与教务宝结课记录一致" },
  { id: "PAY-003", teacherId: "TEA-053", lessons: 9, trialLessons: 0, amount: 1080, status: "可审核", note: "IB 费率已匹配" },
];

const initialMessages: Message[] = [
  { id: "MSG-001", studentId: "STU-0248", kind: "试听资料补充提醒", recipient: "Chen 先生 · 客户群", body: "您好，Olivia 的试听课将于本周六进行。为便于老师准备，请于今天补充最近的英语作业或成绩单。谢谢。", status: "待人工确认", createdAt: "今天 09:05" },
  { id: "MSG-002", studentId: "STU-0194", kind: "LP 与备课确认", recipient: "Daniel Wu · 内部老师", body: "Lucas 的 IB Mathematics Learning Plan 已更新。请查看资料并在今天 18:00 前确认备课安排。", status: "仅内部", createdAt: "今天 09:12" },
  { id: "MSG-003", studentId: "STU-0176", kind: "续课前跟进", recipient: "思佳 · 内部负责人", body: "Ethan 剩余 8 节课，预计 8 月 2 日需要续课沟通。请确认家长当前学习安排。", status: "仅内部", createdAt: "今天 09:30" },
];

const initialFiles: FileRecord[] = [
  { id: "FIL-001", studentId: "STU-0248", title: "试听交接资料", type: "资料链接", source: "Google Drive · 已建立文件夹", addedAt: "今天 09:05" },
  { id: "FIL-002", studentId: "STU-0194", title: "IB Mathematics Learning Plan v2", type: "Learning Plan", source: "Google Drive · 文档链接", addedAt: "昨天 17:32" },
  { id: "FIL-003", studentId: "STU-0231", title: "VCE Chemistry 期中成绩", type: "成绩单", source: "人工上传 · 已索引", addedAt: "7 月 15 日" },
];

const initialAudit: AuditEntry[] = [
  { id: "AUD-001", time: "今天 09:12", actor: "思佳", action: "创建 LP 任务", detail: "Lucas Wang · LP 已进入待发送老师阶段", tone: "blue" },
  { id: "AUD-002", time: "今天 09:18", actor: "系统", action: "发现同步冲突", detail: "Olivia Chen 的负责人字段在腾讯表格发生人工修改", tone: "amber" },
  { id: "AUD-003", time: "昨天 17:20", actor: "Tiffany", action: "记录内部提醒", detail: "Daniel Wu 的备课确认提醒已送达", tone: "green" },
];

const defaultRules: Rules = { lpDays: "N-3", feedbackHours: "24", renewalDays: "8", escalation: "逾期 4 小时后通知主管" };
const lpStages: LpItem["stage"][] = ["待资料", "写作中", "待审核", "已发老师", "待备课确认", "完成"];

function usePersistentState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(initialValue);
  const hydrated = useRef(false);

  useEffect(() => {
    window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(key);
        if (saved) setValue(JSON.parse(saved) as T);
      } catch {
        // Demo data remains usable if a browser has an old or malformed saved value.
      } finally {
        hydrated.current = true;
      }
    }, 0);
  }, [key]);

  useEffect(() => {
    if (!hydrated.current) return;
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}

function nowLabel() {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

let uniqueSequence = 0;

function id(prefix: string) {
  uniqueSequence += 1;
  return `${prefix}-${Date.now().toString().slice(-6)}-${uniqueSequence}`;
}

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "新";
}

function statusTone(status: Student["status"] | TaskStatus | PayrollRow["status"] | Renewal["status"]): Tone {
  const map: Record<string, Tone> = {
    "试听中": "amber", "在读": "green", "待排课": "blue", "待续课": "purple", "停课": "red",
    overdue: "red", today: "amber", upcoming: "blue", waiting: "purple", done: "green",
    "需核对": "amber", "可审核": "blue", "已锁定": "green",
    "待跟进": "amber", "已联系": "blue", "等待家长": "purple", "已确认": "green",
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

export default function Home() {
  const [active, setActive] = useState<Section>("dashboard");
  const [students, setStudents] = usePersistentState("yinling-mvp:students", initialStudents);
  const [teachers, setTeachers] = usePersistentState("yinling-mvp:teachers", initialTeachers);
  const [tasks, setTasks] = usePersistentState("yinling-mvp:tasks", initialTasks);
  const [bookings, setBookings] = usePersistentState("yinling-mvp:bookings", initialBookings);
  const [lpItems, setLpItems] = usePersistentState("yinling-mvp:lp", initialLp);
  const [operations, setOperations] = usePersistentState("yinling-mvp:operations", initialOperations);
  const [renewals, setRenewals] = usePersistentState("yinling-mvp:renewals", initialRenewals);
  const [payroll, setPayroll] = usePersistentState("yinling-mvp:payroll", initialPayroll);
  const [messages, setMessages] = usePersistentState("yinling-mvp:messages", initialMessages);
  const [files, setFiles] = usePersistentState("yinling-mvp:files", initialFiles);
  const [audit, setAudit] = usePersistentState("yinling-mvp:audit", initialAudit);
  const [rules, setRules] = usePersistentState("yinling-mvp:rules", defaultRules);
  const [selectedStudentId, setSelectedStudentId] = useState("STU-0248");
  const [selectedTeacherId, setSelectedTeacherId] = useState("TEA-011");
  const [selectedMessageId, setSelectedMessageId] = useState("MSG-001");
  const [taskFilter, setTaskFilter] = useState<"all" | "mine" | "overdue">("all");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<ModalKind>(null);
  const [toast, setToast] = useState("");
  const [syncState, setSyncState] = useState<"ready" | "running" | "complete">("ready");
  const [syncResolved, setSyncResolved] = useState(false);

  const selectedStudent = students.find((student) => student.id === selectedStudentId) ?? students[0];
  const selectedTeacher = teachers.find((teacher) => teacher.id === selectedTeacherId) ?? teachers[0];
  const selectedMessage = messages.find((message) => message.id === selectedMessageId) ?? messages[0];
  const studentById = (studentId: string) => students.find((student) => student.id === studentId);
  const teacherById = (teacherId: string) => teachers.find((teacher) => teacher.id === teacherId);

  const addAudit = (action: string, detail: string, tone: Tone = "blue") => {
    setAudit((current) => [{ id: id("AUD"), time: `今天 ${nowLabel()}`, actor: "当前操作员", action, detail, tone }, ...current]);
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
    const filtered = tasks.filter((task) => task.status !== "done");
    if (taskFilter === "overdue") return filtered.filter((task) => task.status === "overdue");
    if (taskFilter === "mine") return filtered.filter((task) => task.owner === "思佳");
    return filtered;
  }, [tasks, taskFilter]);

  const filteredStudents = useMemo(() => students.filter((student) => {
    const haystack = `${student.name} ${student.id} ${student.course} ${student.owner}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  }), [search, students]);

  const goToStudent = (studentId: string, section: Section = "students") => {
    setSelectedStudentId(studentId);
    setActive(section);
  };

  const scheduleConflict = (studentId: string, teacherId: string, date: string, start: string, duration: number) => {
    const toMinutes = (time: string) => {
      const [hour = "0", minute = "0"] = time.split(":");
      return Number(hour) * 60 + Number(minute);
    };
    const requestedStart = toMinutes(start);
    const requestedEnd = requestedStart + duration;

    return bookings.some((booking) => {
      if (booking.date !== date || (booking.studentId !== studentId && booking.teacherId !== teacherId)) return false;
      const bookingStart = toMinutes(booking.start);
      const bookingEnd = bookingStart + booking.duration;
      return requestedStart < bookingEnd && bookingStart < requestedEnd;
    });
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

  const recordMessage = () => {
    if (!selectedMessage || selectedMessage.status === "已记录发送") return;
    setMessages((current) => current.map((message) => message.id === selectedMessage.id ? { ...message, status: "已记录发送" } : message));
    addAudit("记录消息发送", `${selectedMessage.kind} → ${selectedMessage.recipient}`, "green");
    notify("已记录发送。Demo 不会向真实企业微信发送消息。");
  };

  const runSync = () => {
    setSyncState("running");
    window.setTimeout(() => {
      setSyncState("complete");
      addAudit("运行模拟同步", "已完成系统到腾讯表格的镜像预览；未写入真实数据", "green");
      notify("同步预览完成，未连接真实腾讯表格");
    }, 850);
  };

  const resolveConflict = (choice: string) => {
    setSyncResolved(true);
    addAudit("处理同步冲突", `Olivia Chen 的负责人字段：${choice}`, "green");
    notify("冲突已处理并保留审计记录");
  };

  const resetDemo = () => {
    const keys = ["students", "teachers", "tasks", "bookings", "lp", "operations", "renewals", "payroll", "messages", "files", "audit", "rules"];
    keys.forEach((key) => window.localStorage.removeItem(`yinling-mvp:${key}`));
    window.location.reload();
  };

  const exportDemo = () => {
    const payload = { students, teachers, tasks, bookings, lpItems, operations, renewals, payroll, messages, files, audit, rules };
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

  const renderDashboard = () => {
    const overdue = tasks.filter((task) => task.status === "overdue").length;
    const today = tasks.filter((task) => task.status === "today").length;
    const waiting = tasks.filter((task) => task.status === "waiting").length;
    return <>
      <ViewHeading eyebrow="2026 年 7 月 17 日 · 星期五" title="今天先处理什么" copy="所有提醒都指向学生、触发原因、负责人和下一步动作。" actions={<><button className="secondary-button" type="button" onClick={() => setActive("schedule")}><CalendarDays size={17} /> 查看排课</button><button className="primary-button" type="button" onClick={() => setModal("student")}><UserPlus size={17} /> 新建学生</button></>} />
      <section className="command-strip" aria-label="快速工作流">
        <button type="button" onClick={() => setModal("booking")}><CalendarPlus size={18} /><span><strong>安排课程</strong><small>检查时区、老师与学生冲突</small></span><ChevronRight size={16} /></button>
        <button type="button" onClick={() => setActive("lp")}><BookOpen size={18} /><span><strong>处理 LP</strong><small>审核、发送与老师备课确认</small></span><ChevronRight size={16} /></button>
        <button type="button" onClick={() => setModal("operation")}><RefreshCw size={18} /><span><strong>记录异常</strong><small>调课、请假、代课或换老师</small></span><ChevronRight size={16} /></button>
        <button type="button" onClick={() => setActive("payroll")}><Wallet size={18} /><span><strong>核对薪资</strong><small>先处理异常，再人工锁定</small></span><ChevronRight size={16} /></button>
      </section>
      <section className="metric-grid" aria-label="今日工作概览">
        <Metric tone="blue" icon={<ListTodo size={21} />} value={visibleTasks.length.toString()} label="待处理" detail={`今天到期 ${today} 项`} onClick={() => { setTaskFilter("all"); }} />
        <Metric tone="red" icon={<AlertTriangle size={21} />} value={overdue.toString()} label="已逾期" detail="需要立即处理" onClick={() => { setTaskFilter("overdue"); }} />
        <Metric tone="amber" icon={<Clock3 size={21} />} value={waiting.toString()} label="等待他人" detail="老师、家长或资料" onClick={() => setActive("messages")} />
        <Metric tone="green" icon={<CheckCircle2 size={21} />} value={`${Math.round((tasks.filter((task) => task.status === "done").length / Math.max(tasks.length, 1)) * 100)}%`} label="已完成" detail="本地演示记录" onClick={() => setActive("audit")} />
      </section>
      <section className="dashboard-grid">
        <article className="panel task-panel">
          <div className="panel-header"><div><p className="eyebrow">强提醒队列</p><h2>优先处理</h2></div><div className="segmented" role="group" aria-label="筛选任务">{([ ["all", "全部"], ["mine", "我的"], ["overdue", "逾期"] ] as const).map(([filter, label]) => <button className={taskFilter === filter ? "active" : ""} key={filter} type="button" onClick={() => setTaskFilter(filter)}>{label}</button>)}</div></div>
          <TaskList tasks={visibleTasks} studentById={studentById} onComplete={completeTask} onOpen={(task) => goToStudent(task.studentId)} />
          <button className="text-button" type="button" onClick={() => setModal("task")}><Plus size={16} /> 添加内部任务</button>
        </article>
        <article className="panel today-panel"><div className="panel-header"><div><p className="eyebrow">按学生当地时间</p><h2>接下来课程</h2></div><IconButton label="打开排课" onClick={() => setActive("schedule")}><CalendarDays size={18} /></IconButton></div><ScheduleList bookings={bookings} studentById={studentById} teacherById={teacherById} onOpen={(booking) => goToStudent(booking.studentId, "schedule")} /><div className="panel-foot"><MapPin size={15} /> 排课页会同时显示学生、老师与公司时间</div></article>
        <article className="panel risk-panel"><div className="panel-header"><div><p className="eyebrow">需要人工判断</p><h2>风险与缺口</h2></div><StatusPill tone="amber">{overdue + 2} 项</StatusPill></div><RiskRow tone="red" title="Olivia 的试听资料不完整" detail="成绩单或最近作业未索引" action={() => goToStudent("STU-0248", "files")} /><RiskRow tone="amber" title="薪资有 1 条试听费率例外" detail="未自动锁定，等待人工核对" action={() => setActive("payroll")} /><RiskRow tone="blue" title="腾讯表格出现字段冲突" detail="负责人字段需要确认来源" action={() => setActive("sync")} /><RiskRow tone="purple" title="续课记录等待家长回复" detail="不自动判定续课结果" action={() => setActive("renewals")} /></article>
      </section>
    </>;
  };

  const renderStudents = () => <>
    <ViewHeading eyebrow="学生 CRM · 内部唯一 ID" title="学生档案" copy="姓名用于查找；排课、提醒、文件和操作记录都以内部 ID 关联。" actions={<button className="primary-button" type="button" onClick={() => setModal("student")}><UserPlus size={17} /> 新建学生</button>} />
    <section className="student-layout"><article className="panel table-panel"><div className="table-toolbar"><div className="search-field"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="查找姓名、ID、课程或负责人" aria-label="查找学生" /></div><span>{filteredStudents.length} 位学生</span></div><div className="student-table"><div className="table-head"><span>学生 / 课程</span><span>当前状态</span><span>负责人</span><span>下一步</span></div>{filteredStudents.map((student) => <button className={`table-row ${selectedStudent.id === student.id ? "selected" : ""}`} type="button" key={student.id} onClick={() => setSelectedStudentId(student.id)}><span className="table-person"><Avatar initials={student.initials} tone={statusTone(student.status)} /><span><strong>{student.name}</strong><small>{student.id} · {student.course}</small></span></span><span><StatusPill tone={statusTone(student.status)}>{student.status}</StatusPill><small>{student.teacher}</small></span><span>{student.owner}</span><span><StatusPill tone={student.nextTone}>{student.next}</StatusPill></span></button>)}</div></article><StudentDetail student={selectedStudent} tasks={tasks} bookings={bookings} files={files} studentById={studentById} teacherById={teacherById} onFiles={() => setActive("files")} onSchedule={() => { setModal("booking"); }} onStatus={(status) => { setStudents((current) => current.map((student) => student.id === selectedStudent.id ? { ...student, status } : student)); addAudit("更新学生状态", `${selectedStudent.name} → ${status}`, "blue"); notify("学生状态已更新"); }} /></section>
  </>;

  const renderTeachers = () => <>
    <ViewHeading eyebrow="人工确认的老师匹配" title="老师资源库" copy="系统只排序候选人并检查约束；最终老师、时段和对外沟通均由教务确认。" actions={<button className="secondary-button" type="button" onClick={() => setActive("students")}><Users size={17} /> 查看学生需求</button>} />
    <section className="matching-banner"><div><p className="eyebrow">当前匹配需求</p><h2>{selectedStudent.name} · {selectedStudent.course}</h2><p><MapPin size={16} /> {selectedStudent.timezone} · 试听 60 分钟 · 长期时间需确认</p></div><button className="primary-button" type="button" onClick={() => setModal("booking")}><CalendarPlus size={17} /> 确认排课</button></section>
    <section className="teacher-grid">{teachers.map((teacher) => { const isSelected = selectedTeacher.id === teacher.id; const match = teacher.subjects.some((subject) => selectedStudent.course.includes(subject.split(" ").slice(-1)[0])) ? 94 : teacher.subjects.some((subject) => subject.includes("English") && selectedStudent.course.includes("English")) ? 87 : 76; return <article className={`teacher-card ${isSelected ? "selected" : ""}`} key={teacher.id}><div className="teacher-head"><Avatar initials={teacher.initials} tone={teacher.acceptsStudents ? "green" : "neutral"} /><div><h2>{teacher.name}</h2><p>匹配度 <strong>{match}%</strong> · {teacher.load}/{teacher.capacity} 节</p></div><StatusPill tone={teacher.acceptsStudents ? "green" : "neutral"}>{teacher.acceptsStudents ? "可接新生" : "暂停接新"}</StatusPill></div><div className="teacher-tags">{teacher.subjects.map((subject) => <span key={subject}>{subject}</span>)}</div><dl><div><dt>可用时间</dt><dd>{teacher.availability}</dd></div><div><dt>时区</dt><dd>{teacher.timezone}</dd></div><div><dt>匹配说明</dt><dd>{teacher.note}</dd></div></dl><button className={isSelected ? "selected-choice" : "choice-button"} type="button" onClick={() => assignTeacher(teacher)}>{isSelected ? <><Check size={16} /> 已选择候选老师</> : "选择为候选老师"}</button><button className="teacher-toggle" type="button" onClick={() => { setTeachers((current) => current.map((item) => item.id === teacher.id ? { ...item, acceptsStudents: !item.acceptsStudents } : item)); addAudit("更新老师接新状态", `${teacher.name}：${teacher.acceptsStudents ? "暂停接新" : "开放接新"}`, "blue"); notify(`${teacher.name} 已${teacher.acceptsStudents ? "暂停" : "开放"}接新`); }}>{teacher.acceptsStudents ? "暂停接新" : "开放接新"}</button></article>; })}</section>
  </>;

  const renderSchedule = () => {
    const todayBookings = bookings.filter((booking) => booking.date >= "2026-07-20");
    return <>
      <ViewHeading eyebrow="统一时点 + IANA 时区" title="排课与时区检查" copy="保存一个准确时间点，再从学生、老师和公司时区显示，避免“澳洲时间”这类含糊记录。" actions={<button className="primary-button" type="button" onClick={() => setModal("booking")}><CalendarPlus size={17} /> 新建排课</button>} />
      <section className="schedule-workspace"><article className="panel calendar-board"><div className="calendar-toolbar"><div className="segmented"><button className="active" type="button">周视图</button><button type="button" onClick={() => notify("日视图将在后续生产版加入，当前保留周视图以展示完整信息密度")}>日视图</button></div><strong>7 月 20 日 - 25 日</strong><StatusPill tone="blue">公司：Asia/Shanghai · UTC+8</StatusPill></div><div className="week-grid"><div className="week-side"><span>时间</span>{["14:00", "16:00", "18:00", "20:00"].map((time) => <strong key={time}>{time}</strong>)}</div>{["周日 20", "周一 21", "周二 22", "周三 23", "周四 24", "周五 25"].map((day, index) => <div className="day-column" key={day}><span>{day}<small>北京</small></span>{[0, 1, 2, 3].map((slot) => <i key={slot} />)}{todayBookings.filter((booking) => Number(booking.date.slice(-2)) === 20 + index).map((booking) => { const student = studentById(booking.studentId); const teacher = teacherById(booking.teacherId); const top = 63 + (["14:00", "16:00", "18:00", "20:00"].indexOf(booking.start) * 96); return <button className={`lesson-block ${booking.status === "待确认" ? "amber" : booking.kind === "试听" ? "blue" : "green"}`} style={{ top }} key={booking.id} type="button" onClick={() => goToStudent(booking.studentId)}><strong>{student?.name}</strong><small>{booking.start} · {teacher?.name}</small><small>{booking.kind} · {booking.status}</small></button>; })}</div>)}</div></article>
        <aside className="panel booking-panel"><div className="panel-header"><div><p className="eyebrow">当前准备排课</p><h2>{selectedStudent.name}</h2></div><StatusPill tone="amber">待确认</StatusPill></div><TimeLine label="学生时间" time="周六 20 Jul · 16:00" detail={selectedStudent.timezone} /><TimeLine label="老师时间" time="周六 20 Jul · 16:00" detail={selectedTeacher.timezone} /><TimeLine label="公司时间" time="周六 20 Jul · 14:00" detail="Asia/Shanghai · UTC+8" /><div className="check-list"><span><CircleCheck size={16} /> 老师科目与长期 Availability 匹配</span><span><CircleCheck size={16} /> 学生与老师没有已有课程冲突</span><span><CircleCheck size={16} /> 这次时区换算不会跨日</span></div><button className="primary-button full" type="button" onClick={() => setModal("booking")}><CalendarPlus size={17} /> 进入排课确认</button><p className="form-footnote">确认排课后，会创建 LP、N-2 与课后检查任务；不会发送真实消息。</p></aside></section>
    </>;
  };

  const renderLp = () => <>
    <ViewHeading eyebrow="Learning Plan · 版本与审批" title="试听与 LP 工作流" copy="每一张卡都有负责人和截止时间；阶段变化会留下审计记录，旧版 LP 不会被覆盖。" actions={<button className="primary-button" type="button" onClick={() => setModal("task")}><Plus size={17} /> 添加流程任务</button>} />
    <section className="workflow-header"><div className="workflow-student"><Avatar initials={selectedStudent.initials} tone={statusTone(selectedStudent.status)} /><div><h2>{selectedStudent.name}</h2><p>{selectedStudent.course} · {selectedStudent.status} · {selectedStudent.owner}</p></div></div><button className="secondary-button" type="button" onClick={() => goToStudent(selectedStudent.id)}><Users size={16} /> 查看档案</button></section>
    <section className="kanban-board">{lpStages.map((stage) => <article key={stage}><header><span className={`kanban-dot ${stage === "完成" ? "green" : stage === "待审核" ? "amber" : stage === "已发老师" ? "blue" : "purple"}`} /> {stage}<strong>{lpItems.filter((item) => item.stage === stage).length}</strong></header>{lpItems.filter((item) => item.stage === stage).map((item) => { const student = studentById(item.studentId); const nextStage = lpStages[Math.min(lpStages.indexOf(stage) + 1, lpStages.length - 1)]; return <div className="kanban-card" key={item.id}><p>{student?.name} · {item.owner}</p><h3>{item.title}</h3><span>截止：{item.due}</span><div className="card-tags"><StatusPill tone={stage === "完成" ? "green" : "amber"}>{stage}</StatusPill></div>{stage !== "完成" && <button className="card-action" type="button" onClick={() => { setLpItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, stage: nextStage } : entry)); addAudit("推进 LP 阶段", `${item.title}：${stage} → ${nextStage}`, "green"); notify(`已推进到「${nextStage}」`); }}><ArrowRight size={15} /> 推进到 {nextStage}</button>}</div>; })}</article>)}</section>
  </>;

  const renderOperations = () => <>
    <ViewHeading eyebrow="结构化异常处理" title="调课、请假与代课" copy="记录原因为后续任务链提供依据；系统提示影响范围，但不自动决定扣费、代课老师或对外沟通。" actions={<button className="primary-button" type="button" onClick={() => setModal("operation")}><CalendarPlus size={17} /> 记录异常</button>} />
    <section className="two-column"><article className="panel"><div className="panel-header"><div><p className="eyebrow">待处理记录</p><h2>异常队列</h2></div><StatusPill tone="amber">{operations.filter((operation) => operation.status === "待处理").length} 项待确认</StatusPill></div><div className="record-list">{operations.map((operation) => { const student = studentById(operation.studentId); return <div className="record-row" key={operation.id}><div className={`record-icon ${operation.status === "已确认" ? "green" : "amber"}`}><RefreshCw size={17} /></div><div><strong>{operation.type} · {student?.name}</strong><span>{operation.detail}</span><small>{operation.createdAt}</small></div><StatusPill tone={operation.status === "已确认" ? "green" : "amber"}>{operation.status}</StatusPill>{operation.status === "待处理" && <button className="compact-button" type="button" onClick={() => { setOperations((current) => current.map((entry) => entry.id === operation.id ? { ...entry, status: "已确认" } : entry)); addAudit("确认异常处理", `${operation.type} · ${student?.name}`, "green"); notify("已确认，后续子任务已保留在工作台"); }}>确认</button>}</div>; })}</div></article><aside className="panel side-note"><p className="eyebrow">处理规则</p><h2>先记录，再决定</h2><ul><li>调课：确认学生、老师与公司时间，生成通知待办。</li><li>请假：由人工确认是否扣学生课时及老师课时。</li><li>代课：系统只给候选老师，不能自动指派。</li><li>停课：记录开始与预计复课日，再生成复课前提醒。</li></ul><button className="secondary-button full" type="button" onClick={() => setActive("audit")}><ShieldCheck size={16} /> 查看操作记录</button></aside></section>
  </>;

  const renderRenewals = () => <>
    <ViewHeading eyebrow="人工判断续课 · 自动避免遗漏" title="考试与续课" copy="系统从剩余课时与考试节点生成跟进提醒；续课结论和家长沟通仍由负责人确认。" actions={<button className="secondary-button" type="button" onClick={() => setModal("task")}><Plus size={17} /> 添加跟进</button>} />
    <section className="panel data-panel"><div className="data-table renewals-table"><div className="data-head"><span>学生 / 课程</span><span>剩余课时</span><span>预计续课</span><span>状态</span><span>操作</span></div>{renewals.map((renewal) => { const student = studentById(renewal.studentId); return <div className="data-row" key={renewal.id}><span className="table-person"><Avatar initials={student?.initials ?? "?"} tone={statusTone(renewal.status)} /><span><strong>{student?.name}</strong><small>{student?.course} · {renewal.owner}</small></span></span><span>{renewal.remaining} 节</span><span>{renewal.estimate}</span><span><StatusPill tone={statusTone(renewal.status)}>{renewal.status}</StatusPill></span><span>{renewal.status === "待跟进" ? <button className="compact-button" type="button" onClick={() => { setRenewals((current) => current.map((item) => item.id === renewal.id ? { ...item, status: "已联系" } : item)); setMessages((current) => [{ id: id("MSG"), studentId: renewal.studentId, kind: "续课前跟进", recipient: `${student?.guardian ?? "家长"}`, body: `您好，${student?.name} 目前剩余 ${renewal.remaining} 节课。教务正在确认接下来的学习安排，方便时请回复我们。`, status: "待人工确认", createdAt: `今天 ${nowLabel()}` }, ...current]); addAudit("创建续课跟进", `${student?.name} · 已生成消息待确认`, "blue"); notify("已生成续课消息，等待人工确认发送"); }}>创建跟进</button> : <button className="compact-button" type="button" onClick={() => goToStudent(renewal.studentId)}>查看档案</button>}</span></div>; })}</div></section>
  </>;

  const renderPayroll = () => <>
    <ViewHeading eyebrow="教务宝导入预览 · 人工锁定" title="课时与薪资" copy="导入数据后按已确认费率计算建议金额；所有异常、调整理由和最终确认人都必须可追溯。" actions={<button className="secondary-button" type="button" onClick={() => { setPayroll((current) => current.map((row) => row.status === "需核对" ? { ...row, status: "可审核", note: "模拟导入完成，等待人工审核" } : row)); addAudit("模拟导入教务宝数据", "已更新本地薪资预览，不影响真实教务宝", "blue"); notify("已完成样例导入与异常重算"); }}><Database size={17} /> 导入样例</button>} />
    <section className="metric-grid payroll-metrics"><Metric tone="blue" icon={<FileText size={21} />} value={`${payroll.reduce((total, row) => total + row.lessons + row.trialLessons, 0)}`} label="导入课次" detail="教务宝样例数据" /><Metric tone="amber" icon={<CircleAlert size={21} />} value={`${payroll.filter((row) => row.status === "需核对").length}`} label="需要核对" detail="不会自动锁定" /><Metric tone="green" icon={<Wallet size={21} />} value={`$${payroll.reduce((total, row) => total + row.amount, 0).toLocaleString()}`} label="建议薪资" detail="等待人工审核" /><Metric tone="purple" icon={<ShieldCheck size={21} />} value={`${payroll.filter((row) => row.status === "已锁定").length}`} label="已锁定" detail="已记录确认人" /></section>
    <section className="panel data-panel"><div className="data-table payroll-table"><div className="data-head"><span>老师</span><span>常规 / 试听课</span><span>建议金额</span><span>状态</span><span>说明与操作</span></div>{payroll.map((row) => { const teacher = teacherById(row.teacherId); return <div className="data-row" key={row.id}><span className="table-person"><Avatar initials={teacher?.initials ?? "?"} tone="blue" /><span><strong>{teacher?.name}</strong><small>{teacher?.subjects.join(" · ")}</small></span></span><span>{row.lessons} / {row.trialLessons}</span><span><strong>${row.amount.toLocaleString()}</strong></span><span><StatusPill tone={statusTone(row.status)}>{row.status}</StatusPill></span><span><small>{row.note}</small>{row.status !== "已锁定" && <button className="compact-button" type="button" onClick={() => { setPayroll((current) => current.map((item) => item.id === row.id ? { ...item, status: "已锁定", note: "已由当前操作员人工锁定" } : item)); addAudit("锁定薪资记录", `${teacher?.name} · $${row.amount.toLocaleString()}`, "green"); notify("已锁定本月演示薪资记录"); }}>人工锁定</button>}</span></div>; })}</div></section>
  </>;

  const renderMessages = () => <>
    <ViewHeading eyebrow="企业微信路由预览 · Demo 不发送" title="消息队列" copy="每条提醒先绑定学生、收件对象和负责人；外部消息必须在送出前人工确认。" actions={<button className="primary-button" type="button" onClick={() => setModal("template")}><Plus size={17} /> 新建消息</button>} />
    <section className="routing-layout"><article className="panel routing-list"><div className="panel-header"><div><p className="eyebrow">按学生关系路由</p><h2>待处理消息</h2></div><StatusPill tone="blue">{messages.filter((message) => message.status !== "已记录发送").length} 条</StatusPill></div>{messages.map((message) => { const student = studentById(message.studentId); return <button className={`route-row ${selectedMessage.id === message.id ? "selected" : ""}`} type="button" key={message.id} onClick={() => setSelectedMessageId(message.id)}><span className={`route-icon ${message.status === "待人工确认" ? "amber" : "blue"}`}><MessageCircle size={18} /></span><span><strong>{message.kind}</strong><small>{student?.name} · {message.recipient}</small></span><StatusPill tone={message.status === "待人工确认" ? "amber" : message.status === "已记录发送" ? "green" : "blue"}>{message.status}</StatusPill><ChevronRight size={17} /></button>})}<div className="send-log"><strong>安全边界</strong><p><CircleAlert size={15} /> 当前仅记录发送意图和操作日志，未连接企业微信 API。</p></div></article><aside className="panel message-preview"><div className="preview-header"><div><p className="eyebrow">发送前预览</p><h2>{selectedMessage.kind}</h2></div><StatusPill tone={selectedMessage.status === "待人工确认" ? "amber" : "blue"}>{selectedMessage.status}</StatusPill></div><div className="route-summary"><span>关联学生<strong>{studentById(selectedMessage.studentId)?.name}</strong></span><span>收件对象<strong>{selectedMessage.recipient}</strong></span><span>创建时间<strong>{selectedMessage.createdAt}</strong></span></div><div className="message-bubble">{selectedMessage.body}</div><div className="preview-foot"><CircleAlert size={16} /> 真实外部消息需要完成企业微信权限 PoC、收件对象映射及人工确认。</div><button className="primary-button full" type="button" disabled={selectedMessage.status === "已记录发送"} onClick={recordMessage}><Send size={16} /> {selectedMessage.status === "已记录发送" ? "已记录发送" : "记录为已发送"}</button></aside></section>
  </>;

  const renderFiles = () => <>
    <ViewHeading eyebrow="资料索引 · 不依赖文件名猜测" title="文件中心" copy="系统保存文件类型、关联对象与来源链接。第一阶段继续使用 Google Drive 等外部存储，不复制真实文件。" actions={<button className="primary-button" type="button" onClick={() => setModal("file")}><FilePlus2 size={17} /> 登记文件</button>} />
    <section className="files-layout"><article className="panel data-panel"><div className="data-table files-table"><div className="data-head"><span>资料</span><span>关联学生</span><span>类型</span><span>来源</span><span>加入时间</span></div>{files.map((file) => { const student = studentById(file.studentId); return <div className="data-row" key={file.id}><span className="file-title"><span className="file-icon"><FileText size={17} /></span><strong>{file.title}</strong></span><span><button className="inline-link" type="button" onClick={() => goToStudent(file.studentId)}>{student?.name} <ChevronRight size={14} /></button></span><span><StatusPill tone={file.type === "Learning Plan" ? "blue" : "neutral"}>{file.type}</StatusPill></span><span><small>{file.source}</small></span><span>{file.addedAt}</span></div>; })}</div></article><aside className="panel side-note"><p className="eyebrow">文件处理原则</p><h2>引用而不复制</h2><ul><li>记录稳定 ID、链接、资料类型和权限来源。</li><li>学生、老师、课程和 LP 都能引用同一份文件。</li><li>文件删除或权限变化应形成数据质量提醒。</li></ul><button className="secondary-button full" type="button" onClick={() => goToStudent(selectedStudent.id)}><Users size={16} /> 返回学生档案</button></aside></section>
  </>;

  const renderSync = () => <>
    <ViewHeading eyebrow="过渡期镜像 · 非备份" title="同步与导入" copy="系统将逐步成为主数据源；腾讯表格只保留明确批准的镜像和有限回写字段，并且所有冲突可追溯。" actions={<button className="primary-button" type="button" onClick={runSync} disabled={syncState === "running"}>{syncState === "running" ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}{syncState === "running" ? "同步预览中" : "运行同步预览"}</button>} />
    <section className="sync-summary"><SummaryCard icon={<Database size={19} />} tone="green" title="系统主数据" text="学生、排课、负责人、任务" /><SummaryCard icon={<RefreshCw size={19} />} tone="blue" title="腾讯表格镜像" text="仅同步已批准的字段" /><SummaryCard icon={<ShieldCheck size={19} />} tone="amber" title="独立备份" text="生产版需数据库快照与恢复点" /></section>
    <section className="sync-layout"><article className="panel ownership-panel"><div className="panel-header"><div><p className="eyebrow">字段所有权</p><h2>谁可以写入什么</h2></div><StatusPill tone={syncState === "complete" ? "green" : "blue"}>{syncState === "complete" ? "预览完成" : "待运行"}</StatusPill></div><OwnershipRow title="姓名、课程、状态、排课、负责人" detail="系统拥有 · 镜像到腾讯表格" tone="blue" label="系统为主" /><OwnershipRow title="旧流程人工备注、历史交接字段" detail="腾讯可受控回写 · 记录前后值" tone="purple" label="有限回写" /><OwnershipRow title="删除动作" detail="两端均软删除，不自动传播" tone="amber" label="人工确认" /><OwnershipRow title="正式备份" detail="数据库快照 + 恢复点 + 独立导出" tone="green" label="独立保存" /></article><aside className="panel conflict-panel"><div className="panel-header"><div><p className="eyebrow">同步冲突</p><h2>{syncResolved ? "今天没有待处理冲突" : "需要人工选择"}</h2></div><StatusPill tone={syncResolved ? "green" : "amber"}>{syncResolved ? "已解决" : "1 项"}</StatusPill></div>{syncResolved ? <div className="resolved-state"><CircleCheck size={28} /><strong>冲突已记录并处理</strong><span>系统会保留来源、时间、操作者和最终选择，供后续审计。</span></div> : <><div className="conflict-record"><span>学生</span><strong>Olivia Chen · STU-0248</strong><span>字段</span><strong>负责教务 StudentOwner</strong></div><div className="conflict-values"><div><span>系统当前值</span><strong>思佳</strong><small>今天 09:12 · 排课任务创建</small></div><div><span>腾讯表格值</span><strong>Tiffany</strong><small>今天 09:18 · 人工编辑</small></div></div><div className="conflict-actions"><button className="secondary-button" type="button" onClick={() => resolveConflict("保留系统值：思佳")}>保留系统值</button><button className="primary-button" type="button" onClick={() => resolveConflict("采用腾讯值：Tiffany")}>采用腾讯值</button></div></>}</aside></section>
  </>;

  const renderReports = () => {
    const completed = tasks.filter((task) => task.status === "done").length;
    const trialCount = students.filter((student) => student.status === "试听中").length;
    const activeTeachers = teachers.filter((teacher) => teacher.acceptsStudents).length;
    const missingFiles = students.filter((student) => student.files < 5).length;
    return <>
      <ViewHeading eyebrow="运营结果而非单纯运行成功" title="运营报表" copy="指标来自本地演示数据。生产版需要经过导入校验和字段口径确认后，才可作为经营数据。" actions={<button className="secondary-button" type="button" onClick={exportDemo}><Download size={17} /> 导出数据</button>} />
      <section className="report-grid"><ReportCard value={`${completed}/${tasks.length}`} label="任务完成" detail="提醒完成情况" tone="green" /><ReportCard value={`${trialCount}`} label="进行中的试听" detail="需要持续关注" tone="amber" /><ReportCard value={`${activeTeachers}/${teachers.length}`} label="可接新老师" detail="当前可用资源" tone="blue" /><ReportCard value={`${missingFiles}`} label="资料待补" detail="文件索引少于 5 项" tone="red" /></section>
      <section className="two-column"><article className="panel chart-panel"><div className="panel-header"><div><p className="eyebrow">负责人负载</p><h2>待处理任务</h2></div><StatusPill tone="blue">动态计算</StatusPill></div>{["思佳", "Tiffany", "Abby", "Tara"].map((owner) => { const count = tasks.filter((task) => task.owner === owner && task.status !== "done").length; return <div className="bar-row" key={owner}><span>{owner}</span><div><i style={{ width: `${Math.max(12, count * 24)}%` }} /></div><strong>{count} 项</strong></div>; })}</article><article className="panel chart-panel"><div className="panel-header"><div><p className="eyebrow">需要留意</p><h2>数据质量</h2></div><StatusPill tone="amber">人工复核</StatusPill></div><DataIssue title="试听资料缺少索引" count={`${missingFiles} 位学生`} tone="red" /><DataIssue title="薪资规则例外" count={`${payroll.filter((row) => row.status === "需核对").length} 条记录`} tone="amber" /><DataIssue title="同步冲突" count={syncResolved ? "0 项待处理" : "1 项待处理"} tone="blue" /><DataIssue title="未确认排课" count={`${bookings.filter((booking) => booking.status === "待确认").length} 节`} tone="purple" /></article></section>
    </>;
  };

  const renderSettings = () => <>
    <ViewHeading eyebrow="规则应可读、可改、可审计" title="规则设置" copy="当前设置只影响本地 Demo 的展示与新建工作流；生产版必须为每项规则设定负责人、版本和生效时间。" actions={<button className="secondary-button" type="button" onClick={resetDemo}><RefreshCw size={17} /> 恢复示例数据</button>} />
    <section className="settings-grid"><article className="panel settings-panel"><div className="panel-header"><div><p className="eyebrow">强提醒规则</p><h2>时间节点</h2></div><StatusPill tone="amber">草稿</StatusPill></div><label>LP 默认提前<input value={rules.lpDays} onChange={(event) => setRules((current) => ({ ...current, lpDays: event.target.value }))} /></label><label>课后反馈检查（小时）<input value={rules.feedbackHours} onChange={(event) => setRules((current) => ({ ...current, feedbackHours: event.target.value }))} /></label><label>续课预销售提前（天）<input value={rules.renewalDays} onChange={(event) => setRules((current) => ({ ...current, renewalDays: event.target.value }))} /></label><label>逾期升级规则<input value={rules.escalation} onChange={(event) => setRules((current) => ({ ...current, escalation: event.target.value }))} /></label><button className="primary-button" type="button" onClick={() => { addAudit("保存强提醒规则", `LP ${rules.lpDays}、课后 ${rules.feedbackHours}h、续课 ${rules.renewalDays} 天`, "green"); notify("规则已保存到当前浏览器的 Demo 数据"); }}><Check size={17} /> 保存规则</button></article><article className="panel side-note"><p className="eyebrow">上线前必须确认</p><h2>外部集成边界</h2><ul><li>企业微信：先验证应用权限、员工、客户群和频率限制。</li><li>教务宝：先核对导出字段与薪资口径，不把样例计算当最终工资。</li><li>腾讯表格：定义系统拥有字段、可回写字段与冲突处理规则。</li><li>ClassIn：先做 API/SDK 权限与中澳网络测试。</li></ul><button className="secondary-button full" type="button" onClick={() => setActive("sync")}><RefreshCw size={16} /> 查看同步边界</button></article></section>
  </>;

  const renderAudit = () => <>
    <ViewHeading eyebrow="完整操作留痕" title="操作审计" copy="每次本地操作都记录时间、操作者、动作和关联结果。生产版还应记录来源系统、IP、权限和不可篡改的保留策略。" actions={<button className="secondary-button" type="button" onClick={exportDemo}><Download size={17} /> 导出数据</button>} />
    <section className="panel audit-panel"><div className="audit-head"><span>时间</span><span>操作者</span><span>动作</span><span>详情</span></div>{audit.map((entry) => <div className="audit-row" key={entry.id}><span>{entry.time}</span><span>{entry.actor}</span><span><StatusPill tone={entry.tone}>{entry.action}</StatusPill></span><span>{entry.detail}</span></div>)}</section>
  </>;

  const renderView = () => {
    switch (active) {
      case "dashboard": return renderDashboard();
      case "students": return renderStudents();
      case "teachers": return renderTeachers();
      case "schedule": return renderSchedule();
      case "lp": return renderLp();
      case "operations": return renderOperations();
      case "renewals": return renderRenewals();
      case "payroll": return renderPayroll();
      case "messages": return renderMessages();
      case "files": return renderFiles();
      case "sync": return renderSync();
      case "reports": return renderReports();
      case "settings": return renderSettings();
      case "audit": return renderAudit();
    }
  };

  const submitStudent = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const course = String(data.get("course") ?? "").trim();
    if (!name || !course) return;
    const newStudent: Student = { id: id("STU"), name, initials: initials(name), status: "待排课", owner: String(data.get("owner") ?? "思佳"), course, timezone: String(data.get("timezone") ?? "Australia/Melbourne · UTC+10"), guardian: String(data.get("guardian") ?? "待补充"), teacher: "待匹配", next: "完成试听交接", nextTone: "blue", files: 0 };
    setStudents((current) => [newStudent, ...current]);
    setSelectedStudentId(newStudent.id);
    setTasks((current) => [{ id: id("TSK"), title: "完成试听交接与老师匹配", owner: newStudent.owner, studentId: newStudent.id, due: "今天", status: "today", tone: "blue", category: "试听", trigger: "新建学生记录" }, ...current]);
    addAudit("新建学生档案", `${newStudent.name} · ${newStudent.id}`, "green");
    setModal(null); setActive("students"); notify("学生档案和首个试听任务已创建");
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

  const submitBooking = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const studentId = String(data.get("studentId") ?? selectedStudent.id);
    const teacherId = String(data.get("teacherId") ?? selectedTeacher.id);
    const date = String(data.get("date") ?? ""); const start = String(data.get("start") ?? ""); const duration = Number(data.get("duration") ?? 60);
    if (scheduleConflict(studentId, teacherId, date, start, duration)) { notify("这个学生或老师在该时段已有重叠课程，请先选择其他时段。"); return; }
    const kind = String(data.get("kind") ?? "试听") as Booking["kind"];
    const booking: Booking = { id: id("LES"), studentId, teacherId, date, start, duration, kind, status: "待确认", timezone: studentById(studentId)?.timezone.split(" · ")[0] ?? "Australia/Melbourne" };
    const teacher = teacherById(teacherId); const student = studentById(studentId);
    setBookings((current) => [...current, booking]);
    setStudents((current) => current.map((item) => item.id === studentId ? { ...item, teacher: teacher?.name ?? "待匹配", status: kind === "试听" ? "试听中" : item.status, next: "完成 LP 与 N-2 检查", nextTone: "amber" } : item));
    createWorkflowTasks(studentId, kind === "试听");
    addAudit("创建排课", `${student?.name} · ${date} ${start} · ${teacher?.name}`, "green");
    setModal(null); setActive("schedule"); notify("排课已创建，并生成 LP、N-2 和课后检查任务");
  };

  const submitOperation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const studentId = String(data.get("studentId") ?? selectedStudent.id); const type = String(data.get("type") ?? "调课") as Operation["type"]; const detail = String(data.get("detail") ?? "").trim(); if (!detail) return;
    const operation: Operation = { id: id("OPS"), studentId, type, detail, status: "待处理", createdAt: `今天 ${nowLabel()}` };
    setOperations((current) => [operation, ...current]); setTasks((current) => [{ id: id("TSK"), title: `${type}：${detail}`, owner: studentById(studentId)?.owner ?? "待分配", studentId, due: "待人工确认", status: "today", tone: "amber", category: "排课", trigger: `${type}记录后自动生成` }, ...current]);
    addAudit("记录教务异常", `${studentById(studentId)?.name} · ${type}`, "amber"); setModal(null); setActive("operations"); notify("异常已记录，并生成后续处理任务");
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
        <div className="workspace-switch"><span className="workspace-dot" /> 全局管理视图 <ChevronDown size={15} /></div>
        <button className="new-button" type="button" onClick={() => setModal("task")}><Plus size={17} /> 新建</button>
        <nav aria-label="主要导航">
          <p>学生与教务</p>
          {navigation.filter((item) => item.group === "work").map((item) => {
            const Icon = item.icon;
            return <button className={active === item.id ? "nav-item active" : "nav-item"} type="button" key={item.id} onClick={() => setActive(item.id)}><Icon size={18} /><span>{item.label}</span>{item.id === "dashboard" && <b>{tasks.filter((task) => task.status !== "done").length}</b>}</button>;
          })}
          <p>运营与系统</p>
          {navigation.filter((item) => item.group === "support").map((item) => {
            const Icon = item.icon;
            return <button className={active === item.id ? "nav-item active" : "nav-item"} type="button" key={item.id} onClick={() => setActive(item.id)}><Icon size={18} /><span>{item.label}</span></button>;
          })}
        </nav>
        <div className="sidebar-foot"><StatusPill tone="amber">本地 MVP</StatusPill><span>未连接真实外部系统</span></div>
      </aside>
      <section className="main-stage">
        <header className="topbar">
          <div className="breadcrumb"><span>吟领教育</span><ChevronRight size={15} /><strong>{navigation.find((item) => item.id === active)?.label}</strong></div>
          <div className="top-actions">
            <button className="top-search" type="button" onClick={() => setActive("students")}><Search size={16} /> 搜索学生、老师或 ID</button>
            <IconButton label="查看提醒" onClick={() => setActive("dashboard")}><ListTodo size={18} /></IconButton>
            <span className="operator"><Avatar initials="NC" tone="green" /> Nixon</span>
          </div>
        </header>
        <div className="content">{renderView()}</div>
      </section>
      {toast && <div className="toast"><CheckCircle2 size={17} /> {toast}</div>}

      {modal === "student" && <Dialog title="新建学生档案" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitStudent}>
          <label>学生姓名<input name="name" autoFocus placeholder="例如 Olivia Chen" required /></label>
          <label>课程 / 年级<input name="course" placeholder="例如 Year 10 English" required /></label>
          <label>负责人<select name="owner"><option>思佳</option><option>Tiffany</option><option>Abby</option><option>Tara</option></select></label>
          <label>学生时区<select name="timezone"><option>Australia/Melbourne · UTC+10</option><option>Australia/Sydney · UTC+10</option><option>Australia/Perth · UTC+8</option><option>Asia/Shanghai · UTC+8</option></select></label>
          <label className="span-2">家长 / 沟通对象<input name="guardian" placeholder="例如 Chen 先生 · 企业微信客户群" /></label>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><UserPlus size={16} /> 创建档案</button></footer>
        </form>
      </Dialog>}

      {modal === "task" && <Dialog title="添加内部任务" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitTask}>
          <label className="span-2">任务内容<input name="title" autoFocus placeholder="例如确认家长是否收到上课链接" required /></label>
          <label>关联学生<select name="studentId" defaultValue={selectedStudent.id}>{students.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.id}</option>)}</select></label>
          <label>负责人<select name="owner"><option>思佳</option><option>Tiffany</option><option>Abby</option><option>Tara</option></select></label>
          <label>截止时间<input name="due" defaultValue="今天" /></label>
          <label>任务分类<select name="category"><option>资料</option><option>试听</option><option>LP</option><option>排课</option><option>课后</option><option>续课</option><option>薪资</option></select></label>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><Plus size={16} /> 加入队列</button></footer>
        </form>
      </Dialog>}

      {modal === "booking" && <Dialog title="新建排课" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitBooking}>
          <label>学生<select name="studentId" defaultValue={selectedStudent.id}>{students.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.course}</option>)}</select></label>
          <label>老师<select name="teacherId" defaultValue={selectedTeacher.id}>{teachers.map((teacher) => <option value={teacher.id} key={teacher.id}>{teacher.name} · {teacher.availability}</option>)}</select></label>
          <label>日期<input name="date" type="date" defaultValue="2026-07-20" required /></label>
          <label>开始时间<input name="start" type="time" defaultValue="16:00" required /></label>
          <label>课程类型<select name="kind"><option>试听</option><option>常规课</option><option>代课</option></select></label>
          <label>课程时长<select name="duration"><option value="60">60 分钟</option><option value="90">90 分钟</option><option value="120">120 分钟</option></select></label>
          <div className="form-notice span-2"><CircleAlert size={16} /> 提交前会检查同一学生或老师是否有时间重叠；成功后自动生成 LP、N-2 和课后检查任务。</div>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><CalendarPlus size={16} /> 检查并创建</button></footer>
        </form>
      </Dialog>}

      {modal === "operation" && <Dialog title="记录调课、请假或代课" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitOperation}>
          <label>学生<select name="studentId" defaultValue={selectedStudent.id}>{students.map((student) => <option value={student.id} key={student.id}>{student.name}</option>)}</select></label>
          <label>类型<select name="type"><option>调课</option><option>请假</option><option>停课</option><option>代课</option><option>换老师</option></select></label>
          <label className="span-2">处理说明<textarea name="detail" rows={4} placeholder="记录原时间、原因、可选时间或需要的后续确认" required /></label>
          <div className="form-notice span-2"><CircleAlert size={16} /> 系统只创建处理任务；是否扣课、由谁代课和对外通知均保留人工决定。</div>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><ClipboardCheck size={16} /> 记录并生成任务</button></footer>
        </form>
      </Dialog>}

      {modal === "file" && <Dialog title="登记资料链接" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitFile}>
          <label>关联学生<select name="studentId" defaultValue={selectedStudent.id}>{students.map((student) => <option value={student.id} key={student.id}>{student.name}</option>)}</select></label>
          <label>资料类型<select name="type"><option>Learning Plan</option><option>成绩单</option><option>课堂反馈</option><option>资料链接</option><option>其他</option></select></label>
          <label className="span-2">资料名称<input name="title" autoFocus placeholder="例如 2026 Semester 2 Learning Plan" required /></label>
          <label className="span-2">来源链接或说明<input name="source" placeholder="例如 Google Drive · https://..." /></label>
          <footer><button className="secondary-button" type="button" onClick={() => setModal(null)}>取消</button><button className="primary-button" type="submit"><FilePlus2 size={16} /> 登记资料</button></footer>
        </form>
      </Dialog>}

      {modal === "template" && <Dialog title="新建消息待确认" onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={submitTemplate}>
          <label>关联学生<select name="studentId" defaultValue={selectedStudent.id}>{students.map((student) => <option value={student.id} key={student.id}>{student.name}</option>)}</select></label>
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
function ScheduleList({ bookings, studentById, teacherById, onOpen }: { bookings: Booking[]; studentById: (id: string) => Student | undefined; teacherById: (id: string) => Teacher | undefined; onOpen: (booking: Booking) => void }) { return <div className="schedule-list">{bookings.slice(0, 4).map((booking) => <button className="schedule-row" type="button" key={booking.id} onClick={() => onOpen(booking)}><span className="schedule-time"><strong>{booking.start}</strong><small>{booking.date.slice(5).replace("-", "/")}</small></span><span className={`schedule-line ${booking.status === "待确认" ? "amber" : booking.kind === "试听" ? "blue" : "green"}`} /><span className="schedule-copy"><strong>{studentById(booking.studentId)?.name}</strong><small>{teacherById(booking.teacherId)?.name} · {booking.kind} · {booking.status}</small></span><ChevronRight size={16} /></button>)}</div>; }
function RiskRow({ tone, title, detail, action }: { tone: Tone; title: string; detail: string; action: () => void }) { return <button className="risk-row" type="button" onClick={action}><span className={`risk-icon ${tone}`}><CircleAlert size={16} /></span><span><strong>{title}</strong><small>{detail}</small></span><ChevronRight size={15} /></button>; }
function StudentDetail({ student, tasks, bookings, files, teacherById, onFiles, onSchedule, onStatus }: { student: Student; tasks: Task[]; bookings: Booking[]; files: FileRecord[]; studentById: (id: string) => Student | undefined; teacherById: (id: string) => Teacher | undefined; onFiles: () => void; onSchedule: () => void; onStatus: (status: Student["status"]) => void }) { const studentTasks = tasks.filter((task) => task.studentId === student.id && task.status !== "done"); const nextBooking = bookings.find((booking) => booking.studentId === student.id); return <aside className="panel student-detail"><div className="detail-top"><Avatar initials={student.initials} tone={statusTone(student.status)} /><div><p>{student.id}</p><h2>{student.name}</h2><StatusPill tone={statusTone(student.status)}>{student.status}</StatusPill></div><IconButton label="更多学生操作"><MoreHorizontal size={18} /></IconButton></div><div className="detail-section"><span>课程与负责人</span><strong>{student.course}</strong><p>{student.owner} · {student.timezone}</p></div><div className="detail-section split"><div><span>老师</span><strong>{student.teacher}</strong></div><div><span>资料</span><button className="inline-link" type="button" onClick={onFiles}>{files.filter((file) => file.studentId === student.id).length} 项索引 <ChevronRight size={14} /></button></div></div><div className="detail-section"><span>家长与沟通路由</span><strong>{student.guardian}</strong></div><label className="status-select">学生状态<select value={student.status} onChange={(event) => onStatus(event.target.value as Student["status"])}>{["待排课", "试听中", "在读", "待续课", "停课"].map((status) => <option key={status}>{status}</option>)}</select></label><div className="timeline"><div className="timeline-title"><strong>下一步与时间线</strong><small>{studentTasks.length} 项待办</small></div>{studentTasks.slice(0, 3).map((task) => <div className="timeline-item" key={task.id}><i className={task.tone} /><span><strong>{task.title}</strong><small>{task.due} · {task.owner}</small></span></div>)}{nextBooking && <div className="timeline-item"><i className="green" /><span><strong>下一节：{nextBooking.date} {nextBooking.start}</strong><small>{teacherById(nextBooking.teacherId)?.name} · {nextBooking.kind}</small></span></div>}</div><button className="primary-button full" type="button" onClick={onSchedule}><CalendarPlus size={16} /> 为此学生安排课程</button></aside>; }
function TimeLine({ label, time, detail }: { label: string; time: string; detail: string }) { return <div className="booking-line"><span>{label}</span><strong>{time}</strong><small>{detail}</small></div>; }
function SummaryCard({ icon, tone, title, text }: { icon: ReactNode; tone: Tone; title: string; text: string }) { return <article><span className={`sync-icon ${tone}`}>{icon}</span><span><strong>{title}</strong><small>{text}</small></span></article>; }
function OwnershipRow({ title, detail, tone, label }: { title: string; detail: string; tone: Tone; label: string }) { return <div className="ownership-row"><span><strong>{title}</strong><small>{detail}</small></span><StatusPill tone={tone}>{label}</StatusPill></div>; }
function ReportCard({ value, label, detail, tone }: { value: string; label: string; detail: string; tone: Tone }) { return <article className={`report-card ${tone}`}><strong>{value}</strong><span>{label}</span><small>{detail}</small></article>; }
function DataIssue({ title, count, tone }: { title: string; count: string; tone: Tone }) { return <div className="issue-row"><span className={`risk-icon ${tone}`}><CircleAlert size={16} /></span><span><strong>{title}</strong><small>{count}</small></span></div>; }
