/**
 * Normalisation and reconciliation for the documented `query_lesson_list`
 * response. This module deliberately contains no HTTP or credential handling,
 * so its data rules can be tested independently from the vendor connection.
 */

export type TeacherRole = "主教" | "助教" | "第三教师";
export type TrialKind = "常规" | "试听" | "待分类";
export type StudentNameSource =
  | "member_title"
  | "trial_team_title_prefix"
  | "trial_course_title_prefix"
  | "trial_name_conflict"
  | "trial_account_unresolved";

export type MonthlyPeriod = {
  value: string;
  start: string;
  end: string;
};

export type LessonTeacher = {
  sourceId: string;
  name: string;
  role: TeacherRole;
  allocatedHours: number | null;
  allocationSource: "single_teacher_lesson_hours" | "unavailable";
};

export type NormalizedLesson = {
  key: string;
  branchId: string | null;
  calId: string;
  memberId: string;
  /** Raw JWB account name (`mem_title`), retained for audit. */
  memberName: string;
  /** Display name; may be safely extracted from a configured trial class or course title. */
  displayStudentName: string;
  studentNameSource: StudentNameSource;
  courseId: string | null;
  courseTitle: string;
  teamId: string | null;
  teamTitle: string;
  dated: string;
  timeTitle: string;
  hours: number;
  typeId: number | null;
  typeTitle: string;
  kind: TrialKind;
  sign: number | null;
  signTitle: string;
  over: 1;
  overTime: string;
  leaveReason: string;
  teachers: LessonTeacher[];
};

export type StudentLessonDetail = {
  lessonId: string;
  sourceStudentId: string;
  name: string;
  sourceStudentName: string;
  nameSource: StudentNameSource;
  course: string;
  className: string;
  dated: string;
  time: string;
  lessons: number;
  kind: TrialKind;
  attendance: string;
  matched: boolean;
};

export type TeacherMonthlyPayroll = {
  id: string;
  sourceTeacherId: string;
  teacherName: string;
  role: TeacherRole;
  /** This source does not document an authoritative teacher monthly total. */
  authoritativeTotalHours: null;
  /** Deduplicated scheduled lesson hours; useful for review only, never salary. */
  derivedTeacherHours: number;
  derivedRegularHours: number;
  derivedTrialHours: number;
  matchedStudentHours: number;
  unresolvedAllocationCount: number;
  unresolvedClassificationCount: number;
  unclassifiedTeacherHours: number;
  groupedLessonCount: number;
  studentDetails: StudentLessonDetail[];
  status: "needs_details";
  notes: string[];
};

export type MonthlyPayrollReport = {
  period: MonthlyPeriod;
  generatedAt: string;
  source: {
    tool: "query_lesson_list";
    requiredFilter: "over=1";
    trialMemberIds: string[];
  };
  lessons: NormalizedLesson[];
  teachers: TeacherMonthlyPayroll[];
  unassignedStudentDetails: StudentLessonDetail[];
  summary: {
    sourceRows: number;
    uniqueLessons: number;
    uniqueTeachers: number;
    sourceStudentHours: number;
    derivedTeacherHours: number;
    unmatchedTeacherLessonGroups: number;
    unresolvedClassificationGroups: number;
    lessonsWithoutTeachers: number;
    unclassifiedLessons: number;
    /** Student-source hours; includes teacherless and unresolved multi-teacher rows. */
    unclassifiedStudentHours: number;
  };
  warnings: string[];
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function optionalId(value: unknown): string | null {
  const result = stringValue(value);
  return result && !/^0+$/.test(result) ? result : null;
}

/** API documents mem_id as an integer, but some gateways serialize it with leading zeroes. */
function canonicalMemberId(value: unknown): string | null {
  const result = optionalId(value);
  return result && /^\d+$/.test(result) ? result.replace(/^0+(?=\d)/, "") : result;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function requiredNumber(value: unknown, label: string): number {
  const result = optionalNumber(value);
  if (result === null || result < 0) throw new Error(`${label} 必须是大于或等于 0 的数字。`);
  return result;
}

function roundHours(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function field(record: UnknownRecord, name: string): unknown {
  return record[name];
}

function dateInPeriod(date: string, period: MonthlyPeriod) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= period.start && date <= period.end;
}

export function parseMonthlyPeriod(value: string): MonthlyPeriod {
  if (!/^\d{4}-\d{2}$/.test(value)) throw new Error("月份必须采用 YYYY-MM 格式。");

  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || month < 1 || month > 12) throw new Error("月份必须采用有效的 YYYY-MM 格式。");

  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    value,
    start: `${yearText}-${monthText}-01`,
    end: `${yearText}-${monthText}-${String(lastDay).padStart(2, "0")}`,
  };
}

