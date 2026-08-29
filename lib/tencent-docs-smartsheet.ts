import "server-only";

import { randomUUID } from "node:crypto";

import type { TencentTrialLedgerFieldWrite, TencentTrialLedgerTargetRecord } from "./tencent-trial-ledger-sync-plan";

const TENCENT_DOCS_MCP_URL = "https://docs.qq.com/openapi/mcp";
const MCP_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;

type JsonRecord = Record<string, unknown>;

export class TencentDocsMcpError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function chunks<T>(values: readonly T[], size = PAGE_SIZE) {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) result.push(values.slice(start, start + size));
  return result;
}

async function callTool(input: Readonly<{
  token: string;
  name: "smartsheet.list_records" | "smartsheet.add_records" | "smartsheet.update_records";
  arguments: JsonRecord;
}>) {
  const token = input.token.trim();
  if (!token || token.length > 16_384) throw new TencentDocsMcpError("tencent_mcp_configuration_missing");

  const requestId = randomUUID();
  let response: Response;
  try {
    response = await fetch(TENCENT_DOCS_MCP_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: { name: input.name, arguments: input.arguments },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });
  } catch {
    throw new TencentDocsMcpError("tencent_mcp_request_failed");
  }
  if (!response.ok) throw new TencentDocsMcpError("tencent_mcp_request_failed");

  const body = await response.text().catch(() => "");
  const candidates = response.headers.get("content-type")?.includes("text/event-stream")
    ? body.split(/\r?\n/u).flatMap((line) => line.startsWith("data:") ? [line.slice(5).trim()] : [])
    : [body];
  const envelope = candidates.flatMap((candidate) => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return record(parsed) && parsed.id === requestId ? [parsed] : [];
    } catch {
      return [];
    }
  }).at(-1);
  if (!envelope || envelope.jsonrpc !== "2.0" || "error" in envelope || !record(envelope.result)) {
    throw new TencentDocsMcpError("tencent_mcp_protocol_invalid");
  }
  const result = envelope.result;
  if (result.isError === true || !record(result.structuredContent)
    || (typeof result.structuredContent.error === "string" && result.structuredContent.error.trim())) {
    throw new TencentDocsMcpError("tencent_mcp_tool_failed");
  }
  return result.structuredContent;
}

function validatedRecords(value: unknown) {
  if (!Array.isArray(value)) throw new TencentDocsMcpError("tencent_mcp_protocol_invalid");
  const records = value.map((candidate) => {
    if (!record(candidate) || typeof candidate.record_id !== "string" || !candidate.record_id.trim()
      || (candidate.field_values !== undefined && !Array.isArray(candidate.field_values))) {
      throw new TencentDocsMcpError("tencent_mcp_protocol_invalid");
    }
    return {
      record_id: candidate.record_id,
      field_values: Array.isArray(candidate.field_values) ? candidate.field_values : [],
    } satisfies TencentTrialLedgerTargetRecord;
  });
  if (new Set(records.map((candidate) => candidate.record_id)).size !== records.length) {
    throw new TencentDocsMcpError("tencent_mcp_protocol_invalid");
  }
  return records;
}

async function listPage(input: Readonly<{
  token: string;
  fileId: string;
  sheetId: string;
  fieldTitles: readonly string[];
  offset?: number;
  recordIds?: readonly string[];
}>) {
  const result = await callTool({
    token: input.token,
    name: "smartsheet.list_records",
    arguments: {
      file_id: input.fileId,
      sheet_id: input.sheetId,
      field_titles: [...input.fieldTitles],
      limit: PAGE_SIZE,
      offset: input.offset ?? 0,
      ...(input.recordIds ? { record_ids: [...input.recordIds] } : {}),
    },
  });
  const records = validatedRecords(result.records);
  const hasMore = result.has_more === true;
  const next = result.next;
  if (hasMore && (!Number.isSafeInteger(next) || (next as number) <= (input.offset ?? 0))) {
    throw new TencentDocsMcpError("tencent_mcp_protocol_invalid");
  }
  return { records, hasMore, next: hasMore ? next as number : 0 };
}

export async function listAllTencentTrialLedgerRecords(input: Readonly<{
  token: string;
  fileId: string;
  sheetId: string;
  fieldTitles: readonly string[];
}>) {
  const records: TencentTrialLedgerTargetRecord[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await listPage({ ...input, offset });
    records.push(...result.records);
    if (!result.hasMore) {
      if (new Set(records.map((candidate) => candidate.record_id)).size !== records.length) {
        throw new TencentDocsMcpError("tencent_mcp_protocol_invalid");
      }
      return records;
    }
    offset = result.next;
  }
  throw new TencentDocsMcpError("tencent_mcp_page_limit_exceeded");
}

export async function listTencentTrialLedgerRecordsById(input: Readonly<{
  token: string;
  fileId: string;
  sheetId: string;
  fieldTitles: readonly string[];
  recordIds: readonly string[];
}>) {
  const records: TencentTrialLedgerTargetRecord[] = [];
  for (const recordIds of chunks([...new Set(input.recordIds)])) {
    if (!recordIds.length) continue;
    const result = await listPage({ ...input, recordIds });
    if (result.hasMore) throw new TencentDocsMcpError("tencent_mcp_protocol_invalid");
    records.push(...result.records);
  }
  if (new Set(records.map((candidate) => candidate.record_id)).size !== records.length) {
    throw new TencentDocsMcpError("tencent_mcp_protocol_invalid");
  }
  return records;
}

export async function addTencentTrialLedgerRecords(input: Readonly<{
  token: string;
  fileId: string;
  sheetId: string;
  records: readonly Readonly<{ field_values: readonly TencentTrialLedgerFieldWrite[] }>[];
}>) {
  const added: TencentTrialLedgerTargetRecord[] = [];
  for (const batch of chunks(input.records)) {
    if (!batch.length) continue;
    const result = await callTool({
      token: input.token,
      name: "smartsheet.add_records",
      arguments: {
        file_id: input.fileId,
        sheet_id: input.sheetId,
        records: batch.map((candidate) => ({ field_values: candidate.field_values })),
      },
    });
    const records = validatedRecords(result.records);
    if (records.length !== batch.length) throw new TencentDocsMcpError("tencent_mcp_write_receipt_invalid");
    added.push(...records);
  }
  return added;
}

export async function updateTencentTrialLedgerRecords(input: Readonly<{
  token: string;
  fileId: string;
  sheetId: string;
  records: readonly Readonly<{ record_id: string; field_values: readonly TencentTrialLedgerFieldWrite[] }>[];
}>) {
  for (const batch of chunks(input.records)) {
    if (!batch.length) continue;
    await callTool({
      token: input.token,
      name: "smartsheet.update_records",
      arguments: {
        file_id: input.fileId,
        sheet_id: input.sheetId,
        records: batch.map((candidate) => ({
          record_id: candidate.record_id,
          field_values: candidate.field_values,
        })),
      },
    });
  }
}
