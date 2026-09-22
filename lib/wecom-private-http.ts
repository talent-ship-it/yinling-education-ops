import { NextResponse } from "next/server";

import {
  hasWecomArchiveBridgeToken,
  readBoundedWecomArchiveJson,
  wecomArchiveBridgeConfiguration,
} from "@/lib/wecom-archive-bridge";

type WecomArchiveBridgeConfiguration = ReturnType<typeof wecomArchiveBridgeConfiguration>;

export function wecomNoStoreJson(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function rejectUntrustedWecomJsonRequest(
  request: Request,
  configuration: WecomArchiveBridgeConfiguration,
) {
  if (!hasWecomArchiveBridgeToken(request.headers.get("authorization"), configuration)) {
    return wecomNoStoreJson({ error: "Not found" }, 404);
  }
  if (!/^application\/json(?:\s*;|\s*$)/iu.test(request.headers.get("content-type") ?? "")) {
    return wecomNoStoreJson({ error: "Unsupported media type" }, 415);
  }
  return null;
}

export async function readTrustedWecomJsonRequest(request: Request) {
  const configuration = wecomArchiveBridgeConfiguration();
  const rejection = rejectUntrustedWecomJsonRequest(request, configuration);
  if (rejection) return { rejection } as const;
  const payload = await readBoundedWecomArchiveJson(request);
  return { configuration, payload } as const;
}