function currentMelbournePeriod(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}`;
}

/** Reject a future reporting month before an upstream call can create an empty-looking export. */
export function nonFutureMonthlyPeriod(value: string, now = new Date()): string {
  const period = parseMonthlyPeriod(value).value;
  if (period > currentMelbournePeriod(now)) throw new Error("不能生成未来月份的教务宝课时表。");
  return period;
}

/** A workbook described as a full monthly table must only cover a finished month. */
export function completedMonthlyPeriod(value: string, now = new Date()): string {
  const period = nonFutureMonthlyPeriod(value, now);
  if (period === currentMelbournePeriod(now)) throw new Error("完整月度课时表只能选择已经结束的月份。当前月份请在结月后导出。");
  return period;
}

/**
 * The business rule is that trials use exactly three dedicated JWB student
 * accounts. A blank setting intentionally leaves every record unclassified;
 * malformed or partial mappings fail closed rather than silently turning a
 * missing B account into a regular lesson.
 */
export function parseTrialMemberIds(value: string | undefined): Set<string> {
  if (!value?.trim()) return new Set();
  const suppliedIds = value.split(",").map((part) => part.trim());
  if (suppliedIds.some((id) => !/^\d+$/.test(id) || /^0+$/.test(id))) {
    throw new Error("JIAOWUBAO_TRIAL_MEMBER_IDS 必须是以逗号分隔的正整数教务宝学员 ID。" );
  }
  const ids = suppliedIds.map((id) => id.replace(/^0+(?=\d)/, ""));
  if (new Set(ids).size !== ids.length) {
    throw new Error("JIAOWUBAO_TRIAL_MEMBER_IDS 包含重复的教务宝学员 ID。" );
  }
  if (ids.length !== 3) {
    throw new Error("JIAOWUBAO_TRIAL_MEMBER_IDS 必须完整配置三个试听 B 账号 ID，或留空使所有课节保持待分类。" );
  }
  return new Set(ids);
}

function lessonKind(memberId: string, trialMemberIds: Set<string>): TrialKind {
  if (!trialMemberIds.size) return "待分类";
  return trialMemberIds.has(memberId) ? "试听" : "常规";
}

/**
 * The supplied JWB screen shows the trial identity in the class field, while
 * the meeting notes describe the same convention as a course-name prefix.
 * Read either documented field, but only accept an unambiguous prefix and
 * keep the B account visible whenever the two fields disagree.
 */
function trialNamePrefix(value: string, allowEnglishNameWithLocation = false): string | null {
  const match = value.match(/^\s*([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z.'-]+)*\s*[\u3400-\u9FFF]{1,8})(?=\s|[（(【\[\-—–_、，,·]|$)/u);
  if (match?.[1]) return match[1].replace(/\s+/g, " ").trim();
  if (!allowEnglishNameWithLocation) return null;
  // The supplied screen includes a class title such as “Rita Wu (NZL)”.
  // Restrict this English-only variant to the class field and a location
  // suffix, so a course title such as “English Spelling” is never a name.
  const englishName = value.match(/^\s*([A-Z][a-z.'-]*(?:\s+[A-Z][a-z.'-]*)+)\s*(?=[（(][A-Za-z]{2,4}[）)])/u);
  return englishName?.[1] ? englishName[1].replace(/\s+/g, " ").trim() : null;
}

function displayStudentIdentity(memberName: string, teamTitle: string, courseTitle: string, kind: TrialKind): {
  name: string;
  source: StudentNameSource;
} {
  if (kind !== "试听") return { name: memberName, source: "member_title" };
  const candidates = [
    { name: trialNamePrefix(teamTitle, true), source: "trial_team_title_prefix" as const },
    { name: trialNamePrefix(courseTitle), source: "trial_course_title_prefix" as const },
  ].filter((candidate): candidate is { name: string; source: "trial_team_title_prefix" | "trial_course_title_prefix" } => Boolean(candidate.name));
  if (!candidates.length) return { name: memberName, source: "trial_account_unresolved" };
  if (new Set(candidates.map((candidate) => candidate.name)).size > 1) {
    return { name: memberName, source: "trial_name_conflict" };
  }
  return { name: candidates[0]?.name ?? memberName, source: candidates[0]?.source ?? "trial_account_unresolved" };
}

function readTeachers(record: UnknownRecord, lessonHours: number): LessonTeacher[] {
  const sources: Array<{
    role: TeacherRole;
    id: string;
    title: string;
  }> = [
    { role: "主教", id: "teacher_id", title: "teacher_title" },
    { role: "助教", id: "teacher_s", title: "teacher_s_title" },
    { role: "第三教师", id: "teacher_t", title: "teacher_t_title" },
  ];

  const present = sources
    .map((source) => ({ ...source, sourceId: optionalId(field(record, source.id)) }))
    .filter((source): source is typeof source & { sourceId: string } => Boolean(source.sourceId));

  return present.map((source) => {
    const name = stringValue(field(record, source.title)) || `未命名教师 #${source.sourceId}`;
    if (present.length === 1) {
      return { sourceId: source.sourceId, name, role: source.role, allocatedHours: lessonHours, allocationSource: "single_teacher_lesson_hours" };
    }
    return { sourceId: source.sourceId, name, role: source.role, allocatedHours: null, allocationSource: "unavailable" };
  });
}

