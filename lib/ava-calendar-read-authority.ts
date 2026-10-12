import { AsyncLocalStorage } from "node:async_hooks";

const authority = new AsyncLocalStorage<() => void>();

export function withAvaCalendarReadAuthority<T>(guard: () => void, read: () => T): T {
  return authority.run(guard, read);
}

export function assertAvaCalendarReadAuthority() {
  authority.getStore()?.();
}
