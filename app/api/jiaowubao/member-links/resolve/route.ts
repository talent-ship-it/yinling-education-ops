import { NextRequest, NextResponse } from "next/server";

import { fetchJiaowubaoMembers, JiaowubaoMemberApiError } from "@/lib/jiaowubao/member-client";
import { hasMonthlyPayrollDashboardAccess } from "@/lib/jiaowubao/monthly-payroll-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Candidate = { localId: string; name: string };

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

/** Comparison is exact after harmless Unicode/case/spacing normalisation; no aliases or partial names. */
function comparableName(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en").replace(/[\s·・.，,，'’`\-—_()（）\[\]【】]/g, "");
}

function candidatesFrom(body: unknown): Candidate[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { candidates?: unknown }).candidates)) return [];
  const values = (body as { candidates: unknown[] }).candidates;
  if (values.length < 1 || values.length > 15) throw new Error("每次只能精确匹配 1 至 15 位学生，以保护接口限流和浏览器响应时间。");
  const candidates = values.map((value) => {
    if (!value || typeof value !== "object") throw new Error("学生关联参数格式不正确。");
    const item = value as Record<string, unknown>;
    const localId = typeof item.localId === "string" ? item.localId.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!localId || name.length < 2 || name.length > 100) throw new Error("每位学生必须提供有效的本地编号和姓名。");
    return { localId, name };
  });
  if (new Set(candidates.map((candidate) => candidate.localId)).size !== candidates.length) throw new Error("学生编号不能重复。");
  return candidates;
}

export async function POST(request: NextRequest) {
  if (!(await hasMonthlyPayrollDashboardAccess())) return noStore({ error: "请先输入访问密码。" }, 401);
  try {
    const candidates = candidatesFrom(await request.json().catch(() => null));
    if (!candidates.length) return noStore({ error: "请提供需要精确匹配的学生。" }, 400);
    const results = [];
    for (const candidate of candidates) {
      const result = await fetchJiaowubaoMembers({ keyword: candidate.name }, { maxPages: 1 });
      const matches = result.members.filter((member) => member.memberName && comparableName(member.memberName) === comparableName(candidate.name));
      results.push({
        localId: candidate.localId,
        localName: candidate.name,
        status: matches.length === 1 ? "matched" : matches.length === 0 ? "not_found" : "ambiguous",
        memberId: matches.length === 1 ? matches[0].memberId : null,
        memberName: matches.length === 1 ? matches[0].memberName : null,
        candidates: matches.map((member) => ({ memberId: member.memberId, memberName: member.memberName })),
      });
    }
    return noStore({ results, persistence: { saved: false, message: "只返回姓名规范化后完全一致且唯一的结果；客户端仍会把关联写入本地学生档案。" } });
  } catch (error) {
    if (error instanceof JiaowubaoMemberApiError) return noStore({ error: error.message }, error.code === "configuration" ? 422 : 502);
    return noStore({ error: error instanceof Error ? error.message : "教务宝学生 ID 精确匹配失败。" }, 400);
  }
}
