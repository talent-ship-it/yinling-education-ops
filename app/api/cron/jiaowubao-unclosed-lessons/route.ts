import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { syncJiaowubaoUnclosedLessons } from "@/lib/jiaowubao-unclosed-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function validSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= 32;
}

function authorizationBuffer(request: Request) {
  return Buffer.from(request.headers.get("authorization") ?? "");
}

function authorized(request: Request) {
  if (process.env.JIAOWUBAO_UNCLOSED_TASKS_ENABLED !== "true") return false;
  const secret = process.env.JIAOWUBAO_UNCLOSED_SYNC_TOKEN;
  if (!validSecret(secret)) return false;
  const supplied = authorizationBuffer(request);
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  if (!authorized(request)) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  try {
    return NextResponse.json({ outcome: "complete", ...await syncJiaowubaoUnclosedLessons() }, { headers });
  } catch {
    return NextResponse.json({ error: "未结课采集未确认完成，请重试。" }, { status: 503, headers });
  }
}
