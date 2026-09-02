import "server-only";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getDemoSessionUser } from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";

type CookieReader = {
  get(name: string): { value: string } | undefined;
};

export function hasWecomDispatchAdminSession(cookieStore: CookieReader) {
  const actor = getDemoSessionUser(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  return actor === DEMO_ADMIN_USER && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
}
