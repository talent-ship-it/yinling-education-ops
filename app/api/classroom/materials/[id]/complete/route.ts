import { verifyMaterialObject } from "@/lib/classroom-materials";
import { materialsErrorResponse, materialsResponse, materialsTarget } from "@/lib/classroom-materials-server";
import { materialObjectInfo, materialRpc } from "@/lib/classroom-materials-store";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { accountId, id, material } = await materialsTarget(context.params, "complete");
    verifyMaterialObject(await materialObjectInfo(material), material);
    return materialsResponse(await materialRpc(accountId, "upload-complete", { id }));
  } catch (error) { return materialsErrorResponse(error); }
}
