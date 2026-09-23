import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientUrl = new URL("../app/operations-client.tsx", import.meta.url);

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end >= 0, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("an authoritative empty snapshot never falls back to sample students or teachers", async () => {
  const client = await readFile(clientUrl, "utf8");
  const defaults = between(client, "function buildRuntimeDefaults", "const initialTasks");
  const loader = between(client, "  useEffect(() => {\n    if (sessionMustChangePassword) return;", "  const logoutFromPasswordChange");

  assert.match(defaults, /const hasImportedPayload = importPayload !== undefined/);
  assert.doesNotMatch(defaults, /hasRealData|Boolean\(realStudents\.length \|\| realTeachers\.length\)/);
  assert.match(defaults, /defaultStudents: hasImportedPayload \? realStudents : initialStudents/);
  assert.match(defaults, /defaultTeachers: hasImportedPayload \? realTeachers : initialTeachers/);
  assert.match(defaults, /defaultTasks: hasImportedPayload \? importPayload\?\.tasks \?\? \[\] : initialTasks/);
  assert.match(defaults, /defaultSelectedStudentId: hasImportedPayload \? realStudents\[0\]\?\.id \?\? "" : "STU-0248"/);
  assert.match(defaults, /defaultSelectedTeacherId: hasImportedPayload \? realTeachers\[0\]\?\.id \?\? "" : "TEA-011"/);
  assert.match(defaults, /label: "Supabase 真实资料快照"/);

  assert.doesNotMatch(loader, /hasRows|当前账号未授权读取真实资料/);
  assert.match(loader, /setDataError\(""\)/);
  assert.match(loader, /setInitialData\(payload\)/);
});

