"use client";

import { useId, useState } from "react";

import {
  deriveExamFollowUpStatuses,
  estimateExamResultDate,
  getLatestStudentFollowUp,
  getLessonPackageBalance,
  sortStudentExams,
  sortStudentFollowUpHistory,
  type ExamFollowUpStatuses,
  type ExamVariant,
  type LessonPackageBalance,
  type StudentExamRecord,
  type StudentFollowUp,
  type StudentLessonPackage,
} from "@/lib/student-records";

export const STUDENT_RECORD_PANEL_SECTIONS = [
  "lp",
  "report",
  "fu",
  "followUp",
  "lessonPackages",
  "exams",
] as const;

export type StudentRecordPanelSection = (typeof STUDENT_RECORD_PANEL_SECTIONS)[number];
export type StudentRecordFileSection = Extract<StudentRecordPanelSection, "lp" | "report" | "fu">;

export type StudentHistoricalJwbSnapshotFacts = Readonly<{
  lessonPackages?: readonly StudentLessonPackage[];
  remainingHours?: number;
  contractHours?: number;
  contractEffectiveDate?: string;
  firstJwbHourEntryDate?: string;
  packageCoverage?: "complete" | "partial" | "none";
  jwbSourceRow?: string | number;
}>;

/**
 * Evidence retained from an unverified Jiaowubao mapping. It is deliberately
 * separate from the active hours and lesson packages that scheduling may use.
 */
export type StudentHistoricalJwbSnapshot = Readonly<{
  retained?: StudentHistoricalJwbSnapshotFacts;
  currentAggregate?: Omit<StudentHistoricalJwbSnapshotFacts, "lessonPackages">;
}>;

export type StudentRecordsPanelStudent = Readonly<{
  id: string;
  name: string;
  followUp?: string;
  followUpHistory?: readonly StudentFollowUp[];
  lessonPackages?: readonly StudentLessonPackage[];
  /** A master-authoritative student may validly have no Jiaowubao supplement. */
  jwbMatchStatus?: "matched" | "unmatched" | "ambiguous";
  /** Active JWB facts only; unsafe former facts live in historicalJwbSnapshot. */
  remainingHours?: number;
  contractHours?: number;
  firstJwbHourEntryDate?: string;
  packageCoverage?: "complete" | "partial" | "none";
  historicalJwbSnapshot?: StudentHistoricalJwbSnapshot;
  examSubject?: string;
  examDate?: string;
  exams?: readonly StudentExamRecord[];
}>;

export type StudentRecordsPanelExam = Readonly<{
  id: string;
  subject: string;
  examType: StudentExamRecord["examType"] | null;
  examVariant?: ExamVariant;
  examMonth?: string;
  examDate?: string;
  resultDateOverride?: string;
  includeRecall?: boolean;
  followUpState?: StudentExamRecord["followUpState"];
}>;

/** Compatible with the existing FileRecord shape; URL and explicit grouping are optional. */
export type StudentRecordsPanelFile = Readonly<{
  id: string;
  studentId: string;
  title: string;
  type: string;
  source: string;
  addedAt: string;
  url?: string;
  recordSection?: StudentRecordFileSection;
}>;

export type StudentRecordsPanelCallbacks = Readonly<{
  onAdd: (section: StudentRecordPanelSection, student: StudentRecordsPanelStudent) => void;
  onOpenFile?: (file: StudentRecordsPanelFile) => void;
  onEditExam?: (exam: StudentExamRecord) => void;
}>;

export type StudentRecordsPanelProps = Readonly<{
  student: StudentRecordsPanelStudent;
  files: readonly StudentRecordsPanelFile[];
  callbacks: StudentRecordsPanelCallbacks;
  initialSection?: StudentRecordPanelSection;
  canAdd?: boolean;
}>;

