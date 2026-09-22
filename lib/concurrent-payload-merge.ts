type IdentifiedRecord = Readonly<{ id: string }>;

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

export function mergeConcurrentPayload<T>(committed: T, local: T, remote: T): { value: T; conflicts: number } {
  if (!Array.isArray(committed) || !Array.isArray(local) || !Array.isArray(remote)) return { value: remote, conflicts: 0 };
  if (![...committed, ...local, ...remote].every(isIdentifiedRecord)) return { value: remote, conflicts: 0 };

  const baseline = new Map(committed.map((item) => [item.id, item]));
  const localItems = new Map(local.map((item) => [item.id, item]));
  const remoteItems = new Map(remote.map((item) => [item.id, item]));
  const orderedIds = [...new Set([...remote.map((item) => item.id), ...local.map((item) => item.id)])];
  let conflicts = 0;
  const value = orderedIds.flatMap((itemId) => {
    const base = baseline.get(itemId);
    const localItem = localItems.get(itemId);
    const remoteItem = remoteItems.get(itemId);
    if (!base) return [localItem ?? remoteItem].filter(isIdentifiedRecord);
    if (!localItem && !remoteItem) return [];
    if (!localItem && remoteItem) {
      if (!structurallyEqual(remoteItem, base)) {
        conflicts += 1;
        return [remoteItem];
      }
      return [];
    }
    if (localItem && !remoteItem) {
      if (!structurallyEqual(localItem, base)) conflicts += 1;
      return [];
    }
    if (!localItem || !remoteItem) return [];
    const localChanged = !structurallyEqual(localItem, base);
    const remoteChanged = !structurallyEqual(remoteItem, base);
    if (localChanged && remoteChanged && !structurallyEqual(localItem, remoteItem)) {
      conflicts += 1;
      return [remoteItem];
    }
    return [localChanged ? localItem : remoteItem];
  });
  return { value: value as T, conflicts };
}