test("student name ordering is real, directional, and shared by pagination navigation", async () => {
  const client = await readFile(clientUrl, "utf8");
  const collection = between(client, "  const studentListSource", "  const teacherSubjectMatch");
  const navigation = between(client, "  const goToStudent", "  const openStudentPreview");
  const toolbar = client.slice(client.indexOf('<ListToolbar query={search}'), client.indexOf("</ListToolbar>", client.indexOf('<ListToolbar query={search}')));

  assert.match(client, /const \[studentNameSort, setStudentNameSort\] = useState<StudentNameSortDirection>\("asc"\)/);
  assert.match(collection, /sortStudentsByName\(studentListSource\.filter/);
  assert.match(collection, /studentNameSort\)/);
  assert.match(navigation, /sortStudentsByName\(targetList, studentNameSort\)/);
  assert.match(toolbar, /setStudentNameSort\(\(current\) => current === "asc" \? "desc" : "asc"\)/);
  assert.match(toolbar, /姓名排序：\$\{studentNameSort === "asc" \? "升序" : "降序"\}/);
  assert.match(toolbar, /aria-pressed=\{studentNameSort === "desc"\}/);
  assert.doesNotMatch(toolbar, /notify\(/);
});

test("messages and files expose prerequisites instead of dead unassociated forms", async () => {
  const client = await readFile(clientUrl, "utf8");
  const messagesAndFiles = between(client, "  const hasScopedActiveStudentRecords", "  const renderSync");
  const recordMessage = between(client, "  const recordMessage", "  const resetDemo");

  assert.match(messagesAndFiles, /scopedActiveStudents\.length > 0/);
  assert.match(messagesAndFiles, /先新建学生/);
  assert.match(messagesAndFiles, /去同步与导入/);
  assert.match(messagesAndFiles, /必须关联当前范围的活跃学生/);
  assert.match(messagesAndFiles, /系统不会保存未关联记录/);
  assert.match(messagesAndFiles, /hasScopedActiveStudentRecords[\s\S]*setModal\("template"\)/);
  assert.match(messagesAndFiles, /hasScopedActiveStudentRecords && !isTeacherView[\s\S]*setModal\("file"\)/);
  assert.match(client, /modal === "file" && hasScopedActiveStudentRecords && !isTeacherView/);
  assert.match(client, /modal === "template" && hasScopedActiveStudentRecords/);
  assert.match(recordMessage, /scopedActiveStudentIds\.has\(message\.studentId\)/);

  const lessonPackage = between(client, '{modal === "lessonPackage"', '{modal === "exam"');
  const [form, service] = await Promise.all([
    readFile(new URL("../app/lesson-package-purchase-form.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/lesson-package-purchase-service.ts", import.meta.url), "utf8"),
  ]);
  assert.match(lessonPackage, /studentModalTargetStudent && studentModalTargetIsValid/);
  assert.match(lessonPackage, /<LessonPackagePurchaseForm key=\{`\$\{sessionOperator\}:\$\{studentModalTargetStudent\.id\}`\} actor=\{sessionOperator\} studentId=\{studentModalTargetStudent\.id\}/);
  assert.match(form, /if \(command\.studentId !== studentId\) throw new Error/);
  assert.match(service, /!access\.teacher && canWriteOpsEntity\(access, "students"\) && canOperateStudent\(access, command\.studentId\)/);
  assert.match(service, /students\.filter\(\(student\) => student\.id === command\.studentId\)/);
  assert.match(service, /if \(matches\.length !== 1\) throw new LessonPackageCommandError/);
  const commit = service.slice(service.indexOf("export async function commitLessonPackagePurchase"));
  const authorizeIndex = commit.indexOf("if (!mayWrite)");
  const prepareIndex = commit.indexOf("prepared = prepareLessonPackagePurchase");
  assert.ok(authorizeIndex >= 0 && prepareIndex > authorizeIndex, "authorization must precede target validation");
  assert.match(commit.slice(authorizeIndex, prepareIndex), /if \(purchaseReceipt\(current\.payload, command, actor\) === "match"\) return \{\s*committed: true, applied: false, commandKey: command\.commandKey, studentRow: undefined,[\s\S]*throw new LessonPackageCommandError\([^\n]*"scope_forbidden"\)/);
});

test("global search restores focus to the exact trigger after every close path", async () => {
  const client = await readFile(clientUrl, "utf8");
  const focusHelpers = between(client, "  const openGlobalSearch", "  useEffect(() => {\n    // eslint-disable-next-line react-hooks/set-state-in-effect");
  const searchDialog = between(client, "      {globalSearchOpen &&", "      {modal === \"student\"");

  assert.match(focusHelpers, /activeOrigin\.setAttribute\("data-global-search-origin", "true"\)/);
  assert.match(focusHelpers, /activeOrigin\.setAttribute\("data-global-search-origin-signature", globalSearchOriginSignature\(activeOrigin\)\)/);
  assert.match(focusHelpers, /querySelector<HTMLElement>\("\[data-global-search-origin='true'\]"\)/);
  assert.match(focusHelpers, /markedOrigin\?\.isConnected/);
  assert.match(focusHelpers, /isCurrentGlobalSearchOrigin\(markedOrigin\)/);
  assert.match(focusHelpers, /markedOrigin\.focus\(\{ preventScroll: true \}\)/);
  assert.match(focusHelpers, /clearGlobalSearchOriginMarker\(markedOrigin\)/);
  assert.match(focusHelpers, /const visibleTrigger = Array\.from\(document\.querySelectorAll<HTMLElement>\("\[data-global-search-trigger\]"\)\)/);
  assert.match(focusHelpers, /!element\.closest\("\.global-search-dialog"\)/);
  assert.match(focusHelpers, /#main-content h1/);
  assert.match(focusHelpers, /flushSync\(\(\) => \{[\s\S]*transition\?\.\(\);[\s\S]*setGlobalSearchOpen\(false\);[\s\S]*\}\);[\s\S]*restoreFocus\(\)/);
  assert.doesNotMatch(focusHelpers, /requestAnimationFrame\(restoreFocus\)/);
  assert.match(client, /const focusOrigin = globalSearchOpen[\s\S]*\[data-global-search-origin='true'\]/);
  assert.match(client, /useLayoutEffect\(\(\) => \{\s*const overlayOpen/);
  assert.match(client, /inertTargets\.forEach\(\(target\) => \{ target\.inert = false; \}\);[\s\S]*isCurrentGlobalSearchOrigin\(focusOrigin\)[\s\S]*focusOrigin\.focus/);
  assert.match(client, /data-global-search-trigger onClick=\{\(event\) => openGlobalSearch\(event\.currentTarget\)\}/);
  assert.match(client, /if \(globalSearchOpen\) \{ closeGlobalSearch\(\); return; \}/);
  assert.match(searchDialog, /onMouseDown=\{\(\) => closeGlobalSearch\(\)\}/);
  assert.match(searchDialog, /label="关闭搜索" onClick=\{\(\) => closeGlobalSearch\(\)\}/);
  assert.match(searchDialog, /closeGlobalSearch\(\(\) => setActive\("schedule"\)\)/);
  assert.doesNotMatch(searchDialog, /setGlobalSearchOpen\(false\)/);
});

test("ordinary dialogs restore focus to the exact launcher after Escape or close", async () => {
  const client = await readFile(clientUrl, "utf8");
  const modalState = between(client, "  const [modal, setModal]", "  // Student-specific dialogs");
  const focusMemory = between(client, "  useEffect(() => {\n    const focusableOriginSelector", "  const openGlobalSearch");
  const overlay = between(client, "  useLayoutEffect(() => {\n    const overlayOpen", "  useEffect(() => {\n    if (!operatorMenuOpen)");

  assert.match(modalState, /overlayFocusOriginRef/);
  assert.match(focusMemory, /button:not\(:disabled\)[\s\S]*\[tabindex\]:not\(\[tabindex='-1'\]\)/);
  assert.match(focusMemory, /target\.closest<HTMLElement>\(focusableOriginSelector\)/);
  assert.match(focusMemory, /document\.addEventListener\("focusin", rememberPageOrigin, true\)/);
  assert.match(focusMemory, /document\.addEventListener\("click", rememberPageOrigin, true\)/);
  assert.match(focusMemory, /document\.removeEventListener\("click", rememberPageOrigin, true\)/);
  assert.match(focusMemory, /element\.closest\("\[aria-modal='true'\]"\)/);
  assert.match(focusMemory, /signature: globalSearchOriginSignature\(element\)/);
  assert.match(overlay, /const overlayFocusOrigin = globalSearchOpen \? null : overlayFocusOriginRef\.current/);
  assert.match(overlay, /overlayFocusOrigin\?\.element/);
  assert.match(overlay, /overlayFocusOrigin\.signature === globalSearchOriginSignature\(overlayFocusOrigin\.element\)/);
  assert.match(overlay, /document\.querySelector\("\[aria-modal='true'\]"\)/);
  assert.match(overlay, /queueMicrotask\(restoreFocus\)/);
  assert.match(overlay, /element !== document\.body/);
  assert.match(overlay, /document\.querySelector<HTMLElement>\("#main-content"\)/);
  assert.match(overlay, /if \(isRestorableFocusOrigin\(mainContent\)\) mainContent\.focus/);
  assert.match(overlay, /if \(!surface\.contains\(document\.activeElement\)\)[\s\S]*\(event\.shiftKey \? last : first\)\.focus/);
  assert.match(overlay, /focusOrigin\.focus\(\{ preventScroll: true \}\)/);
});

test("student-specific dialogs stay bound to their exact target and fail closed on scope drift", async () => {
  const client = await readFile(clientUrl, "utf8");
  const studentModalSection = between(client, "type StudentBoundModalKind", "  const refreshTeacherAvailabilitySubmissions");
  const studentWrites = between(client, "  const submitStudentEdit", "  const submitTask");

  assert.match(studentModalSection, /studentModalTargetId/);
  assert.match(studentModalSection, /studentModalTargetWasArchived/);
  assert.match(studentModalSection, /const openStudentBoundModal = \(nextModal: StudentBoundModalKind, studentId: string\)/);
  assert.match(studentModalSection, /setStudentModalTargetId\(target\.id\)/);
  assert.match(studentModalSection, /setStudentModalTargetWasArchived\(target\.importArchived === true\)/);
  assert.match(studentModalSection, /const studentModalTargetIsValid = Boolean\(studentModalTargetStudent\)/);
  assert.match(studentModalSection, /studentModalTargetIsValid/);
  assert.match(studentModalSection, /closeInvalidStudentModal\(\)/);
  assert.match(studentModalSection, /学生资料已变化，请重新打开/);
  assert.match(studentModalSection, /modal !== "studentRecords"/);
  assert.match(studentModalSection, /scopedActiveStudentIds\.has\(target\.id\)/);

  for (const modal of ["studentEdit", "studentEvidence", "studentReport", "studentRecords", "studentFollowUp", "lessonPackage", "exam"]) {
    assert.match(client, new RegExp(`modal === "${modal}" && studentModalTargetStudent`), `modal ${modal} must render only with its bound target`);
  }
  assert.match(studentWrites, /const target = requireStudentModalTarget\(true\)/);
  assert.match(studentWrites, /student\.id === target\.id/);
  assert.match(studentWrites, /studentId: target\.id/);
  assert.match(client, /openStudentBoundModal\("studentRecords", studentId\)/);
  assert.match(client, /openStudentBoundModal\("studentEdit", visibleSelectedStudent\.id\)/);
  assert.match(client, /openStudentBoundModal\("studentEvidence", visibleSelectedStudent\.id\)/);
  assert.doesNotMatch(client, /setModal\("studentEdit"\)/);
  assert.doesNotMatch(client, /setModal\("studentEvidence"\)/);
  assert.doesNotMatch(client, /setModal\("studentRecords"\)/);
  assert.doesNotMatch(client, /setModal\("studentReport"\)/);
  assert.doesNotMatch(client, /setModal\("studentFollowUp"\)/);
  assert.doesNotMatch(client, /setModal\("lessonPackage"\)/);
  assert.doesNotMatch(client, /setModal\("exam"\)/);
});
