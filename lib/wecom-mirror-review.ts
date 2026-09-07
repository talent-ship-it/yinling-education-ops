export const MIRROR_REVIEW_KINDS = ["task", "schedule", "finding", "capture"] as const;
export type MirrorReviewKind = typeof MIRROR_REVIEW_KINDS[number];
export type MirrorReviewRow = { rowNumber: number; kind: MirrorReviewKind; sourceCapture: string; body: Record<string, unknown>; task?: null | { id: string; status: string | null; owner: string | null; dueAt: string | null } };
export type MirrorReview = {
 batches: { id: string; groupName: string; capturedAt: string }[];
 batch: null | { id: string; groupName: string; capturedAt: string; publishedAt: string; sourceRevision: string; summary: Record<string, unknown> };
 rows: MirrorReviewRow[]; total: number; counts: Partial<Record<MirrorReviewKind, number>>; page: number;
};
export function mirrorReviewFilters(params: URLSearchParams) {
 const rawKind = params.get("kind");
 const kind: MirrorReviewKind = MIRROR_REVIEW_KINDS.includes(rawKind as MirrorReviewKind) ? rawKind as MirrorReviewKind : "task";
 const pageValue = Number(params.get("page") || 1);
 const page = Number.isInteger(pageValue) && pageValue >= 1 && pageValue <= 100 ? pageValue : 1;
 const batch = params.get("batch") || "";
 return { kind, page, query: (params.get("q") || "").trim().slice(0, 100), batch: /^wxm-[a-f0-9]{32}$/.test(batch) ? batch : "" };
}
export function reviewText(body: Record<string, unknown>, key: string) {
 return typeof body[key] === "string" ? body[key] : "";
}
