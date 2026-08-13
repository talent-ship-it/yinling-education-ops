import { normaliseDemoIdentity, type DemoSessionIdentity } from "@/lib/demo-session-token";
import {
  DEMO_ADMIN_USER,
  DEMO_LIMITED_ADMIN_USER,
  resolveDemoStaffAlias,
  resolveDemoStaffName,
} from "@/lib/demo-users";

export type TeacherIdentityResolution =
  | { identity: DemoSessionIdentity }
  | { error: string; status: 401 | 409 | 503 };

const PRIVILEGED_IDENTITY_NAMES = new Set(
  [DEMO_ADMIN_USER, DEMO_LIMITED_ADMIN_USER].map(normaliseDemoIdentity),
);

type TeacherRosterLookup =
  | { matches: string[] }
  | { error: string; status: 503 };

export function lookupTeacherRosterIdentity(candidate: unknown, payload: unknown): TeacherRosterLookup {
  if (!Array.isArray(payload)) {
    return { error: "老师名册暂时无法核对，请稍后重试。", status: 503 };
  }
  const names: string[] = [];
  for (const value of payload) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "老师名册暂时无法核对，请稍后重试。", status: 503 };
    }
    const teacher = value as { id?: unknown; name?: unknown };
    const name = teacher.name;
    if (typeof teacher.id !== "string" || !teacher.id.trim() || typeof name !== "string" || !name.trim()) {
      return { error: "老师名册暂时无法核对，请稍后重试。", status: 503 };
    }
    names.push(name.normalize("NFKC").trim());
  }
  if (typeof candidate !== "string" || !candidate.trim()) return { matches: [] };
  const expected = normaliseDemoIdentity(candidate);
  return { matches: names.filter((name) => normaliseDemoIdentity(name) === expected) };
}

export function resolveTeacherIdentity(candidate: unknown, teachersPayload: unknown): TeacherIdentityResolution {
  if (typeof candidate !== "string" || !candidate.trim()) {
    return { error: "密码不正确。", status: 401 };
  }
  const lookup = lookupTeacherRosterIdentity(candidate, teachersPayload);
  if ("error" in lookup) return lookup;
  const { matches } = lookup;
  if (matches.length > 1) {
    return { error: "老师姓名重复，暂时无法用姓名登录。请联系教务处理。", status: 409 };
  }
  const explicitStaff = resolveDemoStaffAlias(candidate);
  if (explicitStaff) {
    return matches.length === 0
      ? { identity: { user: explicitStaff, role: "staff" } }
      : { error: "该登录名同时属于教务账号和老师名册，请联系管理员处理。", status: 409 };
  }
  if (matches.length === 1) {
    if (PRIVILEGED_IDENTITY_NAMES.has(normaliseDemoIdentity(matches[0]))) {
      return { error: "该姓名属于系统管理账号，请联系管理员处理。", status: 409 };
    }
    return { identity: { user: matches[0], role: "teacher" } };
  }

  const staff = resolveDemoStaffName(candidate);
  return staff
    ? { identity: { user: staff, role: "staff" } }
    : { error: "密码不正确。", status: 401 };
}

export function validateTeacherSession(identity: DemoSessionIdentity, teachersPayload: unknown): TeacherIdentityResolution {
  if (identity.role !== "teacher") return { identity };
  const lookup = lookupTeacherRosterIdentity(identity.user, teachersPayload);
  if ("error" in lookup) return lookup;
  if (lookup.matches.length === 1) return { identity: { user: lookup.matches[0], role: "teacher" } };
  return { error: "老师登录状态已失效，请重新登录。", status: 401 };
}
