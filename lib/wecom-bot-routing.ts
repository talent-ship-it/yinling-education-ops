import type { NormalizedWecomBotRecord } from "./wecom-bot-receiver";
import { normalizeWecomArchiveBatch } from "./wecom-archive";

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
    .filter((record) => record.messageType === "text")
    .map((record) => ({
      messageId: record.messageId,
      chatId: record.chatId,
      senderId: record.senderId,
      sentAt: record.sentAt,
      messageType: record.messageType,
      text: record.text ?? "",
      media: [],
    }));

  if (!textInputs.length) return Object.freeze([...records]);

  const archiveRecords = normalizeWecomArchiveBatch({ records: textInputs });
  const archiveById = new Map(archiveRecords.map((record) => [record.messageId, record]));

  return Object.freeze(records.map((record) => {
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
