import type { NormalizedWecomBotRecord } from "./wecom-bot-receiver";
import { normalizeWecomArchiveBatch } from "./wecom-archive";
import { trialAccountLetter } from "./trial-account-label";

function addressedMixedScriptName(candidate: string, addressed: boolean) {
  return addressed && /^[A-Z][a-z]{1,29}[\p{Script=Han}]{2,4}$/u.test(candidate);
}

export function quotedWecomStudentName(value: string | undefined) {
  const reply = (value ?? "").normalize("NFKC").trim();
  const mention = /(?:\s*[@＠]教务\s*AI\s*助手)+\s*$/iu;
  const text = reply.replace(mention, "").trim();
  const labelled = text.match(/^(?:【)?(?:学生姓名|学生真实姓名|真实姓名|学生|姓名)(?:】)?\s*[:：]\s*(.+)$/u);
  const candidate = (labelled?.[1] ?? text).trim();
  if (trialAccountLetter(candidate) || candidate.length < 2 || candidate.length > 80 || /[\r\n]/u.test(candidate)
    || /^(?:待确认|待补充|未知|未提供|暂无|无|unknown|tbd|none|n\/?a)$/iu.test(candidate)) return null;
  if (!/^(?:[\p{Script=Latin}\p{M}'’.-]+(?: +[\p{Script=Latin}\p{M}'’.-]+){0,3})?[\p{Script=Han}]{0,8}$/u.test(candidate)) return null;
  if (!labelled && !addressedMixedScriptName(candidate, mention.test(reply))) return null;
  return candidate;
}

/**
 * Bot callbacks do not carry the authenticated archive-worker context, so
 * they use a narrower ingress contract. Text callbacks still use the same
 * deterministic classifier and explicit identity-hint extraction as the
 * archive worker before persistence. Trial handovers are additionally grouped
 * by the explicit WeChat name while the student name is still unknown. The
 * database may auto-link only a unique exact active-student match; everything
 * else remains in the review inbox without projecting business state.
 */
export function enrichWecomBotRecords(
  records: readonly NormalizedWecomBotRecord[],
): readonly Readonly<Record<string, unknown>>[] {
  const textInputs = records
    .filter((record) => record.messageType === "text" && !record.quote)
    .map((record) => ({
      messageId: record.messageId,
      chatId: record.chatId,
      senderId: record.senderId,
      sentAt: record.sentAt,
      messageType: record.messageType,
      text: record.text ?? "",
      media: [],
    }));

  const archiveRecords = textInputs.length ? normalizeWecomArchiveBatch({ records: textInputs }) : [];
  const archiveById = new Map(archiveRecords.map((record) => [record.messageId, record]));

  return Object.freeze(records.map((record) => {
    if (record.quote) {
      const quotedStudentName = quotedWecomStudentName(record.text);
      return Object.freeze({ ...record, ...(quotedStudentName ? { quotedStudentName } : {}) });
    }
    const archiveRecord = archiveById.get(record.messageId);
    if (!archiveRecord) return record;

    const metadata: Record<string, string> = {};
    if (archiveRecord.classification !== "other") metadata.classification = archiveRecord.classification;
    if (archiveRecord.studentNameHint) metadata.studentNameHint = archiveRecord.studentNameHint;
    if (archiveRecord.guardianWechatHint) metadata.guardianWechatHint = archiveRecord.guardianWechatHint;
    if (archiveRecord.operationsOwnerHint) metadata.operationsOwnerHint = archiveRecord.operationsOwnerHint;
    if (archiveRecord.coursePlannerHint) metadata.coursePlannerHint = archiveRecord.coursePlannerHint;
    return Object.freeze({ ...record, ...metadata });
  }));
}
