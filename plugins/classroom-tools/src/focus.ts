export type VisibilityReport = { version: 1; state: "hidden" | "visible" };
export const FOCUS_CHANNEL = "classroom-visibility";

type FullscreenDocument = {
  fullscreenElement: Element | null;
  documentElement: { requestFullscreen?: () => Promise<void> };
  exitFullscreen?: () => Promise<void>;
};

export async function toggleClassroomFullscreen(target: FullscreenDocument) {
  if (target.fullscreenElement) {
    if (!target.exitFullscreen) throw new Error("当前浏览器不支持退出全屏。");
    await target.exitFullscreen();
  } else {
    if (!target.documentElement.requestFullscreen) throw new Error("当前浏览器不支持全屏课堂。");
    await target.documentElement.requestFullscreen();
  }
}

export class VisibilityReporter {
  private hidden = false;
  private sentHidden = false;
  private lastReport = -Infinity;
  constructor(private readonly send: (report: VisibilityReport) => void, private readonly onReturn: () => void) {}
  observe(hidden: boolean, now: number) {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (!hidden) {
      this.onReturn();
      if (this.sentHidden) this.send({ version: 1, state: "visible" });
      this.sentHidden = false;
      return;
    }
    if (now - this.lastReport < 10_000) return;
    this.lastReport = now;
    this.sentHidden = true;
    this.send({ version: 1, state: "hidden" });
  }
}

export function isVisibilityReport(value: unknown): value is VisibilityReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<VisibilityReport>;
  return report.version === 1 && (report.state === "hidden" || report.state === "visible");
}
