import { createHash } from "node:crypto";
import type { OpsStateRow, OpsVersionRow, OpsRpcOptions, JiaowubaoOpenApiScheduleSnapshotWindow } from "./ops-store";
import type { AvaCalendarSnapshot, AvaCalendarWindow, AvaCalendarPageFetcher } from "./ava-calendar-snapshot";
import { AvaCalendarReadError } from "./ava-calendar-snapshot";
import type { AvaCalendarProjection, AvaCoordinatorAccount } from "./ava-calendar-projection";
import type { AvaCalendarAvailabilitySnapshot } from "./ava-calendar-health";
import { evaluateAvaCalendarDisplay } from "./ava-calendar-display";
import { projectCalendarAvailability } from "./ava-calendar-availability";
import { localTimeToInstant } from "./teacher-availability";
import { shiftScheduleDate } from "./schedule-calendar";
import { assertAvaCalendarReadAuthority } from "./ava-calendar-read-authority";

export type AvaCalendarPublicationInput = {
  snapshot: AvaCalendarSnapshot;
  rows: OpsStateRow[];
  currentVersions: OpsVersionRow[];
  window: AvaCalendarWindow;
  identity: unknown;
  accounts: readonly AvaCoordinatorAccount[];
  projection: AvaCalendarProjection;
};
export type AvaCalendarPublicationComposition = {
  sourceEvents: (snapshot: AvaCalendarSnapshot) => AvaCalendarSnapshot["events"];
  readMetadata: (snapshot: AvaCalendarSnapshot, assertAuthority: () => Promise<void>) => Promise<void>;
  readRangeMetadata?: (snapshots: AvaCalendarSnapshot[], assertAuthority: () => Promise<void>) => Promise<void>;
  compose: (input: AvaCalendarPublicationInput) => ReturnType<typeof composePublication>;
};
type Capture = { snapshot: AvaCalendarAvailabilitySnapshot; sources: unknown };
type CompositionDependencies = {
  collectSnapshot: (window: AvaCalendarWindow, fetchPage: AvaCalendarPageFetcher) => Promise<AvaCalendarSnapshot>;
  fetchPage: (window: AvaCalendarWindow, input: Parameters<AvaCalendarPageFetcher>[0]) => Promise<JiaowubaoOpenApiScheduleSnapshotWindow>;
  readSources: () => Promise<unknown>;
  now: () => number;
};
type RouteCompositionGetters = Pick<typeof import("./ops-store"), "getOpsSources" | "getJiaowubaoOpenApiScheduleSnapshotWindow">;

export function createAvaCalendarRouteComposition(collectSnapshot: CompositionDependencies["collectSnapshot"], getters: RouteCompositionGetters, deadlineAt: number, now: () => number, options: OpsRpcOptions = {}) {
  return createAvaCalendarServerComposition({
    collectSnapshot,
    fetchPage: (window, page) => getters.getJiaowubaoOpenApiScheduleSnapshotWindow({
      windowStart: window.start, windowEnd: window.end, scope: "all", teacherLabels: null, studentMemberIds: null, studentNameKeys: null, ...page,
    }, { ...options, deadlineAt }),
    readSources: () => getters.getOpsSources({ ...options, deadlineAt }),
    now,
  });
}

async function metadataRead(read: () => Promise<unknown>) {
  try { return await read(); } catch { return null; }
}

function nativeVersions(rows: OpsVersionRow[]) {
  const core = Object.fromEntries(["students", "teachers", "bookings", "lpItems"].map((entity) => [entity, rows.find((row) => row.entity === entity)!.version]));
  const courses = rows.filter((row) => row.entity === "courses");
  return courses.length === 1 && Number.isSafeInteger(courses[0]!.version) && courses[0]!.version >= 0 ? { ...core, courses: courses[0]!.version } : core;
}

function sourceCoverage(window: NonNullable<AvaCalendarAvailabilitySnapshot["sourceWindow"]>) {
  return {
    start: localTimeToInstant(window.start, "00:00", "Australia/Melbourne", "earlier").toISOString(),
    end: localTimeToInstant(shiftScheduleDate(window.end, 1), "00:00", "Australia/Melbourne", "earlier").toISOString(),
  };
}

