import { normalizeStudentImportName, studentImportAutomaticJwbNameKey } from "./student-import";

/** The server-only participant evidence emitted by the snapshot reader. */
export type JiaowubaoSnapshotStudentParticipant = Readonly<{
  memberId: string | null;
  label: string | null;
}>;

/**
 * The two candidate maps are deliberately separate from the allowed maps.
 * Candidate maps describe global uniqueness across the authoritative roster;
 * allowed maps contain only IDs in the caller's current scope. Keeping both
 * maps prevents an unauthorized member/name key from being treated as
 * unknown and then accidentally unioned with another allowed identity.
 */
export type JiaowubaoSnapshotStudentLookup = Readonly<{
  internalByMember: ReadonlyMap<string, string>;
  internalByNameKey: ReadonlyMap<string, string>;
  memberCandidates: ReadonlyMap<string, readonly string[]>;
  nameCandidates: ReadonlyMap<string, readonly string[]>;
}>;

function unique(values: readonly string[]) {
  return [...new Set(values)];
}

/**
 * Resolves one source participant to at most one internal student ID.
 * Member and name evidence belong to the same source participant: conflicting
 * or unauthorized evidence is dropped rather than combined across students.
 */
export function mapJiaowubaoSnapshotParticipant(
  participant: JiaowubaoSnapshotStudentParticipant,
  lookup: JiaowubaoSnapshotStudentLookup,
): string | null {
  const memberCandidates = participant.memberId
    ? unique(lookup.memberCandidates.get(participant.memberId) ?? [])
    : [];
  if (memberCandidates.length > 1) return null;
  const memberCandidate = memberCandidates.length === 1 ? memberCandidates[0]! : null;
  const memberVisible = participant.memberId
    ? lookup.internalByMember.get(participant.memberId) ?? null
    : null;

  // A globally unique member key that is not in the allowed map is known but
  // unauthorized. It must not be silently replaced by name evidence.
  if (memberCandidate && !memberVisible) return null;

  const nameKeys = participant.label
    ? unique([
      normalizeStudentImportName(participant.label),
      studentImportAutomaticJwbNameKey(participant.label),
    ].filter(Boolean))
    : [];
  const nameCandidateIds = unique(nameKeys.flatMap((key) => lookup.nameCandidates.get(key) ?? []));
  if (nameCandidateIds.length > 1) return null;
  const nameCandidate = nameCandidateIds.length === 1 ? nameCandidateIds[0]! : null;
  const nameVisibleIds = unique(nameKeys.flatMap((key) => {
    const visible = lookup.internalByNameKey.get(key);
    return visible ? [visible] : [];
  }));
  if (nameVisibleIds.length > 1) return null;
  const nameVisible = nameVisibleIds.length === 1 ? nameVisibleIds[0]! : null;

  // The source participant must not resolve to different internal students
  // through its two independent identity proofs.
  if (memberCandidate && nameCandidate && memberCandidate !== nameCandidate) return null;
  // As with member IDs, a globally unique but unauthorized name is known and
  // must fail closed instead of becoming a partial visible match.
  if (nameCandidate && !nameVisible) return null;

  return memberVisible ?? nameVisible;
}

export function mapJiaowubaoSnapshotParticipants(
  participants: readonly JiaowubaoSnapshotStudentParticipant[],
  lookup: JiaowubaoSnapshotStudentLookup,
) {
  return participants.flatMap((participant) => {
    const studentId = mapJiaowubaoSnapshotParticipant(participant, lookup);
    return studentId ? [studentId] : [];
  });
}
