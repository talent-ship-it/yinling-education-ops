import { inflateRawSync } from "node:zlib";
import { XMLParser, XMLValidator } from "fast-xml-parser";

/**
 * A deliberately small XLSX reader for server-side imports.
 *
 * It reads only the Open XML parts needed to turn worksheets into ordered cell
 * values.  It does not evaluate formulas, interpret styles, or attempt to
 * repair malformed workbooks.  Those are intentional boundaries: callers
 * should make business decisions from the source values, never from guessed
 * spreadsheet formatting or calculated values.
 */

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_ENCRYPTED_FLAG = 0x0001;
const ZIP_COMPRESSED_FLAG = 0x0020;
const ZIP_STRONG_ENCRYPTION_FLAG = 0x0040;
const ZIP64_UINT16_SENTINEL = 0xffff;
const ZIP64_UINT32_SENTINEL = 0xffffffff;
const MAX_EXCEL_ROW = 1_048_576;
const MAX_EXCEL_COLUMN = 16_384; // XFD

const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 32 * 1024 * 1024,
  maxEntries: 1_024,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalUncompressedBytes: 64 * 1024 * 1024,
  maxSharedStrings: 250_000,
  maxWorksheets: 256,
  maxRowsPerWorksheet: 200_000,
  maxCellsPerWorksheet: 1_000_000,
});

export type XlsxReadLimits = Readonly<typeof DEFAULT_LIMITS>;

/** Limits may only be lowered by a caller, never relaxed past the safe defaults. */
export type XlsxReaderOptions = Readonly<{
  limits?: Partial<XlsxReadLimits>;
}>;

export type XlsxCellType = "string" | "number" | "boolean" | "date" | "error" | "blank";

export type XlsxCell = Readonly<{
  /** A normalised A1 reference, for example `C12`. */
  reference: string;
  /** One-based worksheet row. */
  row: number;
  /** One-based worksheet column. */
  column: number;
  type: XlsxCellType;
  /**
   * The cached source value. Formula cells are not calculated by this reader;
   * when Excel did not persist a cached result, this is null.
   */
  value: string | number | boolean | null;
  /** The untouched cell value from XML, when one exists. */
  rawValue?: string;
  /** Formula text without the leading `=`. This reader never evaluates it. */
  formula?: string;
  /** The zero-based Excel style index, retained for callers that need it. */
  styleIndex?: number;
}>;

export type XlsxRow = Readonly<{
  /** One-based worksheet row. Empty explicit rows are retained. */
  index: number;
  cells: readonly XlsxCell[];
}>;

export type XlsxWorksheet = Readonly<{
  name: string;
  rows: readonly XlsxRow[];
}>;

export type XlsxWorkbook = Readonly<{
  worksheets: readonly XlsxWorksheet[];
}>;

export type XlsxReadErrorCode =
  | "invalid_input"
  | "invalid_limits"
  | "archive_too_large"
  | "invalid_zip"
  | "zip64_not_supported"
  | "multi_disk_zip_not_supported"
  | "encrypted_zip_not_supported"
  | "unsupported_zip_compression"
  | "unsafe_archive_path"
  | "duplicate_archive_entry"
  | "archive_entry_too_large"
  | "archive_expands_too_large"
  | "zip_decompression_failed"
  | "zip_integrity_check_failed"
  | "missing_required_part"
  | "unsafe_xml"
  | "invalid_xml"
  | "invalid_workbook"
  | "invalid_relationship"
  | "unsafe_relationship_target"
  | "invalid_worksheet"
  | "invalid_cell"
  | "shared_string_limit_exceeded";

export class XlsxReadError extends Error {
  constructor(
    readonly code: XlsxReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "XlsxReadError";
  }
}

type XmlRecord = Record<string, unknown>;

type ZipEntry = Readonly<{
  name: string;
  flags: number;
  compression: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}>;

type Archive = Readonly<{
  getEntry: (path: string) => ZipEntry | undefined;
  readEntry: (path: string) => Uint8Array;
}>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  alwaysCreateTextNode: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  removeNSPrefix: true,
  // We reject doctypes/entities before parsing.  Enabling the built-in entity
  // decoding still preserves normal spreadsheet strings such as `A & B`.
  processEntities: true,
});

const utf8 = new TextDecoder("utf-8", { fatal: true });

function record(value: unknown): XmlRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as XmlRecord;
}

function list(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const node = record(value);
  const textValue = node["#text"];
  return typeof textValue === "string" || typeof textValue === "number" || typeof textValue === "boolean"
    ? String(textValue)
    : undefined;
}

