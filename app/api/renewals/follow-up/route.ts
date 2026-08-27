import { createHash } from "node:crypto";

import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import {
  prepareRenewalFollowUp,
  isCreateIfMissingRenewal,
  parseRenewalFollowUpCommand,
  renewalFollowUpIntent,
  RenewalFollowUpServiceError,
} from "@/lib/renewal-follow-up-service";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { buildOpsAccessContext, canOperateStudent, filterOpsStateRows } from "@/lib/ops-access";
import {
  getOpsState,
  getRenewalFollowUpCommandResult,
  OpsStoreError,
  putRenewalFollowUpAtomic,
  putRenewalFollowUpCreateIfMissingAtomic,
  RENEWAL_FOLLOW_UP_ATOMIC_RPC,
  RENEWAL_FOLLOW_UP_CREATE_IF_MISSING_ATOMIC_RPC,
  type OpsStateRow,
} from "@/lib/ops-store";
import {
  MAX_STUDENT_ATTACHMENT_BYTES,
  hasStudentAttachmentMagicBytes,
  isStudentAttachmentContentType,
  sanitiseStudentAttachmentName,
} from "@/lib/student-attachment-validation";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function serviceError(error: RenewalFollowUpServiceError) {
  if (["teacher_forbidden", "student_scope_forbidden", "archived_student_read_only"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 403);
  }
  if (["student_not_found", "renewal_not_found"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 404);
  }
  if (["stale_expected_version", "renewal_identity_conflict"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 409);
  }
  return noStore({ error: error.message, code: error.code }, 400);
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

/** Convert the multipart form into the same strict command shape used by JSON callers. */
async function commandBody(request: NextRequest) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return await request.json().catch(() => null);
  }
  const form = await request.formData().catch(() => null);
  if (!form) return null;
  const allowedFields = new Set([
    "commandKey",
    "renewalId",
    "studentId",
    "packageId",
    "businessStatus",
    "result",
    "attemptedAt",
    "note",
    "renewalDateNote",
    "expectedVersions",
    "fileTitle",
    "attachment",
  ]);
  for (const key of form.keys()) {
    if (!allowedFields.has(key)) {
      throw new RenewalFollowUpServiceError("client_fields_forbidden", "Only reviewed renewal follow-up fields may be submitted.");
    }
  }
  const attachmentValue = form.get("attachment");
  let attachment: Record<string, unknown> | undefined;
  if (attachmentValue instanceof File && attachmentValue.size > 0) {
    const type = attachmentValue.type.toLowerCase();
    if (!isStudentAttachmentContentType(type) || type === "application/pdf") {
      throw new RenewalFollowUpServiceError("invalid_request", "续课聊天截图只支持 JPG、PNG 或 WebP 文件。");
    }
    if (attachmentValue.size > MAX_STUDENT_ATTACHMENT_BYTES) {
      throw new RenewalFollowUpServiceError("invalid_request", "续课聊天截图不能超过 4MB。");
    }
    const bytes = Buffer.from(await attachmentValue.arrayBuffer());
    if (bytes.byteLength !== attachmentValue.size || !hasStudentAttachmentMagicBytes(type, bytes)) {
      throw new RenewalFollowUpServiceError("invalid_request", "文件内容与所选格式不一致。");
    }
    attachment = {
      fileName: sanitiseStudentAttachmentName(attachmentValue.name, "renewal-follow-up"),
      fileTitle: String(form.get("fileTitle") ?? "续课 FU").trim(),
      contentType: type,
      contentBase64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } else if (attachmentValue !== null && !(attachmentValue instanceof File)) {
    throw new RenewalFollowUpServiceError("invalid_request", "续课附件格式无效。");
  }
  return {
    commandKey: form.get("commandKey"),
    renewalId: form.get("renewalId"),
    studentId: form.get("studentId"),
    ...(form.get("packageId") ? { packageId: form.get("packageId") } : {}),
    businessStatus: form.get("businessStatus"),
    result: form.get("result"),
    attemptedAt: form.get("attemptedAt"),
    note: form.get("note") ?? "",
    renewalDateNote: form.get("renewalDateNote") ?? "",
    expectedVersions: (() => {
      try { return JSON.parse(String(form.get("expectedVersions") ?? "null")); } catch { return null; }
    })(),
    ...(attachment ? { attachment } : {}),
  };
}

