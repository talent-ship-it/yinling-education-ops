export const DEMO_ADMIN_USER = "Nixon";
export const DEMO_LIMITED_ADMIN_USER = "Ops Admin";
export const DEMO_STAFF_USERS = ["Abby", "Ella", "Molly", "Thea", "Tiffany"] as const;
export const DEMO_TEACHER_USERS = ["Helen Ceperkovic", "Shirley Li", "Anna Zhang"] as const;

export type DemoLimitedAdminUser = typeof DEMO_LIMITED_ADMIN_USER;
export type DemoStaffUser = (typeof DEMO_STAFF_USERS)[number];
export type DemoTeacherUser = (typeof DEMO_TEACHER_USERS)[number];
export type DemoUser = typeof DEMO_ADMIN_USER | DemoLimitedAdminUser | DemoStaffUser | DemoTeacherUser;

function normalise(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function isDemoTeacher(user: string): user is DemoTeacherUser {
  return DEMO_TEACHER_USERS.some((teacher) => normalise(teacher) === normalise(user));
}

export function isDemoStaff(user: string): user is DemoStaffUser {
  return DEMO_STAFF_USERS.some((staff) => normalise(staff) === normalise(user));
}
