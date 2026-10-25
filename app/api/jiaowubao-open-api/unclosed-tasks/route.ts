import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { DEMO_COOKIE_NAME, getCurrentDemoSession, type DemoSessionIdentity } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { buildOpsAccessContext, canAccessStudent, canReadOpsEntity } from "@/lib/ops-access";
import { getOpsState, readJiaowubaoUnclosedSnapshot } from "@/lib/ops-store";
import { unclosedLessonOwners, unclosedTask, type UnclosedLesson, type UnclosedStateRecord } from "@/lib/jiaowubao-unclosed-lessons";

export const dynamic = "force-dynamic";
type TaskIdentity = { session: DemoSessionIdentity; fullAdmin: boolean };
type Assignment = { owner: string | null; studentIds: string[] };
type Access = ReturnType<typeof buildOpsAccessContext>;

function reply(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function identify() {
  const jar = await cookies();
  const resolved = await getCurrentDemoSession(jar.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return { response: reply({ error: resolved.error }, resolved.status) };
  return { session: resolved.session, fullAdmin: hasFullAdminAccess(resolved.session, jar.get(NIXON_COOKIE_NAME)?.value) };
}

export async function GET() {
  const identity = await identify();
  if ("response" in identity) return identity.response;
  if (identity.session.role === "teacher") return reply({ error: "当前账号不能读取教务任务。" }, 403);
  if (process.env.JIAOWUBAO_UNCLOSED_TASKS_ENABLED !== "true") return reply({ state: "disabled", tasks: [] });
  return readReply(identity);
}

async function readReply(identity: TaskIdentity) {
  try {
    return await readScopedTasks(identity);
  } catch {
    return reply({ error: "未结课任务暂时无法读取。" }, 503);
  }
}

function records(rows: Awaited<ReturnType<typeof getOpsState>>, entity: string) {
  const payload = rows.find((row) => row.entity === entity)?.payload;
  if (!Array.isArray(payload)) throw new Error("invalid_unclosed_scope");
  return payload as UnclosedStateRecord[];
}

async function readScopedTasks(identity: TaskIdentity) {
  const rows = await getOpsState(["students", "teachers", "bookings", "lpItems"]);
  const context = buildOpsAccessContext(rows, identity.session.user, identity.fullAdmin, identity.session);
  if (!canReadOpsEntity(context, "tasks") || !canReadOpsEntity(context, "students")) return reply({ error: "当前账号不能读取教务任务。" }, 403);
  const snapshot = await readJiaowubaoUnclosedSnapshot();
  const groups = taskGroups(snapshot.lessons, records(rows, "students"), records(rows, "lpItems"), context);
  return reply({ state: snapshot.revision ? "complete" : "absent", checkedAt: snapshot.checkedAt, tasks: [...groups].map(([owner, lessons]) => unclosedTask({ owner, lessons, checkedAt: snapshot.checkedAt! })) });
}

function taskGroups(lessons: readonly UnclosedLesson[], students: UnclosedStateRecord[], lpItems: UnclosedStateRecord[], context: Access) {
  const groups = new Map<string | null, UnclosedLesson[]>();
  for (const lesson of lessons) {
    for (const assignment of unclosedLessonOwners(lesson, students, lpItems)) {
      if (!assignmentVisible(assignment, context)) continue;
      appendGroup(groups, assignment.owner, lesson);
    }
  }
  return groups;
}

function appendGroup(groups: Map<string | null, UnclosedLesson[]>, owner: string | null, lesson: UnclosedLesson) {
  groups.set(owner, [...(groups.get(owner) ?? []), lesson]);
}

function unrestrictedAdmin(context: Access) {
  return !context.restrictedStudentScope && (context.fullAdmin || context.limitedAdmin);
}

function visibleStudents(assignment: Assignment, context: Access) {
  return assignment.studentIds.length > 0 && assignment.studentIds.every((id) => canAccessStudent(context, id));
}

function assignmentVisible(assignment: Assignment, context: Access) {
  if (assignment.owner === null) return unrestrictedAdmin(context);
  if (context.staff && assignment.owner !== context.actor) return false;
  return visibleStudents(assignment, context);
}
