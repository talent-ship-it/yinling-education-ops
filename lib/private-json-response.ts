import { gzipSync } from "node:zlib";
import { NextResponse } from "next/server";

/** Preserve the complete private payload while keeping large state reads below host response limits. */
export function privateJsonResponse(payload: unknown, request?: Request, status = 200) {
  const json = JSON.stringify(payload);
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Accept-Encoding",
  });
  const acceptsGzip = request?.headers.get("accept-encoding")?.split(",").some((part) => {
    const [name, ...options] = part.trim().toLowerCase().split(";");
    return name === "gzip" && !options.some((option) => /^\s*q=0(?:\.0*)?\s*$/u.test(option));
  });
  if (acceptsGzip && Buffer.byteLength(json) >= 128 * 1024) {
    headers.set("Content-Encoding", "gzip");
    return new NextResponse(new Uint8Array(gzipSync(json)), { status, headers });
  }
  return new NextResponse(json, { status, headers });
}
