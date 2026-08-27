export const MANAGED_TRIAL_PAYMENT_AUTHORITY_ENTITIES = ["bookings", "students", "tasks"] as const;
export type ManagedTrialPaymentAuthorityEntity = (typeof MANAGED_TRIAL_PAYMENT_AUTHORITY_ENTITIES)[number];

/** The complete cross-owner student surface exposed to an assigned planner. */
export type ManagedTrialPaymentStudentProjection = Readonly<{
  id: string;
  name: string;
  initials: string;
}>;

export type ManagedTrialPaymentProjectionSnapshot = Readonly<{
  versions: Readonly<Record<ManagedTrialPaymentAuthorityEntity, number>>;
  students: readonly ManagedTrialPaymentStudentProjection[];
}>;

export type ManagedTrialPaymentCompletionTaskRow = Readonly<{
  entity: "tasks";
  payload: readonly unknown[];
  version: number;
  updated_at: string;
  updated_by: string;
}>;

export type ManagedTrialPaymentCompletionReceipt = Readonly<{
  committed: true;
  applied: boolean;
  receiptOnly: boolean;
  taskId: string;
  auditEntryId: string;
  taskRow: ManagedTrialPaymentCompletionTaskRow | null;
  managedTrialPaymentSnapshot: ManagedTrialPaymentProjectionSnapshot | null;
}>;

type PaymentTaskCandidate = Readonly<{
  category?: unknown;
  ruleKey?: unknown;
  anchorBookingId?: unknown;
  owner?: unknown;
  assignees?: unknown;
  watchers?: unknown;
}>;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: RecordValue, allowed: ReadonlySet<string>) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasExactKeys(value: RecordValue, expected: readonly string[]) {
  return Object.keys(value).length === expected.length
    && hasOnlyKeys(value, new Set(expected));
}

function parseVersion(value: unknown, entity: ManagedTrialPaymentAuthorityEntity) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`managed trial payment ${entity} version is invalid`);
  }
  return value as number;
}

export function parseManagedTrialPaymentAuthorityVersions(value: unknown) {
  if (!Array.isArray(value)) throw new TypeError("managed trial payment authority rows are invalid");
  return Object.fromEntries(MANAGED_TRIAL_PAYMENT_AUTHORITY_ENTITIES.map((entity) => {
    const matches = value.filter((candidate) => isRecord(candidate) && candidate.entity === entity);
    if (matches.length !== 1) {
      throw new TypeError(`managed trial payment ${entity} authority row is missing or duplicated`);
    }
    return [entity, parseVersion(matches[0].version, entity)];
  })) as Record<ManagedTrialPaymentAuthorityEntity, number>;
}

function parseStudent(value: unknown): ManagedTrialPaymentStudentProjection {
  if (!isRecord(value)
    || !hasOnlyKeys(value, new Set(["id", "name", "initials"]))
    || typeof value.id !== "string" || !value.id.trim()
    || typeof value.name !== "string"
    || typeof value.initials !== "string") {
    throw new TypeError("managed trial payment student projection is invalid");
  }
  return { id: value.id, name: value.name, initials: value.initials };
}

export function parseManagedTrialPaymentProjectionSnapshot(
  value: unknown,
  authorityVersions: Readonly<Partial<Record<ManagedTrialPaymentAuthorityEntity, unknown>>>,
): ManagedTrialPaymentProjectionSnapshot {
  if (!isRecord(value)
    || !hasOnlyKeys(value, new Set(["versions", "students"]))
    || !isRecord(value.versions)
    || !hasOnlyKeys(value.versions, new Set(MANAGED_TRIAL_PAYMENT_AUTHORITY_ENTITIES))
    || !Array.isArray(value.students)) {
    throw new TypeError("managed trial payment snapshot is invalid");
  }
  const suppliedVersions = value.versions;
  const versions = Object.fromEntries(MANAGED_TRIAL_PAYMENT_AUTHORITY_ENTITIES.map((entity) => [
    entity,
    parseVersion(suppliedVersions[entity], entity),
  ])) as Record<ManagedTrialPaymentAuthorityEntity, number>;
  for (const entity of MANAGED_TRIAL_PAYMENT_AUTHORITY_ENTITIES) {
    if (versions[entity] !== parseVersion(authorityVersions[entity], entity)) {
      throw new TypeError("managed trial payment snapshot versions do not match response rows");
    }
  }
  const students = value.students.map(parseStudent);
  if (new Set(students.map((student) => student.id)).size !== students.length) {
    throw new TypeError("managed trial payment projection contains duplicate students");
  }
  return { versions, students };
}

