import type { OpsStateRow } from "./ops-store";
import { mapJiaowubaoSnapshotParticipant, type JiaowubaoSnapshotStudentLookup } from "./jiaowubao-open-api-schedule-reader";
import { normalizeStudentImportName, studentImportAutomaticJwbNameKey } from "./student-import";
import { trialAccountFromParticipants, trialAccountLetter } from "./trial-account-label";
import { isTrialIntake, jiaowubaoTrialCourseTitleMatchesStudentName, matchTrialScheduleEvents, trialPlannerHintFromParticipants, type TrialScheduleEventLike } from "./trial-operations";
import { wecomHandoverScheduleTitleName } from "./wecom-handover-schedule-title";
import { buildWecomLpDraft } from "./wecom-lp-draft";
import type { WecomLpDraftRawSource } from "./wecom-lp-intake";
import { WECOM_HANDOVER_SCHEDULE_ALGORITHM_VERSION, type WecomHandoverScheduleCandidate, type WecomHandoverScheduleEvidence, type WecomHandoverScheduleEvent, type WecomHandoverScheduleInput } from "./wecom-handover-schedule-types";

type RecordValue = Record<string, unknown>;
type Student = RecordValue & { id: string; name: string };
type Draft = ReturnType<typeof buildWecomLpDraft>;
type Context = ReturnType<typeof sourceContext>;
type Participant = WecomHandoverScheduleEvent["sourceParticipants"][number];
type Authority = ReturnType<typeof projectionAuthority>;
type CandidateScope = Readonly<{ students: readonly Student[]; events: readonly PreparedEvent[]; occupied: ReadonlySet<string>; checkedAt: string }>;
type SourceCandidates = ReturnType<typeof sourceCandidates>;
type Selection = ReturnType<typeof sourceSelection>;
type EvidenceScope = CandidateScope & Readonly<{
  now: number; snapshotRevision: string; coverage: WecomHandoverScheduleInput["coverage"];
  competition: ReadonlyMap<string, number>; proven: ReturnType<typeof matchTrialScheduleEvents>;
}>;
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
function sourceNames(source: WecomLpDraftRawSource, draft: Draft) {
  return unique([source.studentName, draft.studentName].flatMap((value) => realName(value, source.wechatName) ? [nameKey(value)] : []));
}
function sourceHintedIds(source: WecomLpDraftRawSource) {
  return unique([source.confirmed?.studentId, ...source.messages.map((message) => message.studentId)].map(text).filter(Boolean));
}
function originalIdentityConflict(source: WecomLpDraftRawSource, draft: Draft, hintedIds: readonly string[], explicitNames: readonly string[]) {
  const originalGuardian = guardianKey(draft.guardianWechat);
  const guardianMismatch = Boolean(originalGuardian && originalGuardian !== guardianKey(source.wechatName));
  return ["identity_conflict", "identity_ambiguous"].includes(source.status) || hintedIds.length > 1 || explicitNames.length > 1 || guardianMismatch
    || draft.conflicts.some((entry) => ["guardianWechat", "studentName", "studentNameKnown"].includes(entry.field));
}
function namedStudents(students: readonly Student[], explicitNames: readonly string[]) {
  if (!explicitNames.length) return [];
  return students.filter((student) => nameKey(student.name) === explicitNames[0] && realName(student.name, student.guardianWechat)).map((student) => student.id);
}
function anchorConflict(sets: readonly string[][], allowed: readonly string[] | null, hintedIds: readonly string[], students: readonly Student[]) {
  return sets.length > 1 && allowed?.length === 0 || hintedIds.some((id) => !students.some((student) => student.id === id));
}
function selectSourceAnchor(sets: readonly string[][], allowed: readonly string[] | null) {
  if (allowed?.length !== 1 || !sets.some((ids) => ids.length === 1)) return null;
  return allowed[0]!;
}
function explicitNameConflict(identity: Student | undefined, explicitNames: readonly string[]) {
  return Boolean(identity && explicitNames.length && nameKey(identity.name) !== explicitNames[0]);
}
function sourceIdentity(source: WecomLpDraftRawSource, draft: Draft, students: readonly Student[]) {
  const explicitNames = sourceNames(source, draft);
  const hintedIds = sourceHintedIds(source);
  const guardian = guardianKey(source.wechatName);
  const guardians = guardian ? students.filter((student) => guardianKey(student.guardianWechat) === guardian).map((student) => student.id) : [];
  const named = namedStudents(students, explicitNames);
  const sets = [hintedIds, guardians, named].filter((ids) => ids.length);
  const allowed = sets.length ? sets.reduce((ids, next) => ids.filter((id) => next.includes(id))) : null;
  const anchor = selectSourceAnchor(sets, allowed);
  const identity = students.find((student) => student.id === anchor);
  const strong = identity && realName(identity.name, identity.guardianWechat) ? identity.id : null;
  const conflict = originalIdentityConflict(source, draft, hintedIds, explicitNames) || anchorConflict(sets, allowed, hintedIds, students) || explicitNameConflict(identity, explicitNames);
  return { conflict, allowed, strong, explicitNames, possibleIds: unique(sets.flat()) };
}
function draftValues(draft: Draft, field: string) {
  return [draft.fields[field], ...draft.conflicts.filter((entry) => entry.field === field).flatMap((entry) => entry.values)].map(text).filter(Boolean);
}
function sourceScheduling(source: WecomLpDraftRawSource, draft: Draft, teachers: readonly RecordValue[]) {
  const plannerValues = unique([source.coursePlanner, draft.fields.planner].map(key).filter(Boolean));
  const teacherField = draft.workflowType === "换老师试听" ? "newTeacher" : "assignedTeacher";
  const contentionTeacherLabels = draftValues(draft, teacherField);
  return {
    contentionTeacherLabels,
    contentionTeacherIds: unique(contentionTeacherLabels.flatMap((label) => teacherChoices(label, teachers).ids)),
    contentionSubjects: draftValues(draft, "subject"),
    contentionPlanners: unique([source.coursePlanner, ...draftValues(draft, "planner")].map(key).filter(Boolean)),
    planner: plannerValues.length === 1 ? plannerValues[0]! : "",
    schedulingConflict: plannerValues.length > 1 || draft.conflicts.some((entry) => ["planner", teacherField, "subject"].includes(entry.field)),
    teacher: teacherChoices(draft.fields[teacherField], teachers), subject: text(draft.fields.subject),
  };
}
function sourceWindow(source: WecomLpDraftRawSource) {
  const handover = Date.parse(source.handoverAt ?? source.messages.find((message) => message.messageId === source.sourceMessageId)?.sentAt ?? source.createdAt);
  if (!Number.isFinite(handover)) throw new TypeError("handover timestamp is invalid");
  return { lower: handover - DAY, upper: handover + 31 * DAY };
}
function sourceContext(source: WecomLpDraftRawSource, students: readonly Student[], teachers: readonly RecordValue[]) {
  const draft = buildWecomLpDraft(source.messages);
  return { source, draft, ...sourceIdentity(source, draft, students), ...sourceScheduling(source, draft, teachers), ...sourceWindow(source) };
}
function teacherAlternativeIds(label: string, teachers: readonly RecordValue[]) {
  const exact = teachers.filter((teacher) => teacherKey(teacher.name) === teacherKey(label)).map((teacher) => text(teacher.id)).filter(Boolean);
  if (exact.length || !label || /\s/u.test(label)) return unique(exact);
  return unique(teachers.filter((teacher) => teacherKey(text(teacher.name).split(/\s+/u)[0]) === teacherKey(label)).map((teacher) => text(teacher.id)).filter(Boolean));
}
function teacherChoices(value: unknown, teachers: readonly RecordValue[]) {
  const label = text(value);
  if (!label) return { ids: [] as string[], alias: false, provided: false };
  const exact = teachers.filter((teacher) => teacherKey(teacher.name) === teacherKey(label)).map((teacher) => text(teacher.id)).filter(Boolean);
  if (unique(exact).length === 1) return { ids: unique(exact), alias: false, provided: true };
  const parts = label.split(/\s*[,，、/+&;；]\s*/u);
  if (parts.length > 1) {
    const choices = parts.map((part) => teacherAlternativeIds(part, teachers));
    return { ids: choices.every((ids) => ids.length === 1) ? unique(choices.flat()) : [], alias: true, provided: true };
  }
  const tokens = label.split(/\s+/u);
  const choices = tokens.map((token) => teachers.filter((teacher) => teacherKey(text(teacher.name).split(/\s+/u)[0]) === teacherKey(token)).map((teacher) => text(teacher.id)).filter(Boolean));
  const resolved = choices.every((ids) => unique(ids).length === 1) || tokens.every((token) => /^[A-Za-z]+$/u.test(token)) && choices.every((ids) => ids.length > 0);
  return { ids: resolved ? unique(choices.flat()) : [], alias: true, provided: true };
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
function participantNameConflict(label: string | null, student: Student) {
  const nativeKeys = [normalizeStudentImportName(student.name), studentImportAutomaticJwbNameKey(student.name)];
  const labelKeys = text(label) ? [normalizeStudentImportName(label!), studentImportAutomaticJwbNameKey(label!)] : [];
  return Boolean(labelKeys.length && !labelKeys.some((value) => nativeKeys.includes(value)));
}
function participantMemberConflict(participant: Participant, student: Student) {
  return !realName(student.name, student.guardianWechat)
    || Boolean(participant.memberId && safeSourceKey(student.jwbSourceRow) && participant.memberId !== safeSourceKey(student.jwbSourceRow));
}
function participantProof(participant: Participant, students: readonly Student[], lookup: JiaowubaoSnapshotStudentLookup) {
  if (trialAccountLetter(participant.label)) return { id: null, unsafe: false };
  const id = mapJiaowubaoSnapshotParticipant(participant, lookup);
  if (!id) return { id: null, unsafe: Boolean(participant.memberId || text(participant.label)) };
  const student = students.find((candidate) => candidate.id === id)!;
  return { id, unsafe: participantNameConflict(participant.label, student) || participantMemberConflict(participant, student) };
}
function sourceTitleConflict(titled: readonly string[], direct: readonly string[]) {
  return Boolean(titled.length > 1 || titled.length && direct.length && titled.some((id) => !direct.includes(id)));
}
function nativeTeacherId(teachers: readonly RecordValue[], label: string | null) {
  const ids = unique(teachers.filter((teacher) => teacherKey(teacher.name) === teacherKey(label)).map((teacher) => text(teacher.id)).filter(Boolean));
  return ids.length === 1 ? ids[0]! : null;
}
function sharedAccountConflict(raw: WecomHandoverScheduleEvent) {
  return unique(raw.sourceParticipants.flatMap((participant) => trialAccountLetter(participant.label) ? [trialAccountLetter(participant.label)!] : [])).length > 1;
}
function prepareEvent(raw: WecomHandoverScheduleEvent, students: readonly Student[], teachers: readonly RecordValue[], lookup: JiaowubaoSnapshotStudentLookup): PreparedEvent {
  const proofs = raw.sourceParticipants.map((participant) => participantProof(participant, students, lookup));
  const direct = unique(proofs.flatMap((proof) => proof.id ? [proof.id] : []));
  const titled = students.filter((student) => realName(student.name, student.guardianWechat))
    .filter((student) => jiaowubaoTrialCourseTitleMatchesStudentName(raw.courseName, student.name)).map((student) => student.id);
  const accounts = trialAccountFromParticipants(raw.sourceParticipants);
  const unsafe = raw.sourceStudentsTruncated || sharedAccountConflict(raw) || proofs.some((proof) => proof.unsafe) || sourceTitleConflict(titled, direct);
  return { raw, unsafe, studentIds: direct.length ? direct : accounts.sharedAccountLetter ? titled : [], teacher: teacherChoices(raw.sourceTeacherLabel, teachers), event: {
    eventId: raw.eventId, startsAt: raw.startsAt, endsAt: raw.endsAt, courseName: raw.courseName,
    teacherId: nativeTeacherId(teachers, raw.sourceTeacherLabel), teacherName: raw.sourceTeacherLabel,
    visibleStudentIds: direct, trialPlannerHint: trialPlannerHintFromParticipants(raw.sourceParticipants), ...accounts,
  } };
}
function coarseMatch(context: Context, event: PreparedEvent) {
  return Boolean(context.teacher.ids.length && event.teacher.ids.some((id) => context.teacher.ids.includes(id))
    && context.subject && subjectMatches(context.subject, event.raw.courseName)
    && context.planner && sourcePlannerCompatible(context, event));
}
function inSourceWindow(context: Context, event: PreparedEvent) {
  const start = Date.parse(event.raw.startsAt);
  return start >= context.lower && start < context.upper;
}
function sourceTeacherCompatible(context: Context, event: PreparedEvent) {
  return !context.teacher.provided || event.teacher.ids.some((id) => context.teacher.ids.includes(id));
}
function sourcePlannerCompatible(context: Context, event: PreparedEvent) {
  return !context.planner || !event.event.trialPlannerHint || context.planner === key(event.event.trialPlannerHint);
}
function sourceConstraintsCompatible(context: Context, event: PreparedEvent) {
  return !context.schedulingConflict && inSourceWindow(context, event) && sourceTeacherCompatible(context, event)
    && sourcePlannerCompatible(context, event) && subjectMatches(context.subject, event.raw.courseName);
}
function eligible(context: Context, event: PreparedEvent) {
  if (!sourceConstraintsCompatible(context, event)) return false;
  return context.strong ? event.studentIds.includes(context.strong) : coarseMatch(context, event);
}
function contentionProof(context: Context, event: PreparedEvent) {
  const teacher = event.teacher.ids.some((id) => context.contentionTeacherIds.includes(id))
    || context.contentionTeacherLabels.some((label) => teacherKey(label) === teacherKey(event.raw.sourceTeacherLabel));
  const subject = context.contentionSubjects.some((value) => subjectMatches(value, event.raw.courseName));
  const planner = Boolean(context.contentionPlanners.length && (!event.event.trialPlannerHint || context.contentionPlanners.includes(key(event.event.trialPlannerHint))));
  return { teacher, subject, planner };
}
function contendedIdentityCompatible(context: Context, event: PreparedEvent, proof: ReturnType<typeof contentionProof>) {
  const teacher = !context.contentionTeacherLabels.length || proof.teacher;
  const subject = !context.contentionSubjects.length || proof.subject;
  const planner = !context.contentionPlanners.length || !event.event.trialPlannerHint || proof.planner;
  return teacher && subject && planner && event.studentIds.some((id) => context.possibleIds.includes(id));
}
function conflictedContention(context: Context, event: PreparedEvent) {
  if (!inSourceWindow(context, event)) return false;
  const proof = contentionProof(context, event);
  return contendedIdentityCompatible(context, event, proof) || proof.teacher && proof.subject && proof.planner;
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
function assertTargets(input: WecomHandoverScheduleInput) {
  if (input.targetSourceMessageIds.length > 50 || unique(input.targetSourceMessageIds).length !== input.targetSourceMessageIds.length
    || unique(input.sources.map((source) => source.sourceMessageId)).length !== input.sources.length
    || input.targetSourceMessageIds.some((id) => !input.sources.some((source) => source.sourceMessageId === id))) throw new TypeError("handover targets are invalid");
}
function projectionClock(input: WecomHandoverScheduleInput) {
  const checked = new Date(input.checkedAt ?? new Date());
  if (!Number.isFinite(checked.valueOf()) || !text(input.snapshotRevision) || !text(input.inputRevision)) throw new TypeError("handover projection revision or clock is invalid");
  return { checkedAt: checked.toISOString(), now: checked.valueOf() };
}
function projectionAuthority(rows: readonly OpsStateRow[]) {
  const students: Student[] = rowsOf(rows, "students").filter((student) => text(student.id) && text(student.name) && key(student.importArchived) !== "true" && student.importArchived !== true)
    .map((student) => ({ ...student, id: text(student.id), name: String(student.name) }));
  if (unique(students.map((student) => student.id)).length !== students.length) throw new TypeError("student authority has duplicate identities");
  const teachers = rowsOf(rows, "teachers");
  const lpItems = rowsOf(rows, "lpItems");
  return {
    students, teachers, lpItems,
    studentArguments: students.map((student) => ({ id: student.id, name: student.name, owner: text(student.owner), planner: text(student.planner) })),
    teacherArguments: teachers.map((teacher) => ({ id: text(teacher.id), name: text(teacher.name) })),
  };
}
function isTrialEvent(event: WecomHandoverScheduleEvent) {
  return event.sourceParticipants.some((participant) => trialAccountLetter(participant.label)) || /试听|视听|\btrial\b/iu.test(text(event.courseName));
}
function projectionEvents(input: WecomHandoverScheduleInput, authority: Authority, now: number) {
  if (input.events.some((event) => !Number.isFinite(Date.parse(event.startsAt)) || !(Date.parse(event.endsAt) > Date.parse(event.startsAt)))) throw new TypeError("schedule source time is invalid");
  const valid = input.events.filter((event) => eventCovered(event, input.coverage, now) && isTrialEvent(event));
  const counts = new Map<string, number>();
  for (const event of valid) counts.set(event.eventId, (counts.get(event.eventId) ?? 0) + 1);
  const lookup = buildLookup(authority.students);
  return valid.map((event) => prepareEvent(event, authority.students, authority.teachers, lookup))
    .map((event) => counts.get(event.raw.eventId) === 1 ? event : { ...event, unsafe: true });
}
function lpOccupiedEventIds(item: RecordValue) {
  return [item.trialSchedule, item.trialScheduleReview].flatMap((schedule) => record(schedule) && text(schedule.eventId) ? [text(schedule.eventId)] : []);
}
function lpCanClaimEvent(item: RecordValue, event: PreparedEvent, authority: Authority, checkedAt: string) {
  return event.studentIds.includes(text(item.studentId)) && matchTrialScheduleEvents({
    lpItems: [lpArguments(item)], students: authority.studentArguments, teachers: authority.teacherArguments, events: [event.event], matchedAt: checkedAt,
  }).length > 0;
}
function occupiedEvents(events: readonly PreparedEvent[], authority: Authority, checkedAt: string) {
  const occupied = new Set(authority.lpItems.flatMap(lpOccupiedEventIds));
  for (const event of events) {
    if (event.unsafe || occupied.has(event.raw.eventId)) continue;
    if (authority.lpItems.some((item) => lpCanClaimEvent(item, event, authority, checkedAt))) occupied.add(event.raw.eventId);
  }
  return occupied;
}
function anchoredTitleMatch(context: Context, event: PreparedEvent, students: readonly Student[]) {
  const student = context.strong ? students.find((candidate) => candidate.id === context.strong) : null;
  if (!student) return false;
  return jiaowubaoTrialCourseTitleMatchesStudentName(event.raw.courseName, student.name) && subjectMatches(context.subject, event.raw.courseName)
    && sourceTeacherCompatible(context, event) && sourcePlannerCompatible(context, event);
}
function uncertainEventContention(context: Context, event: PreparedEvent, students: readonly Student[]) {
  if (!inSourceWindow(context, event) || context.schedulingConflict) return false;
  return eligible(context, event) || coarseMatch(context, event) || anchoredTitleMatch(context, event, students);
}
function candidateStudentAllowed(context: Context, id: string, students: readonly Student[]) {
  return (!context.allowed || context.allowed.includes(id)) && (!context.explicitNames.length || students.some((student) => student.id === id && nameKey(student.name) === context.explicitNames[0]));
}
function scheduleCandidate(event: PreparedEvent, student: Readonly<{ id: string | null; name: string }>, checkedAt: string): WecomHandoverScheduleCandidate {
  return { studentId: student.id, studentName: student.name, sourceRunId: event.raw.sourceRunId, schedule: {
    source: "jiaowubao-open-api", sourceRevision: event.raw.sourceRevision, eventId: event.raw.eventId,
    startsAt: new Date(event.raw.startsAt).toISOString(), endsAt: new Date(event.raw.endsAt).toISOString(),
    courseName: event.raw.courseName, studentName: student.name, teacherId: event.event.teacherId, teacherName: text(event.raw.sourceTeacherLabel),
    plannerHint: event.event.trialPlannerHint ?? null, ...trialAccountFromParticipants(event.raw.sourceParticipants),
    durationMinutes: (Date.parse(event.raw.endsAt) - Date.parse(event.raw.startsAt)) / 60_000, matchedAt: checkedAt,
  } };
}
function pureSharedParticipants(event: PreparedEvent) {
  const letter = event.event.sharedAccountLetter;
  return Boolean(letter && event.raw.sourceParticipants.length && event.raw.sourceParticipants.every((participant) => trialAccountLetter(participant.label) === letter));
}
function titleOnlyCandidate(context: Context, event: PreparedEvent, checkedAt: string) {
  if (event.studentIds.length || context.allowed !== null || context.strong || !pureSharedParticipants(event)) return [];
  const name = wecomHandoverScheduleTitleName(event.raw.courseName);
  if (!name || !realName(name, context.source.wechatName) || context.explicitNames.some((value) => value !== nameKey(name))) return [];
  return [scheduleCandidate(event, { id: null, name }, checkedAt)];
}
function eventCandidates(context: Context, event: PreparedEvent, scope: CandidateScope) {
  if (!event.studentIds.length) return titleOnlyCandidate(context, event, scope.checkedAt);
  return event.studentIds.filter((id) => candidateStudentAllowed(context, id, scope.students))
    .map((id) => scheduleCandidate(event, scope.students.find((student) => student.id === id)!, scope.checkedAt));
}
function compareCandidates(left: WecomHandoverScheduleCandidate, right: WecomHandoverScheduleCandidate) {
  return left.schedule.startsAt.localeCompare(right.schedule.startsAt) || left.schedule.eventId.localeCompare(right.schedule.eventId) || (left.studentId ?? "").localeCompare(right.studentId ?? "");
}
function sourceCandidates(context: Context, scope: CandidateScope) {
  const available = scope.events.filter((event) => !scope.occupied.has(event.raw.eventId));
  const candidateEvents = context.conflict ? [] : available.filter((event) => !event.unsafe && eligible(context, event));
  const candidates = candidateEvents.flatMap((event) => eventCandidates(context, event, scope)).sort(compareCandidates);
  const unsafe = !context.conflict && available.some((event) => event.unsafe && uncertainEventContention(context, event, scope.students));
  const reservations = context.conflict || context.schedulingConflict
    ? available.filter((event) => conflictedContention(context, event)).map((event) => event.raw.eventId) : [];
  return { context, candidates, unsafe, reservations };
}
function candidateCompetition(entries: readonly SourceCandidates[]) {
  const competition = new Map<string, number>();
  for (const entry of entries) {
    for (const id of unique([...entry.candidates.map((candidate) => candidate.schedule.eventId), ...entry.reservations])) competition.set(id, (competition.get(id) ?? 0) + 1);
  }
  return competition;
}
function sourceLpItem(context: Context) {
  if (context.conflict || !context.strong) return [];
  return [{ id: context.source.sourceMessageId, studentId: context.strong, workflowType: context.draft.workflowType ?? undefined, requestedAt: new Date(context.lower + DAY).toISOString(), fields: { assignedTeacher: context.draft.fields.assignedTeacher, newTeacher: context.draft.fields.newTeacher } }];
}
function provenSourceMatches(contexts: readonly Context[], scope: CandidateScope, authority: Authority) {
  return matchTrialScheduleEvents({ lpItems: contexts.flatMap(sourceLpItem), students: authority.studentArguments, teachers: authority.teacherArguments,
    events: scope.events.filter((event) => !event.unsafe && !scope.occupied.has(event.raw.eventId)).map((event) => event.event), matchedAt: scope.checkedAt });
}
function sourceSelection(entry: SourceCandidates, scope: EvidenceScope) {
  const candidate = entry.candidates.length === 1 ? entry.candidates[0]! : null;
  return {
    candidate, event: candidate ? scope.events.find((event) => event.raw.eventId === candidate.schedule.eventId) : null,
    competing: candidate ? (scope.competition.get(candidate.schedule.eventId) ?? 0) > 1 : false,
    complete: covered(entry.context.lower, entry.context.upper, scope.coverage, scope.now),
  };
}
function futureUniqueEvent(context: Context, event: PreparedEvent, now: number) {
  return !event.raw.historical && Date.parse(event.raw.startsAt) >= now && event.studentIds.length === 1 && !context.teacher.alias && !event.teacher.alias;
}
function selectionProofSafe(entry: SourceCandidates, selection: Selection) {
  return !entry.unsafe && selection.complete && !selection.competing;
}
function automaticMatch(entry: SourceCandidates, selection: Selection, scope: EvidenceScope) {
  const { candidate, event } = selection;
  if (!candidate || !candidate.studentId || !event) return false;
  if (entry.context.strong !== candidate.studentId || !futureUniqueEvent(entry.context, event, scope.now)) return false;
  if (!selectionProofSafe(entry, selection)) return false;
  return scope.proven.some((match) => match.lpItemId === entry.context.source.sourceMessageId && match.link.eventId === candidate.schedule.eventId);
}
function ambiguousEvidence(entry: SourceCandidates, selection: Selection) {
  return entry.context.schedulingConflict || entry.unsafe || entry.candidates.length > 1 || selection.competing;
}
function evidenceStatus(entry: SourceCandidates, selection: Selection, automatic: boolean): WecomHandoverScheduleEvidence["status"] {
  if (entry.context.conflict) return "identity_conflict";
  if (ambiguousEvidence(entry, selection)) return "ambiguous";
  if (automatic) return "matched";
  if (entry.candidates.length) return "candidate";
  if (!selection.complete) return "outside_window";
  return entry.context.strong ? "no_match" : "needs_identity";
}
function sourceEvidence(entry: SourceCandidates, scope: EvidenceScope): WecomHandoverScheduleEvidence {
  const selection = sourceSelection(entry, scope);
  const automatic = automaticMatch(entry, selection, scope);
  return { algorithmVersion: WECOM_HANDOVER_SCHEDULE_ALGORITHM_VERSION, sourceMessageId: entry.context.source.sourceMessageId, sourceRevision: entry.context.source.sourceRevision, snapshotRevision: scope.snapshotRevision, checkedAt: scope.checkedAt,
    status: evidenceStatus(entry, selection, automatic), matchedStudentId: automatic ? selection.candidate!.studentId : null, candidates: entry.candidates.slice(0, MAX_CANDIDATES) };
}
export function prepareWecomHandoverScheduleProjection(input: WecomHandoverScheduleInput): readonly WecomHandoverScheduleEvidence[] {
  assertTargets(input);
  const clock = projectionClock(input);
  const authority = projectionAuthority(input.rows);
  const contexts = input.sources.map((source) => sourceContext(source, authority.students, authority.teachers))
    .filter((context) => context.draft.workflowType === "试听 LP" || context.draft.workflowType === "换老师试听");
  const events = projectionEvents(input, authority, clock.now);
  const occupied = occupiedEvents(events, authority, clock.checkedAt);
  const candidateScope = { students: authority.students, events, occupied, checkedAt: clock.checkedAt };
  const entries = contexts.map((context) => sourceCandidates(context, candidateScope));
  const scope = { ...candidateScope, ...clock, snapshotRevision: input.snapshotRevision, coverage: input.coverage,
    competition: candidateCompetition(entries), proven: provenSourceMatches(contexts, candidateScope, authority) };
  const evidence = new Map(entries.map((entry) => [entry.context.source.sourceMessageId, sourceEvidence(entry, scope)]));
  return input.targetSourceMessageIds.map((id): WecomHandoverScheduleEvidence => {
    const entry = evidence.get(id);
    if (entry) return entry;
    const source = input.sources.find((source) => source.sourceMessageId === id)!;
    return { algorithmVersion: WECOM_HANDOVER_SCHEDULE_ALGORITHM_VERSION, sourceMessageId: id, sourceRevision: source.sourceRevision,
      snapshotRevision: input.snapshotRevision, checkedAt: clock.checkedAt,
      status: ["identity_conflict", "identity_ambiguous"].includes(source.status) ? "identity_conflict" : "ambiguous", matchedStudentId: null, candidates: [] };
  });
}
