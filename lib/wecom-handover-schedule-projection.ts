import type { OpsStateRow } from "./ops-store";
import { mapJiaowubaoSnapshotParticipant, type JiaowubaoSnapshotStudentLookup } from "./jiaowubao-open-api-schedule-reader";
import { normalizeStudentImportName, studentImportAutomaticJwbNameKey } from "./student-import";
import { trialAccountFromParticipants, trialAccountLetter } from "./trial-account-label";
import { isTrialIntake, jiaowubaoTrialCourseTitleMatchesStudentName, matchTrialScheduleEvents, trialPlannerHintFromParticipants, type TrialScheduleEventLike } from "./trial-operations";
import { buildWecomLpDraft } from "./wecom-lp-draft";
import type { WecomLpDraftRawSource } from "./wecom-lp-intake";
import type { WecomHandoverScheduleCandidate, WecomHandoverScheduleEvidence, WecomHandoverScheduleEvent, WecomHandoverScheduleInput } from "./wecom-handover-schedule-types";

type RecordValue = Record<string, unknown>;
type Student = RecordValue & { id: string; name: string };
type Context = ReturnType<typeof sourceContext>;
type PreparedEvent = Readonly<{ raw: WecomHandoverScheduleEvent; event: TrialScheduleEventLike; studentIds: readonly string[]; teacher: ReturnType<typeof teacherChoices>; unsafe: boolean }>;
const DAY = 86_400_000;
const MAX_CANDIDATES = 8;
function record(value: unknown): value is RecordValue { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function key(value: unknown) { return text(value).normalize("NFKC").toLocaleLowerCase("en-AU").replace(/\s+/gu, ""); }
function teacherKey(value: unknown) { return text(value).toLocaleLowerCase("en-AU"); }
function nameKey(value: unknown) { return normalizeStudentImportName(text(value)); }
function unique(values: readonly string[]) { return [...new Set(values)]; }
function rowsOf(rows: readonly OpsStateRow[], entity: string) {
  const matches = rows.filter((row) => row.entity === entity);
  const payload = matches[0]?.payload;
  if (matches.length !== 1 || !Array.isArray(payload) || !payload.every(record)) throw new TypeError(`${entity} authority is unavailable`);
  return payload as RecordValue[];
}
function guardianKey(value: unknown) {
  const label = text(value).normalize("NFKC").replace(/(?:\s*@教务\s*AI\s*助手)+\s*$/iu, "").trim();
  const marker = label.toLocaleLowerCase("en-AU").replace(/[\s\p{P}\p{S}]+/gu, "");
  return !marker || marker === "教务ai助手" || !label.includes("@") && /^(?:待补充|待确认|待填写|暂无|未知|无|未提供|na|none|null|unknown|tbd)$/u.test(marker) ? "" : key(label);
}
function realName(value: unknown, guardian: unknown) {
  const name = text(value);
  return name && guardianKey(name) && guardianKey(name) !== guardianKey(guardian) && !trialAccountLetter(name)
    && !/^(?:待确认|待补充|未知|未提供|暂无|unknown|tbd|n\/?a|[-?？]+)$/iu.test(name) ? name : "";
}
function safeSourceKey(value: unknown) {
  const source = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : text(value);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u.test(source) ? source : "";
}
function buildLookup(students: readonly Student[]): JiaowubaoSnapshotStudentLookup {
  const memberCandidates = new Map<string, string[]>();
  const nameCandidates = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, label: string, id: string) => { if (label) map.set(label, unique([...(map.get(label) ?? []), id])); };
  for (const student of students) {
    add(memberCandidates, safeSourceKey(student.jwbSourceRow), student.id);
    if (realName(student.name, student.guardianWechat)) {
      for (const label of unique([normalizeStudentImportName(student.name), studentImportAutomaticJwbNameKey(student.name)])) add(nameCandidates, label, student.id);
    }
  }
  const uniqueMap = (map: Map<string, string[]>) => new Map([...map].flatMap(([label, ids]) => ids.length === 1 ? [[label, ids[0]!] as const] : []));
  return { memberCandidates, nameCandidates, internalByMember: uniqueMap(memberCandidates), internalByNameKey: uniqueMap(nameCandidates) };
}
function sourceContext(source: WecomLpDraftRawSource, students: readonly Student[], teachers: readonly RecordValue[]) {
  const draft = buildWecomLpDraft(source.messages);
  const guardian = guardianKey(source.wechatName);
  const originalGuardian = guardianKey(draft.guardianWechat);
  const explicitNames = unique([source.studentName, draft.studentName].flatMap((value) => realName(value, source.wechatName) ? [nameKey(value)] : []));
  const hintedIds = unique([source.confirmed?.studentId, ...source.messages.map((message) => message.studentId)].flatMap((id) => text(id) ? [text(id)] : []));
  let conflict = ["identity_conflict", "identity_ambiguous"].includes(source.status) || hintedIds.length > 1 || explicitNames.length > 1
    || Boolean(originalGuardian && originalGuardian !== guardian)
    || draft.conflicts.some((entry) => ["guardianWechat", "studentName", "studentNameKnown"].includes(entry.field));
  const guardians = guardian ? students.filter((student) => guardianKey(student.guardianWechat) === guardian).map((student) => student.id) : [];
  const named = explicitNames.length ? students.filter((student) => nameKey(student.name) === explicitNames[0] && realName(student.name, student.guardianWechat)).map((student) => student.id) : [];
  const anchoredSets = [hintedIds, guardians, named].filter((ids) => ids.length);
  const allowed = anchoredSets.length ? anchoredSets.reduce((ids, next) => ids.filter((id) => next.includes(id))) : null;
  if (anchoredSets.length > 1 && allowed?.length === 0 || hintedIds.some((id) => !students.some((student) => student.id === id))) conflict = true;
  const anchor = allowed?.length === 1 && (hintedIds.length === 1 || guardians.length === 1 || named.length === 1) ? allowed[0]! : null;
  const identity = anchor && students.find((student) => student.id === anchor);
  const strong = identity && realName(identity.name, identity.guardianWechat) ? identity.id : null;
  if (identity && explicitNames.length && nameKey(identity.name) !== explicitNames[0]) conflict = true;
  const plannerValues = unique([source.coursePlanner, draft.fields.planner].map(key).filter(Boolean));
  const teacher = teacherChoices(draft.fields.assignedTeacher, teachers);
  const valuesFor = (field: string) => [draft.fields[field], ...draft.conflicts.filter((entry) => entry.field === field).flatMap((entry) => entry.values)].map(text).filter(Boolean);
  const contentionTeacherLabels = valuesFor("assignedTeacher");
  const contentionTeacherIds = unique(contentionTeacherLabels.flatMap((label) => teacherChoices(label, teachers).ids));
  const contentionSubjects = valuesFor("subject");
  const contentionPlanners = unique([source.coursePlanner, ...valuesFor("planner")].map(key).filter(Boolean));
  const handover = Date.parse(source.handoverAt ?? source.messages.find((message) => message.messageId === source.sourceMessageId)?.sentAt ?? source.createdAt);
  if (!Number.isFinite(handover)) throw new TypeError("handover timestamp is invalid");
  return { source, draft, conflict, allowed, strong, explicitNames, possibleIds: unique(anchoredSets.flat()), contentionTeacherLabels, contentionTeacherIds, contentionSubjects, contentionPlanners, planner: plannerValues.length === 1 ? plannerValues[0]! : "", schedulingConflict: plannerValues.length > 1 || draft.conflicts.some((entry) => ["planner", "assignedTeacher", "subject"].includes(entry.field)), teacher, subject: text(draft.fields.subject), lower: handover - DAY, upper: handover + 31 * DAY };
}
function teacherChoices(value: unknown, teachers: readonly RecordValue[]) {
  const label = text(value);
  if (!label) return { ids: [] as string[], alias: false, provided: false };
  const exact = teachers.filter((teacher) => teacherKey(teacher.name) === teacherKey(label)).map((teacher) => text(teacher.id)).filter(Boolean);
  if (unique(exact).length === 1) return { ids: unique(exact), alias: false, provided: true };
  const parts = label.split(/\s*[,，、/+&;；]\s*/u);
  if (parts.length > 1) {
    const choices = parts.map((part) => teachers.filter((teacher) => teacherKey(teacher.name) === teacherKey(part)).map((teacher) => text(teacher.id)).filter(Boolean));
    if (choices.every((ids) => unique(ids).length === 1)) return { ids: unique(choices.flat()), alias: true, provided: true };
  }
  const tokens = label.split(/\s+/u);
  const choices = tokens.map((token) => teachers.filter((teacher) => teacherKey(text(teacher.name).split(/\s+/u)[0]) === teacherKey(token)).map((teacher) => text(teacher.id)).filter(Boolean));
  return { ids: choices.every((ids) => unique(ids).length === 1) ? unique(choices.flat()) : [], alias: true, provided: true };
}
function subjectKeys(value: unknown) {
  let label = text(value).normalize("NFKC").toLocaleLowerCase("en-AU")
    .replace(/\b(?:y(?:ear)?|g(?:rade)?)\s*\d{1,2}(?=[a-z]|\b)/gu, " ").replace(/verbal\s*reasoning/gu, "verbalreasoning");
  const vocabulary = "english|mathematics|maths?|verbalreasoning|reading|writing|science|physics|chemistry|biology|aes";
  label = label.replace(new RegExp(`(${vocabulary})(?=${vocabulary})`, "gu"), "$1 ");
  const patterns = [
    ["english", /(?:^|[^a-z])english(?:$|[^a-z])|英语|英文/u], ["math", /(?:^|[^a-z])(?:mathematics|maths?)(?:$|[^a-z])|数学/u],
    ["verbal", /(?:^|[^a-z])verbalreasoning(?:$|[^a-z])|文字推理|语言推理/u], ["reading", /(?:^|[^a-z])reading(?:$|[^a-z])|阅读/u],
    ["writing", /(?:^|[^a-z])writing(?:$|[^a-z])|写作/u], ["science", /(?:^|[^a-z])science(?:$|[^a-z])|科学/u], ["physics", /(?:^|[^a-z])physics(?:$|[^a-z])|物理/u],
    ["chemistry", /(?:^|[^a-z])chemistry(?:$|[^a-z])|化学/u], ["biology", /(?:^|[^a-z])biology(?:$|[^a-z])|生物/u], ["aes", /(?:^|[^a-z])aes(?:$|[^a-z])/u],
  ] as const;
  return patterns.flatMap(([name, pattern]) => pattern.test(label) ? [name] : []);
}
function subjectMatches(subject: string, course: string | null) {
  if (!subject) return true;
  const expected = subjectKeys(subject);
  const actual = subjectKeys(course);
  return expected.length ? expected.some((part) => actual.includes(part)) : key(course).includes(key(subject));
}
function prepareEvent(raw: WecomHandoverScheduleEvent, students: readonly Student[], teachers: readonly RecordValue[], lookup: JiaowubaoSnapshotStudentLookup): PreparedEvent {
  const realStudents = students.filter((student) => realName(student.name, student.guardianWechat));
  const mapped: string[] = [];
  let unsafe = raw.sourceStudentsTruncated;
  const accounts = trialAccountFromParticipants(raw.sourceParticipants);
  const accountLetters = unique(raw.sourceParticipants.flatMap((participant) => trialAccountLetter(participant.label) ? [trialAccountLetter(participant.label)!] : []));
  if (accountLetters.length > 1) unsafe = true;
  for (const participant of raw.sourceParticipants) {
    if (trialAccountLetter(participant.label)) continue;
    const id = mapJiaowubaoSnapshotParticipant(participant, lookup);
    if (!id) { if (participant.memberId || text(participant.label)) unsafe = true; continue; }
    const student = students.find((candidate) => candidate.id === id)!;
    const nativeKeys = [normalizeStudentImportName(student.name), studentImportAutomaticJwbNameKey(student.name)];
    const labelKeys = text(participant.label) ? [normalizeStudentImportName(participant.label!), studentImportAutomaticJwbNameKey(participant.label!)] : [];
    if (labelKeys.length && !labelKeys.some((label) => nativeKeys.includes(label))) unsafe = true;
    if (!realName(student.name, student.guardianWechat) || participant.memberId && safeSourceKey(student.jwbSourceRow) && participant.memberId !== safeSourceKey(student.jwbSourceRow)) unsafe = true;
    mapped.push(id);
  }
  const direct = unique(mapped);
  const titled = realStudents.filter((student) => jiaowubaoTrialCourseTitleMatchesStudentName(raw.courseName, student.name)).map((student) => student.id);
  if (titled.length > 1 || titled.length && direct.length && titled.some((id) => !direct.includes(id))) unsafe = true;
  const studentIds = direct.length ? direct : accounts.sharedAccountLetter ? titled : [];
  const teacherIds = unique(teachers.filter((teacher) => teacherKey(teacher.name) === teacherKey(raw.sourceTeacherLabel)).map((teacher) => text(teacher.id)).filter(Boolean));
  return { raw, unsafe, studentIds, teacher: teacherChoices(raw.sourceTeacherLabel, teachers), event: {
    eventId: raw.eventId, startsAt: raw.startsAt, endsAt: raw.endsAt, courseName: raw.courseName,
    teacherId: teacherIds.length === 1 ? teacherIds[0]! : null, teacherName: raw.sourceTeacherLabel,
    visibleStudentIds: direct, trialPlannerHint: trialPlannerHintFromParticipants(raw.sourceParticipants), ...accounts,
  } };
}
function coarseMatch(context: Context, event: PreparedEvent) {
  return Boolean(context.teacher.ids.length && event.teacher.ids.some((id) => context.teacher.ids.includes(id))
    && context.subject && subjectMatches(context.subject, event.raw.courseName)
    && context.planner && context.planner === key(event.event.trialPlannerHint));
}
function eligible(context: Context, event: PreparedEvent) {
  const start = Date.parse(event.raw.startsAt);
  if (start < context.lower || start >= context.upper || context.schedulingConflict) return false;
  if (context.planner && event.event.trialPlannerHint && context.planner !== key(event.event.trialPlannerHint)) return false;
  if (context.teacher.provided && (!event.teacher.ids.some((id) => context.teacher.ids.includes(id)))) return false;
  if (!subjectMatches(context.subject, event.raw.courseName)) return false;
  return context.strong ? event.studentIds.includes(context.strong) : coarseMatch(context, event);
}
function conflictedContention(context: Context, event: PreparedEvent) {
  const start = Date.parse(event.raw.startsAt);
  if (start < context.lower || start >= context.upper) return false;
  const teacherProof = event.teacher.ids.some((id) => context.contentionTeacherIds.includes(id))
    || context.contentionTeacherLabels.some((label) => teacherKey(label) === teacherKey(event.raw.sourceTeacherLabel));
  const teacherCompatible = !context.contentionTeacherLabels.length || teacherProof;
  const subjectProof = context.contentionSubjects.some((subject) => subjectMatches(subject, event.raw.courseName));
  const subjectCompatible = !context.contentionSubjects.length || subjectProof;
  const plannerProof = Boolean(event.event.trialPlannerHint && context.contentionPlanners.includes(key(event.event.trialPlannerHint)));
  const plannerCompatible = !context.contentionPlanners.length || !event.event.trialPlannerHint || plannerProof;
  return Boolean(teacherCompatible && subjectCompatible && plannerCompatible && event.studentIds.some((id) => context.possibleIds.includes(id))
    || teacherProof && subjectProof && plannerProof);
}
function covered(lower: number, upper: number, coverage: WecomHandoverScheduleInput["coverage"], now: number) {
  let cursor = lower;
  const windows = coverage.map((window) => [Date.parse(window.startsAt), Math.min(Date.parse(window.endsAt), window.historical ? now : Infinity)] as const).filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start).sort((left, right) => left[0] - right[0]);
  for (const [start, end] of windows) {
    if (start > cursor) break;
    cursor = Math.max(cursor, end);
    if (cursor >= upper) return true;
  }
  return false;
}
function eventCovered(event: WecomHandoverScheduleEvent, coverage: WecomHandoverScheduleInput["coverage"], now: number) {
  const start = Date.parse(event.startsAt);
  return (!event.historical || start < now) && coverage.some((window) => window.historical === event.historical && Date.parse(window.startsAt) <= start && Date.parse(window.endsAt) > start)
    && (!event.historical || !coverage.some((window) => !window.historical && Date.parse(window.startsAt) <= start && Date.parse(window.endsAt) > start));
}
function lpArguments(lp: RecordValue) {
  return { id: text(lp.id), studentId: text(lp.studentId), workflowType: text(lp.workflowType), stage: text(lp.stage), resultStatus: text(lp.resultStatus),
    ...(text(lp.requestedAt) ? { requestedAt: text(lp.requestedAt) } : {}), ...(record(lp.fields) ? { fields: lp.fields } : {}),
    ...(isTrialIntake(lp.trialIntake) ? { trialIntake: lp.trialIntake } : {}),
  };
}
export function prepareWecomHandoverScheduleProjection(input: WecomHandoverScheduleInput): readonly WecomHandoverScheduleEvidence[] {
  if (input.targetSourceMessageIds.length > 50 || unique(input.targetSourceMessageIds).length !== input.targetSourceMessageIds.length
    || unique(input.sources.map((source) => source.sourceMessageId)).length !== input.sources.length
    || input.targetSourceMessageIds.some((id) => !input.sources.some((source) => source.sourceMessageId === id))) throw new TypeError("handover targets are invalid");
  const checked = new Date(input.checkedAt ?? new Date());
  if (!Number.isFinite(checked.valueOf()) || !text(input.snapshotRevision) || !text(input.inputRevision)) throw new TypeError("handover projection revision or clock is invalid");
  const checkedAt = checked.toISOString();
  const now = checked.valueOf();
  const roster = rowsOf(input.rows, "students");
  const students: Student[] = roster.filter((student) => text(student.id) && text(student.name) && key(student.importArchived) !== "true" && student.importArchived !== true).map((student) => ({ ...student, id: text(student.id), name: String(student.name) }));
  if (unique(students.map((student) => student.id)).length !== students.length) throw new TypeError("student authority has duplicate identities");
  const teachers = rowsOf(input.rows, "teachers");
  const lpItems = rowsOf(input.rows, "lpItems");
  const lookup = buildLookup(students);
  const contexts = input.sources.map((source) => sourceContext(source, students, teachers));
  if (input.events.some((event) => !Number.isFinite(Date.parse(event.startsAt)) || !(Date.parse(event.endsAt) > Date.parse(event.startsAt)))) throw new TypeError("schedule source time is invalid");
  const validEvents = input.events.filter((event) => eventCovered(event, input.coverage, now)
    && (event.sourceParticipants.some((participant) => trialAccountLetter(participant.label)) || /试听|视听|\btrial\b/iu.test(text(event.courseName))));
  const eventCounts = new Map<string, number>();
  for (const event of validEvents) eventCounts.set(event.eventId, (eventCounts.get(event.eventId) ?? 0) + 1);
  const events = validEvents.map((event) => prepareEvent(event, students, teachers, lookup)).map((event) => eventCounts.get(event.raw.eventId) === 1 ? event : { ...event, unsafe: true });
  const studentArguments = students.map((student) => ({ id: student.id, name: student.name, owner: text(student.owner), planner: text(student.planner) }));
  const teacherArguments = teachers.map((teacher) => ({ id: text(teacher.id), name: text(teacher.name) }));
  const occupied = new Set(lpItems.flatMap((item) => [item.trialSchedule, item.trialScheduleReview].flatMap((schedule) => record(schedule) && text(schedule.eventId) ? [text(schedule.eventId)] : [])));
  for (const event of events) {
    if (event.unsafe || occupied.has(event.raw.eventId)) continue;
    if (lpItems.some((item) => event.studentIds.includes(text(item.studentId)) && matchTrialScheduleEvents({ lpItems: [lpArguments(item)], students: studentArguments, teachers: teacherArguments, events: [event.event], matchedAt: checkedAt }).length)) occupied.add(event.raw.eventId);
  }
  const candidatesBySource = contexts.map((context) => {
    const candidates: WecomHandoverScheduleCandidate[] = [];
    let unsafe = false;
    if (!context.conflict) for (const event of events) {
      if (occupied.has(event.raw.eventId)) continue;
      if (event.unsafe) {
        const start = Date.parse(event.raw.startsAt);
        const anchoredStudent = context.strong ? students.find((student) => student.id === context.strong) : null;
        const anchoredTitle = anchoredStudent && jiaowubaoTrialCourseTitleMatchesStudentName(event.raw.courseName, anchoredStudent.name)
          && subjectMatches(context.subject, event.raw.courseName)
          && (!context.teacher.provided || event.teacher.ids.some((id) => context.teacher.ids.includes(id)))
          && (!context.planner || !event.event.trialPlannerHint || context.planner === key(event.event.trialPlannerHint));
        if (start >= context.lower && start < context.upper && !context.schedulingConflict && (eligible(context, event) || coarseMatch(context, event) || anchoredTitle)) unsafe = true;
        continue;
      }
      if (!eligible(context, event)) continue;
      const ids = event.studentIds.filter((id) => (!context.allowed || context.allowed.includes(id)) && (!context.explicitNames.length || students.some((student) => student.id === id && nameKey(student.name) === context.explicitNames[0])));
      for (const studentId of ids) {
        const student = students.find((candidate) => candidate.id === studentId)!;
        candidates.push({ studentId, studentName: student.name, sourceRunId: event.raw.sourceRunId, schedule: {
          source: "jiaowubao-open-api", sourceRevision: event.raw.sourceRevision, eventId: event.raw.eventId,
          startsAt: new Date(event.raw.startsAt).toISOString(), endsAt: new Date(event.raw.endsAt).toISOString(),
          courseName: event.raw.courseName, studentName: student.name, teacherId: event.event.teacherId, teacherName: text(event.raw.sourceTeacherLabel),
          plannerHint: event.event.trialPlannerHint ?? null, ...trialAccountFromParticipants(event.raw.sourceParticipants),
          durationMinutes: (Date.parse(event.raw.endsAt) - Date.parse(event.raw.startsAt)) / 60_000, matchedAt: checkedAt,
        } });
      }
    }
    candidates.sort((left, right) => left.schedule.startsAt.localeCompare(right.schedule.startsAt) || left.schedule.eventId.localeCompare(right.schedule.eventId) || left.studentId.localeCompare(right.studentId));
    const reservations = context.conflict || context.schedulingConflict
      ? events.filter((event) => !occupied.has(event.raw.eventId) && conflictedContention(context, event)).map((event) => event.raw.eventId) : [];
    return { context, candidates, unsafe, reservations };
  });
  const competition = new Map<string, number>();
  for (const entry of candidatesBySource) for (const id of unique([...entry.candidates.map((candidate) => candidate.schedule.eventId), ...entry.reservations])) competition.set(id, (competition.get(id) ?? 0) + 1);
  const strongLpItems = contexts.flatMap((context) => !context.conflict && context.strong ? [{ id: context.source.sourceMessageId, studentId: context.strong, workflowType: "试听 LP", requestedAt: new Date(context.lower + DAY).toISOString(), fields: { assignedTeacher: context.draft.fields.assignedTeacher } }] : []);
  const proven = matchTrialScheduleEvents({ lpItems: strongLpItems, students: studentArguments, teachers: teacherArguments, events: events.filter((event) => !event.unsafe && !occupied.has(event.raw.eventId)).map((event) => event.event), matchedAt: checkedAt });
  const evidence = new Map(candidatesBySource.map(({ context, candidates, unsafe }) => {
    const complete = covered(context.lower, context.upper, input.coverage, now);
    const candidate = candidates.length === 1 ? candidates[0]! : null;
    const event = candidate ? events.find((entry) => entry.raw.eventId === candidate.schedule.eventId) : null;
    const competing = candidate ? (competition.get(candidate.schedule.eventId) ?? 0) > 1 : false;
    const automatic = Boolean(candidate && context.strong === candidate.studentId && event && !event.raw.historical && Date.parse(candidate.schedule.startsAt) >= now
      && event.studentIds.length === 1 && !context.teacher.alias && !event.teacher.alias && !unsafe && complete && !competing
      && proven.some((match) => match.lpItemId === context.source.sourceMessageId && match.link.eventId === candidate.schedule.eventId));
    const status: WecomHandoverScheduleEvidence["status"] = context.conflict ? "identity_conflict" : context.schedulingConflict || unsafe || candidates.length > 1 || competing ? "ambiguous"
      : automatic ? "matched" : candidates.length ? "candidate" : !complete ? "outside_window" : !context.strong ? "needs_identity" : "no_match";
    return [context.source.sourceMessageId, { sourceMessageId: context.source.sourceMessageId, sourceRevision: context.source.sourceRevision, snapshotRevision: input.snapshotRevision, checkedAt,
      status, matchedStudentId: automatic ? candidate!.studentId : null, candidates: candidates.slice(0, MAX_CANDIDATES) } satisfies WecomHandoverScheduleEvidence] as const;
  }));
  return input.targetSourceMessageIds.map((id) => evidence.get(id)!);
}
