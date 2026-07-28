import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getDemoSessionUser } from "@/lib/demo-auth";
import { buildOpsAccessContext, canAccessStudent } from "@/lib/ops-access";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { getOpsState, putStudentFuAttachment } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

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

  const formData = await request.formData().catch(() => null);
  const studentId = String(formData?.get("studentId") ?? "").trim();
  const file = formData?.get("file");
  if (!studentId || !(file instanceof File) || !file.size) {
    return noStore({ error: "请选择需要归档的聊天记录截图。" }, 400);
  }
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    return noStore({ error: "只支持 PNG、JPG 或 WebP 截图。" }, 415);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return noStore({ error: "截图不能超过 4MB。" }, 413);
  }

  try {
    const allRows = await getOpsState();
    const fullAdmin = actor === "Nixon" && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
    const access = buildOpsAccessContext(allRows, actor, fullAdmin);
    if (!canAccessStudent(access, studentId)) return noStore({ error: "未找到该学生档案。" }, 404);
    const bytes = Buffer.from(await file.arrayBuffer());
    const attachment = await putStudentFuAttachment({
      studentId,
      fileName: file.name.slice(0, 180) || "follow-up-screenshot",
      contentType: file.type,
      contentBase64: bytes.toString("base64"),
      actor,
    });
    return noStore({
      id: attachment.id,
      fileName: attachment.file_name,
      byteSize: attachment.byte_size,
      uploadedAt: attachment.uploaded_at,
      url: `/api/fu-attachments/${attachment.id}`,
    });
  } catch (error) {
    return noStore({ error: error instanceof Error ? error.message : "截图归档失败。" }, 503);
  }
}
