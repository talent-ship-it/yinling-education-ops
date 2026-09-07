export const MIRROR_REVIEW_KINDS = ["task", "schedule", "finding", "capture"] as const;
export type MirrorReviewKind = typeof MIRROR_REVIEW_KINDS[number];
export type MirrorReviewRow = { rowNumber: number; kind: MirrorReviewKind; sourceCapture: string; body: Record<string, unknown> };
export type MirrorReview = {
 batch: null | { id: string; groupName: string; capturedAt: string; publishedAt: string; sourceRevision: string; summary: Record<string, unknown> };
 rows: MirrorReviewRow[]; total: number; counts: Partial<Record<MirrorReviewKind, number>>; page: number;
};
export function mirrorReviewFilters(params: URLSearchParams) {
 const rawKind = params.get("kind");
 const kind: MirrorReviewKind = MIRROR_REVIEW_KINDS.includes(rawKind as MirrorReviewKind) ? rawKind as MirrorReviewKind : "task";
 const pageValue = Number(params.get("page") || 1);
 const page = Number.isInteger(pageValue) && pageValue >= 1 && pageValue <= 100 ? pageValue : 1;
 return { kind, page, query: (params.get("q") || "").trim().slice(0, 100) };
}
export function reviewText(body: Record<string, unknown>, key: string) {
 return typeof body[key] === "string" ? body[key] : "";
}