export type StudentRecordsPanelData = Readonly<{
  jwbMatchStatus?: "matched" | "unmatched" | "ambiguous";
  hasHistoricalJwbFacts: boolean;
  historicalJwbSnapshot?: StudentHistoricalJwbSnapshot;
  packageCoverage: "complete" | "partial" | "none";
  files: Readonly<Record<StudentRecordFileSection, readonly StudentRecordsPanelFile[]>>;
  followUps: readonly StudentFollowUp[];
  latestFollowUp: StudentFollowUp | null;
  lessonPackages: readonly Readonly<{
    lessonPackage: StudentLessonPackage;
    balance: LessonPackageBalance;
  }>[];
  exams: readonly Readonly<{
    exam: StudentRecordsPanelExam;
    estimatedResultDate: string | null;
    followUpStatuses: ExamFollowUpStatuses | null;
  }>[];
}>;

const SECTION_LABELS: Record<StudentRecordPanelSection, string> = {
  lp: "LP / 学校资料",
  report: "Report 资料",
  fu: "FU",
  followUp: "最近跟进",
  lessonPackages: "课包",
  exams: "考试",
};

const REPORT_FILE_TYPES = new Set(["Report 资料", "成绩单"]);
const FU_FILE_TYPES = new Set(["FU", "续课 FU", "课堂反馈"]);

export function studentFileRecordSection(file: StudentRecordsPanelFile): StudentRecordFileSection {
  if (file.recordSection) return file.recordSection;
  if (REPORT_FILE_TYPES.has(file.type)) return "report";
  if (FU_FILE_TYPES.has(file.type)) return "fu";
  return "lp";
}

function sortFileHistory(files: readonly StudentRecordsPanelFile[]) {
  return files
    .map((file, index) => ({ file, index, timestamp: Date.parse(file.addedAt) }))
    .sort((left, right) => {
      const leftValid = Number.isFinite(left.timestamp);
      const rightValid = Number.isFinite(right.timestamp);
      if (leftValid && rightValid) return right.timestamp - left.timestamp || left.index - right.index;
      if (leftValid) return -1;
      if (rightValid) return 1;
      return left.index - right.index;
    })
    .map(({ file }) => file);
}

function sortPurchases(lessonPackage: StudentLessonPackage) {
  return [...lessonPackage.purchaseRecords].sort((left, right) => {
    const byDate = Date.parse(right.purchasedAt) - Date.parse(left.purchasedAt);
    return byDate || right.id.localeCompare(left.id);
  });
}

function legacyFollowUp(student: StudentRecordsPanelStudent): StudentFollowUp | null {
  const followedUpAt = student.followUp?.trim();
  if (!followedUpAt || ["未记录", "暂无记录", "待确认"].includes(followedUpAt)) return null;
  return { id: `legacy-follow-up:${student.id}`, followedUpAt };
}

function legacyExam(student: StudentRecordsPanelStudent): StudentRecordsPanelExam | null {
  const subject = student.examSubject?.trim();
  const examDate = student.examDate?.trim();
  if (!subject && !examDate) return null;
  return {
    id: `legacy-exam:${student.id}`,
    subject: subject || "考试科目待确认",
    examType: null,
    ...(examDate ? { examDate } : {}),
  };
}

