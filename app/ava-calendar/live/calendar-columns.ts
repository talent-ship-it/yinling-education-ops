"use client";

import { useEffect, useState, type RefObject } from "react";
import { calendarColumnWindow } from "@/lib/ava-calendar-columns";

type Viewport = { width: number; left: number };
function stableViewport(prior: Viewport, next: Viewport) { return prior.width === next.width && prior.left === next.left ? prior : next; }
export function useCalendarColumnWindow(hostRef: RefObject<HTMLDivElement | null>, total: number) {
  const [viewport, setViewport] = useState<Viewport>({ width: 340, left: 0 });
  useEffect(() => {
    const viewport = hostRef.current!.parentElement!;
    const measure = () => { const next = { width: viewport.clientWidth, left: viewport.scrollLeft }; setViewport((prior) => stableViewport(prior, next)); };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    viewport.addEventListener("scroll", measure, { passive: true });
    return () => { observer.disconnect(); viewport.removeEventListener("scroll", measure); };
  }, [hostRef]);
  return calendarColumnWindow(total, viewport.width, viewport.left);
}
export function calendarLifecycle() {
  let active = true;
  return {
    dispose: () => { active = false; },
    guard<Args extends unknown[]>(callback: (...args: Args) => void) {
      return (...args: Args) => { if (active) callback(...args); };
    },
  };
}

export function calendarScrollers(element: HTMLElement) {
  return [...element.querySelectorAll<HTMLElement>(".fc-timegrid-body")].map((body) => body.closest<HTMLElement>(".fc-scroller")!);
}
export function readCalendarScroll(element: HTMLElement, prior: { top: number; left: number }) {
  return { top: calendarScrollers(element)[0]?.scrollTop ?? prior.top, left: element.parentElement!.scrollLeft };
}
export function restoreCalendarScroll(element: HTMLElement, position: { top: number; left: number }) {
  if (position.top >= 0) calendarScrollers(element).forEach((scroller) => { scroller.scrollTop = position.top; });
  element.parentElement!.scrollLeft = position.left;
}
export function appendCalendarSpacer(element: HTMLElement, width: number) {
  if (width <= 0) return;
  const spacer = document.createElement("div"); spacer.setAttribute("aria-hidden", "true"); spacer.style.flex = `0 0 ${width}px`; element.append(spacer);
}
export function sizeTeacherColumn(element: HTMLElement, width: number, global: boolean) {
  if (!global) return;
  element.style.flex = `0 0 ${width}px`; element.style.width = `${width}px`; element.style.minWidth = "0"; element.style.boxSizing = "border-box";
}
