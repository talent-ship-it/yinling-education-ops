import "server-only";
import { callTencentDocsTool } from "./tencent-docs-smartsheet";
import { TENCENT_LP_SOURCE_FILE_ID, TENCENT_LP_SOURCE_SHEET_ID, type TencentLpSourceCell } from "./tencent-lp-source";
const PAGE_ROWS = 100;
const MAX_ROWS = 20_000;
type JsonRecord = Record<string, unknown>;
function object(value: unknown): value is JsonRecord { return !!value && typeof value === "object" && !Array.isArray(value); }
function isTargetSheet(value: unknown): value is JsonRecord {
  return object(value) && value.sheet_id === TENCENT_LP_SOURCE_SHEET_ID;
}
function validCoordinate(value: unknown, minimum: number, end: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) < end;
}
function sheetRowCount(sheet: JsonRecord) {
  if (sheet.sheet_type !== "worksheet" || !validCoordinate(sheet.row_count, 1, MAX_ROWS + 1)) {
    throw new Error("tencent_lp_source_sheet_invalid");
  }
  return sheet.row_count;
}
function sourceRowCount(info: JsonRecord) {
  if (!Array.isArray(info.sheets)) throw new Error("tencent_lp_source_sheet_invalid");
  const sheets = info.sheets.filter(isTargetSheet);
  if (sheets.length !== 1) throw new Error("tencent_lp_source_sheet_invalid");
  return sheetRowCount(sheets[0]!);
}
function validPageCell(cell: unknown, start: number, end: number) {
  return object(cell) && validCoordinate(cell.row, start, end) && validCoordinate(cell.col, 0, 17);
}
function sourcePageCells(result: JsonRecord, start: number, end: number) {
  if (!Array.isArray(result.cells) || result.cells.some((cell) => !validPageCell(cell, start, end))) {
    throw new Error("tencent_lp_source_page_invalid");
  }
  return result.cells as TencentLpSourceCell[];
}
function assertSyncBudget(deadlineAt: number, phase: "read" | "write") {
  if (Date.now() > deadlineAt - 31_000) throw new Error(`tencent_lp_source_${phase}_budget_exceeded`);
}
export async function readTencentLpSource(token: string, deadlineAt: number) {
  const info = await callTencentDocsTool({ token, name: "sheet.get_sheet_info", arguments: { file_id: TENCENT_LP_SOURCE_FILE_ID } });
  const rowCount = sourceRowCount(info);
  const cells: TencentLpSourceCell[] = [];
  for (let start = 0; start < rowCount; start += PAGE_ROWS) {
    assertSyncBudget(deadlineAt, "read");
    const end = Math.min(start + PAGE_ROWS, rowCount);
    const result = await callTencentDocsTool({ token, name: "sheet.get_cell_data", arguments: {
      file_id: TENCENT_LP_SOURCE_FILE_ID, sheet_id: TENCENT_LP_SOURCE_SHEET_ID,
      start_row: start, end_row: end - 1, start_col: 0, end_col: 16, return_csv: false,
    } });
    cells.push(...sourcePageCells(result, start, end));
  }
  return cells;
}

export async function readTencentLpSourceRow(token: string, row: number, deadlineAt: number) {
  assertSyncBudget(deadlineAt, "read");
  const header = await callTencentDocsTool({ token, name: "sheet.get_cell_data", arguments: {
    file_id: TENCENT_LP_SOURCE_FILE_ID, sheet_id: TENCENT_LP_SOURCE_SHEET_ID,
    start_row: 0, end_row: 0, start_col: 0, end_col: 16, return_csv: false,
  } });
  assertSyncBudget(deadlineAt, "read");
  const result = await callTencentDocsTool({ token, name: "sheet.get_cell_data", arguments: {
    file_id: TENCENT_LP_SOURCE_FILE_ID, sheet_id: TENCENT_LP_SOURCE_SHEET_ID,
    start_row: row, end_row: row, start_col: 0, end_col: 16, return_csv: false,
  } });
  return [...sourcePageCells(header, 0, 1), ...sourcePageCells(result, row, row + 1)];
}
function assertWriteTarget(row: number, column: number) {
  if (!validCoordinate(row, 1, MAX_ROWS + 1)) throw new Error("tencent_lp_source_write_target_invalid");
  if (![9, 10, 14, 15, 16].includes(column)) throw new Error("tencent_lp_source_write_target_invalid");
}
export async function writeTencentLpSourceCell(token: string, row: number, column: number, value: string | boolean, deadlineAt: number) {
  assertWriteTarget(row, column);
  assertSyncBudget(deadlineAt, "write");
  const cell = typeof value === "boolean" ? { value_type: "BOOL", bool_value: value } : { value_type: "STRING", string_value: value };
  await callTencentDocsTool({ token, name: "sheet.set_cell_value", arguments: {
    file_id: TENCENT_LP_SOURCE_FILE_ID, sheet_id: TENCENT_LP_SOURCE_SHEET_ID, row, col: column, ...cell,
  } });
}
