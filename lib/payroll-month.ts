export function previousMelbournePayrollMonth(now: Date) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("墨尔本月份无效。");
  }
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

export const PAYROLL_ABSENT_POLL_DELAY_MS = 60_000;
export const PAYROLL_ABSENT_ERROR_DELAY_MS = 120_000;

function isClosedAbsentMonth(month: string, currentMonth: string, feed: { state: string; month: string } | null) {
  return month < currentMonth && feed?.state === "absent" && feed.month === month;
}

export function canPollAbsentPayrollMonth(input: Readonly<{
  canView: boolean;
  active: string;
  month: string;
  currentMonth: string;
  feed: { state: string; month: string } | null;
  loading: boolean;
  syncing: boolean;
  exporting: boolean;
}>) {
  return input.canView && input.active === "payroll"
    && isClosedAbsentMonth(input.month, input.currentMonth, input.feed)
    && !input.loading && !input.syncing && !input.exporting;
}

export function createPayrollAbsentMonthWake<TTimer>(input: Readonly<{
  wake: () => void;
  isHidden: () => boolean;
  now: () => number;
  schedule: (callback: () => void, delay: number) => TTimer;
  cancel: (timer: TTimer) => void;
}>) {
  let nextAllowedAt = input.now() + PAYROLL_ABSENT_POLL_DELAY_MS;
  let timer: TTimer | undefined;
  const clear = () => {
    if (timer !== undefined) input.cancel(timer);
    timer = undefined;
  };
  return {
    markStarted() {
      nextAllowedAt = input.now() + PAYROLL_ABSENT_POLL_DELAY_MS;
      clear();
    },
    markError() {
      nextAllowedAt = input.now() + PAYROLL_ABSENT_ERROR_DELAY_MS;
      clear();
    },
    resume() {
      clear();
      if (input.isHidden()) return;
      const remaining = nextAllowedAt - input.now();
      if (remaining <= 0) input.wake();
      else timer = input.schedule(() => {
        timer = undefined;
        if (!input.isHidden()) input.wake();
      }, remaining);
    },
    stop: clear,
  };
}
