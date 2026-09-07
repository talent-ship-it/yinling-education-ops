"use client";
import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
const locationEvent = "ops-workspace-location";
function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener("hashchange", listener);
  window.addEventListener(locationEvent, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener("hashchange", listener);
    window.removeEventListener(locationEvent, listener);
  };
}
/** URL state contains only section/record IDs; authorization remains in the workspace and APIs. */
export function useWorkspaceLocation<T extends string>(key: string, fallback: T) {
  const read = useCallback((): T => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get(key);
    return value && value.length <= 180 ? value as T : fallback;
  }, [fallback, key]);
  // Hydration first uses the server fallback, then adopts the browser URL.
  const value = useSyncExternalStore(subscribe, read, () => fallback);
  const update = useCallback((action: SetStateAction<T>) => {
    const next = typeof action === "function" ? action(read()) : action;
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.hash.slice(1));
    if (params.get(key) !== next) {
      params.set(key, next);
      url.hash = params.toString();
      window.history.pushState(null, "", url);
      window.dispatchEvent(new Event(locationEvent));
    }
  }, [key, read]);
  return [value, update] as const;
}
