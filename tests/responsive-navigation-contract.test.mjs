import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end >= 0, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("keeps the 900px workspace inside the viewport instead of restoring the 1120px page minimum", async () => {
  const css = await read("../app/globals.css");
  const compactRail = section(
    css,
    "@media (max-width:1119px)",
    "@media (min-width:761px) and (max-width:1023px)",
  );
  const tabletRail = section(
    css,
    "@media (min-width:761px) and (max-width:1023px)",
    "@media (min-width:761px) and (max-width:1119px)",
  );

  // At 900px both blocks apply. Keep the assertion adjacent to the old
  // desktop minimum so a future breakpoint change cannot silently re-enable
  // full-page horizontal overflow.
  assert.match(compactRail, /body\s*\{\s*min-width:0;\s*\}/);
  assert.match(compactRail, /\.main-stage\s*\{\s*min-width:0;\s*\}/);
  assert.match(tabletRail, /\.app-shell\s*\{\s*grid-template-columns:80px minmax\(0,1fr\);\s*\}/);
  assert.match(css, /body\s*\{[^}]*min-width:1120px/);
  assert.match(css, /\.app-shell\s*\{[^}]*grid-template-columns:236px minmax\(0,1fr\)/);
});

test("reveals the main-content skip link for keyboard focus", async () => {
  const [client, css] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/globals.css"),
  ]);

  assert.match(client, /className="skip-link" href="#main-content"/);
  assert.match(client, /<main className="content" id="main-content" tabIndex=\{-1\}>/);
  assert.match(css, /\.skip-link:focus,\s*\.skip-link:focus-visible\s*\{\s*transform:translateY\(0\);\s*\}/);
});

test("lets desktop operators collapse the sidebar to an accessible icon rail", async () => {
  const [client, css] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/globals.css"),
  ]);

  assert.match(client, /const SIDEBAR_COLLAPSED_STORAGE_KEY = "yinling\.sidebar-collapsed"/);
  assert.match(client, /const \[sidebarCollapsed, setSidebarCollapsed\] = useState\(false\)/);
  assert.match(client, /window\.localStorage\.getItem\(SIDEBAR_COLLAPSED_STORAGE_KEY\)/);
  assert.match(client, /window\.localStorage\.setItem\(SIDEBAR_COLLAPSED_STORAGE_KEY, String\(sidebarCollapsed\)\)/);
  assert.match(client, /className=\{`app-shell\$\{sidebarCollapsed \? " sidebar-collapsed" : ""\}`\}/);
  assert.match(client, /className="sidebar-toggle" data-sidebar-toggle[\s\S]*aria-label=\{sidebarToggleLabel\}[\s\S]*aria-pressed=\{sidebarCollapsed\}/);
  assert.match(client, /sidebarCollapsed \? <ChevronRight size=\{17\} \/> : <ChevronLeft size=\{17\} \/>/);
  assert.match(client, /<nav id="primary-navigation" aria-label="主要导航">/);

  const desktopRail = section(css, "@media (min-width:1024px)", "@media (prefers-reduced-transparency:reduce)");
  assert.match(desktopRail, /\.app-shell\.sidebar-collapsed\s*\{\s*grid-template-columns:80px minmax\(0,1fr\);/);
  assert.match(desktopRail, /\.sidebar\.sidebar-collapsed \.brand > div,[\s\S]*\.sidebar\.sidebar-collapsed \.nav-item > b \{ display:none; \}/);
  assert.match(desktopRail, /\.sidebar\.sidebar-collapsed \.nav-item\s*\{\s*justify-content:center;[\s\S]*width:48px;/);
  assert.doesNotMatch(client, /className="workspace-switch"/);
  assert.doesNotMatch(client, /className="new-button"/);
});

