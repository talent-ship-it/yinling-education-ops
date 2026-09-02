import { randomUUID } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, hasValidDemoSession } from "@/lib/demo-auth";
import { getOpsState, OpsStoreError, putOpsState } from "@/lib/ops-store";
import { dispatchWecomCliText, isKnownWecomCliRecipient, normalizeWecomCliText } from "@/lib/wecom-cli-bridge";
import { hasWecomDispatchAuthorization, isSameOriginRequest, WECOM_DISPATCH_COOKIE_NAME } from "@/lib/wecom-dispatch-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StoredMessage = Record<string, unknown> & {
  id: string;
  body: string;
  status: string;
  recipientRef?: string;
};

type DispatchRequest = {
  messageId: string;
  expectedMessagesVersion: number;
};

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseDispatchRequest(value: unknown): DispatchRequest | null {
  if (!isRecord(value) || Object.keys(value).length !== 2) return null;
  const { messageId, expectedMessagesVersion } = value;
  if (typeof messageId !== "string" || !/^MSG-[A-Za-z0-9-]{1,80}$/.test(messageId)) return null;
  if (typeof expectedMessagesVersion !== "number" || !Number.isInteger(expectedMessagesVersion) || expectedMessagesVersion < 0) return null;
  return { messageId, expectedMessagesVersion };
}

function asMessages(value: unknown): StoredMessage[] | null {
  if (!Array.isArray(value)) return null;
  const messages: StoredMessage[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.body !== "string" || typeof entry.status !== "string") return null;
    messages.push(entry as StoredMessage);
  }
  return messages;
}

function replaceMessage(messages: StoredMessage[], messageId: string, changes: Record<string, unknown>) {
  return messages.map((message) => message.id === messageId ? { ...message, ...changes } : message);
}

async function updateMessageStatus(input: {
  messages: StoredMessage[];
  expectedVersion: number;
  messageId: string;
  changes: Record<string, unknown>;
}) {
  const rows = await putOpsState({
    entity: "messages",
    payload: replaceMessage(input.messages, input.messageId, input.changes),
    expectedVersion: input.expectedVersion,
    actor: "wecom-dispatch-system",
  });
  return rows[0];
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  if (!hasValidDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value)) return noStore({ error: "请先登录内部系统。" }, 401);
  if (!hasWecomDispatchAuthorization(cookieStore.get(WECOM_DISPATCH_COOKIE_NAME)?.value)) {
    return noStore({ error: "需要企业微信发送授权。", code: "authorization_required" }, 403);
  }
  if (!isSameOriginRequest(request)) return noStore({ error: "请求来源无效。" }, 403);

  const input = parseDispatchRequest(await request.json().catch(() => null));
  if (!input) return noStore({ error: "发送请求无效。" }, 400);

  try {
    const [current] = await getOpsState(["messages"]);
    if (!current) return noStore({ error: "消息队列尚未初始化。" }, 409);
    if (current.version !== input.expectedMessagesVersion) {
      return noStore({ error: "消息队列刚刚更新，请刷新后再发送。", currentVersion: current.version }, 409);
    }

    const messages = asMessages(current.payload);
    if (!messages) return noStore({ error: "消息队列数据格式无效。" }, 503);
    const message = messages.find((entry) => entry.id === input.messageId);
    if (!message) return noStore({ error: "找不到这条消息，请刷新后再试。" }, 404);
    if (message.status !== "待人工确认") return noStore({ error: "这条消息当前不能发送。" }, 409);

    const text = normalizeWecomCliText(message.body);
    const recipientRef = typeof message.recipientRef === "string" ? message.recipientRef : null;
    if (!text || !recipientRef || !isKnownWecomCliRecipient(recipientRef)) {
      return noStore({ error: "收件对象未映射到企业微信，或消息内容无效。" }, 409);
    }

    const deliveryId = randomUUID();
    const sending = await updateMessageStatus({
      messages,
      expectedVersion: current.version,
      messageId: message.id,
      changes: { status: "发送中", deliveryId, failureCode: null },
    });
    if (!sending) return noStore({ error: "无法锁定这条消息，请刷新后再试。" }, 409);

    const sent = await dispatchWecomCliText({ deliveryId, recipientRef, text });
    if (sent.kind === "unknown") {
      return noStore({ status: "uncertain", deliveryId, messageVersion: sending.version }, 202);
    }

    const sendingMessages = asMessages(sending.payload);
    if (!sendingMessages) return noStore({ status: "uncertain", deliveryId, messageVersion: sending.version }, 202);
    const changes = sent.kind === "sent"
      ? { status: "已发送", sentAt: new Date().toISOString(), failureCode: null }
      : { status: "发送失败", failureCode: sent.code };
    const completed = await updateMessageStatus({
      messages: sendingMessages,
      expectedVersion: sending.version,
      messageId: message.id,
      changes,
    });

    if (!completed) return noStore({ status: "uncertain", deliveryId, messageVersion: sending.version }, 202);
    if (sent.kind === "sent") return noStore({ status: "sent", deliveryId, messageVersion: completed.version });
    return noStore({ error: "企业微信未接受这条消息。", code: sent.code, messageVersion: completed.version }, 502);
  } catch (error) {
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "消息队列刚刚更新，请刷新后再发送。" }, 409);
    }
    return noStore({ error: "企业微信发送服务暂时不可用。" }, 503);
  }
}
