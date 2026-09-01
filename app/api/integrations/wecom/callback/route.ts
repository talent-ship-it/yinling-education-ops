import { NextResponse } from "next/server";

import {
  encryptedWecomXmlField,
  WECOM_CALLBACK_MAX_BODY_BYTES,
  wecomCallbackHttpConfiguration,
} from "@/lib/wecom-callback-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function textResponse(body: string, status = 200) {
  return new NextResponse(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function callbackRequest(url: URL, encrypted: string) {
  return {
    msgSignature: url.searchParams.get("msg_signature") ?? "",
    timestamp: url.searchParams.get("timestamp") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
    encrypted,
  };
}

async function boundedBody(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/u.test(contentLength)
    || Number(contentLength) > WECOM_CALLBACK_MAX_BODY_BYTES)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > WECOM_CALLBACK_MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    return null;
  }
}

/** Standard app callback URL verification; conversation-archive records use the separate bridge. */
export async function GET(request: Request) {
  const configuration = wecomCallbackHttpConfiguration();
  if (!configuration.ready || !configuration.crypto) return textResponse("Not found", 404);
  const url = new URL(request.url);
  const encrypted = url.searchParams.get("echostr") ?? "";
  try {
    const decrypted = configuration.crypto.decrypt(callbackRequest(url, encrypted));
    return textResponse(decrypted.message);
  } catch {
    return textResponse("Not found", 404);
  }
}

/** Authenticates ordinary WeCom app events but never treats them as archive history. */
export async function POST(request: Request) {
  const configuration = wecomCallbackHttpConfiguration();
  if (!configuration.ready || !configuration.crypto) return textResponse("Not found", 404);
  if (!/^\s*(?:text|application)\/xml(?:\s*;|\s*$)/iu.test(request.headers.get("content-type") ?? "")) {
    return textResponse("Unsupported media type", 415);
  }
  const body = await boundedBody(request);
  const encrypted = body === null ? null : encryptedWecomXmlField(body);
  if (!encrypted) return textResponse("Invalid request", body === null ? 413 : 400);
  try {
    configuration.crypto.decrypt(callbackRequest(new URL(request.url), encrypted));
    return textResponse("success");
  } catch {
    return textResponse("Not found", 404);
  }
}