function attribute(node: XmlRecord, name: string): string | undefined {
  const value = node[`@_${name}`];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : undefined;
}

function fail(code: XlsxReadErrorCode, message: string): never {
  throw new XlsxReadError(code, message);
}

function asPositiveInteger(value: string | undefined, code: XlsxReadErrorCode, field: string) {
  if (!value || !/^[1-9]\d*$/.test(value)) fail(code, `${field} 必须是正整数。`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(code, `${field} 超出安全整数范围。`);
  return parsed;
}

function asNonNegativeInteger(value: string | undefined, code: XlsxReadErrorCode, field: string) {
  if (value === undefined || !/^\d+$/.test(value)) fail(code, `${field} 必须是非负整数。`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(code, `${field} 超出安全整数范围。`);
  return parsed;
}

function resolveLimits(options?: XlsxReaderOptions): XlsxReadLimits {
  const requested = options?.limits;
  if (!requested) return DEFAULT_LIMITS;
  const resolved = {} as Record<keyof XlsxReadLimits, number>;
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof XlsxReadLimits)[]) {
    const candidate = requested[key];
    if (candidate === undefined) {
      resolved[key] = DEFAULT_LIMITS[key];
      continue;
    }
    if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > DEFAULT_LIMITS[key]) {
      fail("invalid_limits", `${key} 只能设为不超过安全默认值的正整数。`);
    }
    resolved[key] = candidate;
  }
  return Object.freeze(resolved) as XlsxReadLimits;
}

function inBounds(bytes: Uint8Array, offset: number, length: number) {
  return Number.isSafeInteger(offset)
    && Number.isSafeInteger(length)
    && offset >= 0
    && length >= 0
    && offset <= bytes.length
    && length <= bytes.length - offset;
}

function requireBounds(bytes: Uint8Array, offset: number, length: number) {
  if (!inBounds(bytes, offset, length)) fail("invalid_zip", "XLSX ZIP 目录或文件内容越界。");
}

