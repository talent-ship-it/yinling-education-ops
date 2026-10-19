import { NextRequest } from "next/server";

import { ClassroomMaterialsError, materialGrantsInput, materialId } from "@/lib/classroom-materials";
import { materialsBody, materialsErrorResponse, materialsResponse, materialsSession } from "@/lib/classroom-materials-server";
import { materialRpc } from "@/lib/classroom-materials-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await materialsSession();
    const targetType = request.nextUrl.searchParams.get("targetType");
    if (targetType !== "folder" && targetType !== "material") throw new ClassroomMaterialsError("授权对象无效。", "materials_invalid_target");
    return materialsResponse(await materialRpc(session.accountId, "grants-read", { targetType, targetId: materialId(request.nextUrl.searchParams.get("targetId")) }));
  } catch (error) { return materialsErrorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const session = await materialsSession();
    return materialsResponse(await materialRpc(session.accountId, "grants-replace", materialGrantsInput(await materialsBody(request))));
  } catch (error) { return materialsErrorResponse(error); }
}
