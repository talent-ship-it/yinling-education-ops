import { createHash } from "node:crypto";

import { NextRequest } from "next/server";

import { ClassroomMaterialsError, externalMaterialUrl, materialId, materialListInput, materialMaxBytes, materialTitle } from "@/lib/classroom-materials";
import { materialsBody, materialsErrorResponse, materialsResponse, materialsSession } from "@/lib/classroom-materials-server";
import { materialRpc, materialsStorageConfigured } from "@/lib/classroom-materials-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await materialsSession();
    const result = await materialRpc(session.accountId, "list", materialListInput(request.nextUrl.searchParams));
    return materialsResponse({ ...result, canPresent: session.role === "teacher", configured: materialsStorageConfigured(), uploadScope: createHash("sha256").update(`materials-upload:${session.accountId}`).digest("hex"), maxFileBytes: materialMaxBytes() });
  } catch (error) { return materialsErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await materialsSession();
    const input = await materialsBody(request);
    if (input.action === "create-folder") {
      return materialsResponse(await materialRpc(session.accountId, "create-folder", { parentId: materialId(input.parentId, true), name: materialTitle(input.name, 160) }), 201);
    }
    if (input.action === "create-link") {
      return materialsResponse(await materialRpc(session.accountId, "create-link", { folderId: materialId(input.folderId, true), title: materialTitle(input.title), sourceUrl: externalMaterialUrl(input.sourceUrl) }), 201);
    }
    throw new ClassroomMaterialsError("资料操作无效。", "materials_invalid_input");
  } catch (error) { return materialsErrorResponse(error); }
}
