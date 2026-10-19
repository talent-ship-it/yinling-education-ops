import { ClassroomMaterialsError, materialMaxBytes, materialRecord, materialUploadInput, verifyMaterialObject } from "@/lib/classroom-materials";
import { materialsBody, materialsErrorResponse, materialsResponse, materialsSession, publicMaterial } from "@/lib/classroom-materials-server";
import { materialObjectInfo, materialRpc, materialUploadDescriptor, materialsStorageConfigured } from "@/lib/classroom-materials-store";

export const dynamic = "force-dynamic";

async function completedUpload(accountId: string, material: Record<string, unknown>) {
  if (material.status === "ready") return material;
  const object = await materialObjectInfo(material, { allowMissing: true });
  if (!object) return null;
  verifyMaterialObject(object, material);
  const completed = await materialRpc(accountId, "upload-complete", { id: material.id });
  return materialRecord(completed.material);
}

export async function POST(request: Request) {
  try {
    const session = await materialsSession();
    const input = materialUploadInput(await materialsBody(request), materialMaxBytes());
    if (!materialsStorageConfigured()) throw new ClassroomMaterialsError("资料文件存储尚未配置。", "materials_storage_unconfigured", 503);
    const result = await materialRpc(session.accountId, "upload-start", input);
    const material = materialRecord(result.material);
    const ready = await completedUpload(session.accountId, material);
    if (ready) return materialsResponse({ material: publicMaterial(ready), upload: null });
    return materialsResponse({ material: publicMaterial(material), upload: await materialUploadDescriptor(material) }, 201);
  } catch (error) { return materialsErrorResponse(error); }
}
