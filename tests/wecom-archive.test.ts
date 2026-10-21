import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  normalizeWecomArchiveBatch,
  WecomArchiveParseError,
} from "../lib/wecom-archive";

const sentAt = "2026-09-01T00:15:00.000Z";

function base(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "synthetic-message-1",
    chatId: "synthetic-room-1",
    senderId: "synthetic-user-1",
    sentAt,
    messageType: "text",
    text: "普通内部讨论",
    media: [],
    ...overrides,
  };
}

test("normalises official aliases and detects a structured information handover", () => {
  const [result] = normalizeWecomArchiveBatch({ records: [{
    msgid: "synthetic-official-1",
    roomid: "synthetic-room-1",
    from: "synthetic-user-1",
    msgtime: Date.parse(sentAt),
    msgtype: "text",
    action: "send",
    tolist: ["synthetic-user-2"],
    text: { content: "信息交接表\n学生姓名：Mia示例\n家长微信名：Parent-Synthetic\n科目：English" },
    media: [],
  }] });
  assert.deepEqual(result, {
    messageId: "synthetic-official-1",
    chatId: "synthetic-room-1",
    senderId: "synthetic-user-1",
    sentAt,
    messageType: "text",
    text: "信息交接表\n学生姓名:Mia示例\n家长微信名:Parent-Synthetic\n科目:English",
    classification: "handover",
    studentNameHint: "Mia示例",
    guardianWechatHint: "Parent-Synthetic",
    operationsOwnerHint: null,
    coursePlannerHint: null,
    media: [],
  });
});

test("extracts the trial identity bridge and staff assignments from explicit labels", () => {
  const [result] = normalizeWecomArchiveBatch([base({
    messageId: "synthetic-trial-identity-1",
    text: "[Rose]试听LP 信息交接[Rose]\n【微信名】：Parent Synthetic\n【教务】：Thea\n【课程规划老师】：Elaine@Insider Leads\n【学生】：",
  })]);
  assert.equal(result?.classification, "handover");
  assert.equal(result?.studentNameHint, null);
  assert.equal(result?.guardianWechatHint, "Parent Synthetic");
  assert.equal(result?.operationsOwnerHint, "Thea");
  assert.equal(result?.coursePlannerHint, "Elaine@Insider Leads");
});

test("treats a later same-group WeChat-name plus student-name message as a handover identity update", () => {
  const [result] = normalizeWecomArchiveBatch([base({
    messageId: "synthetic-trial-identity-2",
    text: "【微信名】：Parent Synthetic\n【学生姓名】：Mia Example米娅",
  })]);
  assert.equal(result?.classification, "handover");
  assert.equal(result?.guardianWechatHint, "Parent Synthetic");
  assert.equal(result?.studentNameHint, "Mia Example米娅");
});

test("classifies renewal screenshots and extracts only one explicit student hint", () => {
  const [result] = normalizeWecomArchiveBatch([base({
    messageId: "synthetic-renewal-1",
    text: "🌻 Lydia示例，续费前跟进",
    contextText: ["续费前跟进有了的话，Report群发聊天截图"],
  })]);
  assert.equal(result?.classification, "renewal_follow_up");
  assert.equal(result?.studentNameHint, "Lydia示例");
  assert.equal(result?.guardianWechatHint, null);

  const [ambiguous] = normalizeWecomArchiveBatch([base({
    messageId: "synthetic-renewal-2",
    text: "🌻 Lydia示例，续费前跟进\n🌸 Carlos示例，续费前跟进",
  })]);
  assert.equal(ambiguous?.classification, "renewal_follow_up");
  assert.equal(ambiguous?.studentNameHint, null);
});

test("uses nearby context only for explicit guardian labels", () => {
  const [result] = normalizeWecomArchiveBatch([base({
    messageId: "synthetic-context-1",
    text: "信息交接表",
    contextText: ["家长微信名：SyntheticParent", "销售老师说请尽快处理"],
  })]);
  assert.equal(result?.guardianWechatHint, "SyntheticParent");
  assert.equal(result?.studentNameHint, null);
});

test("verifies downloaded media bytes, derives a digest, and upgrades the type to mixed", () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("synthetic-image")]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const [result] = normalizeWecomArchiveBatch([base({
    messageId: "synthetic-media-1",
    text: "续费前跟进截图",
    media: [{
      mediaKey: "synthetic-media-key-1",
      fileName: "../follow-up.jpg",
      contentType: "image/jpeg",
      contentBase64: bytes.toString("base64"),
      sha256: digest,
    }],
  })]);
  assert.equal(result?.messageType, "mixed");
  assert.equal(result?.classification, "renewal_follow_up");
  assert.deepEqual(result?.media[0], {
    mediaKey: "synthetic-media-key-1",
    fileName: ".._follow-up.jpg",
    contentType: "image/jpeg",
    contentBase64: bytes.toString("base64"),
    sha256: digest,
  });
});

