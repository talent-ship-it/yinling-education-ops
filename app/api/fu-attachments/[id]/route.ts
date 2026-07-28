import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getDemoSessionUser } from "@/lib/demo-auth";
import { buildOpsAccessContext, canAccessStudent } from "@/lib/ops-access";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { getOpsState, getStudentFuAttachment } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const actor = getDemoSessionUser(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!actor) {
    return NextResponse.json({ error: "请先输入访问密码。" }, { status: 401 });
  }

  try {
    const { id } = await context.params;
    const attachment = await getStudentFuAttachment(id);
    if (!attachment?.content_base64) {
      return NextResponse.json({ error: "未找到该聊天记录截图。" }, { status: 404 });
    }
    const allRows = await getOpsState();
    const fullAdmin = actor === "Nixon" && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
    const access = buildOpsAccessContext(allRows, actor, fullAdmin);
    if (!canAccessStudent(access, attachment.student_id)) {
      return NextResponse.json({ error: "未找到该聊天记录截图。" }, { status: 404 });
    }
    const bytes = new Uint8Array(Buffer.from(attachment.content_base64, "base64"));
    return new NextResponse(bytes, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": attachment.content_type,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.file_name)}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "截图读取失败。" }, {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
