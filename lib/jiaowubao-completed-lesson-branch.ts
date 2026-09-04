// Outside the grammar of every real JiaoWuBao source ID. This is deliberate:
// a browser bundle loaded before support shipped must reject the page instead
// of mistaking the marker for a real branch and releasing teacher payroll.
export const JIAOWUBAO_COMPLETED_LESSON_UNKNOWN_BRANCH_ID = "~";

export function isJiaowubaoCompletedLessonUnknownBranchId(value: string) {
  return value === JIAOWUBAO_COMPLETED_LESSON_UNKNOWN_BRANCH_ID;
}

export function jiaowubaoCompletedLessonBranchDisplay(value: string) {
  return isJiaowubaoCompletedLessonUnknownBranchId(value)
    ? "未知（历史来源未提供）"
    : value;
}
