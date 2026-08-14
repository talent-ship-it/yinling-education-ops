import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { buildOpsAccessContext, canAccessStudent, canOperateStudent, filterOpsStateRows } from "@/lib/ops-access";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { getOpsState, OpsStoreError, putStudentFuAttachmentAtomic } from "@/lib/ops-store";
import { isFuAttachmentCategory, type FuAttachmentCategory } from "@/lib/student-records";
import {
  MAX_STUDENT_ATTACHMENT_BYTES,
  hasStudentAttachmentMagicBytes,
  isStudentAttachmentContentType,
  sanitiseStudentAttachmentName,
  studentAttachmentKind,
} from "@/lib/student-attachment-validation";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

const COMMAND_KEY_PATTERN = /^fu-attachment:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function plainTitle(value: unknown) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  if (session.role === "teacher") return noStore({ error: "老师账号只能查看学生资料。" }, 403);

  const formData = await request.formData().catch(() => null);
  const studentId = String(formData?.get("studentId") ?? "").trim();
  const commandKey = String(formData?.get("commandKey") ?? "").trim();
  const fileTitle = plainTitle(formData?.get("fileTitle"));
  const fileType = String(formData?.get("fileType") ?? "").trim();
  const fuCategoryValue = String(formData?.get("fuCategory") ?? "").trim();
  const file = formData?.get("file");
  if (!studentId || !COMMAND_KEY_PATTERN.test(commandKey) || !fileTitle || !(file instanceof File) || !file.size) {
    return noStore({ error: "请选择需要归档的附件。" }, 400);
  }
  const contentType = file.type.toLowerCase();
  if (!isStudentAttachmentContentType(contentType)) {
    return noStore({ error: "只支持 PDF、PNG、JPG 或 WebP 文件。" }, 415);
  }
  if (file.size > MAX_STUDENT_ATTACHMENT_BYTES) {
    return noStore({ error: "附件不能超过 4MB。" }, 413);
  }

  try {
    const allRows = await getOpsState();
    const fullAdmin = actor === "Nixon" && session.role === "admin" && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
    const access = buildOpsAccessContext(allRows, actor, fullAdmin, session.role);
    if (!canAccessStudent(access, studentId)) return noStore({ error: "未找到该学生档案。" }, 404);
    if (!canOperateStudent(access, studentId)) return noStore({ error: "已归档学生不能新增附件。" }, 403);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.byteLength !== file.size || !hasStudentAttachmentMagicBytes(contentType, bytes)) {
      return noStore({ error: "文件内容与所选格式不一致。" }, 415);
    }
    const attachmentKind = studentAttachmentKind(contentType);
    const expectedFileType = attachmentKind === "report"
      ? "Report 资料"
      : fuCategoryValue === "renewal_update" ? "续课 FU" : "FU";
    if (fileType !== expectedFileType) return noStore({ error: "附件资料类型不匹配。" }, 400);
    const fuCategory: FuAttachmentCategory | undefined = attachmentKind === "report"
      ? undefined
      : isFuAttachmentCategory(fuCategoryValue) ? fuCategoryValue : undefined;
    if (attachmentKind !== "report" && !fuCategory) return noStore({ error: "请选择有效的 FU 分类。" }, 400);
    const studentsRow = allRows.find((row) => row.entity === "students");
    const filesRow = allRows.find((row) => row.entity === "files");
    if (!studentsRow || !filesRow) return noStore({ error: "学生文件索引尚未初始化。" }, 503);
    const committed = await putStudentFuAttachmentAtomic({
      commandKey,
      studentId,
      fileName: sanitiseStudentAttachmentName(
        file.name,
        attachmentKind === "report" ? "student-report.pdf" : "follow-up-screenshot",
      ),
      contentType,
      contentBase64: bytes.toString("base64"),
      fileTitle,
      fileType,
      fuCategory,
      expectedVersions: { files: filesRow.version, students: studentsRow.version },
      actor,
    });
    const result = committed[0];
    if (!result) throw new OpsStoreError("附件事务没有返回保存结果。", "invalid_commit_result");
    const committedRows = allRows.map((row) => row.entity === "files"
      ? result.files_row
      : row.entity === "students" ? result.students_row : row);
    const committedAccess = buildOpsAccessContext(committedRows, actor, fullAdmin, session.role);
    const committedVisible = filterOpsStateRows(committedRows, committedAccess);
    const visibleFilesRow = committedVisible.find((row) => row.entity === "files");
    const visibleStudentsRow = committedVisible.find((row) => row.entity === "students");
    if (!visibleFilesRow || !visibleStudentsRow) {
      throw new OpsStoreError("附件已保存但当前账号无法读取更新后的资料索引。", "invalid_commit_result");
    }
    const attachment = result.attachment;
    return noStore({
      id: attachment.id,
      fileName: attachment.file_name,
      byteSize: attachment.byte_size,
      uploadedAt: attachment.uploaded_at,
      url: `/api/fu-attachments/${attachment.id}`,
      kind: attachmentKind,
      applied: result.applied,
      filesRow: visibleFilesRow,
      studentsRow: visibleStudentsRow,
      auditEntryId: result.audit_entry_id,
    });
  } catch (error) {
    if (error instanceof OpsStoreError && error.code === "40001") {
      return noStore({ error: "学生资料刚刚已更新，请重新选择附件上传。", code: "version_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "42501") {
      return noStore({ error: "已归档学生不能新增附件。", code: "student_scope_forbidden" }, 403);
    }
    return noStore({ error: error instanceof Error ? error.message : "附件归档失败。" }, 503);
  }
}
