import type { JiaowubaoOpenApiScheduleSnapshotIdentityPage } from "./ops-store";

import {
  JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_RECORDS,
  JIAOWUBAO_SCHEDULE_SNAPSHOT_SOURCE_KEY,
  type JiaowubaoScheduleCurrentIdentity,
} from "./jiaowubao-open-api-schedule-snapshot";

const PAGE_SIZE = 500;
const MAX_PAGES = Math.ceil(JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_RECORDS / PAGE_SIZE);
const REVISION = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_KEY = /^jwb-open-api:schedule:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

type IdentityPageFetcher = (input: Readonly<{
  apiSourceKey: string;
  revision: string;
  limit: number;
  cursorSourceKey: string | null;
}>) => Promise<JiaowubaoOpenApiScheduleSnapshotIdentityPage>;

function fail(message: string): never {
  throw new Error(message);
}

function boundedRowCount(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0
    && (value as number) <= JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_RECORDS;
}

function validPageShape(page: JiaowubaoOpenApiScheduleSnapshotIdentityPage) {
  return boundedRowCount(page.rowCount) && Array.isArray(page.items)
    && page.items.length <= PAGE_SIZE && typeof page.hasMore === "boolean";
}

function expectedRowCountMatches(actual: number, expected: number | null) {
  return expected === null || actual === expected;
}

function identityPageRowCount(
  page: JiaowubaoOpenApiScheduleSnapshotIdentityPage,
  revision: string,
  expectedRowCount: number | null,
) {
  if (page.state !== "complete") {
    fail("jiaowubao_schedule_identity_snapshot_changed");
  }
  if (page.revision !== revision) fail("jiaowubao_schedule_identity_snapshot_changed");
  if (!validPageShape(page)) fail("jiaowubao_schedule_identity_page_invalid");
  if (!expectedRowCountMatches(page.rowCount, expectedRowCount)) {
    fail("jiaowubao_schedule_identity_page_invalid");
  }
  return page.rowCount;
}

function isScheduleSourceKey(value: unknown): value is string {
  return typeof value === "string" && SOURCE_KEY.test(value);
}

function isUnseenNextKey(value: string, previousKey: string | null, seen: ReadonlySet<string>) {
  return value > (previousKey ?? "") && !seen.has(value);
}

function validSourceDate(value: unknown): value is string | null {
  return value === null || typeof value === "string" && value.length <= 64;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validIdentityItem(
  item: unknown,
  previousKey: string | null,
  seen: ReadonlySet<string>,
): item is Readonly<{ sourceKey: string; sourceDate: string | null }> {
  if (!isRecord(item)) return false;
  if (!isScheduleSourceKey(item.sourceKey)) return false;
  if (!isUnseenNextKey(item.sourceKey, previousKey, seen)) return false;
  return validSourceDate(item.sourceDate);
}

function appendIdentityPage(
  items: JiaowubaoOpenApiScheduleSnapshotIdentityPage["items"],
  cursorSourceKey: string | null,
  seen: Set<string>,
  identities: JiaowubaoScheduleCurrentIdentity[],
) {
  let previousKey = cursorSourceKey;
  for (const item of items) {
    if (!validIdentityItem(item, previousKey, seen)) {
      fail("jiaowubao_schedule_identity_page_invalid");
    }
    previousKey = item.sourceKey;
    seen.add(item.sourceKey);
    identities.push(Object.freeze({ sourceKey: item.sourceKey, sourceDate: item.sourceDate }));
  }
  return previousKey;
}

function nextIdentityCursor(
  page: JiaowubaoOpenApiScheduleSnapshotIdentityPage,
  lastKey: string | null,
  identityCount: number,
) {
  if (!page.hasMore) {
    if (page.nextCursor !== null || identityCount !== page.rowCount) {
      fail("jiaowubao_schedule_identity_page_invalid");
    }
    return null;
  }
  if (page.items.length !== PAGE_SIZE || page.nextCursor !== lastKey) {
    fail("jiaowubao_schedule_identity_page_invalid");
  }
  return page.nextCursor;
}

/** Reads every identity from one immutable current revision before collection. */
export async function readJiaowubaoScheduleSnapshotIdentities(
  revision: string,
  fetchPage: IdentityPageFetcher,
): Promise<readonly JiaowubaoScheduleCurrentIdentity[]> {
  if (!REVISION.test(revision)) fail("jiaowubao_schedule_identity_revision_invalid");
  const identities: JiaowubaoScheduleCurrentIdentity[] = [];
  const seen = new Set<string>();
  let cursorSourceKey: string | null = null;
  let expectedRowCount: number | null = null;

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const page = await fetchPage({
      apiSourceKey: JIAOWUBAO_SCHEDULE_SNAPSHOT_SOURCE_KEY,
      revision,
      limit: PAGE_SIZE,
      cursorSourceKey,
    });
    expectedRowCount = identityPageRowCount(page, revision, expectedRowCount);
    const lastKey = appendIdentityPage(page.items, cursorSourceKey, seen, identities);
    const nextCursor = nextIdentityCursor(page, lastKey, identities.length);
    if (nextCursor === null) {
      return Object.freeze(identities);
    }
    cursorSourceKey = nextCursor;
  }
  fail("jiaowubao_schedule_identity_page_limit");
}
