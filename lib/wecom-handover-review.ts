export type WecomHandoverFilter = "pending" | "identified" | "all";
export type WecomHandoverCasePage = Readonly<{
  total: number;
  pendingCount: number;
  nextCursor: string | null;
  rows: readonly Readonly<{
    id: string;
    wechatName: string;
    studentName: string | null;
    operationsOwner: string | null;
    coursePlanner: string | null;
    status: "awaiting_student_name" | "identified" | "identity_conflict" | "identity_ambiguous";
    createdAt: string;
  }>[];
}>;

export function wecomHandoverFilter(value: unknown): WecomHandoverFilter {
  return value === "identified" || value === "all" ? value : "pending";
}

export function wecomHandoverCursor(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value : null;
}