function visibleRows(rows: OpsStateRow[], actor: string, fullAdmin: boolean, role: Parameters<typeof buildOpsAccessContext>[3]) {
  const access = buildOpsAccessContext(rows, actor, fullAdmin, role);
  const visible = filterOpsStateRows(rows, access);
  const renewalsRow = visible.find((row) => row.entity === "renewals");
  const studentsRow = visible.find((row) => row.entity === "students");
  const filesRow = visible.find((row) => row.entity === "files");
  const tasksRow = visible.find((row) => row.entity === "tasks");
  if (!renewalsRow || !studentsRow || !filesRow || !tasksRow) throw new OpsStoreError("续课提交结果不可见。", "invalid_commit_result");
  return { renewalsRow, studentsRow, filesRow, tasksRow };
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  if (session.role === "teacher") return noStore({ error: "老师账号不能记录续课跟进。", code: "teacher_forbidden" }, 403);
  const fullAdmin = actor === DEMO_ADMIN_USER
    && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);

  let requiredRpc = RENEWAL_FOLLOW_UP_ATOMIC_RPC;
  try {
    const command = parseRenewalFollowUpCommand(await commandBody(request));
    const createIfMissing = isCreateIfMissingRenewal(command);
    requiredRpc = createIfMissing
      ? RENEWAL_FOLLOW_UP_CREATE_IF_MISSING_ATOMIC_RPC
      : RENEWAL_FOLLOW_UP_ATOMIC_RPC;
    const commandIntent = renewalFollowUpIntent(command);

    // A retry after a lost HTTP response must not be blocked by stale OCC
    // versions. The ledger lookup is read-only and actor/intent bound.
    const replay = await getRenewalFollowUpCommandResult({
      commandKey: command.commandKey,
      commandIntent,
      actor,
    });
    if (replay[0]) {
      const replayRows = await getOpsState(["renewals", "students", "files", "tasks", "teachers"]);
      const replayAccess = buildOpsAccessContext(replayRows, actor, fullAdmin, session.role);
      if (!canOperateStudent(replayAccess, replay[0].student_id)) {
        return noStore({ error: "当前账号不能读取这次续课提交结果。", code: "student_scope_forbidden" }, 403);
      }
      const committed = visibleRows(replayRows, actor, fullAdmin, session.role);
      return noStore({
        committed: true,
        applied: false,
        commandKey: replay[0].command_key,
        renewalId: replay[0].renewal_id,
        studentId: replay[0].student_id,
        attachmentId: replay[0].attachment_id,
        renewalsRow: committed.renewalsRow,
        studentsRow: committed.studentsRow,
        filesRow: committed.filesRow,
        tasksRow: committed.tasksRow,
        auditEntryId: replay[0].audit_entry_id,
      });
    }

    const rows = await getOpsState(["renewals", "students", "files", "tasks", "teachers"]);
    const access = buildOpsAccessContext(rows, actor, fullAdmin, session.role);
    if (!canOperateStudent(access, command.studentId)) {
      return noStore({ error: "当前账号不能记录这位学生的续课跟进。", code: "student_scope_forbidden" }, 403);
    }
    const prepared = prepareRenewalFollowUp({ command, rows, actor, role: session.role, fullAdmin });
    const saved = createIfMissing
      ? await putRenewalFollowUpCreateIfMissingAtomic({ ...prepared, packageId: command.packageId!, actor })
      : await putRenewalFollowUpAtomic({ ...prepared, actor });
    const result = saved[0];
    if (!result) throw new OpsStoreError("续课事务没有返回保存结果。", "invalid_commit_result");
    const committedRows = rows.map((row) => row.entity === "renewals"
      ? result.renewals_row
      : row.entity === "students" ? result.students_row
        : row.entity === "files" ? result.files_row
          : row.entity === "tasks" ? result.tasks_row : row);
    const committed = visibleRows(committedRows, actor, fullAdmin, session.role);
    return noStore({
      committed: true,
      applied: result.applied,
      commandKey: result.command_key,
      renewalId: result.renewal_id,
      studentId: result.student_id,
      attachment: result.attachment,
      renewalsRow: committed.renewalsRow,
      studentsRow: committed.studentsRow,
      filesRow: committed.filesRow,
      tasksRow: committed.tasksRow,
      auditEntryId: result.audit_entry_id,
    });
  } catch (error) {
    if (missingRpc(error)) {
      return noStore({
        error: "续课跟进原子数据库合同尚未部署，当前不会降级为分散写入。",
        code: requiredRpc === RENEWAL_FOLLOW_UP_CREATE_IF_MISSING_ATOMIC_RPC
          ? "renewal_follow_up_create_if_missing_contract_unavailable"
          : "renewal_follow_up_contract_unavailable",
        requiredRpc,
      }, 501);
    }
    if (error instanceof RenewalFollowUpServiceError) return serviceError(error);
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "学生、续课、任务或文件资料刚刚发生变化，请刷新后重试。", code: "version_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "同一个续课命令已用于不同内容，请刷新后重试。", code: "idempotency_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "42501") {
      return noStore({ error: "当前账号不能操作该学生的续课资料。", code: "student_scope_forbidden" }, 403);
    }
    return noStore({ error: error instanceof Error ? error.message : "续课跟进保存失败。" }, 503);
  }
}
