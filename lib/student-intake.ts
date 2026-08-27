export type StudentIntakeSegment = "试听" | "已报名";

export type StudentDisplayNameResolution =
  | {
      ok: true;
      displayName: string;
      guardianWechat?: string;
    }
  | {
      ok: false;
      reason: "missing_name" | "missing_guardian_wechat";
      message: string;
    };

/**
 * Resolves the user-facing name for a manually created student record.
 *
 * Trial records may not have the student's real name yet, but must still have
 * a guardian WeChat name so that the record is identifiable. Enrolled records
 * always require the student's real name.
 */
export function resolveStudentDisplayName(input: {
  segment: StudentIntakeSegment;
  name?: string | null;
  guardianWechat?: string | null;
}): StudentDisplayNameResolution {
  const name = input.name?.trim() ?? "";
  const guardianWechat = input.guardianWechat?.trim() ?? "";

  if (input.segment === "试听" && !name && !guardianWechat) {
    return {
      ok: false,
      reason: "missing_guardian_wechat",
      message: "试听学生未填写姓名时，请填写家长微信名，系统将用它作为临时识别名称。",
    };
  }

  if (input.segment === "已报名" && !name) {
    return {
      ok: false,
      reason: "missing_name",
      message: "已报名学生必须填写学生姓名。",
    };
  }

  return {
    ok: true,
    displayName: name || guardianWechat,
    guardianWechat: guardianWechat || undefined,
  };
}
