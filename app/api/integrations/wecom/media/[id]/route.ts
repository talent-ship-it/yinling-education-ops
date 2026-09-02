import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { buildOpsAccessContext, canAccessStudent, canReadOpsEntity } from "@/lib/ops-access";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { getOpsState, getWecomArchiveMedia } from "@/lib/ops-store";
import { sanitiseStudentAttachmentName } from "@/lib/student-attachment-validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function noStore(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { id } = await context.params;
  if (!UUID.test(id)) return noStore({ error: "未找到该企业微信附件。" }, 404);

  try {
    const media = await getWecomArchiveMedia(id);
    if (!media?.content_base64) return noStore({ error: "未找到该企业微信附件。" }, 404);
    const rows = await getOpsState();
    const { session } = resolved;
    const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);
    const access = buildOpsAccessContext(rows, session.user, fullAdmin, session);
    if (!canReadOpsEntity(access, "files") || !canAccessStudent(access, media.student_id)) {
      return noStore({ error: "未找到该企业微信附件。" }, 404);
    }

    const bytes = new Uint8Array(Buffer.from(media.content_base64, "base64"));
    if (bytes.byteLength !== media.byte_size) return noStore({ error: "企业微信附件完整性核对失败。" }, 503);
    const fileName = sanitiseStudentAttachmentName(
      media.file_name,
      media.content_type === "application/pdf" ? "wecom-document.pdf" : "wecom-image",
    );
    return new NextResponse(bytes, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": media.content_type,
        "Content-Disposition": `${media.content_type === "application/pdf" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return noStore({ error: "企业微信附件读取失败。" }, 503);
  }
}
