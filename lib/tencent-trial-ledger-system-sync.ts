import "server-only";

import {
  addTencentTrialLedgerRecords,
  listAllTencentTrialLedgerRecords,
  listTencentTrialLedgerRecordsById,
  TencentDocsMcpError,
  updateTencentTrialLedgerRecords,
} from "./tencent-docs-smartsheet";
import {
  TENCENT_TRIAL_LEDGER_FIELDS,
  TENCENT_TRIAL_LEDGER_FILE_ID,
  TENCENT_TRIAL_LEDGER_SHEET_ID,
} from "./tencent-trial-ledger-mirror";
import {
  assertTencentTrialLedgerReadback,
  planTencentTrialLedgerWrites,
  TencentTrialLedgerSyncPlanError,
  type TencentTrialLedgerRecordMapping,
  type TencentTrialLedgerSyncRow,
} from "./tencent-trial-ledger-sync-plan";

type JsonRecord = Record<string, unknown>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export class TencentTrialLedgerSystemSyncError extends Error {
  constructor(readonly code: string, readonly phase: string) {
    super(code);
  }
}

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function bridgeJson(input: Readonly<{
  url: URL;
  token: string;
  method?: "GET" | "POST";
  body?: JsonRecord;
}>) {
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: input.method ?? "GET",
      headers: {
        Authorization: `Bearer ${input.token}`,
        ...(input.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new TencentTrialLedgerSystemSyncError("bridge_request_failed", "bridge");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !record(payload)) {
    throw new TencentTrialLedgerSystemSyncError("bridge_request_failed", "bridge");
  }
  return payload;
}

function string(value: unknown) {
  return typeof value === "string" ? value : "";
}

function syncRows(value: unknown) {
  if (!Array.isArray(value)) throw new TencentTrialLedgerSystemSyncError("claim_invalid", "claim");
  return value.map((candidate) => {
    if (!record(candidate) || !record(candidate.values)) {
      throw new TencentTrialLedgerSystemSyncError("claim_invalid", "claim");
    }
    return {
      lpItemId: string(candidate.lpItemId),
      payloadSha256: string(candidate.payloadSha256),
      values: candidate.values,
    } as TencentTrialLedgerSyncRow;
  });
}

function syncMappings(value: unknown) {
  if (!Array.isArray(value)) throw new TencentTrialLedgerSystemSyncError("claim_invalid", "claim");
  return value.map((candidate) => {
    if (!record(candidate)) throw new TencentTrialLedgerSystemSyncError("claim_invalid", "claim");
    return {
      lpItemId: string(candidate.lpItemId),
      recordId: string(candidate.recordId),
      payloadSha256: string(candidate.payloadSha256),
    } satisfies TencentTrialLedgerRecordMapping;
  });
}

function category(error: unknown) {
  if (error instanceof TencentTrialLedgerSystemSyncError
    || error instanceof TencentDocsMcpError
    || error instanceof TencentTrialLedgerSyncPlanError) return error.code;
  return "system_sync_failed";
}

export async function runTencentTrialLedgerSystemSync(input: Readonly<{
  bridgeUrl: URL;
  bridgeToken: string;
  tencentToken: string;
}>) {
  let leaseToken = "";
  let phase = "claim";
  try {
    const claim = await bridgeJson({ url: input.bridgeUrl, token: input.bridgeToken });
    if (claim.outcome === "idle") return { outcome: "idle" as const };
    if (claim.outcome !== "claimed" || !UUID_V4.test(string(claim.leaseToken).toLowerCase())
      || !SHA256.test(string(claim.payloadSha256)) || !SHA256.test(string(claim.completionProof))
      || !record(claim.target) || claim.target.fileId !== TENCENT_TRIAL_LEDGER_FILE_ID
      || claim.target.sheetId !== TENCENT_TRIAL_LEDGER_SHEET_ID || !Array.isArray(claim.events)) {
      throw new TencentTrialLedgerSystemSyncError("claim_invalid", phase);
    }
    leaseToken = string(claim.leaseToken);
    const rows = syncRows(claim.rows);
    const mappings = syncMappings(claim.mappings);

    phase = "read_target";
    const records = await listAllTencentTrialLedgerRecords({
      token: input.tencentToken,
      fileId: TENCENT_TRIAL_LEDGER_FILE_ID,
      sheetId: TENCENT_TRIAL_LEDGER_SHEET_ID,
      fieldTitles: TENCENT_TRIAL_LEDGER_FIELDS,
    });
    const plan = planTencentTrialLedgerWrites({ rows, mappings, records });

    phase = "update_target";
    await updateTencentTrialLedgerRecords({
      token: input.tencentToken,
      fileId: TENCENT_TRIAL_LEDGER_FILE_ID,
      sheetId: TENCENT_TRIAL_LEDGER_SHEET_ID,
      records: plan.updates.map((update) => ({
        record_id: update.recordId,
        field_values: update.fieldValues,
      })),
    });

    phase = "add_target";
    const added = await addTencentTrialLedgerRecords({
      token: input.tencentToken,
      fileId: TENCENT_TRIAL_LEDGER_FILE_ID,
      sheetId: TENCENT_TRIAL_LEDGER_SHEET_ID,
      records: plan.creates.map((create) => ({ field_values: create.fieldValues })),
    });
    if (added.length !== plan.creates.length) {
      throw new TencentTrialLedgerSystemSyncError("tencent_mcp_write_receipt_invalid", phase);
    }
    const assignments = [
      ...plan.assignments.map((assignment) => ({ row: assignment.row, recordId: assignment.recordId })),
      ...plan.creates.map((create, index) => ({ row: create.row, recordId: added[index]!.record_id })),
    ];

    phase = "readback";
    const readback = await listTencentTrialLedgerRecordsById({
      token: input.tencentToken,
      fileId: TENCENT_TRIAL_LEDGER_FILE_ID,
      sheetId: TENCENT_TRIAL_LEDGER_SHEET_ID,
      fieldTitles: TENCENT_TRIAL_LEDGER_FIELDS,
      recordIds: assignments.map((assignment) => assignment.recordId),
    });
    assertTencentTrialLedgerReadback({ assignments, records: readback });

    phase = "complete";
    const receipt = await bridgeJson({
      url: input.bridgeUrl,
      token: input.bridgeToken,
      method: "POST",
      body: {
        action: "complete",
        leaseToken,
        payloadSha256: string(claim.payloadSha256),
        completionProof: string(claim.completionProof),
        mappings: assignments.map((assignment) => ({
          lpItemId: assignment.row.lpItemId,
          recordId: assignment.recordId,
          payloadSha256: assignment.row.payloadSha256,
        })),
      },
    });
    if (receipt.outcome !== "completed" || !Number.isSafeInteger(receipt.completedEventCount)
      || !Number.isSafeInteger(receipt.syncedRecordCount) || receipt.syncedRecordCount !== rows.length) {
      throw new TencentTrialLedgerSystemSyncError("completion_receipt_invalid", phase);
    }
    leaseToken = "";
    return {
      outcome: "completed" as const,
      addedCount: plan.creates.length,
      updatedCount: plan.updates.length,
      adoptedCount: plan.assignments.filter((assignment) => assignment.source === "adopted").length,
      completedEventCount: receipt.completedEventCount as number,
      syncedRecordCount: receipt.syncedRecordCount as number,
    };
  } catch (error) {
    const code = category(error);
    if (leaseToken) {
      await bridgeJson({
        url: input.bridgeUrl,
        token: input.bridgeToken,
        method: "POST",
        body: { action: "fail", leaseToken, errorCode: code },
      }).catch(() => undefined);
    }
    if (error instanceof TencentTrialLedgerSystemSyncError) throw error;
    throw new TencentTrialLedgerSystemSyncError(code, phase);
  }
}
