export class TrialScreenshotError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function screenshotFail(status: number, code: string, message: string): never { throw new TrialScreenshotError(status, code, message); }
export function screenshotRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
export function screenshotText(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
export function screenshotNormalise(value: unknown) { return screenshotText(value).normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase("en-AU"); }
export function screenshotJson(payload: unknown, status = 200) { return Response.json(payload, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } }); }
