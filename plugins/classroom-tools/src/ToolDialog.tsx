import React, { useEffect, useRef, type ReactNode } from "react";

function trapDialogTab(event: React.KeyboardEvent, element: HTMLDivElement | null) {
  if (event.key !== "Tab") return;
  const controls = Array.from(element?.querySelectorAll<HTMLElement>("input:not(:disabled),button:not(:disabled)") ?? []);
  const target = event.shiftKey ? controls.at(-1) : controls[0];
  const boundary = event.shiftKey ? controls[0] : controls.at(-1);
  if (document.activeElement === boundary) { event.preventDefault(); target?.focus(); }
}

export function ToolDialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("input,button:not(:disabled)")?.focus());
    return () => { cancelAnimationFrame(frame); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div ref={panel} className="ilct-panel" role="dialog" aria-label={title} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    trapDialogTab(event, panel.current);
  }}>
    <div className="ilct-header"><span>{title}</span><button className="ilct-close" aria-label="关闭面板" onClick={close}>×</button></div>
    <div className="ilct-body">{children}</div>
  </div>;
}
