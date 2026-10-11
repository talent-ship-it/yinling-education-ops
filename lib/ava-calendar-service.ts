import type { DemoSessionIdentity } from "./demo-session-token";
import type { OpsStateRow, OpsVersionRow } from "./ops-store";
import type { AvaCoordinatorAccount } from "./ava-calendar-projection";
import type { AvaCalendarSnapshot, AvaCalendarWindow } from "./ava-calendar-snapshot";
import { AvaCalendarReadError, validateAvaCalendarWindow } from "./ava-calendar-snapshot";
import { buildOpsAccessContext, canReadOpsEntity } from "./ops-access";
import { projectAvaCalendarEvents } from "./ava-calendar-projection";

export type AvaCalendarDependencies = {
  readSession: () => Promise<{ session: DemoSessionIdentity; fullAdmin: boolean } | { error: string; status: number }>;
  readRows: () => Promise<OpsStateRow[]>;
  readVersions: () => Promise<OpsVersionRow[]>;
  readAccounts: () => Promise<readonly AvaCoordinatorAccount[]>;
  readSnapshot: (window: AvaCalendarWindow) => Promise<AvaCalendarSnapshot>;
};

const ENTITIES = ["students", "teachers", "bookings", "lpItems"];
const HEADERS = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: HEADERS });
}

function versions(rows: OpsVersionRow[]) {
  return ENTITIES.map((entity) => {
    const matches = rows.filter((row) => row.entity === entity);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0]!.version) || matches[0]!.version < 0) throw new AvaCalendarReadError("source_unavailable");
    return matches[0]!.version;
  });
}

function accountVersions(accounts: readonly AvaCoordinatorAccount[]) {
  return JSON.stringify(accounts.map((account) => [account.account_id, account.account_name, account.account_role, account.status]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

function requestWindow(request: Request) {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => !["start", "end"].includes(key)) || params.getAll("start").length !== 1 || params.getAll("end").length !== 1) throw new AvaCalendarReadError("invalid_window");
  const window = { start: params.get("start")!, end: params.get("end")! };
  validateAvaCalendarWindow(window);
  return window;
}

function validateRowPayloads(rows: OpsStateRow[]) {
  if (ENTITIES.some((entity) => !Array.isArray(rows.find((row) => row.entity === entity)?.payload))) throw new AvaCalendarReadError("source_unavailable");
}

type CalendarAuthority = {
  session: Awaited<ReturnType<AvaCalendarDependencies["readSession"]>>;
  accounts: readonly AvaCoordinatorAccount[];
};

function validateCurrentAuthority(initial: CalendarAuthority & { versions: number[] }, current: CalendarAuthority & { versions: OpsVersionRow[] }) {
  if (JSON.stringify(initial.versions) !== JSON.stringify(versions(current.versions)) || JSON.stringify(initial.session) !== JSON.stringify(current.session)
    || accountVersions(initial.accounts) !== accountVersions(current.accounts)) throw new AvaCalendarReadError("source_changed");
}

function errorResponse(error: unknown) {
  if (error instanceof AvaCalendarReadError && error.code === "invalid_window") return json({ error: "请选择有效的日期范围。" }, 400);
  if (error instanceof AvaCalendarReadError && error.code === "source_changed") return json({ error: "课表或身份已更新，请刷新。" }, 409);
  return json({ error: "课表暂时无法完整读取，请稍后重试。" }, 503);
}

export function createAvaCalendarHandler(dependencies: AvaCalendarDependencies) {
  return async (request: Request) => {
    try {
      const resolved = await dependencies.readSession();
      if (!("session" in resolved)) return json({ error: resolved.error }, resolved.status);
      const window = requestWindow(request);
      const rows = await dependencies.readRows();
      const initialVersions = versions(rows);
      validateRowPayloads(rows);
      const access = buildOpsAccessContext(rows, resolved.session.user, resolved.fullAdmin, resolved.session);
      if (!["students", "teachers", "bookings"].every((entity) => canReadOpsEntity(access, entity))) return json({ error: "当前账号无权查看日历。" }, 403);
      const [snapshot, accounts] = await Promise.all([dependencies.readSnapshot(window), dependencies.readAccounts()]);
      const [currentVersions, currentSession, currentAccounts] = await Promise.all([dependencies.readVersions(), dependencies.readSession(), dependencies.readAccounts()]);
      if (!("session" in currentSession)) return json({ error: currentSession.error }, currentSession.status);
      validateCurrentAuthority({ versions: initialVersions, session: resolved, accounts }, { versions: currentVersions, session: currentSession, accounts: currentAccounts });
      const projection = projectAvaCalendarEvents({ rows, access, accounts, events: snapshot.events, revision: snapshot.revision });
      return json({ ...projection, source: { revision: snapshot.revision, publishedAt: snapshot.publishedAt, freshness: snapshot.freshness, coverage: snapshot.coverage } });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
