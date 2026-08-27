export type StudentNameSortDirection = "asc" | "desc";

type StudentNameRow = Readonly<{
  id: string;
  name: string;
}>;

/**
 * Return a deterministic copy of a student collection ordered by display name.
 * The stable ID tie-breaker keeps pagination and direct-record navigation aligned
 * when two rows have the same name.
 */
export function sortStudentsByName<T extends StudentNameRow>(
  students: readonly T[],
  direction: StudentNameSortDirection,
): T[] {
  const multiplier = direction === "desc" ? -1 : 1;
  return [...students].sort((left, right) => {
    const nameOrder = left.name.localeCompare(right.name);
    if (nameOrder !== 0) return nameOrder * multiplier;
    return left.id.localeCompare(right.id) * multiplier;
  });
}
