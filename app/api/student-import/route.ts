import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DEMO_ADMIN_USER,
  DEMO_COOKIE_NAME,
  getCurrentDemoSession,
} from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  commitStudentImportPlanAtomic,
  getLatestStudentImportSourceRows,
  getOpsState,
  getStudentImportCommitReplayResult,
  OpsStoreError,
  STUDENT_IMPORT_ATOMIC_COMMIT_RPC,
  STUDENT_IMPORT_COMMIT_REPLAY_RESULT_RPC,
  STUDENT_IMPORT_SOURCE_ROWS_RPC,
} from "@/lib/ops-store";
import { StudentImportError } from "@/lib/student-import";
import {
  assertStudentImportCommit,
  hasStudentImportAdminAccess,
  parseStudentImportSourceUnavailableDetail,
  parseStudentImportCommitRequest,
  prepareStudentImport,
  StudentImportServiceError,
} from "@/lib/student-import-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

async function adminSession() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return { actor: null, fullAdmin: false };
  const { session } = resolved;
  const actor = session.user;
  const fullAdmin = actor === DEMO_ADMIN_USER && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  return { actor, fullAdmin };
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError
    && (error.code === "PGRST202" || error.code === "42883");
}

function databaseContractUnavailable() {
  return noStore({
    error: "学生导入数据库合同尚未部署，当前不能读取或提交正式导入。",
    code: "student_import_contract_unavailable",
    requiredRpcs: [
      STUDENT_IMPORT_SOURCE_ROWS_RPC,
      STUDENT_IMPORT_ATOMIC_COMMIT_RPC,
      STUDENT_IMPORT_COMMIT_REPLAY_RESULT_RPC,
    ],
  }, 501);
}

function sourceRowsUnavailable(error: OpsStoreError) {
  const missingSources = parseStudentImportSourceUnavailableDetail(error.detail);
  const labels = missingSources?.map((source) => source === "master" ? "学生总表" : "教务宝");
  return noStore({
    error: labels?.length
      ? `学生正式导入缺少已审核的${labels.join("、")}来源快照。`
      : "学生正式导入来源快照尚未准备完成。",
    code: "student_import_source_rows_unavailable",
    ...(missingSources ? { missingSources } : {}),
  }, 503);
}

function missingSourceRows(error: unknown): error is OpsStoreError {
  return error instanceof OpsStoreError
    && error.code === "P0002"
    && error.message === "student_import_source_rows_unavailable";
}

function serviceError(error: StudentImportServiceError) {
  if (["ambiguous_plan", "insufficient_identity_coverage", "stale_plan", "stale_students_version"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 409);
  }
  const sourceFailure = error.code === "invalid_source_snapshot" || error.code === "invalid_students_state";
  return noStore({ error: error.message, code: error.code }, sourceFailure ? 503 : 400);
}

async function currentPlan() {
  const stateEntities = [
    "students", "bookings", "files", "lpItems", "messages", "operations", "payroll", "renewals", "tasks",
  ];
  const [sourceSnapshot, rows] = await Promise.all([
    getLatestStudentImportSourceRows(),
    getOpsState(stateEntities),
  ]);
  return prepareStudentImport({
    sourceSnapshot,
    studentsRow: rows.find((row) => row.entity === "students"),
    referenceRows: rows.filter((row) => row.entity !== "students"),
  });
}

async function requireAdmin() {
  const session = await adminSession();
  if (!session.actor) return { response: noStore({ error: "请先输入访问密码。" }, 401) } as const;
  if (!hasStudentImportAdminAccess(session.actor, session.fullAdmin)) {
    return { response: noStore({ error: "只有管理员可以执行学生正式导入。" }, 403) } as const;
  }
  return { session } as const;
}

/** Server-computed dry run; no source or student rows are accepted from the caller. */
export async function GET() {
  const access = await requireAdmin();
  if ("response" in access) return access.response;

  try {
    const prepared = await currentPlan();
    return noStore(prepared.response);
  } catch (error) {
    if (missingRpc(error)) return databaseContractUnavailable();
    if (missingSourceRows(error)) return sourceRowsUnavailable(error);
    if (error instanceof StudentImportServiceError) return serviceError(error);
    if (error instanceof StudentImportError) return noStore({ error: error.message, code: error.code }, 422);
    return noStore({ error: error instanceof Error ? error.message : "学生导入预检失败。" }, 503);
  }
}

/**
 * Recomputes the complete plan from server-owned rows and delegates one atomic
 * write. It deliberately never accepts a client-computed students payload.
 */
export async function POST(request: Request) {
  const access = await requireAdmin();
  if ("response" in access) return access.response;

  try {
    const confirmation = parseStudentImportCommitRequest(await request.json().catch(() => null));
    const prepared = await currentPlan();
    const matchesCurrentPlan = confirmation.planFingerprint === prepared.response.planFingerprint
      && confirmation.expectedStudentVersion === prepared.response.expectedStudentVersion;
    if (!matchesCurrentPlan) {
      const replay = await getStudentImportCommitReplayResult({
        planFingerprint: confirmation.planFingerprint,
        expectedStudentVersion: confirmation.expectedStudentVersion,
        actor: access.session.actor,
      });
      if (!replay[0]) {
        throw new OpsStoreError(
          "学生导入重放没有返回已提交结果。",
          "student_import_commit_replay_unavailable",
        );
      }
      return noStore({
        committed: true,
        replayed: true,
        studentVersion: replay[0].version,
      });
    }
    assertStudentImportCommit(confirmation, prepared);
    const saved = await commitStudentImportPlanAtomic({
      planFingerprint: prepared.response.planFingerprint,
      expectedStudentVersion: prepared.response.expectedStudentVersion,
      sourceRevisions: prepared.sourceRevisions,
      students: prepared.plan.students,
      actor: access.session.actor,
    });
    if (!saved[0]) throw new OpsStoreError("学生导入原子提交没有返回保存结果。", "invalid_commit_result");
    return noStore({
      committed: true,
      studentVersion: saved[0].version,
      summary: prepared.response.summary,
      excluded: prepared.response.excluded,
      unmatched: prepared.response.unmatched,
      ambiguous: prepared.response.ambiguous,
    });
  } catch (error) {
    if (missingRpc(error)) return databaseContractUnavailable();
    if (missingSourceRows(error)) return sourceRowsUnavailable(error);
    if (error instanceof StudentImportServiceError) return serviceError(error);
    if (error instanceof StudentImportError) return noStore({ error: error.message, code: error.code }, 422);
    if (error instanceof OpsStoreError && (
      error.code === "40001"
      || error.message === "version_conflict"
      || error.message === "student_import_commit_replay_unavailable"
    )) {
      return noStore({ error: "学生资料或导入来源刚刚发生变化，请重新预检。", code: "import_conflict" }, 409);
    }
    return noStore({ error: error instanceof Error ? error.message : "学生导入提交失败。" }, 503);
  }
}
