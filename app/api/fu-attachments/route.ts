import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getDemoSessionUser } from "@/lib/demo-auth";
import { isDemoTeacher } from "@/lib/demo-users";
import { buildOpsAccessContext, canAccessStudent } from "@/lib/ops-access";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { getOpsState, putStudentFuAttachment } from "@/lib/ops-store";
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

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const actor = getDemoSessionUser(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!actor) return noStore({ error: "请先输入访问密码。" }, 401);
  if (isDemoTeacher(actor)) return noStore({ error: "老师账号只能查看学生资料。" }, 403);

  const formData = await request.formData().catch(() => null);
  const studentId = String(formData?.get("studentId") ?? "").trim();
  const file = formData?.get("file");
  if (!studentId || !(file instanceof File) || !file.size) {
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
    const fullAdmin = actor === "Nixon" && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
    const access = buildOpsAccessContext(allRows, actor, fullAdmin);
    if (!canAccessStudent(access, studentId)) return noStore({ error: "未找到该学生档案。" }, 404);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.byteLength !== file.size || !hasStudentAttachmentMagicBytes(contentType, bytes)) {
      return noStore({ error: "文件内容与所选格式不一致。" }, 415);
    }
    const attachmentKind = studentAttachmentKind(contentType);
    const attachment = await putStudentFuAttachment({
      studentId,
      fileName: sanitiseStudentAttachmentName(
        file.name,
        attachmentKind === "report" ? "student-report.pdf" : "follow-up-screenshot",
      ),
      contentType,
      contentBase64: bytes.toString("base64"),
      actor,
    });
    return noStore({
      id: attachment.id,
      fileName: attachment.file_name,
      byteSize: attachment.byte_size,
      uploadedAt: attachment.uploaded_at,
      url: `/api/fu-attachments/${attachment.id}`,
      kind: attachmentKind,
    });
  } catch (error) {
    return noStore({ error: error instanceof Error ? error.message : "附件归档失败。" }, 503);
  }
}
