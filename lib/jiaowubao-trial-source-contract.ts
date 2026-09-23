type PinnedSourceWindow = Readonly<{ start: string; end: string }>;
type RequestedSourceWindow = Readonly<{ startsAt: string; endsAt: string }>;
type SourcePageMetadata = Readonly<{
  state: string;
  freshness: string;
  revision: string | null;
  sourceWindow: unknown;
}>;

const EXACT_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MELBOURNE_BOUNDARY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Melbourne",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return EXACT_DATE.test(value) && Number.isFinite(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value;
}

function addDay(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function melbourneMidnight(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return null;
  const parts = Object.fromEntries(MELBOURNE_BOUNDARY.formatToParts(parsed)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return parts.hour === "00" && parts.minute === "00" && parts.second === "00"
    ? `${parts.year}-${parts.month}-${parts.day}`
    : null;
}

function matchingPinnedSourceWindow(value: unknown, expected: PinnedSourceWindow | null) {
  if (expected === null || !record(value)) return null;
  const matches = [
    exactDate(expected.start),
    exactDate(expected.end),
    expected.end >= expected.start,
    value.start === expected.start,
    value.end === expected.end,
  ].every(Boolean);
  return matches ? expected : null;
}

function requestCoveredByPinnedWindow(pinned: PinnedSourceWindow, requested: RequestedSourceWindow) {
  const startsOn = melbourneMidnight(requested.startsAt);
  const endsOn = melbourneMidnight(requested.endsAt);
  if (startsOn === null || endsOn === null) return false;
  return [
    startsOn >= pinned.start,
    startsOn <= pinned.end,
    endsOn > startsOn,
    endsOn <= addDay(pinned.end),
  ].every(Boolean);
}

function staleSourceCoversRequest(
  value: unknown,
  expected: PinnedSourceWindow | null,
  requested: RequestedSourceWindow,
) {
  const pinned = matchingPinnedSourceWindow(value, expected);
  return pinned === null ? false : requestCoveredByPinnedWindow(pinned, requested);
}

/** Accepts stale data only for an exact immutable revision and covered Melbourne interval. */
export function acceptsJiaowubaoTrialSourcePage(
  page: SourcePageMetadata,
  snapshotRevision: string,
  requestedWindow: RequestedSourceWindow,
  stalePinnedSourceWindow: PinnedSourceWindow | null,
) {
  if (page.revision !== snapshotRevision) return false;
  if (page.state === "complete" && page.freshness === "fresh") return true;
  return page.state === "stale" && page.freshness === "stale"
    && staleSourceCoversRequest(page.sourceWindow, stalePinnedSourceWindow, requestedWindow);
}