export function normalizeCompletedLesson(
  value: unknown,
  period: MonthlyPeriod,
  trialMemberIds: Set<string>,
): NormalizedLesson {
  if (!isRecord(value)) throw new Error("教务宝课节记录不是对象。");
  if (optionalNumber(field(value, "over")) !== 1) throw new Error("课节记录不是已结课记录（over=1）。");

  const calId = optionalId(field(value, "cal_id"));
  const memberId = canonicalMemberId(field(value, "mem_id"));
  const dated = stringValue(field(value, "dated"));
  if (!calId || !memberId) throw new Error("课节记录缺少 cal_id 或 mem_id，无法安全关联。" );
  if (!dateInPeriod(dated, period)) throw new Error(`课节 ${calId} 的日期不在 ${period.value} 内。`);

  const hours = requiredNumber(field(value, "hours"), `课节 ${calId} 的 hours`);
  const typeId = optionalNumber(field(value, "type"));
  const branchId = optionalId(field(value, "branch_id"));
  const key = `${branchId ?? "unknown"}:${calId}:${memberId}`;
  const memberName = stringValue(field(value, "mem_title")) || `未命名学员 #${memberId}`;
  const courseTitle = stringValue(field(value, "course_title"));
  const teamTitle = stringValue(field(value, "team_title"));
  const kind = lessonKind(memberId, trialMemberIds);
  const displayIdentity = displayStudentIdentity(memberName, teamTitle, courseTitle, kind);

  return {
    key,
    branchId,
    calId,
    memberId,
    memberName,
    displayStudentName: displayIdentity.name,
    studentNameSource: displayIdentity.source,
    courseId: optionalId(field(value, "course_id")),
    courseTitle,
    teamId: optionalId(field(value, "team_id")) ?? optionalId(field(value, "class_id")),
    teamTitle,
    dated,
    timeTitle: stringValue(field(value, "time_title")),
    hours,
    typeId,
    typeTitle: stringValue(field(value, "type_title")),
    kind,
    sign: optionalNumber(field(value, "sign")),
    signTitle: stringValue(field(value, "sign_title")) || "未提供",
    over: 1,
    overTime: stringValue(field(value, "over_time")),
    leaveReason: stringValue(field(value, "leave_reason")),
    teachers: readTeachers(value, hours),
  };
}

