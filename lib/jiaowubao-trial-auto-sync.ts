import { randomUUID } from "node:crypto";

import {
  getOpsState,
  syncJiaowubaoTrialMatchesAtomic,
  type OpsRpcOptions,
} from "./ops-store";
import {
  runJiaowubaoTrialAutoSyncCore,
  runJiaowubaoTrialAutoSyncHorizonCore,
  type JiaowubaoTrialAutoSyncDependencies,
  type JiaowubaoTrialAutoSyncResult,
} from "./jiaowubao-trial-auto-sync-core";
import { readJiaowubaoTrialSourceWindow } from "./jiaowubao-trial-source-window";
import type { JiaowubaoTrialSyncWindow } from "./jiaowubao-trial-sync";

type RpcOptionsProvider = OpsRpcOptions | (() => OpsRpcOptions);

function currentRpcOptions(provider: RpcOptionsProvider) {
  return typeof provider === "function" ? provider() : provider;
}

function dependencies(
  rpcOptions: RpcOptionsProvider,
  stalePinnedSourceWindow: Readonly<{ start: string; end: string }> | null = null,
): JiaowubaoTrialAutoSyncDependencies {
  return {
    getRows: (entities) => getOpsState(entities, currentRpcOptions(rpcOptions)),
    readSource: (revision, window) => readJiaowubaoTrialSourceWindow(
      revision,
      window,
      rpcOptions,
      stalePinnedSourceWindow,
    ),
    commit: (input) => syncJiaowubaoTrialMatchesAtomic(input, currentRpcOptions(rpcOptions)),
    uuid: randomUUID,
    now: () => new Date(),
  };
}

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
  rpcOptions: RpcOptionsProvider = {},
): Promise<JiaowubaoTrialAutoSyncResult> {
  return runJiaowubaoTrialAutoSyncCore(input, dependencies(rpcOptions));
}

export async function runJiaowubaoTrialAutoSyncHorizon(
  input: Readonly<{
    snapshotRevision: string;
    windows: readonly JiaowubaoTrialSyncWindow[];
    actor?: "Ops Admin";
  }>,
  rpcOptions: RpcOptionsProvider = {},
  stalePinnedSourceWindow: Readonly<{ start: string; end: string }> | null = null,
): Promise<JiaowubaoTrialAutoSyncResult> {
  return runJiaowubaoTrialAutoSyncHorizonCore(
    input,
    dependencies(rpcOptions, stalePinnedSourceWindow),
  );
}
