export const DEMO_ADMIN_USER = "Nixon";
export const DEMO_LIMITED_ADMIN_USER = "Ops Admin";
export const DEMO_STAFF_USERS = ["Abby", "Ella", "Molly", "Thea", "Tiffany", "Tara", "Eileen", "思佳"] as const;
export const DEMO_TEACHER_USERS = ["Helen Ceperkovic", "Shirley Li", "Anna Zhang", "Nixon（测试）"] as const;

export type DemoLimitedAdminUser = typeof DEMO_LIMITED_ADMIN_USER;
export type DemoStaffUser = (typeof DEMO_STAFF_USERS)[number];
export type DemoTeacherUser = (typeof DEMO_TEACHER_USERS)[number];
/**
 * Session identities can include any teacher currently present in the
 * server-owned teacher roster. The literal arrays above remain only as sample
 * identities for seeded/demo data; they are not an authentication boundary.
 */
export type DemoUser = string;

export const DEMO_STAFF_LOGIN_ROLE = "教务";

export function normaliseDemoUserName(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-AU");
}

export function demoStaffLoginAlias(user: DemoStaffUser) {
  return `${user} ${DEMO_STAFF_LOGIN_ROLE}`;
}

export function resolveDemoStaffAlias(candidate: unknown): DemoStaffUser | null {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const normalizedCandidate = normaliseDemoUserName(candidate);
  return DEMO_STAFF_USERS.find(
    (staff) => normaliseDemoUserName(demoStaffLoginAlias(staff)) === normalizedCandidate,
  ) ?? null;
}

export function resolveDemoStaffName(candidate: unknown): DemoStaffUser | null {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const normalizedCandidate = normaliseDemoUserName(candidate);
  return DEMO_STAFF_USERS.find(
    (staff) => normaliseDemoUserName(staff) === normalizedCandidate,
  ) ?? null;
}

export function isDemoTeacher(user: string): user is DemoTeacherUser {
  return DEMO_TEACHER_USERS.some((teacher) => normaliseDemoUserName(teacher) === normaliseDemoUserName(user));
}

export function isDemoStaff(user: string): user is DemoStaffUser {
  return DEMO_STAFF_USERS.some((staff) => normaliseDemoUserName(staff) === normaliseDemoUserName(user));
}
