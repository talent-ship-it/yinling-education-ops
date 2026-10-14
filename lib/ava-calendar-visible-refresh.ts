"use client";

import { useEffect } from "react";

export function useAvaCalendarVisibleRefresh(loading: boolean, refreshCalendar: () => void) {
  useEffect(() => {
    if (loading) return;
    let timer: ReturnType<typeof setTimeout>;
    function refreshWhenVisible() {
      if (document.visibilityState === "visible") refreshCalendar();
      timer = setTimeout(refreshWhenVisible, 60000);
    }
    timer = setTimeout(refreshWhenVisible, 60000);
    return () => clearTimeout(timer);
  }, [loading, refreshCalendar]);
}