export function managedTrialPaymentSnapshotIsCurrent(
  snapshot: ManagedTrialPaymentProjectionSnapshot,
  versions: Readonly<Record<ManagedTrialPaymentAuthorityEntity, number>>,
) {
  return MANAGED_TRIAL_PAYMENT_AUTHORITY_ENTITIES.every(
    (entity) => snapshot.versions[entity] === versions[entity],
  );
}

export function managedTrialPaymentSnapshotCanReplace(
  snapshot: ManagedTrialPaymentProjectionSnapshot,
  versions: Readonly<Record<ManagedTrialPaymentAuthorityEntity, number>>,
) {
  return MANAGED_TRIAL_PAYMENT_AUTHORITY_ENTITIES.every(
    (entity) => snapshot.versions[entity] >= versions[entity],
  );
}

function samePerson(left: unknown, right: string) {
  return typeof left === "string"
    && left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

/** Client-side defense in depth; the server projection remains authoritative. */
export function isManagedTrialPaymentTaskRecipient(
  task: PaymentTaskCandidate,
  recipient: string,
) {
  return task.category === "试听"
    && (task.ruleKey === "trial.payment-n2" || task.ruleKey === "trial.payment-urgent")
    && typeof task.anchorBookingId === "string" && Boolean(task.anchorBookingId.trim())
    && samePerson(task.owner, recipient)
    && Array.isArray(task.assignees) && task.assignees.length === 1
    && samePerson(task.assignees[0], recipient)
    && Array.isArray(task.watchers) && task.watchers.length === 1
    && samePerson(task.watchers[0], "Ops Admin");
}

/**
 * Strictly parses the dedicated completion response. Receipt-only is the sole
 * successful shape allowed to omit rows; a normal success must carry the exact
 * completed task plus a projection bound to the same task version.
 */
export function parseManagedTrialPaymentCompletionReceipt(
  value: unknown,
  expectedTaskId: string,
  actor: string,
): ManagedTrialPaymentCompletionReceipt {
  const responseKeys = [
    "committed", "applied", "receiptOnly", "taskId", "taskRow",
    "managedTrialPaymentSnapshot", "auditEntryId",
  ] as const;
  if (!isRecord(value)
    || !hasExactKeys(value, responseKeys)
    || value.committed !== true
    || typeof value.applied !== "boolean"
    || typeof value.receiptOnly !== "boolean"
    || value.taskId !== expectedTaskId
    || typeof value.auditEntryId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.auditEntryId)) {
    throw new TypeError("managed trial payment completion receipt is invalid");
  }
  if (value.receiptOnly) {
    if (value.applied !== false || value.taskRow !== null || value.managedTrialPaymentSnapshot !== null) {
      throw new TypeError("managed trial payment receipt-only response exposed state");
    }
    return {
      committed: true,
      applied: false,
      receiptOnly: true,
      taskId: expectedTaskId,
      taskRow: null,
      managedTrialPaymentSnapshot: null,
      auditEntryId: value.auditEntryId,
    };
  }
  const taskRow = value.taskRow;
  if (!isRecord(taskRow)
    || !hasExactKeys(taskRow, ["entity", "payload", "version", "updated_at", "updated_by"])
    || taskRow.entity !== "tasks"
    || !Array.isArray(taskRow.payload)
    || !Number.isSafeInteger(taskRow.version) || (taskRow.version as number) < 1
    || typeof taskRow.updated_at !== "string"
    || typeof taskRow.updated_by !== "string") {
    throw new TypeError("managed trial payment completion task row is invalid");
  }
  const matchingTasks = taskRow.payload.filter((candidate) => isRecord(candidate) && candidate.id === expectedTaskId);
  if (matchingTasks.length !== 1) throw new TypeError("managed trial payment completion task is missing or duplicated");
  const task = matchingTasks[0];
  if (!isManagedTrialPaymentTaskRecipient(task, actor)
    || task.status !== "done"
    || task.tone !== "green"
    || task.result !== "已由规划老师确认试听付款"
    || typeof task.closedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(task.closedAt)
    || new Date(task.closedAt).toISOString() !== task.closedAt) {
    throw new TypeError("managed trial payment completion task evidence is invalid");
  }
  const rawSnapshot = value.managedTrialPaymentSnapshot;
  const snapshot = parseManagedTrialPaymentProjectionSnapshot(
    rawSnapshot,
    isRecord(rawSnapshot) && isRecord(rawSnapshot.versions) ? rawSnapshot.versions : {},
  );
  if (snapshot.versions.tasks !== taskRow.version) {
    throw new TypeError("managed trial payment completion versions are inconsistent");
  }
  return {
    committed: true,
    applied: value.applied,
    receiptOnly: false,
    taskId: expectedTaskId,
    taskRow: taskRow as ManagedTrialPaymentCompletionTaskRow,
    managedTrialPaymentSnapshot: snapshot,
    auditEntryId: value.auditEntryId,
  };
}
