import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { buildOpsAccessContext, canOperateStudent, filterOpsStateRows } from "@/lib/ops-access";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getOpsState,
  OpsStoreError,
  putStudentFileLinkAtomic,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const COMMAND_KEY_PATTERN = /^file-link:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_TYPES = new Set([
  "Learning Plan",
  "学校资料",
  "Report 资料",
  "成绩单",
  "课堂反馈",
  "FU",
  "续课 FU",
  "资料链接",
  "其他",
]);

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function cleanText(value: unknown, maxLength: number) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanHttpsSource(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 500) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) return null;
    const normalized = parsed.href;
    return normalized.length <= 500 ? normalized : null;
  } catch {
    return null;
  }
}

function expectedVersions(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 2
    || !Number.isSafeInteger(candidate.files) || Number(candidate.files) < 1
    || !Number.isSafeInteger(candidate.students) || Number(candidate.students) < 1) return null;
  return { files: candidate.files as number, students: candidate.students as number };
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  if (session.role === "teacher") return noStore({ error: "老师账号只能查看学生资料。", code: "teacher_forbidden" }, 403);

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const commandKey = String(body?.commandKey ?? "").trim();
  const studentId = cleanText(body?.studentId, 120);
  const fileTitle = cleanText(body?.fileTitle, 180);
  const fileType = String(body?.fileType ?? "").trim();
  const source = cleanHttpsSource(body?.source);
  const versions = expectedVersions(body?.expectedVersions);
  if (!COMMAND_KEY_PATTERN.test(commandKey)
    || !studentId
    || !fileTitle
    || !FILE_TYPES.has(fileType)
    || !source
    || !versions) {
    return noStore({ error: "资料登记参数不完整，链接必须是有效的 HTTPS 地址。" }, 400);
  }

  try {
    const allRows = await getOpsState();
    const fullAdmin = actor === DEMO_ADMIN_USER
      && session.role === "admin"
      && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
    const access = buildOpsAccessContext(allRows, actor, fullAdmin, session.role);
    // This check is intentionally server-side and uses the same active scope
    // as the rest of the operations API.  Archived students never become a
    // valid target, even when the browser submits a forged student id.
    if (!canOperateStudent(access, studentId)) {
      return noStore({ error: "当前账号不能为该学生登记资料。", code: "student_scope_forbidden" }, 403);
    }
    const filesRow = allRows.find((row) => row.entity === "files");
    const studentsRow = allRows.find((row) => row.entity === "students");
    if (!filesRow || !studentsRow) return noStore({ error: "学生文件索引尚未初始化。" }, 503);

    const committed = await putStudentFileLinkAtomic({
      commandKey,
      studentId,
      fileTitle,
      fileType,
      source,
      expectedVersions: versions,
      actor,
    });
    const result = committed[0];
    if (!result) throw new OpsStoreError("资料登记事务没有返回保存结果。", "invalid_commit_result");

    const committedRows = allRows.map((row) => row.entity === "files"
      ? result.files_row
      : row.entity === "students" ? result.students_row : row);
    const committedAccess = buildOpsAccessContext(committedRows, actor, fullAdmin, session.role);
    const visible = filterOpsStateRows(committedRows, committedAccess);
    const visibleFilesRow = visible.find((row) => row.entity === "files");
    const visibleStudentsRow = visible.find((row) => row.entity === "students");
    if (!visibleFilesRow || !visibleStudentsRow) {
      throw new OpsStoreError("资料已保存但当前账号无法读取更新后的文件索引。", "invalid_commit_result");
    }
    return noStore({
      committed: true,
      applied: result.applied,
      commandKey: result.command_key,
      fileRecord: result.file_record,
      filesRow: visibleFilesRow,
      studentsRow: visibleStudentsRow,
      auditEntryId: result.audit_entry_id,
    });
  } catch (error) {
    if (error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883")) {
      return noStore({ error: "文件登记原子数据库合同尚未部署，当前不会降级为分散写入。", code: "file_link_atomic_contract_unavailable" }, 501);
    }
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "学生或文件资料刚刚发生变化，请刷新后重试。", code: "version_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "同一个资料登记命令已用于不同内容，请刷新后重试。", code: "idempotency_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "42501") {
      return noStore({ error: "已归档学生不能新增资料。", code: "student_scope_forbidden" }, 403);
    }
    return noStore({ error: error instanceof Error ? error.message : "资料登记失败。" }, 503);
  }
}
