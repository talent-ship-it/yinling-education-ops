import { ClassroomMaterialsError, materialMaxBytes, materialRecord, materialUploadInput } from "@/lib/classroom-materials";
import { materialsBody, materialsErrorResponse, materialsResponse, materialsSession, publicMaterial } from "@/lib/classroom-materials-server";
import { materialRpc, materialUploadDescriptor, materialsStorageConfigured } from "@/lib/classroom-materials-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await materialsSession();
    const input = materialUploadInput(await materialsBody(request), materialMaxBytes());
    if (!materialsStorageConfigured()) throw new ClassroomMaterialsError("资料文件存储尚未配置。", "materials_storage_unconfigured", 503);
    const result = await materialRpc(session.accountId, "upload-start", input);
    const material = materialRecord(result.material);
    if (material.status === "ready") return materialsResponse({ material: publicMaterial(material), upload: null });
    return materialsResponse({ material: publicMaterial(material), upload: await materialUploadDescriptor(material) }, 201);
  } catch (error) { return materialsErrorResponse(error); }
}
