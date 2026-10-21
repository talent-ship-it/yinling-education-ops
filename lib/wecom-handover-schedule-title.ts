import { trialAccountLetter } from "./trial-account-label";
import { jiaowubaoTrialStudentNameFromCourseTitle } from "./trial-operations";

export function wecomHandoverScheduleTitleName(value: unknown): string | null {
  const title = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  const capture = title.match(/^.*[-–—]\s+(.{1,80}?)\s*试听(?:课)?\s*$/u)?.[1]?.trim();
  if (!capture || !/^[A-Za-z '’.\-\u4e00-\u9fff]+$/u.test(capture)) return null;
  const compact = capture.replace(/([A-Za-z])[ ._'’\-]+(?=[\u4e00-\u9fff])/gu, "$1");
  if (!/^[A-Za-z'’.\-]+(?: +[A-Za-z'’.\-]+){0,3}[\u4e00-\u9fff]{0,8}$/u.test(compact) || !/[A-Za-z]/u.test(compact)) return null;
  const name = jiaowubaoTrialStudentNameFromCourseTitle(title);
  const generic = compact.toLowerCase().replace(/ +/gu, "");
  if (name !== compact || trialAccountLetter(name) || /^(?:unknown|tbd|na|none|null|student|unknownstudent|newstudent|trialstudent|placeholder|pending|notprovided|notknown)$/u.test(generic)) return null;
  return /^(?:(?:english|mathematics|maths?|verbalreasoning|reading|writing|science|physics|chemistry|biology|aes|trial))+$/u.test(generic) ? null : name;
}
