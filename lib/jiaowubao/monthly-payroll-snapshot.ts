import { createHmac, timingSafeEqual } from "node:crypto";

import type { MonthlyPayrollReport } from "./monthly-payroll";

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 4_000_000;

type SnapshotPayload = {
  version: number;
  issuedAt: number;
  expiresAt: number;
  report: MonthlyPayrollReport;
};

export class MonthlyPayrollSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonthlyPayrollSnapshotError";
  }
}
function encodedJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodedJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new MonthlyPayrollSnapshotError("月度核对快照无法读取，请重新同步。");
  }
}

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function validSecret(secret: string | undefined) {
  const value = secret?.trim();
  if (!value || value.length < 32) {
    throw new MonthlyPayrollSnapshotError("缺少安全的 JIAOWUBAO_MONTHLY_PAYROLL_SNAPSHOT_SECRET，无法生成可下载的核对快照。");
  }
  return value;
}

function isSnapshotPayload(value: unknown): value is SnapshotPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Partial<SnapshotPayload>;
  return payload.version === SNAPSHOT_VERSION
    && typeof payload.issuedAt === "number"
    && typeof payload.expiresAt === "number"
    && Boolean(payload.report)
    && typeof payload.report === "object"
    && !Array.isArray(payload.report)
    && typeof payload.report.period?.value === "string"
    && Array.isArray(payload.report.lessons)
    && Array.isArray(payload.report.teachers)
    && Array.isArray(payload.report.unassignedStudentDetails)
    && Array.isArray(payload.report.warnings);
}

export function createMonthlyPayrollSnapshot(report: MonthlyPayrollReport, options: { secret?: string; now?: number } = {}) {
  const secret = validSecret(options.secret ?? process.env.JIAOWUBAO_MONTHLY_PAYROLL_SNAPSHOT_SECRET);
  const issuedAt = options.now ?? Date.now();
  const snapshot: SnapshotPayload = {
    version: SNAPSHOT_VERSION,
    issuedAt,
    expiresAt: issuedAt + SNAPSHOT_TTL_MS,
    report,
  };
  const payload = encodedJson(snapshot);
  if (Buffer.byteLength(payload, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new MonthlyPayrollSnapshotError("本月核对快照过大，无法安全下载；请联系管理员配置受控存档。");
  }
  return `${payload}.${signature(payload, secret)}`;
}

export function readMonthlyPayrollSnapshot(token: unknown, options: { secret?: string; now?: number } = {}): MonthlyPayrollReport {
  const secret = validSecret(options.secret ?? process.env.JIAOWUBAO_MONTHLY_PAYROLL_SNAPSHOT_SECRET);
  if (typeof token !== "string" || token.length > MAX_SNAPSHOT_BYTES * 2) {
    throw new MonthlyPayrollSnapshotError("月度核对快照无效，请重新同步。");
  }
  const [payload, receivedSignature, ...rest] = token.split(".");
  if (!payload || !receivedSignature || rest.length) throw new MonthlyPayrollSnapshotError("月度核对快照无效，请重新同步。");

  const expectedSignature = signature(payload, secret);
  const expected = Buffer.from(expectedSignature);
  const received = Buffer.from(receivedSignature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new MonthlyPayrollSnapshotError("月度核对快照校验失败，请重新同步。");
  }

  const decoded = decodedJson(payload);
  if (!isSnapshotPayload(decoded)) throw new MonthlyPayrollSnapshotError("月度核对快照格式不完整，请重新同步。");
  const now = options.now ?? Date.now();
  if (decoded.issuedAt > now || decoded.expiresAt <= now || decoded.expiresAt - decoded.issuedAt !== SNAPSHOT_TTL_MS) {
    throw new MonthlyPayrollSnapshotError("月度核对快照已过期，请重新同步后下载。");
  }
  return decoded.report;
}
