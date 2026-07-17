"use client";

import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BadgeDollarSign,
  BarChart3,
  Bell,
  BookOpen,
  CalendarClock,
  CalendarDays,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  Database,
  ExternalLink,
  FileText,
  FolderOpen,
  Globe2,
  GraduationCap,
  LayoutDashboard,
  ListFilter,
  ListTodo,
  MapPin,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

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

type Task = {
  id: number;
  title: string;
  owner: string;
  due: string;
  student: string;
  status: "overdue" | "today" | "upcoming" | "waiting" | "done";
  tone: "red" | "amber" | "blue" | "green";
};

const navigation: Array<{
  id: Section;
  label: string;
  icon: typeof LayoutDashboard;
  group: "core" | "support";
}> = [
  { id: "dashboard", label: "工作台", icon: LayoutDashboard, group: "core" },
  { id: "students", label: "学生", icon: Users, group: "core" },
  { id: "teachers", label: "老师", icon: GraduationCap, group: "core" },
  { id: "schedule", label: "排课日历", icon: CalendarDays, group: "core" },
  { id: "lp", label: "试听与 LP", icon: BookOpen, group: "core" },
  { id: "operations", label: "调课与代课", icon: CalendarClock, group: "core" },
  { id: "renewals", label: "考试与续课", icon: ListTodo, group: "core" },
  { id: "payroll", label: "课时与薪资", icon: Wallet, group: "support" },
  { id: "messages", label: "消息与企业微信", icon: MessageSquare, group: "support" },
  { id: "files", label: "文件中心", icon: FolderOpen, group: "support" },
  { id: "sync", label: "数据同步", icon: RefreshCw, group: "support" },
  { id: "reports", label: "报表", icon: BarChart3, group: "support" },
  { id: "settings", label: "规则与设置", icon: Settings, group: "support" },
  { id: "audit", label: "操作审计", icon: ShieldCheck, group: "support" },
];

const initialTasks: Task[] = [
  {
    id: 1,
    title: "确认 N-2 资料与收费状态",
    owner: "思佳",
    due: "今天 10:30",
    student: "Olivia Chen · 英文试听",
    status: "overdue",
    tone: "red",
  },
  {
    id: 2,
    title: "发送 LP 给老师并确认备课",
    owner: "Tiffany",
    due: "今天 14:00",
    student: "Lucas Wang · IB 数学",
    status: "today",
    tone: "amber",
  },
  {
    id: 3,
    title: "跟进家长：考试日期已变更",
    owner: "Abby",
    due: "今天 16:30",
    student: "Sophie Liu · VCE 化学",
    status: "today",
    tone: "blue",
  },
  {
    id: 4,
    title: "核对教务宝未结课记录",
    owner: "思佳",
    due: "明天 11:00",
    student: "Ethan Zhao · 物理",
    status: "upcoming",
    tone: "amber",
  },
  {
    id: 5,
    title: "等待老师确认长期可上课时间",
    owner: "Tara",
    due: "等待回复",
    student: "Mia Zhang · 小学英文",
    status: "waiting",
    tone: "blue",
  },
];

const students = [
  {
    id: "STU-0248",
    name: "Olivia Chen",
    initials: "OC",
    status: "试听中",
    statusTone: "amber",
    owner: "思佳",
    course: "Year 10 English",
    location: "Melbourne · UTC+10",
    next: "N-2 资料与收费确认",
    nextTone: "red",
    guardian: "Chen 先生 · 企业微信客户群",
    teacher: "待确认",
    date: "周六 20 Jul · 16:00",
    timezone: "北京 14:00 · 伦敦 07:00",
    files: 4,
  },
  {
    id: "STU-0194",
    name: "Lucas Wang",
    initials: "LW",
    status: "在读",
    statusTone: "green",
    owner: "Tiffany",
    course: "IB Mathematics AA HL",
    location: "Sydney · UTC+10",
    next: "LP 待发老师",
    nextTone: "amber",
    guardian: "Wang 女士 · 企业微信客户",
    teacher: "Daniel Wu",
    date: "周四 18 Jul · 19:00",
    timezone: "北京 17:00 · 伦敦 10:00",
    files: 9,
  },
  {
    id: "STU-0231",
    name: "Sophie Liu",
    initials: "SL",
    status: "在读",
    statusTone: "green",
    owner: "Abby",
    course: "VCE Chemistry",
    location: "Melbourne · UTC+10",
    next: "更新考试节点",
    nextTone: "blue",
    guardian: "Liu 女士 · 企业微信客户群",
    teacher: "Amelia Brown",
    date: "周一 22 Jul · 18:30",
    timezone: "北京 16:30 · 伦敦 09:30",
    files: 7,
  },
  {
    id: "STU-0176",
    name: "Ethan Zhao",
    initials: "EZ",
    status: "待续课",
    statusTone: "purple",
    owner: "思佳",
    course: "Year 12 Physics",
    location: "Perth · UTC+8",
    next: "续课 N-8 跟进",
    nextTone: "amber",
    guardian: "Zhao 女士 · 企业微信客户",
    teacher: "Michael Yu",
    date: "周三 24 Jul · 17:00",
    timezone: "北京 17:00 · 伦敦 10:00",
    files: 6,
  },
];