test("requires archive media bytes and rejects integrity or claimed-classification mismatches", () => {
  assert.throws(
    () => normalizeWecomArchiveBatch([base({ messageType: "image", text: "", media: [] })]),
    (error: unknown) => error instanceof WecomArchiveParseError && error.code === "media_missing",
  );
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("synthetic-image")]);
  assert.throws(
    () => normalizeWecomArchiveBatch([base({
      media: [{
        mediaKey: "synthetic-media-key-2",
        fileName: "image.png",
        contentType: "image/png",
        contentBase64: bytes.toString("base64"),
      }],
    })]),
    (error: unknown) => error instanceof WecomArchiveParseError && error.code === "media_integrity_mismatch",
  );
  assert.throws(
    () => normalizeWecomArchiveBatch([base({ classification: "handover" })]),
    (error: unknown) => error instanceof WecomArchiveParseError && error.code === "classification_mismatch",
  );
});

test("deduplicates exact retries but rejects conflicting message IDs and unexpected fields", () => {
  const duplicate = base();
  assert.equal(normalizeWecomArchiveBatch([duplicate, { ...duplicate }]).length, 1);
  assert.throws(
    () => normalizeWecomArchiveBatch([duplicate, { ...duplicate, text: "changed" }]),
    (error: unknown) => error instanceof WecomArchiveParseError && error.code === "idempotency_conflict",
  );
  assert.throws(
    () => normalizeWecomArchiveBatch([{ ...duplicate, rawSecretPayload: "forbidden" }]),
    (error: unknown) => error instanceof WecomArchiveParseError && error.code === "unexpected_field",
  );
});

test("rejects conflicting aliases and repeated media keys, and emits well-formed filenames", () => {
  assert.throws(
    () => normalizeWecomArchiveBatch([base({ msgid: "different-message-id" })]),
    (error: unknown) => error instanceof WecomArchiveParseError && error.code === "alias_conflict",
  );
  assert.throws(
    () => normalizeWecomArchiveBatch([base({ msgtime: Date.parse(sentAt) + 1_000 })]),
    (error: unknown) => error instanceof WecomArchiveParseError && error.code === "alias_conflict",
  );

  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("synthetic-image")]);
  const media = {
    mediaKey: "repeated-media-key",
    fileName: "one.jpg",
    contentType: "image/jpeg",
    contentBase64: bytes.toString("base64"),
  };
  assert.throws(
    () => normalizeWecomArchiveBatch([base({ media: [media, { ...media, fileName: "two.jpg" }] })]),
    (error: unknown) => error instanceof WecomArchiveParseError && error.code === "duplicate_media_key",
  );

  const [normalised] = normalizeWecomArchiveBatch([base({
    messageId: "synthetic-well-formed-filename",
    media: [{ ...media, mediaKey: "well-formed-media", fileName: `prefix-\ud800-${"😀".repeat(200)}.jpg` }],
  })]);
  const fileName = normalised?.media[0]?.fileName ?? "";
  assert.doesNotThrow(() => encodeURIComponent(fileName));
  assert.ok(Array.from(fileName).every((point) => {
    const codePoint = point.codePointAt(0) ?? 0;
    return codePoint < 0xd800 || codePoint > 0xdfff;
  }));
});


test("explicit business labels route concise student handovers without a guardian", () => {
  for (const text of [
    "LP类型：老生新LP\n学生：Synthetic Student\n安排科目：English\n安排老师：Synthetic Teacher",
    "【ＬＰ类型】：二次试听\n【学生】：Synthetic Student\n【新老师】：Synthetic Teacher\n重听原因：Adjust pacing",
    "业务类型：老师LP修改\n学生：Synthetic Student\n涉及科目：English\n变动内容：Adjust goal",
  ]) {
    const [result] = normalizeWecomArchiveBatch([base({ text })]);
    assert.equal(result.classification, "handover");
    assert.equal(result.studentNameHint, "Synthetic Student");
    assert.equal(result.guardianWechatHint, null);
  }
});

test("neighboring type labels and prose do not turn unrelated messages into handovers", () => {
  const template = "业务类型：老师LP修改\n学生：Synthetic Student\n涉及科目：English\n变动内容：Adjust goal";
  for (const record of [
    base({ text: "普通内部讨论", contextText: [template] }),
    base({ text: "备注：业务类型：老师LP修改\n学生：Synthetic Student" }),
    base({ text: "业务类型：未知业务\n学生：Synthetic Student" }),
    base({ text: "业务类型：老师LP修改\n涉及科目：English\n变动内容：Adjust goal" }),
  ]) assert.equal(normalizeWecomArchiveBatch([record])[0].classification, "other");
});
