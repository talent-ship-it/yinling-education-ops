import "server-only";

import { cookies } from "next/headers";

import {
  DEMO_COOKIE_NAME,
  getCurrentDemoSession,
} from "@/lib/demo-auth";
import type { DemoSessionIdentity } from "@/lib/demo-session-token";
import {
  hasFullAdminAccess,
  NIXON_COOKIE_NAME,
} from "@/lib/nixon-auth";

export type AccountRequestSession = DemoSessionIdentity & Readonly<{
  accountId: string;
}>;

export type AccountRequestContext = Readonly<{
  session: AccountRequestSession;
  fullAdmin: boolean;
  cookieValue: string;
}>;

export type AccountRequestContextResolution =
  | { context: AccountRequestContext }
  | { error: string; status: 401 | 403 | 409 | 503 };

export async function resolveAccountRequestContext(options: Readonly<{
  allowPasswordChangeRequired?: boolean;
}> = {}): Promise<AccountRequestContextResolution> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(DEMO_COOKIE_NAME)?.value ?? "";
  const resolved = await getCurrentDemoSession(cookieValue, {
    allowPasswordChangeRequired: options.allowPasswordChangeRequired,
  });
  if (!("session" in resolved)) return { error: resolved.error, status: resolved.status };
  if (!resolved.session.accountId) {
    return { error: "账号目录尚未建立，请退出后重新登录。", status: 409 };
  }
  const session = resolved.session as AccountRequestSession;
  return {
    context: {
      session,
      cookieValue,
      fullAdmin: hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value),
    },
  };
}
