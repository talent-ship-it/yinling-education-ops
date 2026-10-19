import { externalMaterialUrl, materialId, materialRecord } from "@/lib/classroom-materials";
import { materialsErrorResponse, materialsResponse, materialsSession } from "@/lib/classroom-materials-server";
import { materialReadUrl, materialRpc } from "@/lib/classroom-materials-store";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await materialsSession();
    const id = materialId((await context.params).id)!;
    const material = materialRecord((await materialRpc(session.accountId, "authorize", { id, permission: "download" })).material);
    const url = material.kind === "link" ? externalMaterialUrl(material.sourceUrl) : await materialReadUrl(material, true);
    return materialsResponse({ url, kind: material.kind });
  } catch (error) { return materialsErrorResponse(error); }
}
