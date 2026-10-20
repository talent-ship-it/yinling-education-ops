import { parseTrialScreenshotText, type TrialScreenshotExtraction } from "../lib/jiaowubao-trial-screenshot";
import type { TrialScreenshotCandidate, TrialScreenshotMatchResult, TrialScreenshotTarget } from "../lib/trial-screenshot-match-service";

export type { TrialScreenshotTarget, TrialScreenshotCandidate };
export type TrialScreenshotMatch = Readonly<Pick<TrialScreenshotMatchResult, "ambiguous" | "hasMore" | "reason"> & {
  candidates: readonly TrialScreenshotCandidate[];
  coverage: null | Readonly<{
    state: string;
    freshness: string;
    timeZone: string;
    complete: boolean;
    sourceRevision: string | null;
  }>;
}>;
type Evidence = Readonly<{
  sourceDate: string;
  startTime: string;
  endTime: string;
  teacherName: string;
  courseName: string;
  sharedAccountLetter?: string;
}>;
type Dependencies = Readonly<{
  recognize: (file: File, progress: (value: number) => void, signal: AbortSignal) => Promise<string>;
  match: (target: TrialScreenshotTarget, evidence: Evidence, signal: AbortSignal) => Promise<TrialScreenshotMatch>;
}>;
export type TrialScreenshotImportSnapshot = Readonly<{
  text: string;
  extraction: TrialScreenshotExtraction | null;
  match: TrialScreenshotMatch | null;
  selectedCandidate: string | null;
  selectedFields: readonly string[];
  phase: "idle" | "recognizing" | "matching";
  progress: number;
  error: string | null;
}>;
const initialSnapshot: TrialScreenshotImportSnapshot = Object.freeze({
  text: "", extraction: null, match: null, selectedCandidate: null, selectedFields: [], phase: "idle", progress: 0, error: null,
});

function evidenceFrom(extraction: TrialScreenshotExtraction): Evidence | null {
  const { sourceDate, startTime, endTime, teacherName, courseName, sharedAccountLetter } = extraction;
  if (!sourceDate || !startTime || !endTime || !teacherName || !courseName) return null;
  return { sourceDate, startTime, endTime, teacherName, courseName, ...(sharedAccountLetter ? { sharedAccountLetter } : {}) };
}

export async function requestTrialScreenshotMatch(target: TrialScreenshotTarget, evidence: Evidence, signal: AbortSignal): Promise<TrialScreenshotMatch> {
  const response = await fetch("/api/operations/trial-screenshot-match", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target, evidence }), signal, cache: "no-store",
  });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "教务宝排课暂时无法核对，请重试。");
  if (!Array.isArray(body.candidates)) throw new Error("教务宝排课暂时无法核对，请重试。");
  return body as TrialScreenshotMatch;
}

export function screenshotCandidateKey(candidate: TrialScreenshotCandidate) {
  return `${candidate.sourceRevision}:${candidate.eventId}`;
}

function selectedScreenshotCandidate(snapshot: TrialScreenshotImportSnapshot) {
  return snapshot.match?.candidates.find((candidate) => screenshotCandidateKey(candidate) === snapshot.selectedCandidate) ?? null;
}

export function confirmableScreenshotCandidate(snapshot: TrialScreenshotImportSnapshot) {
  const candidate = selectedScreenshotCandidate(snapshot);
  const coverage = snapshot.match?.coverage;
  if (snapshot.phase !== "idle" || !candidate || !coverage) return null;
  if (!coverage.complete || coverage.state !== "complete" || coverage.freshness !== "fresh") return null;
  if (coverage.timeZone !== "Australia/Melbourne" || coverage.sourceRevision !== candidate.sourceRevision) return null;
  return candidate;
}

export function proposedScreenshotFields(snapshot: TrialScreenshotImportSnapshot): Record<string, unknown> {
  const source = selectedScreenshotCandidate(snapshot) ?? snapshot.extraction;
  if (!source) return {};
  const result: Record<string, unknown> = {};
  if (source.teacherName) result.assignedTeacher = source.teacherName;
  if (source.studentNameHint) result.studentName = source.studentNameHint;
  if (source.durationMinutes === 45 || source.durationMinutes === 60) result.trialDurationMinutes = source.durationMinutes;
  return result;
}

