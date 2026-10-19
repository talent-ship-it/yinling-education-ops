import { materialId, materialRecord, verifyMaterialObject } from "@/lib/classroom-materials";
import { materialsErrorResponse, materialsResponse, materialsSession } from "@/lib/classroom-materials-server";
import { materialObjectInfo, materialRpc } from "@/lib/classroom-materials-store";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await materialsSession();
    const id = materialId((await context.params).id)!;
    const material = materialRecord((await materialRpc(session.accountId, "authorize", { id, permission: "complete" })).material);
    verifyMaterialObject(await materialObjectInfo(material), material);
    return materialsResponse(await materialRpc(session.accountId, "upload-complete", { id }));
  } catch (error) { return materialsErrorResponse(error); }
}
