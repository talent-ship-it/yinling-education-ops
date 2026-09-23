type IdentifiedRecord = Readonly<{ id: string }>;

type MergedRecord = Readonly<{
  item?: IdentifiedRecord;
  conflict: boolean;
}>;

function isIdentifiedRecord(value: unknown): value is IdentifiedRecord {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === "string";
}

export function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => structurallyEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(rightRecord, key) && structurallyEqual(leftRecord[key], rightRecord[key]));
}

function mergeLocalDeletion(base: IdentifiedRecord, remote: IdentifiedRecord): MergedRecord {
  const conflict = !structurallyEqual(remote, base);
  return conflict ? { item: remote, conflict } : { conflict };
}

function mergeRemoteDeletion(base: IdentifiedRecord, local: IdentifiedRecord): MergedRecord {
  return { conflict: !structurallyEqual(local, base) };
}

function mergeConcurrentEdits(
  base: IdentifiedRecord,
  local: IdentifiedRecord,
  remote: IdentifiedRecord,
): MergedRecord {
  const localChanged = !structurallyEqual(local, base);
  const remoteChanged = !structurallyEqual(remote, base);
  const conflict = localChanged && remoteChanged && !structurallyEqual(local, remote);
  return { item: conflict ? remote : localChanged ? local : remote, conflict };
}

function mergeRecord(
  base: IdentifiedRecord | undefined,
  local: IdentifiedRecord | undefined,
  remote: IdentifiedRecord | undefined,
): MergedRecord {
  if (!base) return { item: local ?? remote, conflict: false };
  if (!local && !remote) return { conflict: false };
  if (!local) return mergeLocalDeletion(base, remote as IdentifiedRecord);
  if (!remote) return mergeRemoteDeletion(base, local);
  return mergeConcurrentEdits(base, local, remote);
}

export function mergeConcurrentPayload<T>(committed: T, local: T, remote: T): { value: T; conflicts: number } {
  if (!Array.isArray(committed) || !Array.isArray(local) || !Array.isArray(remote)) return { value: remote, conflicts: 0 };
  if (![...committed, ...local, ...remote].every(isIdentifiedRecord)) return { value: remote, conflicts: 0 };

  const baseline = new Map(committed.map((item) => [item.id, item]));
  const localItems = new Map(local.map((item) => [item.id, item]));
  const remoteItems = new Map(remote.map((item) => [item.id, item]));
  const orderedIds = [...new Set([...remote.map((item) => item.id), ...local.map((item) => item.id)])];
  let conflicts = 0;
  const mergedItems: IdentifiedRecord[] = [];
  for (const itemId of orderedIds) {
    const merged = mergeRecord(baseline.get(itemId), localItems.get(itemId), remoteItems.get(itemId));
    if (merged.item) mergedItems.push(merged.item);
    if (merged.conflict) conflicts += 1;
  }
  return { value: mergedItems as T, conflicts };
}
