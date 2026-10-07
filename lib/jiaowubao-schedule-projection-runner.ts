export type JiaowubaoScheduleProjectionState = "pending" | "authority_done" | "complete";
export type JiaowubaoScheduleProjectionPhase = "prepare_authority" | "project_authority" | "project_trials";

export type JiaowubaoScheduleProjectionTarget = Readonly<{
  revision: string;
  rowCount: number;
  projectionState: JiaowubaoScheduleProjectionState;
  window: Readonly<{ start: string; end: string }>;
  publishedAt: string;
}>;

type ProjectionTransitionReceipt = Readonly<{
  revision: string;
  state: JiaowubaoScheduleProjectionState;
  replayed: boolean;
}>;

export type JiaowubaoScheduleProjectionDependencies<AuthorityReceipt, TrialReceipt> = Readonly<{
  canStartProjection: () => boolean;
  assertAuthorityTime: () => void;
  prepareAuthority: (target: JiaowubaoScheduleProjectionTarget) => Promise<AuthorityReceipt>;
  projectAuthority: (
    target: JiaowubaoScheduleProjectionTarget,
    prepared: AuthorityReceipt,
  ) => Promise<AuthorityReceipt>;
  projectTrials: (
    target: JiaowubaoScheduleProjectionTarget,
    allowStalePinnedRevision: boolean,
  ) => Promise<TrialReceipt>;
  advance: (input: Readonly<{
    revision: string;
    expectedState: JiaowubaoScheduleProjectionState;
    nextState: JiaowubaoScheduleProjectionState;
  }>) => Promise<unknown>;
}>;

const PROJECTION_STATES = new Set<JiaowubaoScheduleProjectionState>(["pending", "authority_done", "complete"]);
const TRANSITION_STATES: Readonly<Record<JiaowubaoScheduleProjectionState, ReadonlySet<JiaowubaoScheduleProjectionState>>> = {
  pending: new Set<JiaowubaoScheduleProjectionState>(["pending"]),
  authority_done: new Set<JiaowubaoScheduleProjectionState>(["authority_done", "complete"]),
  complete: new Set<JiaowubaoScheduleProjectionState>(["complete"]),
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function transitionReceipt(value: unknown): ProjectionTransitionReceipt | null {
  if (!isRecord(value) || typeof value.revision !== "string" || typeof value.replayed !== "boolean") return null;
  if (!PROJECTION_STATES.has(value.state as JiaowubaoScheduleProjectionState)) return null;
  return Object.freeze({
    revision: value.revision,
    state: value.state as JiaowubaoScheduleProjectionState,
    replayed: value.replayed,
  });
}

function transitionState(
  value: unknown,
  revision: string,
  requestedState: JiaowubaoScheduleProjectionState,
) {
  const receipt = transitionReceipt(value);
  if (receipt === null || receipt.revision !== revision) throw new Error("projection_transition_invalid");
  if (!TRANSITION_STATES[requestedState].has(receipt.state)) throw new Error("projection_transition_invalid");
  return receipt.state;
}

function targetWithState(
  target: JiaowubaoScheduleProjectionTarget,
  projectionState: JiaowubaoScheduleProjectionState,
) {
  return Object.freeze({ ...target, projectionState });
}

export async function runJiaowubaoScheduleProjectionTarget<AuthorityReceipt, TrialReceipt>(
  target: JiaowubaoScheduleProjectionTarget,
  dependencies: JiaowubaoScheduleProjectionDependencies<AuthorityReceipt, TrialReceipt>,
  setPhase: (phase: JiaowubaoScheduleProjectionPhase) => void,
) {
  let state = target.projectionState;
  let authorityProjection: AuthorityReceipt | null = null;
  let trialProjection: TrialReceipt | null = null;

  if (state === "pending") {
    setPhase("prepare_authority");
    dependencies.assertAuthorityTime();
    const prepared = await dependencies.prepareAuthority(target);
    setPhase("project_authority");
    dependencies.assertAuthorityTime();
    authorityProjection = await dependencies.projectAuthority(target, prepared);
    state = transitionState(await dependencies.advance({
      revision: target.revision,
      expectedState: "pending",
      nextState: "authority_done",
    }), target.revision, "authority_done");
  }

  if (state === "authority_done") {
    setPhase("project_trials");
    trialProjection = await dependencies.projectTrials(targetWithState(target, state), true);
    state = transitionState(await dependencies.advance({
      revision: target.revision,
      expectedState: "authority_done",
      nextState: "complete",
    }), target.revision, "complete");
  }

  if (state !== "complete") throw new Error("projection_incomplete");
  return Object.freeze({ authorityProjection, trialProjection });
}

export async function runOrQueueJiaowubaoScheduleProjectionTarget<AuthorityReceipt, TrialReceipt>(
  target: JiaowubaoScheduleProjectionTarget,
  dependencies: JiaowubaoScheduleProjectionDependencies<AuthorityReceipt, TrialReceipt>,
  setPhase: (phase: JiaowubaoScheduleProjectionPhase) => void,
) {
  let queuedTarget = target;
  if (target.projectionState === "complete") {
    queuedTarget = targetWithState(target, transitionState(await dependencies.advance({
      revision: target.revision,
      expectedState: "complete",
      nextState: "pending",
    }), target.revision, "pending"));
  }
  if (!dependencies.canStartProjection()) {
    return Object.freeze({
      projectionQueued: true,
      authorityProjection: null,
      trialProjection: null,
    });
  }
  return Object.freeze({
    projectionQueued: false,
    ...await runJiaowubaoScheduleProjectionTarget(queuedTarget, dependencies, setPhase),
  });
}