type TeacherLessonGroup = {
  sourceTeacherId: string;
  teacherName: string;
  role: TeacherRole;
  lessonId: string;
  sourceLessonKey: string;
  allocatedHours: number | null;
  allocationSource: LessonTeacher["allocationSource"];
  members: NormalizedLesson[];
};

function groupTeacherLessons(lessons: NormalizedLesson[]): TeacherLessonGroup[] {
  const groups = new Map<string, TeacherLessonGroup>();
  const lessonMembers = new Map<string, NormalizedLesson[]>();

  for (const lesson of lessons) {
    const sourceLessonKey = `${lesson.branchId ?? "unknown"}:${lesson.calId}`;
    const members = lessonMembers.get(sourceLessonKey);
    if (members) members.push(lesson);
    else lessonMembers.set(sourceLessonKey, [lesson]);
  }

  for (const lesson of lessons) {
    for (const teacher of lesson.teachers) {
      const key = `${teacher.sourceId}:${teacher.role}:${lesson.branchId ?? "unknown"}:${lesson.calId}`;
      const existing = groups.get(key);
      if (existing) {
        existing.members.push(lesson);
        continue;
      }
      groups.set(key, {
        sourceTeacherId: teacher.sourceId,
        teacherName: teacher.name,
        role: teacher.role,
        lessonId: lesson.calId,
        sourceLessonKey: `${lesson.branchId ?? "unknown"}:${lesson.calId}`,
        allocatedHours: teacher.allocatedHours,
        allocationSource: teacher.allocationSource,
        members: [lesson],
      });
    }
  }

  return [...groups.values()].map((group) => {
    // A `cal_id` can have more than one student row. Confirm the complete
    // family is consistently assigned before treating single-teacher `hours`
    // as a teacher allocation; one teacherless/inconsistent member makes the
    // allocation unverifiable.
    const family = lessonMembers.get(group.sourceLessonKey) ?? group.members;
    const roleValues = family.flatMap((lesson) => lesson.teachers);
    const allTeacherIds = new Set(roleValues.map((teacher) => teacher.sourceId));
    const roleAssignments = new Set(roleValues.map((teacher) => `${teacher.role}:${teacher.sourceId}`));
    const memberHours = new Set(family.map((lesson) => lesson.hours));
    const hasTeacherlessMember = family.some((lesson) => !lesson.teachers.length);
    if (!hasTeacherlessMember && allTeacherIds.size === 1 && roleAssignments.size === 1 && memberHours.size === 1) {
      group.allocatedHours = group.members[0]?.hours ?? null;
      group.allocationSource = "single_teacher_lesson_hours";
      return group;
    }

    group.allocatedHours = null;
    group.allocationSource = "unavailable";
    return group;
  });
}

function stableLessonSignature(lesson: NormalizedLesson): string {
  return JSON.stringify({
    calId: lesson.calId,
    memberId: lesson.memberId,
    memberName: lesson.memberName,
    teamTitle: lesson.teamTitle,
    courseTitle: lesson.courseTitle,
    dated: lesson.dated,
    hours: lesson.hours,
    teacherIds: lesson.teachers.map((teacher) => [teacher.role, teacher.sourceId, teacher.allocatedHours]),
  });
}