export function selectedScreenshotFields(snapshot: TrialScreenshotImportSnapshot): Record<string, unknown> {
  if (snapshot.phase !== "idle") return {};
  const proposed = proposedScreenshotFields(snapshot);
  const fields = Object.fromEntries(snapshot.selectedFields.filter((key) => Object.hasOwn(proposed, key)).map((key) => [key, proposed[key]]));
  if (Object.hasOwn(fields, "studentName")) fields.studentNameKnown = true;
  return fields;
}

export function screenshotMelbourneTime(instant: string) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return "时间无效";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
}

export class TrialScreenshotImportFlow {
  private snapshot = initialSnapshot;
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private generation = 0;

  constructor(private target: TrialScreenshotTarget, private dependencies: Dependencies) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<TrialScreenshotImportSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private begin() {
    this.controller?.abort();
    this.controller = new AbortController();
    return { generation: ++this.generation, signal: this.controller.signal };
  }
  private current(operation: { generation: number; signal: AbortSignal }) {
    return operation.generation === this.generation && !operation.signal.aborted;
  }
  cancel = () => {
    this.generation++;
    this.controller?.abort();
    this.update({ phase: "idle", progress: 0 });
  };
  setText = (text: string) => {
    this.cancel();
    this.update({ text, extraction: null, match: null, selectedCandidate: null, selectedFields: [], error: null });
  };
  selectCandidate = (key: string) => {
    if (!this.snapshot.match?.candidates.some((candidate) => screenshotCandidateKey(candidate) === key)) return;
    this.update({ selectedCandidate: key, selectedFields: [] });
  };
  toggleField = (key: string) => {
    if (!Object.hasOwn(proposedScreenshotFields(this.snapshot), key)) return;
    const fields = new Set(this.snapshot.selectedFields);
    if (fields.has(key)) fields.delete(key);
    else fields.add(key);
    this.update({ selectedFields: [...fields] });
  };
  upload = async (file: File) => {
    const operation = this.begin();
    this.update({ ...initialSnapshot, phase: "recognizing" });
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size === 0 || file.size > 3 * 1024 * 1024) {
      this.update({ phase: "idle", error: "请选择不超过 3 MB 的 PNG、JPG 或 WebP 截图。" });
      return;
    }
    try {
      const text = await this.dependencies.recognize(file, (progress) => {
        if (this.current(operation)) this.update({ progress });
      }, operation.signal);
      if (this.current(operation)) this.update({ text, phase: "idle", progress: 100 });
    } catch {
      if (this.current(operation)) this.update({ phase: "idle", error: "截图识别失败，请重试或手动填写识别文字。" });
    }
  };
  parseAndMatch = async () => {
    const operation = this.begin();
    this.update({ extraction: null, match: null, selectedCandidate: null, selectedFields: [], error: null, phase: "idle" });
    let extraction: TrialScreenshotExtraction;
    try {
      extraction = parseTrialScreenshotText(this.snapshot.text);
    } catch {
      this.update({ error: "截图文字无效，请修正后重新解析。" });
      return;
    }
    this.update({ extraction });
    const evidence = evidenceFrom(extraction);
    if (!evidence) {
      this.update({ error: "请补齐日期、起止时间、老师和完整课程名后重新解析。" });
      return;
    }
    await this.loadMatches(evidence, operation);
  };
  private async loadMatches(evidence: Evidence, operation: { generation: number; signal: AbortSignal }) {
    this.update({ phase: "matching" });
    try {
      const match = await this.dependencies.match(this.target, evidence, operation.signal);
      if (this.current(operation)) this.update({ match, phase: "idle" });
    } catch (error) {
      if (this.current(operation)) this.update({ phase: "idle", error: error instanceof Error ? error.message : "教务宝排课暂时无法核对，请重试。" });
    }
  }
}
