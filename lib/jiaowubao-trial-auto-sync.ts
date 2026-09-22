import { randomUUID } from "node:crypto";

import {
  getOpsState,
  syncJiaowubaoTrialMatchesAtomic,
} from "./ops-store";
import {
  runJiaowubaoTrialAutoSyncCore,
  runJiaowubaoTrialAutoSyncHorizonCore,
  type JiaowubaoTrialAutoSyncDependencies,
  type JiaowubaoTrialAutoSyncResult,
} from "./jiaowubao-trial-auto-sync-core";
import { readJiaowubaoTrialSourceWindow } from "./jiaowubao-trial-source-window";
import type { JiaowubaoTrialSyncWindow } from "./jiaowubao-trial-sync";

const DEFAULT_DEPENDENCIES: JiaowubaoTrialAutoSyncDependencies = {
  getRows: (entities) => getOpsState(entities),
  readSource: readJiaowubaoTrialSourceWindow,
  commit: syncJiaowubaoTrialMatchesAtomic,
  uuid: randomUUID,
  now: () => new Date(),
};

export { jiaowubaoTrialProjectionWindow } from "./jiaowubao-trial-auto-sync-core";
export type { JiaowubaoTrialAutoSyncResult } from "./jiaowubao-trial-auto-sync-core";

/**
 * Reconciles every unambiguous trial match from the immutable source snapshot.
 * It runs even when the source revision is unchanged, because a newly-created
 * LP may become matchable against the already-published snapshot.
 */
export async function runJiaowubaoTrialAutoSync(
  input: Readonly<{
    snapshotRevision: string;
    window: JiaowubaoTrialSyncWindow;
    actor?: "Ops Admin";
  }>,
): Promise<JiaowubaoTrialAutoSyncResult> {
  return runJiaowubaoTrialAutoSyncCore(input, DEFAULT_DEPENDENCIES);
}

export async function runJiaowubaoTrialAutoSyncHorizon(
  input: Readonly<{
    snapshotRevision: string;
    windows: readonly JiaowubaoTrialSyncWindow[];
    actor?: "Ops Admin";
  }>,
): Promise<JiaowubaoTrialAutoSyncResult> {
  return runJiaowubaoTrialAutoSyncHorizonCore(input, DEFAULT_DEPENDENCIES);
}
