import { insertMeetingDocument } from "@/lib/bigbluebutton";
import { ClassroomMaterialsError, externalMaterialUrl, materialId, materialRecord, materialUsesExternalViewer } from "@/lib/classroom-materials";
import { authorizedMaterialsMeeting, materialsBody, materialsErrorResponse, materialsResponse, materialsSession } from "@/lib/classroom-materials-server";
import { materialReadUrl, materialRpc } from "@/lib/classroom-materials-store";
import { readClassroomEndRequests } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await materialsSession();
    const id = materialId((await context.params).id)!;
    const input = await materialsBody(request);
    const meetingId = await authorizedMaterialsMeeting(session, input);
    const material = materialRecord((await materialRpc(session.accountId, "authorize", { id, permission: "display" })).material);
    const url = material.kind === "link" ? externalMaterialUrl(material.sourceUrl) : await materialReadUrl(material);
    if ((await readClassroomEndRequests(String(input.occurrenceId))).length > 0) {
      throw new ClassroomMaterialsError("这节课正在结束或已经结束。", "materials_classroom_unavailable", 409);
    }
    if (material.kind === "link" || materialUsesExternalViewer(String(material.mimeType))) return materialsResponse({ mode: "external", url });
    await insertMeetingDocument({ meetingId, name: String(material.fileName || material.title), url });
    return materialsResponse({ mode: "presentation" });
  } catch (error) { return materialsErrorResponse(error); }
}