const teacherCandidates = [
  {
    name: "Amelia Brown",
    initials: "AB",
    match: 94,
    areas: ["Year 10 English", "VCE English"],
    availability: "周六 15:00-20:00",
    location: "Melbourne · UTC+10",
    load: "8 / 12 节",
    note: "长期时段匹配，试听经验充足",
  },
  {
    name: "Grace Lin",
    initials: "GL",
    match: 87,
    areas: ["Year 7-10 English", "写作"],
    availability: "周六 16:00-19:00",
    location: "Sydney · UTC+10",
    load: "10 / 12 节",
    note: "科目匹配，负载偏高",
  },
  {
    name: "Rachel Song",
    initials: "RS",
    match: 78,
    areas: ["Year 9-10 English"],
    availability: "周六 14:00-17:00",
    location: "Brisbane · UTC+10",
    load: "4 / 10 节",
    note: "需要确认家长对老师背景的偏好",
  },
];

const scheduleItems = [
  {
    time: "14:00",
    timeChina: "12:00 北京",
    title: "Olivia Chen · 英文试听",
    detail: "待确认老师 · 60 分钟 · 资料待补",
    tone: "amber",
  },
  {
    time: "16:00",
    timeChina: "14:00 北京",
    title: "Sophie Liu · VCE 化学",
    detail: "Amelia Brown · 常规课 · 已确认",
    tone: "blue",
  },
  {
    time: "18:30",
    timeChina: "16:30 北京",
    title: "Lucas Wang · IB 数学",
    detail: "Daniel Wu · LP 待发送 · 已排课",
    tone: "green",
  },
  {
    time: "20:00",
    timeChina: "18:00 北京",
    title: "Ethan Zhao · 物理",
    detail: "Michael Yu · 续课前常规课",
    tone: "purple",
  },
];

function StatusPill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function Avatar({ initials, tone = "blue" }: { initials: string; tone?: string }) {
  return <span className={`avatar ${tone}`}>{initials}</span>;
}

function MiniAction({ label }: { label: string }) {
  return (
    <button className="icon-button" aria-label={label} title={label} type="button">
      <MoreHorizontal size={18} aria-hidden="true" />
    </button>
  );
}

function EmptyModule({ section }: { section: string }) {
  return (
    <section className="placeholder-view">
      <div className="placeholder-icon"><LayersIcon /></div>
      <p className="eyebrow">DEMO 模块</p>
      <h1>{section}</h1>
      <p>
        这个页面已保留在完整产品架构中。当前 Demo 将重点验证排课、任务、学生档案、消息路由和薪资核对，
        此模块会在试点阶段接入真实规则与数据。
      </p>
      <div className="placeholder-grid">
        <div><span>数据来源</span><strong>人工导入 / 已验证集成</strong></div>
        <div><span>操作方式</span><strong>先人工确认，再逐步自动化</strong></div>
        <div><span>上线条件</span><strong>规则字典与负责人确认</strong></div>
      </div>
    </section>
  );
}

function LayersIcon() {
  return <Database size={28} aria-hidden="true" />;
}