export function buildMonthlyPayrollReport(input: {
  period: string;
  lessons: unknown[];
  trialMemberIds?: Set<string>;
  generatedAt?: string;
}): MonthlyPayrollReport {
  const period = parseMonthlyPeriod(input.period);
  const trialMemberIds = input.trialMemberIds ?? new Set<string>();
  const normalizedByKey = new Map<string, NormalizedLesson>();

  for (const rawLesson of input.lessons) {
    const lesson = normalizeCompletedLesson(rawLesson, period, trialMemberIds);
    const existing = normalizedByKey.get(lesson.key);
    if (existing && stableLessonSignature(existing) !== stableLessonSignature(lesson)) {
      throw new Error(`课节 ${lesson.key} 出现互相冲突的重复记录。`);
    }
    normalizedByKey.set(lesson.key, lesson);
  }

  const lessons = [...normalizedByKey.values()].sort((left, right) => left.dated.localeCompare(right.dated) || left.key.localeCompare(right.key));
  const groups = groupTeacherLessons(lessons);
  const teachers = new Map<string, TeacherMonthlyPayroll>();

  for (const group of groups) {
    const teacherKey = `${group.sourceTeacherId}:${group.role}`;
    let teacher = teachers.get(teacherKey);
    if (!teacher) {
      teacher = {
        id: `JWB-${period.value}-${group.sourceTeacherId}-${group.role}`,
        sourceTeacherId: group.sourceTeacherId,
        teacherName: group.teacherName,
        role: group.role,
        authoritativeTotalHours: null,
        derivedTeacherHours: 0,
        derivedRegularHours: 0,
        derivedTrialHours: 0,
        matchedStudentHours: 0,
        unresolvedAllocationCount: 0,
        unresolvedClassificationCount: 0,
        unclassifiedTeacherHours: 0,
        groupedLessonCount: 0,
        studentDetails: [],
        status: "needs_details",
        notes: [],
      };
      teachers.set(teacherKey, teacher);
    }

    teacher.groupedLessonCount += 1;
    const memberKinds = new Set(group.members.map((lesson) => lesson.kind));
    const hasMixedKinds = memberKinds.size > 1;
    const groupedKind = hasMixedKinds ? "待分类" : group.members[0]?.kind ?? "待分类";
    const hasOneStudent = group.members.length === 1;
    const canMatchStudent = hasOneStudent && group.allocatedHours !== null;

    if (hasMixedKinds) teacher.unresolvedClassificationCount += 1;

    if (group.allocatedHours === null) {
      teacher.unresolvedAllocationCount += 1;
    } else {
      teacher.derivedTeacherHours = roundHours(teacher.derivedTeacherHours + group.allocatedHours);
      if (groupedKind === "常规") teacher.derivedRegularHours = roundHours(teacher.derivedRegularHours + group.allocatedHours);
      if (groupedKind === "试听") teacher.derivedTrialHours = roundHours(teacher.derivedTrialHours + group.allocatedHours);
      if (groupedKind === "待分类") teacher.unclassifiedTeacherHours = roundHours(teacher.unclassifiedTeacherHours + group.allocatedHours);
      if (canMatchStudent) teacher.matchedStudentHours = roundHours(teacher.matchedStudentHours + group.allocatedHours);
    }

    for (const lesson of group.members) {
      teacher.studentDetails.push({
        lessonId: lesson.calId,
        sourceStudentId: lesson.memberId,
        name: lesson.displayStudentName,
        sourceStudentName: lesson.memberName,
        nameSource: lesson.studentNameSource,
        course: lesson.courseTitle || "未提供课程名称",
        className: lesson.teamTitle || "未提供班级名称",
        dated: lesson.dated,
        time: lesson.timeTitle || "未提供时间",
        lessons: lesson.hours,
        kind: lesson.kind,
        attendance: lesson.signTitle,
        matched: canMatchStudent,
      });
    }
  }

  const teacherRows = [...teachers.values()]
    .map((teacher) => {
      teacher.studentDetails.sort((left, right) => left.dated.localeCompare(right.dated) || left.name.localeCompare(right.name));
      teacher.notes.push("当前接口文档未提供老师月度总课时；推导课节时长不得作为薪资锁定口径。");
      if (!trialMemberIds.size) teacher.notes.push("当前未配置试听账号 ID 映射，课节类型均保留为“待分类”。");
      if (teacher.unresolvedAllocationCount) teacher.notes.push(`${teacher.unresolvedAllocationCount} 节多老师课未提供角色课时分配。`);
      if (teacher.unresolvedClassificationCount) teacher.notes.push(`${teacher.unresolvedClassificationCount} 节多人课同时包含试听和常规账号，课时分类保留待核对。`);
      if (teacher.studentDetails.some((detail) => !detail.matched)) teacher.notes.push("同一课节有多名学生时，不会将老师课时重复计入每位学生。" );
      return teacher;
    })
    .sort((left, right) => left.teacherName.localeCompare(right.teacherName, "zh-Hans-CN") || left.role.localeCompare(right.role));

  const teacherlessLessons = lessons.filter((lesson) => !lesson.teachers.length);
  const unassignedStudentDetails = teacherlessLessons.map((lesson) => ({
    lessonId: lesson.calId,
    sourceStudentId: lesson.memberId,
    name: lesson.displayStudentName,
    sourceStudentName: lesson.memberName,
    nameSource: lesson.studentNameSource,
    course: lesson.courseTitle || "未提供课程名称",
    className: lesson.teamTitle || "未提供班级名称",
    dated: lesson.dated,
    time: lesson.timeTitle || "未提供时间",
    lessons: lesson.hours,
    kind: lesson.kind,
    attendance: lesson.signTitle,
    matched: false,
  })).sort((left, right) => left.dated.localeCompare(right.dated) || left.name.localeCompare(right.name));
  const lessonsWithoutTeachers = teacherlessLessons.length;
  const unclassifiedLessons = lessons.filter((lesson) => lesson.kind === "待分类").length;
  const unclassifiedStudentHours = roundHours(lessons
    .filter((lesson) => lesson.kind === "待分类")
    .reduce((total, lesson) => total + lesson.hours, 0));
  const unresolvedAllocationCount = teacherRows.reduce((total, teacher) => total + teacher.unresolvedAllocationCount, 0);
  const unresolvedClassificationGroups = teacherRows.reduce((total, teacher) => total + teacher.unresolvedClassificationCount, 0);
  const unresolvedTrialAccountRows = lessons.filter((lesson) => lesson.studentNameSource === "trial_account_unresolved").length;
  const conflictingTrialAccountRows = lessons.filter((lesson) => lesson.studentNameSource === "trial_name_conflict").length;
  const warnings = [
    "已强制筛选 over=1（已结课）。",
    "query_lesson_list 未提供老师月度总课时，因此本次导出不自动生成或锁定薪资。",
  ];
  if (!trialMemberIds.size) warnings.push("未配置 JIAOWUBAO_TRIAL_MEMBER_IDS，试听/常规课不会被猜测分类。");
  if (unresolvedAllocationCount) warnings.push(`${unresolvedAllocationCount} 节多老师课缺少角色课时分配，保留待核对。`);
  if (unresolvedClassificationGroups) warnings.push(`${unresolvedClassificationGroups} 节多人课同时包含试听和常规账号，保留待分类。`);
  if (unresolvedTrialAccountRows) warnings.push(`${unresolvedTrialAccountRows} 条试听 B 账号记录未能从班级名称或课程名称安全提取真实学生名，保留账号名待核对。`);
  if (conflictingTrialAccountRows) warnings.push(`${conflictingTrialAccountRows} 条试听 B 账号记录的班级名称和课程名称疑似对应不同学生，保留账号名待核对。`);
  if (lessonsWithoutTeachers) warnings.push(`${lessonsWithoutTeachers} 条已结课记录没有教师 ID，已在“未分配教师”明细和原始明细中保留。`);

  return {
    period,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    source: {
      tool: "query_lesson_list",
      requiredFilter: "over=1",
      trialMemberIds: [...trialMemberIds].sort((left, right) => left.localeCompare(right, "en")),
    },
    lessons,
    teachers: teacherRows,
    unassignedStudentDetails,
    summary: {
      sourceRows: input.lessons.length,
      uniqueLessons: new Set(lessons.map((lesson) => `${lesson.branchId ?? "unknown"}:${lesson.calId}`)).size,
      uniqueTeachers: teacherRows.length,
      sourceStudentHours: roundHours(lessons.reduce((total, lesson) => total + lesson.hours, 0)),
      derivedTeacherHours: roundHours(teacherRows.reduce((total, teacher) => total + teacher.derivedTeacherHours, 0)),
      unmatchedTeacherLessonGroups: unresolvedAllocationCount,
      unresolvedClassificationGroups,
      lessonsWithoutTeachers,
      unclassifiedLessons,
      unclassifiedStudentHours,
    },
    warnings,
  };
}
