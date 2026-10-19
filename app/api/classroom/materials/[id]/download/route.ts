import { externalMaterialUrl } from "@/lib/classroom-materials";
import { materialsErrorResponse, materialsResponse, materialsTarget } from "@/lib/classroom-materials-server";
import { materialReadUrl } from "@/lib/classroom-materials-store";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { material } = await materialsTarget(context.params, "download");
    const url = material.kind === "link" ? externalMaterialUrl(material.sourceUrl) : await materialReadUrl(material, true);
    return materialsResponse({ url, kind: material.kind });
  } catch (error) { return materialsErrorResponse(error); }
}