function capturedCoverage(sourceWindow: JiaowubaoOpenApiScheduleSnapshotWindow["sourceWindow"] | undefined, request: AvaCalendarWindow): AvaCalendarSnapshot["coverage"] {
  if (!sourceWindow) return "partial";
  const source = sourceCoverage(sourceWindow);
  return Date.parse(request.start) >= Date.parse(source.start) && Date.parse(request.end) <= Date.parse(source.end) ? "complete" : "partial";
}

function composePublication(input: AvaCalendarPublicationInput, capture: Capture, now: number) {
  const snapshot = capture.snapshot;
  const display = evaluateAvaCalendarDisplay(snapshot, input.window, capture.sources, now);
  const availability = projectCalendarAvailability({ rows: input.rows, snapshot, window: input.window, health: null, display, visibleTeacherIds: new Set(input.projection.teachers.map(({ id }) => id)) });
  const versions = nativeVersions(input.currentVersions);
  const accountIdentity = input.accounts.map(({ account_id, account_name, account_role, status }) => [account_id, account_name, account_role, status]).sort((left, right) => left[0]!.localeCompare(right[0]!));
  const sourceWindow = snapshot.sourceWindow ? [snapshot.sourceWindow.start, snapshot.sourceWindow.end] : null;
  const consistencyKey = createHash("sha256").update(JSON.stringify([snapshot.revision, snapshot.publishedAt, sourceWindow, versions, input.identity, accountIdentity])).digest("hex");
  return { ...availability, nativeVersions: versions, consistencyKey, source: {
    revision: snapshot.revision, publishedAt: snapshot.publishedAt, freshness: snapshot.freshness, coverage: snapshot.coverage, sync: display.sync,
    ...(snapshot.sourceWindow ? { window: sourceCoverage(snapshot.sourceWindow) } : {}),
  } };
}

function createAvaCalendarServerComposition(dependencies: CompositionDependencies) {
  const captures = new WeakMap<AvaCalendarSnapshot, Capture>();
  const captureFor = (snapshot: AvaCalendarSnapshot) => {
    const capture = captures.get(snapshot);
    if (!capture) throw new AvaCalendarReadError("source_unavailable");
    return capture;
  };
  return {
    readSnapshot: async (window: AvaCalendarWindow, assertAuthority?: () => Promise<void>) => {
      let first: JiaowubaoOpenApiScheduleSnapshotWindow | undefined;
      const events: AvaCalendarSnapshot["events"] = [];
      const snapshot = await dependencies.collectSnapshot(window, async (input) => {
        await assertAuthority?.();
        assertAvaCalendarReadAuthority();
        const page = await dependencies.fetchPage(window, input);
        first ??= page;
        events.push(...page.events);
        return page;
      });
      if (!first) throw new AvaCalendarReadError("source_unavailable");
      captures.set(snapshot, { snapshot: { ...snapshot, events, publishedAt: first.publishedAt!, coverage: capturedCoverage(first.sourceWindow, window), ...(first.sourceWindow ? { sourceWindow: { ...first.sourceWindow } } : {}), paginationComplete: true, invalidTimeEventCount: 0 }, sources: null });
      return snapshot;
    },
    publication: {
      sourceEvents: (snapshot: AvaCalendarSnapshot) => captureFor(snapshot).snapshot.events,
      readRangeMetadata: async (snapshots: AvaCalendarSnapshot[], assertAuthority: () => Promise<void>) => {
        await assertAuthority();
        assertAvaCalendarReadAuthority();
        const sources = await metadataRead(dependencies.readSources);
        await assertAuthority();
        assertAvaCalendarReadAuthority();
        for (const snapshot of snapshots) captureFor(snapshot).sources = sources;
      },
      readMetadata: async (snapshot: AvaCalendarSnapshot, assertAuthority: () => Promise<void>) => {
        const capture = captureFor(snapshot);
        await assertAuthority();
        assertAvaCalendarReadAuthority();
        capture.sources = await metadataRead(dependencies.readSources);
        await assertAuthority();
        assertAvaCalendarReadAuthority();

      },
      compose: (input: AvaCalendarPublicationInput) => composePublication(input, captureFor(input.snapshot), dependencies.now()),
    } satisfies AvaCalendarPublicationComposition,
  };
}