export function buildStudentRecordsPanelData(
  student: StudentRecordsPanelStudent,
  files: readonly StudentRecordsPanelFile[],
): StudentRecordsPanelData {
  const groupedFiles: Record<StudentRecordFileSection, StudentRecordsPanelFile[]> = {
    lp: [],
    report: [],
    fu: [],
  };
  for (const file of files) {
    if (file.studentId === student.id) groupedFiles[studentFileRecordSection(file)].push(file);
  }

  const structuredFollowUps = student.followUpHistory ?? [];
  const fallbackFollowUp = structuredFollowUps.length ? null : legacyFollowUp(student);
  const followUps = fallbackFollowUp
    ? [fallbackFollowUp]
    : sortStudentFollowUpHistory(structuredFollowUps);
  const structuredExams = student.exams ?? [];
  const fallbackExam = structuredExams.length ? null : legacyExam(student);
  return {
    jwbMatchStatus: student.jwbMatchStatus,
    hasHistoricalJwbFacts: student.historicalJwbSnapshot !== undefined,
    historicalJwbSnapshot: student.historicalJwbSnapshot,
    packageCoverage: student.packageCoverage ?? (student.lessonPackages?.length ? "complete" : "none"),
    files: {
      lp: sortFileHistory(groupedFiles.lp),
      report: sortFileHistory(groupedFiles.report),
      fu: sortFileHistory(groupedFiles.fu),
    },
    followUps,
    latestFollowUp: getLatestStudentFollowUp(followUps),
    lessonPackages: (student.lessonPackages ?? []).map((lessonPackage) => ({
      lessonPackage: {
        ...lessonPackage,
        subjectIds: [...lessonPackage.subjectIds],
        purchaseRecords: sortPurchases(lessonPackage),
      },
      balance: getLessonPackageBalance(lessonPackage),
    })),
    exams: fallbackExam
      ? [{ exam: fallbackExam, estimatedResultDate: null, followUpStatuses: null }]
      : sortStudentExams(structuredExams).map((exam) => ({
          exam: { ...exam },
          estimatedResultDate: exam.resultDateOverride ?? estimateExamResultDate(exam),
          followUpStatuses: deriveExamFollowUpStatuses(exam),
        })),
  };
}

function sectionCount(section: StudentRecordPanelSection, data: StudentRecordsPanelData) {
  if (section === "lp" || section === "report" || section === "fu") return data.files[section].length;
  if (section === "followUp") return data.followUps.length;
  if (section === "lessonPackages") return data.lessonPackages.length;
  return data.exams.length;
}

function EmptyRecords() {
  return <div className="empty-inline">暂无记录</div>;
}

function FileTitle({ file, onOpen }: Readonly<{
  file: StudentRecordsPanelFile;
  onOpen?: (file: StudentRecordsPanelFile) => void;
}>) {
  if (onOpen) {
    return <button className="inline-link" type="button" onClick={() => onOpen(file)}>{file.title}</button>;
  }
  if (file.url) {
    return <a className="inline-link" href={file.url} target="_blank" rel="noreferrer">{file.title}</a>;
  }
  return <strong>{file.title}</strong>;
}

function FileHistory({ files, onOpen }: Readonly<{
  files: readonly StudentRecordsPanelFile[];
  onOpen?: (file: StudentRecordsPanelFile) => void;
}>) {
  if (!files.length) return <EmptyRecords />;
  return (
    <div className="record-list">
      {files.map((file) => (
        <article className="record-row" key={file.id}>
          <span className="record-icon green" aria-hidden="true">{file.type.slice(0, 1)}</span>
          <div>
            <FileTitle file={file} onOpen={onOpen} />
            <span>{file.source}</span>
          </div>
          <small>{file.addedAt}</small>
          <span>{file.type}</span>
        </article>
      ))}
    </div>
  );
}

