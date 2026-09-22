"use client";

import { useEffect, useRef, type RefObject } from "react";
import { ChevronLeft } from "lucide-react";

/** Move keyboard focus into a mobile detail pane, then back to its list row. */
export function MobileDetailBackButton({ open, opener, onClose, children }: {
  open: boolean;
  opener: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: string;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open || !window.matchMedia("(max-width: 760px)").matches) return;
    const returnTo = opener.current;
    button.current?.focus();
    return () => { if (returnTo?.isConnected) returnTo.focus(); };
  }, [open, opener]);
  return <button ref={button} className="mobile-preview-close" type="button" onClick={onClose}><ChevronLeft size={20} />{children}</button>;
}
