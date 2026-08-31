import type { DemoSessionRole } from "@/lib/demo-session-token";
import {
  assertLegacyTaskDeadlineSetCommand,
  authorizeLegacyTaskDeadlineCommand,
  legacyTaskDeadlineIntent,
  prepareLegacyTaskDeadline,
  type LegacyTaskDeadlineCommand,
  type LegacyTaskDeadlineIntent,
  type LegacyTaskDeadlineSetIntent,
} from "@/lib/legacy-task-deadline-service";
import type {
  LegacyTaskDeadlineCommandResult,
  LegacyTaskDeadlineCommitResult,
  OpsStateRow,
} from "@/lib/ops-store";

type ReplayLookup = (input: Readonly<{
  commandKey: string;
  commandIntent: LegacyTaskDeadlineIntent;
  actor: string;
}>) => Promise<readonly LegacyTaskDeadlineCommandResult[]>;

type DeadlineMutation = (input: Readonly<{
  commandKey: string;
  commandIntent: LegacyTaskDeadlineSetIntent;
  expectedVersions: Readonly<{ students: number; tasks: number }>;
  actor: string;
}>) => Promise<readonly LegacyTaskDeadlineCommitResult[]>;

export type LegacyTaskDeadlineExecution =
  | Readonly<{ kind: "replay"; result: LegacyTaskDeadlineCommandResult }>
  | Readonly<{ kind: "commit"; result: LegacyTaskDeadlineCommitResult | undefined }>;

/**
 * Reauthorizes before replay, permits a historical clear receipt, then gates
 * every new clear before the sole mutation dependency can be called.
 */
export async function executeLegacyTaskDeadlineCommand(input: Readonly<{
  command: LegacyTaskDeadlineCommand;
  rows: readonly OpsStateRow[];
  actor: string;
  role: DemoSessionRole;
  fullAdmin: boolean;
  getReplay: ReplayLookup;
  mutate: DeadlineMutation;
}>): Promise<LegacyTaskDeadlineExecution> {
  authorizeLegacyTaskDeadlineCommand(input);
  const commandIntent = legacyTaskDeadlineIntent(input.command);
  const replay = await input.getReplay({
    commandKey: input.command.commandKey,
    commandIntent,
    actor: input.actor,
  });
  if (replay[0]) return { kind: "replay", result: replay[0] };

  assertLegacyTaskDeadlineSetCommand(input.command);
  const prepared = prepareLegacyTaskDeadline({
    command: input.command,
    rows: input.rows,
    actor: input.actor,
    role: input.role,
    fullAdmin: input.fullAdmin,
  });
  const committed = await input.mutate({
    commandKey: prepared.commandKey,
    commandIntent: prepared.commandIntent,
    expectedVersions: prepared.expectedVersions,
    actor: input.actor,
  });
  return { kind: "commit", result: committed[0] };
}