function uint16(bytes: Uint8Array, offset: number) {
  requireBounds(bytes, offset, 2);
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint32(bytes: Uint8Array, offset: number) {
  requireBounds(bytes, offset, 4);
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function decodeZipPath(bytes: Uint8Array) {
  let path: string;
  try {
    path = utf8.decode(bytes);
  } catch {
    fail("invalid_zip", "XLSX ZIP 文件名不是有效 UTF-8。");
  }
  if (!/^[\x21-\x7e]+$/.test(path)) fail("unsafe_archive_path", "XLSX ZIP 文件名必须是安全 ASCII 路径。");
  return path;
}

function isDirectoryPath(path: string) {
  return path.endsWith("/");
}

function assertSafeArchivePath(path: string, allowDirectory = false) {
  const candidate = allowDirectory && isDirectoryPath(path) ? path.slice(0, -1) : path;
  if (!candidate || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    fail("unsafe_archive_path", "XLSX ZIP 包含不安全的文件路径。");
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail("unsafe_archive_path", "XLSX ZIP 包含不安全的文件路径。");
  }
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function locateEndOfCentralDirectory(bytes: Uint8Array) {
  const minimumOffset = Math.max(0, bytes.length - 22 - ZIP64_UINT16_SENTINEL);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (uint32(bytes, offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = uint16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  fail("invalid_zip", "未找到有效的 XLSX ZIP 目录。");
}

function readArchive(bytes: Uint8Array, limits: XlsxReadLimits): Archive {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    fail("invalid_input", "XLSX 输入必须是非空的字节数组。");
  }
  if (bytes.byteLength > limits.maxArchiveBytes) {
    fail("archive_too_large", "XLSX 文件超过允许的大小。");
  }
  if (bytes.byteLength < 22) fail("invalid_zip", "XLSX ZIP 文件不完整。");

  const eocdOffset = locateEndOfCentralDirectory(bytes);
  const diskNumber = uint16(bytes, eocdOffset + 4);
  const centralDirectoryDisk = uint16(bytes, eocdOffset + 6);
  const entriesOnDisk = uint16(bytes, eocdOffset + 8);
  const entryCount = uint16(bytes, eocdOffset + 10);
  const centralDirectorySize = uint32(bytes, eocdOffset + 12);
  const centralDirectoryOffset = uint32(bytes, eocdOffset + 16);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    fail("multi_disk_zip_not_supported", "不支持多磁盘 XLSX ZIP 文件。");
  }
  if (entryCount === ZIP64_UINT16_SENTINEL
    || centralDirectorySize === ZIP64_UINT32_SENTINEL
    || centralDirectoryOffset === ZIP64_UINT32_SENTINEL) {
    fail("zip64_not_supported", "不支持 ZIP64 XLSX 文件。");
  }
  if (entryCount === 0 || entryCount > limits.maxEntries) {
    fail("invalid_zip", "XLSX ZIP 文件条目数量无效或超过限制。");
  }
  requireBounds(bytes, centralDirectoryOffset, centralDirectorySize);
  if (centralDirectoryOffset + centralDirectorySize !== eocdOffset) {
    fail("invalid_zip", "XLSX ZIP 中央目录位置无效。");
  }

  const entries = new Map<string, ZipEntry>();
  let cursor = centralDirectoryOffset;
  let totalUncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    requireBounds(bytes, cursor, 46);
    if (uint32(bytes, cursor) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      fail("invalid_zip", "XLSX ZIP 中央目录条目无效。");
    }
    const flags = uint16(bytes, cursor + 8);
    const compression = uint16(bytes, cursor + 10);
    const checksum = uint32(bytes, cursor + 16);
    const compressedSize = uint32(bytes, cursor + 20);
    const uncompressedSize = uint32(bytes, cursor + 24);
    const fileNameLength = uint16(bytes, cursor + 28);
    const extraLength = uint16(bytes, cursor + 30);
    const commentLength = uint16(bytes, cursor + 32);
    const diskStart = uint16(bytes, cursor + 34);
    const localHeaderOffset = uint32(bytes, cursor + 42);
    const headerLength = 46 + fileNameLength + extraLength + commentLength;
    requireBounds(bytes, cursor, headerLength);

    if (compressedSize === ZIP64_UINT32_SENTINEL
      || uncompressedSize === ZIP64_UINT32_SENTINEL
      || localHeaderOffset === ZIP64_UINT32_SENTINEL
      || diskStart === ZIP64_UINT16_SENTINEL) {
      fail("zip64_not_supported", "不支持 ZIP64 XLSX 文件。");
    }
    if (diskStart !== 0) fail("multi_disk_zip_not_supported", "不支持多磁盘 XLSX ZIP 文件。");
    if (flags & (ZIP_ENCRYPTED_FLAG | ZIP_COMPRESSED_FLAG | ZIP_STRONG_ENCRYPTION_FLAG)) {
      fail("encrypted_zip_not_supported", "不支持加密 XLSX ZIP 文件。");
    }
    if (compression !== 0 && compression !== 8) {
      fail("unsupported_zip_compression", "XLSX ZIP 使用了不支持的压缩格式。");
    }
    if (uncompressedSize > limits.maxEntryBytes) {
      fail("archive_entry_too_large", "XLSX ZIP 内含超过限制的文件。");
    }
    totalUncompressedBytes += uncompressedSize;
    if (!Number.isSafeInteger(totalUncompressedBytes) || totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      fail("archive_expands_too_large", "XLSX 解压后的总大小超过限制。");
    }

    const path = decodeZipPath(bytes.subarray(cursor + 46, cursor + 46 + fileNameLength));
    assertSafeArchivePath(path, true);
    if (!isDirectoryPath(path)) {
      if (entries.has(path)) fail("duplicate_archive_entry", "XLSX ZIP 包含重复文件。");
      entries.set(path, {
        name: path,
        flags,
        compression,
        crc32: checksum,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }
    cursor += headerLength;
  }
  if (cursor !== centralDirectoryOffset + centralDirectorySize) {
    fail("invalid_zip", "XLSX ZIP 中央目录长度无效。");
  }

  function getEntry(path: string) {
    return entries.get(path);
  }

  function readEntry(path: string) {
    const entry = entries.get(path);
    if (!entry) fail("missing_required_part", `XLSX 缺少必要部分：${path}。`);
    const offset = entry.localHeaderOffset;
    requireBounds(bytes, offset, 30);
    if (uint32(bytes, offset) !== ZIP_LOCAL_FILE_HEADER) {
      fail("invalid_zip", "XLSX ZIP 本地文件头无效。");
    }
    const flags = uint16(bytes, offset + 6);
    const compression = uint16(bytes, offset + 8);
    const localChecksum = uint32(bytes, offset + 14);
    const localCompressedSize = uint32(bytes, offset + 18);
    const localUncompressedSize = uint32(bytes, offset + 22);
    const fileNameLength = uint16(bytes, offset + 26);
    const extraLength = uint16(bytes, offset + 28);
    const localHeaderLength = 30 + fileNameLength + extraLength;
    requireBounds(bytes, offset, localHeaderLength);
    const localName = decodeZipPath(bytes.subarray(offset + 30, offset + 30 + fileNameLength));

    if (localName !== entry.name || flags !== entry.flags || compression !== entry.compression) {
      fail("invalid_zip", "XLSX ZIP 本地文件头与目录不一致。");
    }
    if (!(flags & ZIP_DATA_DESCRIPTOR_FLAG)
      && (localChecksum !== entry.crc32
        || localCompressedSize !== entry.compressedSize
        || localUncompressedSize !== entry.uncompressedSize)) {
      fail("invalid_zip", "XLSX ZIP 本地文件头大小或校验和不一致。");
    }
    const dataOffset = offset + localHeaderLength;
    requireBounds(bytes, dataOffset, entry.compressedSize);
    const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
    let output: Uint8Array;
    if (entry.compression === 0) {
      output = compressed;
    } else {
      try {
        output = inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
      } catch {
        fail("zip_decompression_failed", "XLSX ZIP 文件无法安全解压。");
      }
    }
    if (output.byteLength !== entry.uncompressedSize || crc32(output) !== entry.crc32) {
      fail("zip_integrity_check_failed", "XLSX ZIP 文件完整性校验失败。");
    }
    return output;
  }

  return Object.freeze({ getEntry, readEntry });
}

function decodeXml(bytes: Uint8Array, partName: string) {
  let xml: string;
  try {
    xml = utf8.decode(bytes);
  } catch {
    fail("invalid_xml", `XLSX 部分 ${partName} 不是有效 UTF-8 XML。`);
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    fail("unsafe_xml", `XLSX 部分 ${partName} 包含不允许的 DTD 或实体声明。`);
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) fail("invalid_xml", `XLSX 部分 ${partName} 不是有效 XML。`);
  try {
    return parser.parse(xml);
  } catch {
    fail("invalid_xml", `XLSX 部分 ${partName} 无法解析。`);
  }
}

function readXmlPart(archive: Archive, partName: string, rootName: string) {
  const parsed = record(decodeXml(archive.readEntry(partName), partName));
  const root = record(parsed[rootName]);
  if (Object.keys(root).length === 0) fail("invalid_xml", `XLSX 部分 ${partName} 缺少 ${rootName} 根元素。`);
  return root;
}

function parseSharedText(value: unknown) {
  const node = record(value);
  const direct = text(node.t);
  if (direct !== undefined) return direct;
  const runs = list(node.r);
  if (runs.length === 0) return "";
  return runs.map((run) => {
    const runText = text(record(run).t);
    return runText ?? "";
  }).join("");
}

function readSharedStrings(archive: Archive, limits: XlsxReadLimits) {
  if (!archive.getEntry("xl/sharedStrings.xml")) return [] as readonly string[];
  const root = readXmlPart(archive, "xl/sharedStrings.xml", "sst");
  const strings = list(root.si);
  if (strings.length > limits.maxSharedStrings) {
    fail("shared_string_limit_exceeded", "XLSX 共享字符串数量超过限制。");
  }
  const declared = attribute(root, "uniqueCount");
  if (declared !== undefined && asNonNegativeInteger(declared, "invalid_xml", "sharedStrings uniqueCount") !== strings.length) {
    fail("invalid_xml", "XLSX 共享字符串计数与实际内容不一致。");
  }
  return Object.freeze(strings.map(parseSharedText));
}

function normaliseRelationshipTarget(target: string) {
  if (!target || target.includes("\\") || target.includes("\0") || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
    fail("unsafe_relationship_target", "XLSX 工作表关系目标不安全。");
  }
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail("unsafe_relationship_target", "XLSX 工作表关系目标不安全。");
  }
  return path;
}

function readWorksheetTargets(archive: Archive, limits: XlsxReadLimits) {
  const workbook = readXmlPart(archive, "xl/workbook.xml", "workbook");
  const relationshipsRoot = readXmlPart(archive, "xl/_rels/workbook.xml.rels", "Relationships");
  const relations = new Map<string, string>();
  for (const rawRelation of list(relationshipsRoot.Relationship)) {
    const relation = record(rawRelation);
    const id = attribute(relation, "Id");
    const type = attribute(relation, "Type");
    const target = attribute(relation, "Target");
    const targetMode = attribute(relation, "TargetMode");
    if (!id || !type || !target) fail("invalid_relationship", "XLSX 工作簿关系不完整。");
    if (relations.has(id)) fail("invalid_relationship", "XLSX 工作簿关系 ID 重复。");
    if (targetMode?.toLowerCase() === "external") {
      fail("unsafe_relationship_target", "XLSX 工作簿不能引用外部工作表。");
    }
    if (type.endsWith("/worksheet")) relations.set(id, normaliseRelationshipTarget(target));
  }

  const sheets = list(record(workbook.sheets).sheet);
  if (sheets.length === 0 || sheets.length > limits.maxWorksheets) {
    fail("invalid_workbook", "XLSX 工作表数量无效或超过限制。");
  }
  const names = new Set<string>();
  const targets = new Set<string>();
  return sheets.map((rawSheet) => {
    const sheet = record(rawSheet);
    const name = attribute(sheet, "name");
    const relationshipId = attribute(sheet, "id");
    if (!name || !relationshipId) fail("invalid_workbook", "XLSX 工作表缺少名称或关系 ID。");
    if (name.length > 31 || /[\x00-\x1f\[\]:*?/\\]/.test(name) || names.has(name)) {
      fail("invalid_workbook", "XLSX 工作表名称无效或重复。");
    }
    const target = relations.get(relationshipId);
    if (!target) fail("invalid_relationship", "XLSX 工作表没有有效的内部关系。");
    if (targets.has(target)) fail("invalid_relationship", "多个 XLSX 工作表不能指向同一个 XML 部分。");
    names.add(name);
    targets.add(target);
    return { name, target };
  });
}

function columnNumber(columnLetters: string) {
  let result = 0;
  for (const letter of columnLetters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result;
}

function columnLetters(column: number) {
  let current = column;
  let result = "";
  while (current > 0) {
    current -= 1;
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }
  return result;
}

function cellAddress(reference: string | undefined, inferredRow: number, previousColumn: number) {
  if (!reference) {
    const column = previousColumn + 1;
    if (column > MAX_EXCEL_COLUMN) fail("invalid_cell", "XLSX 单元格列号超出 Excel 范围。");
    return { reference: `${columnLetters(column)}${inferredRow}`, row: inferredRow, column };
  }
  const matched = /^([A-Za-z]{1,3})([1-9]\d*)$/.exec(reference);
  if (!matched) fail("invalid_cell", "XLSX 单元格引用无效。");
  const column = columnNumber(matched[1].toUpperCase());
  const row = Number(matched[2]);
  if (!Number.isSafeInteger(row) || row > MAX_EXCEL_ROW || column > MAX_EXCEL_COLUMN) {
    fail("invalid_cell", "XLSX 单元格引用超出 Excel 范围。");
  }
  if (row !== inferredRow || column <= previousColumn) {
    fail("invalid_cell", "XLSX 单元格未按行列升序排列。");
  }
  return { reference: `${matched[1].toUpperCase()}${row}`, row, column };
}

function formulaText(value: unknown) {
  const result = text(value);
  return result === undefined || result === "" ? undefined : result;
}

function rawCellValue(cell: XmlRecord) {
  return text(cell.v);
}

function parseCell(
  rawCell: unknown,
  rowIndex: number,
  previousColumn: number,
  sharedStrings: readonly string[],
) {
  const cell = record(rawCell);
  if (Object.keys(cell).length === 0) fail("invalid_cell", "XLSX 单元格结构无效。");
  const address = cellAddress(attribute(cell, "r"), rowIndex, previousColumn);
  const rawType = attribute(cell, "t") ?? "n";
  const style = attribute(cell, "s");
  const styleIndex = style === undefined ? undefined : asNonNegativeInteger(style, "invalid_cell", "cell style");
  const formula = formulaText(cell.f);
  const rawValue = rawCellValue(cell);
  const base = {
    ...address,
    ...(styleIndex === undefined ? {} : { styleIndex }),
    ...(formula === undefined ? {} : { formula }),
  };

  if (rawType === "inlineStr") {
    if (rawValue !== undefined) fail("invalid_cell", "inlineStr 单元格不能同时包含 v 值。");
    if (cell.is === undefined) fail("invalid_cell", "inlineStr 单元格缺少 is 内容。");
    const value = parseSharedText(cell.is);
    return { ...base, type: "string" as const, value, rawValue: value };
  }
  if (rawType === "s") {
    if (rawValue === undefined) fail("invalid_cell", "共享字符串单元格缺少 v 值。");
    const sharedIndex = asNonNegativeInteger(rawValue.trim(), "invalid_cell", "shared string index");
    const value = sharedStrings[sharedIndex];
    if (value === undefined) fail("invalid_cell", "共享字符串索引超出范围。");
    return { ...base, type: "string" as const, value, rawValue };
  }
  if (rawType === "b") {
    if (rawValue !== "0" && rawValue !== "1") fail("invalid_cell", "布尔单元格必须为 0 或 1。");
    return { ...base, type: "boolean" as const, value: rawValue === "1", rawValue };
  }
  if (rawType === "e") {
    if (!rawValue) fail("invalid_cell", "错误单元格缺少错误值。");
    return { ...base, type: "error" as const, value: rawValue, rawValue };
  }
  if (rawType === "d") {
    if (!rawValue) fail("invalid_cell", "日期单元格缺少日期值。");
    return { ...base, type: "date" as const, value: rawValue, rawValue };
  }
  if (rawType === "str") {
    if (rawValue === undefined) {
      if (formula !== undefined) return { ...base, type: "blank" as const, value: null };
      fail("invalid_cell", "字符串单元格缺少 v 值。");
    }
    return { ...base, type: "string" as const, value: rawValue, rawValue };
  }
  if (rawType !== "n") fail("invalid_cell", "XLSX 单元格类型不受支持。");
  if (rawValue === undefined) {
    if (formula !== undefined || Object.keys(cell).length <= 3) return { ...base, type: "blank" as const, value: null };
    fail("invalid_cell", "数值单元格缺少 v 值。");
  }
  const normalisedValue = rawValue.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalisedValue)) {
    fail("invalid_cell", "数值单元格不是有限数字。");
  }
  const value = Number(normalisedValue);
  if (!Number.isFinite(value)) fail("invalid_cell", "数值单元格不是有限数字。");
  return { ...base, type: "number" as const, value, rawValue };
}

function readWorksheet(
  archive: Archive,
  target: string,
  name: string,
  sharedStrings: readonly string[],
  limits: XlsxReadLimits,
): XlsxWorksheet {
  const root = readXmlPart(archive, target, "worksheet");
  if (root.sheetData === undefined) {
    fail("invalid_worksheet", "XLSX 工作表缺少 sheetData。");
  }
  const rawRows = list(record(root.sheetData).row);
  if (rawRows.length > limits.maxRowsPerWorksheet) {
    fail("invalid_worksheet", "XLSX 工作表行数超过限制。");
  }
  const rows: XlsxRow[] = [];
  let previousRow = 0;
  let totalCells = 0;
  for (const rawRow of rawRows) {
    const row = record(rawRow);
    const declaredRow = attribute(row, "r");
    const rowIndex = declaredRow === undefined
      ? previousRow + 1
      : asPositiveInteger(declaredRow, "invalid_worksheet", "row index");
    if (rowIndex <= previousRow || rowIndex > MAX_EXCEL_ROW) {
      fail("invalid_worksheet", "XLSX 行未按升序排列或超出 Excel 范围。");
    }
    const cells: XlsxCell[] = [];
    let previousColumn = 0;
    for (const rawCell of list(row.c)) {
      const cell = parseCell(rawCell, rowIndex, previousColumn, sharedStrings);
      cells.push(cell);
      previousColumn = cell.column;
      totalCells += 1;
      if (totalCells > limits.maxCellsPerWorksheet) {
        fail("invalid_worksheet", "XLSX 工作表单元格数量超过限制。");
      }
    }
    rows.push(Object.freeze({ index: rowIndex, cells: Object.freeze(cells) }));
    previousRow = rowIndex;
  }
  return Object.freeze({ name, rows: Object.freeze(rows) });
}

/**
 * Parse a standard `.xlsx` archive into workbook-order worksheets and
 * row/column-order cells. Any malformed, encrypted, oversized, ambiguous, or
 * unsafe input fails closed with `XlsxReadError`.
 */
export function readXlsx(input: Uint8Array, options?: XlsxReaderOptions): XlsxWorkbook {
  const limits = resolveLimits(options);
  const archive = readArchive(input, limits);
  // Open Packaging Convention content types are mandatory for a real XLSX.
  readXmlPart(archive, "[Content_Types].xml", "Types");
  const sharedStrings = readSharedStrings(archive, limits);
  const targets = readWorksheetTargets(archive, limits);
  const worksheets = targets.map(({ name, target }) => readWorksheet(archive, target, name, sharedStrings, limits));
  return Object.freeze({ worksheets: Object.freeze(worksheets) });
}
