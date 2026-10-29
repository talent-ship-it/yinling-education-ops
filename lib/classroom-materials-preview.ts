import { ClassroomMaterialsError, materialRecord } from "./classroom-materials";

type Session = { accountId: string; role: string; permissions?: readonly string[] };
type TeacherAccount = { account_id: string; account_role: string; status: string };

/** Resolve an admin's read-only preview; all writes retain the signed actor. */
export async function resolveMaterialsViewer(
  session: Session,
  name: string | null,
  findTeacher: (name: string) => Promise<TeacherAccount | null>,
) {
  if (!name) return { accountId: session.accountId, preview: false };
  if (!["admin", "limited-admin"].includes(session.role)) {
    throw new ClassroomMaterialsError("只有管理员可以预览教师资料权限。", "materials_forbidden", 403);
  }
  if (!session.permissions?.some((permission) => ["*", "classroom.materials.read", "classroom.materials.manage"].includes(permission))) {
    throw new ClassroomMaterialsError("当前账号没有资料预览权限。", "materials_forbidden", 403);
  }
  if (name.length > 180 || name.trim() !== name || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new ClassroomMaterialsError("教师名称无效。", "materials_invalid_input");
  }
  const account = await findTeacher(name);
  if (!account || account.account_role !== "teacher" || account.status !== "active") {
    throw new ClassroomMaterialsError("该教师账号尚不可用。", "materials_not_found", 404);
  }
  return { accountId: account.account_id, preview: true };
}

export function materialsPreviewResult(result: Record<string, unknown>, preview: boolean) {
  if (!preview) return result;
  const materials = Array.isArray(result.materials) ? result.materials : [];
  return { ...result, canManage: false, materials: materials.map((material) => ({ ...materialRecord(material), canDownload: false })) };
}