test("keeps a long collapsed sidebar inside its full-height green rail", async () => {
  const css = await read("../app/globals.css");
  const railScroll = section(
    css,
    "@media (min-width:761px) {\n  .sidebar { height:100dvh; min-height:100dvh; }",
    "@media (prefers-reduced-transparency:reduce)",
  );

  assert.match(railScroll, /\.sidebar\s*\{\s*height:100dvh; min-height:100dvh;\s*\}/);
  assert.match(railScroll, /\.sidebar nav\s*\{\s*-ms-overflow-style:none; flex:1 1 auto; min-height:0; overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain; scrollbar-width:none;\s*\}/);
  assert.match(railScroll, /\.sidebar nav::\-webkit-scrollbar\s*\{\s*height:0; width:0;\s*\}/);
  assert.doesNotMatch(css, /\.sidebar\.sidebar-collapsed nav\s*\{\s*overflow:visible;/);
  assert.doesNotMatch(css, /\.sidebar nav\s*\{\s*overflow:visible;/);
});

test("turns dense exam and renewal rows into compact cards before the action column clips", async () => {
  const css = await read("../app/globals.css");
  const tabletRail = section(
    css,
    "@media (min-width:761px) and (max-width:1023px)",
    "@media (min-width:761px) and (max-width:1119px)",
  );

  assert.match(tabletRail, /\.exam-collection \.collection-head,\s*\.renewal-collection \.collection-head\s*\{\s*display:none;\s*\}/);
  assert.match(tabletRail, /\.exam-collection \.collection-row\.exam-grid-row,[\s\S]*grid-template-columns:minmax\(0,1fr\) auto;/);
  assert.match(tabletRail, /\.renewal-collection \.collection-row\.renewal-grid-row\s*> \.row-primary[\s\S]*grid-column:1 \/ -1;/);
  assert.match(tabletRail, /\.exam-collection \.exam-row-actions,[\s\S]*grid-column:2;/);
});

test("keeps long mobile saved-view strips scrollable inside their panel", async () => {
  const css = await read("../app/globals.css");

  assert.match(css, /Keep long saved-view strips inside their panel/);
  assert.match(css, /\.view-tabs\s*\{[\s\S]*max-width:100%;[\s\S]*min-width:0;[\s\S]*overflow-x:auto;[\s\S]*width:100%;/);
  assert.match(css, /\.view-bar\s*> \.view-tabs,[\s\S]*\.collection-shell\s*> \.view-tabs,[\s\S]*\.exam-toolbar\s*> \.view-tabs\s*\{\s*flex:1 1 100%;\s*\}/);
});

test("keeps mobile To Do filters on one readable horizontal strip", async () => {
  const css = await read("../app/globals.css");
  const mobileTasks = section(
    css,
    "@media (max-width:720px) {",
    ".timeline-item .inline-link",
  );

  assert.match(mobileTasks, /\.to-do-filters\s*\{[^}]*flex-wrap:nowrap;[^}]*overflow-x:auto;/);
  assert.match(mobileTasks, /\.to-do-filters button\s*\{\s*flex:0 0 auto; white-space:nowrap;\s*\}/);
  assert.match(css, /\.dashboard-grid > \*\s*\{\s*min-width:0;\s*\}/);
});

test("keeps student status and next-step content in the columns that actually render", async () => {
  const css = await read("../app/globals.css");

  assert.match(css, /\.student-grid\s*\{\s*grid-template-columns:22px minmax\(200px,1\.2fr\) minmax\(150px,\.85fr\) minmax\(130px,\.95fr\);\s*\}/);
  assert.match(css, /\.student-grid \.row-cell\s*\{\s*overflow:hidden;\s*\}/);
  assert.match(css, /\.student-grid \.row-cell > \.status-pill\s*\{[^}]*text-overflow:ellipsis;/);
  assert.match(css, /\.student-grid > \.row-cell:nth-of-type\(3\)\s*\{\s*grid-column:2 \/ 4;\s*grid-row:3;\s*padding-top:3px;\s*\}/);
  assert.doesNotMatch(css, /content:"负责人 · "/);
  assert.doesNotMatch(css, /\.student-grid > \.row-cell:nth-of-type\(4\)/);
});

test("keeps mobile classroom status visible and empty LP stages compact", async () => {
  const css = await read("../app/globals.css");

  assert.match(css, /\.kanban-board > article\s*\{\s*min-height:44px;\s*min-width:0;/);
  assert.match(css, /\.classroom-room-list \.collection-row\.classroom-grid-row\s*\{[\s\S]*grid-template-columns:minmax\(0,1fr\) auto;[\s\S]*min-width:0;/);
  assert.match(css, /\.classroom-room-list \.collection-row\.classroom-grid-row > span:nth-child\(2\)\s*\{\s*grid-column:1;/);
  assert.match(css, /\.classroom-room-list \.collection-row\.classroom-grid-row > \.status-pill\s*\{[\s\S]*grid-column:2;[\s\S]*grid-row:1 \/ span 2;/);
});

test("keeps phone overlays from summoning the keyboard and preserves 44px touch targets", async () => {
  const [client, css] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/globals.css"),
  ]);

  assert.doesNotMatch(client, /\bautoFocus\b/);
  assert.match(client, /data-dialog-autofocus="true"/);
  assert.match(client, /matchMedia\("\(min-width: 761px\) and \(pointer: fine\)"\)/);
  assert.match(client, /surface\.querySelector<HTMLElement>\("\[data-dialog-autofocus='true'\]"\)/);
  assert.match(client, /name="global-search"[\s\S]*autoComplete="off"/);
  assert.match(client, /name="list-search"[\s\S]*autoComplete="off"/);
  assert.match(css, /:where\(button, a\[href\], input, select, textarea, summary, \[role="button"\]\)\s*\{\s*touch-action:manipulation;/);
  assert.match(css, /\.student-grid > \.row-primary,[\s\S]*\.student-grid > \.row-cell\s*\{\s*min-height:44px;/);
  assert.match(css, /\.lp-card-actions,[\s\S]*grid-template-columns:44px minmax\(0,1fr\) 44px 44px;/);
  assert.match(css, /\.lp-result-select,[\s\S]*\.lp-row-actions \.icon-button\s*\{[\s\S]*min-height:44px;/);
});

test("keeps hidden source file inputs from widening the sync page", async () => {
  const css = await read("../app/globals.css");

  // Source-ingest cards apply width:100% to their inputs. The accessibility
  // utility must win that cascade so clipped file inputs cannot extend the
  // document beyond desktop, tablet, or mobile viewports.
  assert.match(css, /\.visually-hidden\s*\{[^}]*height:1px !important;[^}]*width:1px !important;/);
});

test("uses the complete role-scoped navigation in the 375px More drawer", async () => {
  const [client, css] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/globals.css"),
  ]);
  const definitions = section(
    client,
    "const navigationDefinitions:",
    "function navigationFor",
  );
  const navigationIds = [...definitions.matchAll(/\bid: "([^"]+)"/g)].map((match) => match[1]);
  assert.equal(navigationIds.length, 17);
  assert.deepEqual(navigationIds, [
    "dashboard",
    "students",
    "teachers",
    "schedule",
    "classroom",
    "courses",
    "lp",
    "operations",
    "renewals",
    "payroll",
    "messages",
    "files",
    "sync",
    "reports",
    "settings",
    "accounts",
    "audit",
  ]);

  const mobileDrawer = section(
    client,
    '<div className="mobile-nav-grid">',
    '          <button className="mobile-preferences-button"',
  );
  const bottomNavigation = section(
    client,
    '<nav className="mobile-bottom-nav"',
    '<div className="mobile-nav-backdrop"',
  );
  assert.match(client, /const visibleNavigation = useMemo\(\(\) => isAdminView/);
  assert.match(client, /const visibleMobileNavigation = useMemo\(\(\) => visibleNavigation\.filter/);
  assert.match(bottomNavigation, /visibleMobileNavigation\.map/);
  assert.match(bottomNavigation, /MoreHorizontal/);
  assert.match(mobileDrawer, /visibleNavigation\.map/);
  assert.doesNotMatch(mobileDrawer, /visibleMobileNavigation/);
  assert.match(mobileDrawer, /navigateMobile\(item\.id\)/);
  assert.match(client, /const navigateMobile = \(section: Section\) => \{\s*setActive\(section\);\s*setMobileMenuOpen\(false\)/);

  const mobileCss = section(
    css,
    "@media (max-width:760px)",
    "@keyframes mobile-sheet-enter",
  );
  assert.match(mobileCss, /\.mobile-nav-drawer\s*\{[\s\S]*max-height:88dvh;[\s\S]*overflow-y:auto;/);
  assert.match(mobileCss, /\.mobile-nav-drawer\s*>\s*header\s*\{[\s\S]*position:sticky;[\s\S]*top:0;[\s\S]*z-index:2;/);
  assert.match(mobileCss, /\.mobile-operator-picker\s*\{[\s\S]*display:grid;[\s\S]*grid-template-columns:minmax\(0,1fr\);/);
  assert.match(mobileCss, /\.mobile-operator-picker select\s*\{[\s\S]*min-width:0;[\s\S]*width:100%;/);
});

test("keeps every navigation definition wired to a renderView branch", async () => {
  const client = await read("../app/operations-client.tsx");
  const definitions = section(
    client,
    "const navigationDefinitions:",
    "function navigationFor",
  );
  const navigationIds = [...definitions.matchAll(/\bid: "([^"]+)"/g)].map((match) => match[1]);
  const renderView = section(client, "const renderView = () => {", "const removeStudentCreationPending");
  const renderBranches = [...renderView.matchAll(/case "([^"]+)":\s*return\s+(render\w+)\(\);/g)]
    .map((match) => ({ id: match[1], renderer: match[2] }));

  assert.equal(renderBranches.length, navigationIds.length);
  assert.deepEqual(renderBranches.map(({ id }) => id), navigationIds);
  for (const { id, renderer } of renderBranches) {
    assert.match(renderView, new RegExp(`case "${id}":\\s*return ${renderer}\\(\\);`));
  }
});

test("keeps page navigation and classroom/API boundaries aligned for every signed role", async () => {
  const [client, classroom, appState] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/api/classroom/route.ts"),
    read("../app/api/app-state/route.ts"),
  ]);
  const sectionIds = (name) => {
    const match = client.match(new RegExp(`const ${name} = new Set<Section>\\(\\[([^\\]]+)\\]`));
    assert.ok(match, `missing ${name}`);
    return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
  };

  assert.deepEqual(sectionIds("staffSectionIds"), [
    "dashboard", "students", "teachers", "schedule", "courses", "lp", "operations", "renewals", "messages", "files", "accounts",
  ]);
  assert.deepEqual(sectionIds("teacherSectionIds"), ["dashboard", "students", "schedule", "classroom", "accounts"]);
  assert.doesNotMatch(client, /staffSectionIds = new Set<Section>\([^)]*"classroom"/s);
  assert.doesNotMatch(client, /teacherSectionIds = new Set<Section>\([^)]*"payroll"/s);
  assert.match(client, /const noPayrollAdminSectionIds = new Set<Section>\(navigationDefinitions\.filter\(\(item\) => item\.id !== "payroll"\)/);
  assert.match(client, /const canViewPayroll = isFullAdminSession && currentOperator === "Nixon"/);
  assert.match(client, /const isAdminView = canUseAdminScope && \(currentOperator === "Nixon" \|\| currentOperator === DEMO_LIMITED_ADMIN_USER\)/);

  // A same-name roster teacher must not promote a signed staff session. Both
  // desktop and mobile are expected to consume this one visible list.
  assert.match(client, /const isTeacherView = teacherOperatorNames\.has\(currentOperator\) && \(initialRole === "teacher" \|\| canUseAdminScope\)/);
  assert.match(client, /const canViewClassroom = isAdminView \|\| isTeacherView/);
  assert.match(client, /const canJoinTeacherClassroom = initialRole === "teacher" && isTeacherView/);
  assert.match(client, /const visibleNavigation = useMemo\(\(\) => isAdminView/);
  assert.match(client, /visibleMobileNavigation = useMemo\(\(\) => visibleNavigation\.filter/);
  assert.match(client, /<div className="mobile-nav-grid">[\s\S]*visibleNavigation\.map/);
  const renderView = section(client, "const renderView = () => {", "const removeStudentCreationPending");
  assert.match(renderView, /if \(!canViewPayroll && active === "payroll"\) return renderDashboard\(\);/);
  assert.match(renderView, /!isAdminView[\s\S]*teacherSectionIds : staffSectionIds/);

  // Staff schedule pages must not expose a classroom action that can bounce
  // into the protected classroom route; admins/teachers retain the controls.
  assert.match(client, /canViewClassroom \? \(historicalBooking \?/);
  assert.doesNotMatch(client, /openCourseSource|courseSourceExpanded/);
  assert.match(classroom, /session\.role !== "admin" && session\.role !== "limited-admin" && session\.role !== "teacher"/);
  assert.match(classroom, /session\.role === "admin"[\s\S]*hasValidNixonSession/);
  assert.match(classroom, /canWriteBookings: canWriteOpsEntity\(access, "bookings"\)/);
  assert.match(classroom, /if \(!context\.canWriteBookings\) return noStore/);
  assert.match(appState, /if \(entities\?\.some\(\(entity\) => !canReadOpsEntity\(access, entity\)\)\)/);
  assert.match(appState, /if \(body\.entity === "audit"\) return noStore\([\s\S]*403\)/);
  assert.match(appState, /!canReadUnrestrictedOpsData\(access\)/);
});

test("collapses messages/files before the 1210px rail and scrolls their own lists", async () => {
  const [client, css] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/globals.css"),
  ]);
  const max1210 = section(css, "@media (max-width:1210px)", "/* Design engineering polish");
  const desktopMax1210 = section(
    css,
    "@media (min-width:761px) and (max-width:1210px)",
    "@media (min-width:761px) and (max-width:1399px)",
  );
  const messages = section(client, "const renderMessages = () =>", "const renderFiles = () =>");
  const files = section(client, "const renderFiles = () =>", "const renderSync = () =>");

  assert.match(max1210, /\.message-layout[^}]*grid-template-columns:1fr/);
  assert.match(desktopMax1210, /\.message-layout[\s\S]*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(client, /<div className="master-detail-layout message-layout">/);
  assert.match(messages, /className="collection-viewport message-list"/);
  assert.match(files, /className="collection-viewport"/);
  assert.match(css, /\.collection-viewport\s*\{[^}]*overflow:auto;/);
  assert.match(max1210, /\.collection-viewport\s*\{\s*height:420px;\s*\}/);
  assert.match(css, /\.message-list\s*\{[^}]*min-width:0;/);
  assert.match(css, /\.collection-main\s*\{[^}]*min-width:0;/);
});