function FollowUpHistory({ data }: Readonly<{ data: StudentRecordsPanelData }>) {
  if (!data.latestFollowUp) return <EmptyRecords />;
  return (
    <>
      <div className="detail-section">
        <span>最近跟进</span>
        <strong>{data.latestFollowUp.followedUpAt}</strong>
        {data.latestFollowUp.note ? <p>{data.latestFollowUp.note}</p> : null}
      </div>
      <div className="timeline">
        <div className="timeline-title"><strong>历史</strong><small>{data.followUps.length}</small></div>
        {data.followUps.map((followUp) => (
          <div className="timeline-item" key={followUp.id}>
            <i className="green" aria-hidden="true" />
            <span>
              <strong>{followUp.followedUpAt}</strong>
              {(followUp.note || followUp.recordedBy) ? <small>{[followUp.note, followUp.recordedBy].filter(Boolean).join(" · ")}</small> : null}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

export function studentJwbPackageNotice(data: StudentRecordsPanelData): string | null {
  const hasNoSafeJwb = data.jwbMatchStatus === "unmatched" || data.jwbMatchStatus === "ambiguous";
  const noSafeJwbEmptyNotice = data.jwbMatchStatus === "ambiguous"
    ? "腾讯总表已建档，教务宝有多个候选待核对；当前不采用任何候选，课时和课包暂为空。"
    : "腾讯总表已建档，暂未关联教务宝资料；课时和课包暂为空。";
  const historicalEvidenceOnlyNotice = "历史教务宝资料已作为只读快照保留待核验，不可用于排课或扣课。";
  const historicalSnapshotNotice = `${data.jwbMatchStatus === "ambiguous"
    ? "腾讯总表已建档，教务宝有多个候选待核对。"
    : data.jwbMatchStatus === "unmatched"
      ? "腾讯总表已建档，暂未关联教务宝资料。"
      : "当前教务宝资料无法安全建立可用课包。"}${historicalEvidenceOnlyNotice}`;
  if (data.historicalJwbSnapshot) {
    const hasVerifiedCurrentPackages = data.jwbMatchStatus === "matched"
      && (data.packageCoverage === "complete" || data.packageCoverage === "partial")
      && data.lessonPackages.length > 0;
    return data.lessonPackages.length
      ? hasVerifiedCurrentPackages
        ? `下方仅显示当前可用课包。当前可核对课包仍可使用；${historicalEvidenceOnlyNotice}`
        : `下方仅显示当前可用课包。${historicalSnapshotNotice}`
      : historicalSnapshotNotice;
  }
  if (!data.lessonPackages.length) {
    if (hasNoSafeJwb) return noSafeJwbEmptyNotice;
    return data.packageCoverage === "none"
      ? "教务宝当前余额已保留，但缺少可核对的逐课程购买历史，尚未建立课包。"
      : null;
  }
  if (hasNoSafeJwb) {
    return data.jwbMatchStatus === "ambiguous"
      ? "教务宝有多个候选待核对；当前未采用教务宝补充。下方仅显示现有可用课包。"
      : "暂未关联教务宝资料；当前未采用教务宝补充。下方仅显示现有可用课包。";
  }
  return data.packageCoverage === "partial"
    ? "当前仅显示有购买历史可核对的课包；其余课程余额仍保留在教务宝汇总中，需人工补齐购买记录。"
    : null;
}

function snapshotHoursSummary(label: string, facts: StudentHistoricalJwbSnapshotFacts) {
  const values: string[] = [];
  if (facts.remainingHours !== undefined) values.push(`余额 ${facts.remainingHours}`);
  if (facts.contractHours !== undefined) values.push(`总 ${facts.contractHours}`);
  if (facts.contractEffectiveDate) values.push(`生效 ${facts.contractEffectiveDate}`);
  if (facts.firstJwbHourEntryDate) values.push(`首笔正向合同 ${facts.firstJwbHourEntryDate}`);
  return values.length ? `${label}：${values.join(" · ")}` : null;
}

/** Compact read-only evidence only; snapshot packages are never returned as active lesson packages. */
export function studentHistoricalJwbSnapshotEvidence(snapshot?: StudentHistoricalJwbSnapshot): readonly string[] {
  if (!snapshot) return [];
  const evidence: string[] = [];
  const retained = snapshot.retained;
  if (retained) {
    if (retained.lessonPackages?.length) evidence.push(`历史保留课包 ${retained.lessonPackages.length} 个`);
    const retainedHours = snapshotHoursSummary("历史保留汇总", retained);
    if (retainedHours) evidence.push(retainedHours);
  }
  const currentAggregate = snapshot.currentAggregate;
  if (currentAggregate) {
    const aggregateHours = snapshotHoursSummary("当前教务宝汇总（只读）", currentAggregate);
    if (aggregateHours) evidence.push(aggregateHours);
  }
  return evidence;
}

function HistoricalJwbSnapshotEvidence({ snapshot }: Readonly<{ snapshot: StudentHistoricalJwbSnapshot }>) {
  const evidence = studentHistoricalJwbSnapshotEvidence(snapshot);
  return <div className="detail-section">
    <span>教务宝历史资料</span>
    <strong>历史待核验 · 不可用于排课或扣课</strong>
    {evidence.length
      ? evidence.map((item) => <p key={item}>{item}</p>)
      : <p>已保留只读历史快照，待人工核验。</p>}
  </div>;
}

function LessonPackageHistory({ data }: Readonly<{ data: StudentRecordsPanelData }>) {
  const notice = studentJwbPackageNotice(data);
  if (!data.lessonPackages.length) return <>
    {notice ? <div className="form-notice">{notice}</div> : null}
    {data.historicalJwbSnapshot ? <HistoricalJwbSnapshotEvidence snapshot={data.historicalJwbSnapshot} /> : null}
    <EmptyRecords />
  </>;
  return (
    <>
      {notice ? <div className="form-notice">{notice}</div> : null}
      {data.historicalJwbSnapshot ? <HistoricalJwbSnapshotEvidence snapshot={data.historicalJwbSnapshot} /> : null}
      <div className="record-list">
      {data.lessonPackages.map(({ lessonPackage, balance }) => (
        <article className="detail-section" key={lessonPackage.id}>
          <strong>{lessonPackage.name}</strong>
          <p>{lessonPackage.subjectIds.join(" / ") || "未绑定科目"}</p>
          <p>总 {balance.totalHours} · 已消耗 {balance.consumedHours} · 剩余 {balance.remainingHours}</p>
          <div className="timeline">
            <div className="timeline-title"><strong>购买记录</strong><small>{lessonPackage.purchaseRecords.length}</small></div>
            {lessonPackage.purchaseRecords.map((purchase) => (
              <div className="timeline-item" key={purchase.id}>
                <i className="blue" aria-hidden="true" />
                <span>
                  <strong>+{purchase.hours} 课时</strong>
                  <small>{[purchase.purchasedAt, purchase.note].filter(Boolean).join(" · ")}</small>
                </span>
              </div>
            ))}
          </div>
        </article>
      ))}
      </div>
    </>
  );
}

const EXAM_TYPE_LABELS: Record<StudentExamRecord["examType"], string> = {
  scholarship: "奖学金",
  selective: "精英",
  aeas: "AEAS",
  other: "其他",
};

const EXAM_VARIANT_LABELS: Readonly<Partial<Record<ExamVariant, string>>> = {
  oc: "OC",
  mgs: "MGS",
  gate: "GATE",
  jmss: "JMSS",
  school_interview: "学校面试",
  australian_university_final: "大学期末",
  australian_university_assignment: "大学作业",
  vce: "VCE",
  wace: "WACE",
  hsc: "HSC",
  qce: "QCE",
  sace: "SACE",
  icas: "ICAS",
  amc: "AMC",
  ielts_paper: "IELTS 纸笔",
  ielts_computer: "IELTS 机考",
  pte: "PTE",
  ccl: "CCL",
};

const FOLLOW_UP_LABELS = {
  pending: "待完成",
  completed: "完成",
  not_required: "无需",
} as const;

export type ExamHistoryFilter = "all" | "incomplete";

function examMonth(exam: StudentRecordsPanelExam) {
  return exam.examMonth ?? exam.examDate?.slice(0, 7);
}

export function filterStudentRecordExams(
  exams: StudentRecordsPanelData["exams"],
  currentMonth: string,
  filter: ExamHistoryFilter,
) {
  return exams.filter(({ exam, followUpStatuses }) => {
    if (examMonth(exam) !== currentMonth) return false;
    if (filter === "all") return true;
    return followUpStatuses !== null
      && Object.values(followUpStatuses).some((status) => status === "pending");
  });
}

function FollowUpStatuses({ statuses }: Readonly<{ statuses: ExamFollowUpStatuses | null }>) {
  if (!statuses) return null;
  return <span className="exam-follow-up-statuses">
    <small>关心 {FOLLOW_UP_LABELS[statuses.exam_care]}</small>
    <small>回忆 {FOLLOW_UP_LABELS[statuses.exam_recall]}</small>
    <small>出分 {FOLLOW_UP_LABELS[statuses.exam_results_follow_up]}</small>
  </span>;
}

function ExamHistory({
  data,
  currentMonth,
  onEditExam,
}: Readonly<{
  data: StudentRecordsPanelData;
  currentMonth: string;
  onEditExam?: (exam: StudentExamRecord) => void;
}>) {
  const [filter, setFilter] = useState<ExamHistoryFilter>("all");
  if (!data.exams.length) return <EmptyRecords />;
  const exams = filterStudentRecordExams(data.exams, currentMonth, filter);
  return (
    <>
      <div className="view-tabs" aria-label={`${currentMonth} 考试筛选`}>
        <button className={filter === "all" ? "active" : ""} type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>本月全部</button>
        <button className={filter === "incomplete" ? "active" : ""} type="button" aria-pressed={filter === "incomplete"} onClick={() => setFilter("incomplete")}>未完成</button>
      </div>
      {!exams.length ? <EmptyRecords /> : <div className="record-list">
      {exams.map(({ exam, estimatedResultDate, followUpStatuses }) => (
        <article className="record-row" key={exam.id}>
          <span className="record-icon amber" aria-hidden="true">考</span>
          <div>
            <strong>{exam.subject}</strong>
            {exam.examVariant ? <span>{EXAM_VARIANT_LABELS[exam.examVariant] ?? EXAM_TYPE_LABELS[exam.examType ?? "other"]}</span> : exam.examType ? <span>{EXAM_TYPE_LABELS[exam.examType]}</span> : null}
            <FollowUpStatuses statuses={followUpStatuses} />
          </div>
          <small>{exam.examDate ?? exam.examMonth ?? "日期待确认"}</small>
          <span>预计出分 {estimatedResultDate ?? "待定"}</span>
          {onEditExam && exam.examType && exam.examMonth ? <button className="inline-link" type="button" onClick={() => onEditExam(exam as StudentExamRecord)}>编辑</button> : null}
        </article>
      ))}
      </div>}
    </>
  );
}

function SectionContent({
  section,
  data,
  onOpenFile,
  currentMonth,
  onEditExam,
}: Readonly<{
  section: StudentRecordPanelSection;
  data: StudentRecordsPanelData;
  onOpenFile?: (file: StudentRecordsPanelFile) => void;
  currentMonth: string;
  onEditExam?: (exam: StudentExamRecord) => void;
}>) {
  if (section === "lp" || section === "report" || section === "fu") {
    return <FileHistory files={data.files[section]} onOpen={onOpenFile} />;
  }
  if (section === "followUp") return <FollowUpHistory data={data} />;
  if (section === "lessonPackages") return <LessonPackageHistory data={data} />;
  return <ExamHistory data={data} currentMonth={currentMonth} onEditExam={onEditExam} />;
}

export function StudentRecordsPanel({
  student,
  files,
  callbacks,
  initialSection = "lp",
  canAdd = true,
}: StudentRecordsPanelProps) {
  const [section, setSection] = useState<StudentRecordPanelSection>(initialSection);
  const panelId = useId();
  const data = buildStudentRecordsPanelData(student, files);
  const currentMonth = new Date().toISOString().slice(0, 7);

  return (
    <section className="panel collection-shell" aria-label={`${student.name} 学生资料`}>
      <div className="view-tabs" role="tablist" aria-label="学生资料">
        {STUDENT_RECORD_PANEL_SECTIONS.map((value) => (
          <button
            className={section === value ? "active" : ""}
            type="button"
            role="tab"
            aria-selected={section === value}
            aria-controls={`${panelId}-${value}`}
            key={value}
            onClick={() => setSection(value)}
          >
            {SECTION_LABELS[value]} {sectionCount(value, data)}
          </button>
        ))}
      </div>
      <header className="panel-header">
        <h2>{SECTION_LABELS[section]}</h2>
        {canAdd ? <button className="secondary-button" type="button" onClick={() => callbacks.onAdd(section, student)}>
          + 新增
        </button> : null}
      </header>
      <div id={`${panelId}-${section}`} role="tabpanel">
        <SectionContent section={section} data={data} onOpenFile={callbacks.onOpenFile} currentMonth={currentMonth} onEditExam={callbacks.onEditExam} />
      </div>
    </section>
  );
}

export default StudentRecordsPanel;