export default function Home() {
  const [active, setActive] = useState<Section>("dashboard");
  const [tasks, setTasks] = useState(initialTasks);
  const [taskFilter, setTaskFilter] = useState<"all" | "mine" | "overdue">("all");
  const [selectedStudentId, setSelectedStudentId] = useState("STU-0248");
  const [selectedTeacher, setSelectedTeacher] = useState("Amelia Brown");
  const [lpSent, setLpSent] = useState(false);
  const [syncResolved, setSyncResolved] = useState(false);
  const [showMessagePreview, setShowMessagePreview] = useState(true);

  const selectedStudent = students.find((student) => student.id === selectedStudentId) ?? students[0];
  const visibleTasks = useMemo(() => {
    if (taskFilter === "overdue") return tasks.filter((task) => task.status === "overdue");
    if (taskFilter === "mine") return tasks.filter((task) => task.owner === "思佳");
    return tasks.filter((task) => task.status !== "done");
  }, [taskFilter, tasks]);

  const completeTask = (taskId: number) => {
    setTasks((current) => current.map((task) => (
      task.id === taskId ? { ...task, status: "done", tone: "green", due: "已完成" } : task
    )));
  };

  const renderDashboard = () => (
    <>
      <section className="view-heading">
        <div>
          <p className="eyebrow">2026 年 7 月 17 日 · 星期五</p>
          <h1>今天的教务工作台</h1>
          <p className="view-copy">先处理会影响试听、开课和家长体验的事项。</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" type="button" onClick={() => setActive("schedule")}>
            <CalendarDays size={17} aria-hidden="true" /> 查看日历
          </button>
          <button className="primary-button" type="button" onClick={() => setActive("students")}>
            <Plus size={17} aria-hidden="true" /> 新建学生记录
          </button>
        </div>
      </section>

      <section className="metric-grid" aria-label="今日工作概览">
        <article className="metric-card blue-card">
          <div className="metric-icon"><ListTodo size={21} aria-hidden="true" /></div>
          <div><span>待处理任务</span><strong>14</strong><small>今天到期 6 项</small></div>
          <ArrowUpRight size={18} aria-hidden="true" />
        </article>
        <article className="metric-card red-card">
          <div className="metric-icon"><AlertTriangle size={21} aria-hidden="true" /></div>
          <div><span>已逾期</span><strong>3</strong><small>其中 1 项影响试听</small></div>
          <ArrowUpRight size={18} aria-hidden="true" />
        </article>
        <article className="metric-card amber-card">
          <div className="metric-icon"><Bell size={21} aria-hidden="true" /></div>
          <div><span>等待他人</span><strong>5</strong><small>老师确认 3 项</small></div>
          <ArrowUpRight size={18} aria-hidden="true" />
        </article>
        <article className="metric-card green-card">
          <div className="metric-icon"><CircleCheck size={21} aria-hidden="true" /></div>
          <div><span>本周按时完成</span><strong>93%</strong><small>较上周 +4%</small></div>
          <ArrowUpRight size={18} aria-hidden="true" />
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="panel task-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">强提醒</p>
              <h2>优先处理</h2>
            </div>
            <div className="segmented" role="group" aria-label="筛选任务">
              {([
                ["all", "全部"],
                ["mine", "我的"],
                ["overdue", "已逾期"],
              ] as const).map(([id, label]) => (
                <button
                  className={taskFilter === id ? "active" : ""}
                  key={id}
                  onClick={() => setTaskFilter(id)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="task-list">
            {visibleTasks.length === 0 ? (
              <div className="task-empty"><CircleCheck size={20} aria-hidden="true" /> 当前筛选下没有待处理事项</div>
            ) : visibleTasks.map((task) => (
              <div className="task-row" key={task.id}>
                <span className={`task-dot ${task.tone}`} aria-hidden="true" />
                <div className="task-copy">
                  <strong>{task.title}</strong>
                  <span>{task.student} · {task.owner}</span>
                </div>
                <span className={`due-label ${task.status}`}>{task.due}</span>
                <button
                  className="complete-button"
                  onClick={() => completeTask(task.id)}
                  title="标记完成"
                  aria-label={`完成：${task.title}`}
                  type="button"
                >
                  <Check size={16} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
          <button className="text-button" onClick={() => setActive("lp")} type="button">
            查看全部任务 <ArrowRight size={16} aria-hidden="true" />
          </button>
        </article>

        <article className="panel schedule-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">学生当地时间 · Australia/Melbourne</p>
              <h2>今日课程</h2>
            </div>
            <button className="icon-button" aria-label="筛选日程" title="筛选日程" type="button">
              <ListFilter size={18} aria-hidden="true" />
            </button>
          </div>
          <div className="schedule-list">
            {scheduleItems.map((item) => (
              <button className="schedule-row" key={item.title} type="button" onClick={() => setActive("schedule")}>
                <div className="schedule-time"><strong>{item.time}</strong><span>{item.timeChina}</span></div>
                <span className={`schedule-line ${item.tone}`} aria-hidden="true" />
                <div className="schedule-copy"><strong>{item.title}</strong><span>{item.detail}</span></div>
                <ChevronRight size={17} aria-hidden="true" />
              </button>
            ))}
          </div>
          <div className="timezone-note"><Globe2 size={16} aria-hidden="true" /> 默认以学生当地时间展示，悬停可查看老师与公司时区。</div>
        </article>

        <article className="panel alerts-panel">
          <div className="panel-header"><div><p className="eyebrow">风险雷达</p><h2>需要留意</h2></div><MiniAction label="更多风险事项" /></div>
          <div className="risk-list">
            <div className="risk-row"><span className="risk-icon red"><CircleAlert size={17} /></span><div><strong>Olivia Chen 的试听资料不完整</strong><span>缺家长目标与最近成绩单</span></div><span className="risk-count">影响试听</span></div>
            <div className="risk-row"><span className="risk-icon amber"><Clock3 size={17} /></span><div><strong>2 节课超过 N+2 未结课</strong><span>来自教务宝导入核对</span></div><span className="risk-count">需处理</span></div>
            <div className="risk-row"><span className="risk-icon blue"><RefreshCw size={17} /></span><div><strong>腾讯表格有 1 个字段冲突</strong><span>等待确认 StudentOwner</span></div><span className="risk-count">可解决</span></div>
          </div>
        </article>
      </section>
    </>
  );

  const renderStudents = () => (
    <>
      <section className="view-heading">
        <div><p className="eyebrow">学生 CRM · 4 条 Demo 记录</p><h1>学生与学习进度</h1><p className="view-copy">每位学生从试听、排课到续课都在同一条时间线上。</p></div>
        <div className="heading-actions"><button className="secondary-button" type="button"><Search size={17} /> 搜索</button><button className="primary-button" type="button"><Plus size={17} /> 新建学生</button></div>
      </section>
      <section className="student-layout">
        <article className="panel table-panel">
          <div className="table-toolbar"><span>全部学生</span><div><StatusPill tone="green">在读 2</StatusPill><StatusPill tone="amber">试听 1</StatusPill><StatusPill tone="purple">待续课 1</StatusPill></div></div>
          <div className="student-table" role="table" aria-label="学生列表">
            <div className="table-head" role="row"><span>学生</span><span>当前学习</span><span>负责人</span><span>下一步</span></div>
            {students.map((student) => (
              <button
                className={`table-row ${selectedStudent.id === student.id ? "selected" : ""}`}
                key={student.id}
                onClick={() => setSelectedStudentId(student.id)}
                type="button"
              >
                <span className="table-person"><Avatar initials={student.initials} tone={student.statusTone} /><span><strong>{student.name}</strong><small>{student.id} · {student.location}</small></span></span>
                <span><strong>{student.course}</strong><small><StatusPill tone={student.statusTone}>{student.status}</StatusPill></small></span>
                <span>{student.owner}</span>
                <span><StatusPill tone={student.nextTone}>{student.next}</StatusPill></span>
              </button>
            ))}
          </div>
        </article>

        <aside className="panel student-detail">
          <div className="detail-top"><Avatar initials={selectedStudent.initials} tone={selectedStudent.statusTone} /><div><p>{selectedStudent.id}</p><h2>{selectedStudent.name}</h2><StatusPill tone={selectedStudent.statusTone}>{selectedStudent.status}</StatusPill></div><MiniAction label="学生操作" /></div>
          <div className="detail-section"><span>本次课程</span><strong>{selectedStudent.course}</strong><p><CalendarDays size={15} /> {selectedStudent.date}</p><p><Globe2 size={15} /> {selectedStudent.timezone}</p></div>
          <div className="detail-section split"><div><span>负责教务</span><strong>{selectedStudent.owner}</strong></div><div><span>授课老师</span><strong>{selectedStudent.teacher}</strong></div></div>
          <div className="detail-section"><span>家长与消息路由</span><strong>{selectedStudent.guardian}</strong><button className="inline-link" onClick={() => setActive("messages")} type="button">查看企业微信路由 <ChevronRight size={15} /></button></div>
          <div className="timeline"><div className="timeline-title"><span>最近时间线</span><button type="button">全部记录</button></div><div className="timeline-item"><i className="blue" /><div><strong>已创建试听课任务</strong><span>今天 09:12 · 思佳</span></div></div><div className="timeline-item"><i className="amber" /><div><strong>等待家长补充目标</strong><span>昨天 17:40 · 自动提醒</span></div></div><div className="timeline-item"><i className="green" /><div><strong>已导入基础资料</strong><span>昨天 16:05 · 腾讯表格</span></div></div></div>
          <button className="detail-cta" type="button" onClick={() => setActive("lp")}><BookOpen size={17} /> 打开试听与 LP 工作流</button>
        </aside>
      </section>
    </>
  );

  const renderTeachers = () => (
    <>
      <section className="view-heading"><div><p className="eyebrow">教师资源库 · 智能匹配仅供人工确认</p><h1>老师匹配与负载</h1><p className="view-copy">先用硬条件排除不合适人选，再由教务确认沟通偏好和长期时段。</p></div><div className="heading-actions"><button className="secondary-button" type="button"><ListFilter size={17} /> 筛选能力</button><button className="primary-button" type="button"><Plus size={17} /> 新建老师</button></div></section>
      <section className="matching-banner"><div><span className="matching-kicker">正在为 Olivia Chen 匹配</span><h2>Year 10 English · 周六 16:00 Melbourne</h2><p><MapPin size={16} /> 学生 UTC+10 · 长期时间已确认 · 试听课 60 分钟</p></div><button className="secondary-button" type="button" onClick={() => setActive("students")}>查看学生档案 <ChevronRight size={16} /></button></section>
      <section className="teacher-grid">
        {teacherCandidates.map((teacher) => (
          <article className={`teacher-card ${selectedTeacher === teacher.name ? "selected" : ""}`} key={teacher.name}>
            <div className="teacher-head"><Avatar initials={teacher.initials} tone={teacher.match >= 90 ? "green" : "blue"} /><div><h2>{teacher.name}</h2><p>匹配度 <strong>{teacher.match}%</strong></p></div><StatusPill tone={teacher.match >= 90 ? "green" : "blue"}>{teacher.match >= 90 ? "优先推荐" : "可选"}</StatusPill></div>
            <div className="teacher-tags">{teacher.areas.map((area) => <span key={area}>{area}</span>)}</div>
            <dl><div><dt>可上课</dt><dd>{teacher.availability}</dd></div><div><dt>所在地</dt><dd>{teacher.location}</dd></div><div><dt>当前负载</dt><dd>{teacher.load}</dd></div></dl>
            <p className="teacher-note"><CircleCheck size={15} /> {teacher.note}</p>
            <button className={selectedTeacher === teacher.name ? "selected-choice" : "choice-button"} onClick={() => setSelectedTeacher(teacher.name)} type="button">{selectedTeacher === teacher.name ? <><Check size={16} /> 已选择候选老师</> : "选择为候选老师"}</button>
          </article>
        ))}
      </section>
      <section className="panel selection-summary"><div><p className="eyebrow">人工确认后才会生成排课</p><h2>当前选择：{selectedTeacher}</h2><p>系统已检查科目、年级、时区、长期 Availability 与当前负载。家长偏好和最终沟通仍需教务确认。</p></div><button className="primary-button" type="button" onClick={() => setActive("schedule")}>继续排课 <ArrowRight size={17} /></button></section>
    </>
  );

  const renderSchedule = () => (
    <>
      <section className="view-heading"><div><p className="eyebrow">学生当地时间 · 周视图</p><h1>排课与时区检查</h1><p className="view-copy">保存前同时检查学生、老师和公司时间，避免夏令时与跨日错误。</p></div><div className="heading-actions"><button className="secondary-button" type="button"><CalendarDays size={17} /> 本周</button><button className="primary-button" type="button"><Plus size={17} /> 新建排课</button></div></section>
      <section className="schedule-workspace">
        <article className="panel calendar-board"><div className="calendar-toolbar"><div><button className="calendar-switch active" type="button">周视图</button><button className="calendar-switch" type="button">日视图</button></div><strong>15 - 21 Jul 2026</strong><div className="timezone-chip"><Globe2 size={15} /> 学生当地时区</div></div><div className="week-grid"><div className="week-side"><span>时间</span><strong>14:00</strong><strong>16:00</strong><strong>18:00</strong><strong>20:00</strong></div>{["周一", "周二", "周三", "周四", "周五", "周六"].map((day, index) => <div className="day-column" key={day}><span>{day}<small>{15 + index}</small></span>{index === 2 && <button className="lesson-block blue" type="button"><strong>Sophie · VCE 化学</strong><small>16:00 · Amelia</small></button>}{index === 3 && <button className="lesson-block green" type="button"><strong>Lucas · IB 数学</strong><small>18:30 · Daniel</small></button>}{index === 5 && <button className="lesson-block amber" type="button"><strong>Olivia · 英文试听</strong><small>16:00 · 待确认</small></button>}</div>)}</div></article>
        <aside className="panel booking-panel"><div className="panel-header"><div><p className="eyebrow">新建试听排课</p><h2>Olivia Chen</h2></div><StatusPill tone="amber">待确认</StatusPill></div><div className="booking-line"><span>学生时间</span><strong>周六 20 Jul · 16:00</strong><small>Melbourne · UTC+10</small></div><div className="booking-line"><span>老师时间</span><strong>周六 20 Jul · 16:00</strong><small>Amelia Brown · UTC+10</small></div><div className="booking-line"><span>公司时间</span><strong>周六 20 Jul · 14:00</strong><small>Beijing · UTC+8</small></div><div className="check-list"><div><CircleCheck size={16} /><span>老师长期 Availability 匹配</span></div><div><CircleCheck size={16} /><span>学生与老师没有时间冲突</span></div><div><CircleCheck size={16} /><span>跨时区未跨日</span></div></div><button className="primary-button full" type="button" onClick={() => setActive("lp")}>确认并生成 LP 任务 <ArrowRight size={17} /></button><p className="form-footnote">确认后只生成内部任务；企业微信消息在发送前仍可预览。</p></aside>
      </section>
    </>
  );

  const renderLp = () => (
    <>
      <section className="view-heading"><div><p className="eyebrow">试听与 Learning Plan</p><h1>任务链与人工确认</h1><p className="view-copy">课程建立后自动生成 N-3、N-2、N-1 与课后任务，但每一个关键判断都保留负责人。</p></div><div className="heading-actions"><button className="secondary-button" type="button"><FileText size={17} /> LP 模板</button><button className="primary-button" type="button"><Plus size={17} /> 创建 LP</button></div></section>
      <section className="workflow-header"><div className="workflow-student"><Avatar initials="LW" tone="green" /><div><h2>Lucas Wang · IB Mathematics AA HL</h2><p>周四 18 Jul · 19:00 Sydney · 授课老师 Daniel Wu</p></div></div><StatusPill tone="amber">LP 待发送</StatusPill></section>
      <section className="kanban-board"><article><header><span className="kanban-dot blue" /> 已建档 <strong>1</strong></header><div className="kanban-card"><p>试听资料已导入</p><h3>学生目标与长期时间</h3><span>思佳 · 今天 09:12</span><div className="card-tags"><StatusPill tone="green">完成</StatusPill><StatusPill>4 个文件</StatusPill></div></div></article><article><header><span className="kanban-dot amber" /> 处理中 <strong>2</strong></header><div className="kanban-card featured"><p>LP 审核通过</p><h3>发送 LP 并确认老师备课</h3><span>Tiffany · 今天 14:00</span><div className="card-tags"><StatusPill tone="amber">今天到期</StatusPill></div><button className="card-action" type="button" onClick={() => setLpSent(true)}>{lpSent ? <><Check size={15} /> 已记录发送</> : <>记录已发送 <ArrowRight size={15} /></>}</button></div><div className="kanban-card"><p>收费已确认</p><h3>发送 ClassIn 与资料链接</h3><span>思佳 · 今天 15:00</span><div className="card-tags"><StatusPill tone="blue">等待上一项</StatusPill></div></div></article><article><header><span className="kanban-dot purple" /> 课前确认 <strong>2</strong></header><div className="kanban-card"><p>N-1</p><h3>老师备课确认</h3><span>Daniel Wu · 明天 18:00</span><div className="card-tags"><StatusPill>未开始</StatusPill></div></div><div className="kanban-card"><p>课前</p><h3>发送上课提醒</h3><span>企业微信 · 周四 17:00</span><div className="card-tags"><StatusPill>按规则触发</StatusPill></div></div></article><article><header><span className="kanban-dot green" /> 课后跟进 <strong>2</strong></header><div className="kanban-card"><p>课后 24h</p><h3>反馈与作业检查</h3><span>自动创建 · 待负责人确认</span><div className="card-tags"><StatusPill>尚未到期</StatusPill></div></div></article></section>
      <section className="panel rule-note"><CircleAlert size={20} /><div><strong>规则来源清晰可追溯</strong><span>本任务链引用“Learning Plan”与“试听课”手册规则。试点阶段会把规则、负责人和例外名单做成可审核的配置。</span></div><button className="text-button" type="button">查看规则来源 <ExternalLink size={15} /></button></section>
    </>
  );

  const renderPayroll = () => (
    <>
      <section className="view-heading"><div><p className="eyebrow">教务宝导入 · 本月模拟数据</p><h1>课时与薪资核对</h1><p className="view-copy">先保留教务宝为课时证据来源，再把计算过程和异常集中到一个审核视图。</p></div><div className="heading-actions"><button className="secondary-button" type="button"><FileText size={17} /> 导入记录</button><button className="primary-button" type="button"><Plus size={17} /> 导入教务宝文件</button></div></section>
      <section className="metric-grid payroll-metrics"><article className="metric-card blue-card"><div className="metric-icon"><CalendarDays size={21} /></div><div><span>导入课程</span><strong>128</strong><small>2026-07-01 至 07-16</small></div></article><article className="metric-card green-card"><div className="metric-icon"><CircleCheck size={21} /></div><div><span>可自动核对</span><strong>121</strong><small>94.5% 无异常</small></div></article><article className="metric-card amber-card"><div className="metric-icon"><AlertTriangle size={21} /></div><div><span>需人工确认</span><strong>7</strong><small>请假、代课或未结课</small></div></article><article className="metric-card red-card"><div className="metric-icon"><BadgeDollarSign size={21} /></div><div><span>待确认差额</span><strong>$184</strong><small>2 个规则缺失</small></div></article></section>
      <section className="panel payroll-table"><div className="panel-header"><div><p className="eyebrow">异常优先</p><h2>待核对记录</h2></div><button className="secondary-button" type="button"><RefreshCw size={16} /> 重新计算</button></div><div className="pay-grid"><div className="pay-head"><span>老师</span><span>课程</span><span>教务宝状态</span><span>计算建议</span><span>原因</span></div>{[["Amelia Brown", "Sophie Liu · VCE 化学", "已结课", "$96", "无异常", "green"],["Michael Yu", "Ethan Zhao · 物理", "未结课 N+3", "$0", "等待结课确认", "amber"],["Daniel Wu", "Lucas Wang · IB 数学", "代课记录", "$128", "缺少代课费率", "red"]].map(([teacher, course, status, pay, reason, tone]) => <div className="pay-row" key={String(teacher)}><span><Avatar initials={String(teacher).split(" ").map((part) => part[0]).join("")} tone={String(tone)} />{teacher}</span><span>{course}</span><span>{status}</span><span><strong>{pay}</strong></span><span><StatusPill tone={String(tone)}>{reason}</StatusPill></span></div>)}</div></section>
    </>
  );

  const renderMessages = () => (
    <>
      <section className="view-heading"><div><p className="eyebrow">企业微信 · Demo 不发送真实消息</p><h1>消息路由与发送预览</h1><p className="view-copy">每条提醒先确定业务对象和负责人，再决定是否可以自动发送。</p></div><div className="heading-actions"><button className="secondary-button" type="button" onClick={() => setShowMessagePreview((value) => !value)}>{showMessagePreview ? <X size={17} /> : <MessageCircle size={17} />}{showMessagePreview ? "收起预览" : "显示预览"}</button><button className="primary-button" type="button"><Plus size={17} /> 新建模板</button></div></section>
      <section className="routing-layout"><article className="panel routing-list"><div className="panel-header"><div><p className="eyebrow">按学生关系路由</p><h2>今日消息计划</h2></div><StatusPill tone="blue">3 条待处理</StatusPill></div><button className="route-row selected" type="button" onClick={() => setShowMessagePreview(true)}><span className="route-icon blue"><Bell size={18} /></span><div><strong>试听资料补充提醒</strong><span>Olivia Chen · 发给家长客户群</span></div><StatusPill tone="amber">待人工确认</StatusPill><ChevronRight size={17} /></button><button className="route-row" type="button" onClick={() => setShowMessagePreview(true)}><span className="route-icon green"><BookOpen size={18} /></span><div><strong>LP 与备课确认</strong><span>Lucas Wang · 发给 Daniel Wu</span></div><StatusPill tone="blue">内部提醒</StatusPill><ChevronRight size={17} /></button><button className="route-row" type="button" onClick={() => setShowMessagePreview(true)}><span className="route-icon purple"><Clock3 size={18} /></span><div><strong>续课前跟进</strong><span>Ethan Zhao · 发给思佳</span></div><StatusPill>先内部处理</StatusPill><ChevronRight size={17} /></button><div className="send-log"><div><span>最近发送记录</span><button type="button">全部日志</button></div><p><CircleCheck size={15} /> 07:45 · 已发送给内部负责人：Sophie Liu 的考试节点更新</p><p><CircleCheck size={15} /> 昨天 17:20 · 已确认老师备课提醒送达</p></div></article>
        {showMessagePreview && <aside className="panel message-preview"><div className="preview-header"><div><p className="eyebrow">发送前预览</p><h2>试听资料补充提醒</h2></div><StatusPill tone="amber">需人工确认</StatusPill></div><div className="route-summary"><div><span>业务对象</span><strong>Olivia Chen · 英文试听</strong></div><div><span>收件对象</span><strong>Chen 先生与 Olivia 客户群</strong></div><div><span>群主 / 跟进成员</span><strong>思佳</strong></div></div><div className="message-bubble"><p>您好，Olivia 的英文试听课已安排在本周六 16:00（Melbourne 时间）。</p><p>为了让老师更好准备课程，麻烦您补充近期成绩单和希望重点提升的内容。收到后我们会尽快确认试听资料。</p><p>谢谢！</p></div><div className="preview-foot"><CircleAlert size={16} /><span>外部联系人与客户群的实际自动发送权限，需要在企业微信试点中验证。Demo 只展示正确路由与发送日志。</span></div></aside>}
      </section>
    </>
  );

  const renderSync = () => (
    <>
      <section className="view-heading"><div><p className="eyebrow">迁移期 · 受控同步</p><h1>腾讯表格同步中心</h1><p className="view-copy">新系统为主数据源；腾讯表格保留为过渡镜像和旧流程输入，不把同步当备份。</p></div><div className="heading-actions"><button className="secondary-button" type="button"><FileText size={17} /> 导出备份</button><button className="primary-button" type="button"><RefreshCw size={17} /> 检查同步</button></div></section>
      <section className="sync-summary"><article><span className="sync-icon green"><CircleCheck size={20} /></span><div><strong>学生总表</strong><span>系统 → 腾讯镜像</span></div><StatusPill tone="green">已同步</StatusPill><small>2 分钟前</small></article><article><span className="sync-icon green"><CircleCheck size={20} /></span><div><strong>教师信息表</strong><span>系统 → 腾讯镜像</span></div><StatusPill tone="green">已同步</StatusPill><small>5 分钟前</small></article><article><span className="sync-icon amber"><AlertTriangle size={20} /></span><div><strong>LP 工作表</strong><span>腾讯指定列 → 系统</span></div><StatusPill tone="amber">1 个冲突</StatusPill><small>等待处理</small></article></section>
      <section className="sync-layout"><article className="panel ownership-panel"><div className="panel-header"><div><p className="eyebrow">字段所有权</p><h2>谁可以写入什么</h2></div><MiniAction label="同步设置" /></div><div className="ownership-row"><div><strong>姓名、课程、状态、排课、负责人</strong><span>系统拥有 · 镜像到腾讯表格</span></div><StatusPill tone="blue">系统为主</StatusPill></div><div className="ownership-row"><div><strong>旧流程人工备注、历史交接字段</strong><span>腾讯可回写 · 记录前后值</span></div><StatusPill tone="purple">受控回写</StatusPill></div><div className="ownership-row"><div><strong>删除动作</strong><span>两端均软删除，不自动传播</span></div><StatusPill>人工确认</StatusPill></div><div className="ownership-row"><div><strong>正式备份</strong><span>数据库快照 + 恢复点 + 独立导出</span></div><StatusPill tone="green">独立保存</StatusPill></div></article><aside className="panel conflict-panel"><div className="panel-header"><div><p className="eyebrow">同步冲突</p><h2>{syncResolved ? "今天没有待处理冲突" : "需要人工选择"}</h2></div>{syncResolved ? <StatusPill tone="green">已解决</StatusPill> : <StatusPill tone="amber">1 项</StatusPill>}</div>{!syncResolved ? <><div className="conflict-record"><span>学生</span><strong>Olivia Chen · STU-0248</strong><span>字段</span><strong>负责教务 StudentOwner</strong></div><div className="conflict-values"><div><span>系统当前值</span><strong>思佳</strong><small>今天 09:12 · 排课任务创建</small></div><div><span>腾讯表格值</span><strong>Tiffany</strong><small>今天 09:18 · 人工编辑</small></div></div><div className="conflict-actions"><button className="secondary-button" onClick={() => setSyncResolved(true)} type="button">保留系统值</button><button className="primary-button" onClick={() => setSyncResolved(true)} type="button">采用腾讯值</button></div></> : <div className="resolved-state"><CircleCheck size={27} /><strong>冲突已记录并处理</strong><span>系统保留来源、时间、操作者和最终选择，后续可审计。</span></div>}</aside></section>
    </>
  );

  const content = {
    dashboard: renderDashboard,
    students: renderStudents,
    teachers: renderTeachers,
    schedule: renderSchedule,
    lp: renderLp,
    payroll: renderPayroll,
    messages: renderMessages,
    sync: renderSync,
  }[active];

  const activeLabel = navigation.find((item) => item.id === active)?.label ?? "模块";

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><BookOpen size={21} /></div><div><strong>吟领教务</strong><span>Learning Operations</span></div></div>
        <div className="workspace-pill"><span className="workspace-dot" /> 2026 教务管理 <ChevronRight size={14} /></div>
        <nav className="primary-nav" aria-label="主导航">
          <p>运营</p>
          {navigation.filter((item) => item.group === "core").map((item) => { const Icon = item.icon; return <button className={active === item.id ? "nav-item active" : "nav-item"} key={item.id} onClick={() => setActive(item.id)} type="button"><Icon size={18} aria-hidden="true" /> <span>{item.label}</span></button>; })}
          <p className="nav-divider-label">支持</p>
          {navigation.filter((item) => item.group === "support").map((item) => { const Icon = item.icon; return <button className={active === item.id ? "nav-item active" : "nav-item"} key={item.id} onClick={() => setActive(item.id)} type="button"><Icon size={18} aria-hidden="true" /> <span>{item.label}</span></button>; })}
        </nav>
        <div className="sidebar-foot"><div className="sync-indicator"><span /> 资料同步正常</div><button type="button"><CircleHelpIcon /> 使用指南</button></div>
      </aside>
      <section className="app-main">
        <header className="topbar"><div className="crumb"><span>教务运营</span><ChevronRight size={14} /><strong>{activeLabel}</strong></div><div className="topbar-actions"><button className="top-icon" type="button" aria-label="全局搜索" title="全局搜索"><Search size={18} /></button><button className="top-icon notification" type="button" aria-label="通知" title="通知"><Bell size={18} /><i>3</i></button><span className="top-divider" /><Avatar initials="NC" tone="blue" /><div className="profile"><strong>Nixon</strong><span>系统管理员</span></div><ChevronRight className="profile-chevron" size={15} /></div></header>
        <div className="content-area">{content ? content() : <EmptyModule section={activeLabel} />}</div>
      </section>
    </main>
  );
}

function CircleHelpIcon() {
  return <MessageCircle size={16} aria-hidden="true" />;
}
