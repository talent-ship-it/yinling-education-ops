/**
 * Minimal browser-safe Open XML package writer.
 *
 * XLSX is a ZIP container. We deliberately use the uncompressed ZIP method:
 * it keeps this security-sensitive export dependency-free and lets the
 * repository's strict XLSX reader validate every CRC and package part.
 */

export type OpenXmlPart = Readonly<{ name: string; xml: string }>;

const MAX_XLSX_BYTES = 32 * 1024 * 1024;
const MAX_PARTS = 128;
const SAFE_PART = /^(?:\[Content_Types\]\.xml|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)$/u;
const encoder = new TextEncoder();

function fail(message: string): never {
  throw new Error(message);
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

function uint16(value: number) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function uint32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function concat(parts: readonly Uint8Array[]) {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  if (!Number.isSafeInteger(size) || size > MAX_XLSX_BYTES) fail("XLSX 输出超过安全大小上限。");
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function localHeader(input: Readonly<{
  name: Uint8Array;
  checksum: number;
  size: number;
}>) {
  return concat([
    uint32(0x04034b50),
    uint16(20),
    uint16(0),
    uint16(0),
    uint16(0),
    // Deterministic DOS date: 1980-01-01.
    uint16(33),
    uint32(input.checksum),
    uint32(input.size),
    uint32(input.size),
    uint16(input.name.byteLength),
    uint16(0),
    input.name,
  ]);
}

function centralHeader(input: Readonly<{
  name: Uint8Array;
  checksum: number;
  size: number;
  localOffset: number;
}>) {
  return concat([
    uint32(0x02014b50),
    uint16(20),
    uint16(20),
    uint16(0),
    uint16(0),
    uint16(0),
    uint16(33),
    uint32(input.checksum),
    uint32(input.size),
    uint32(input.size),
    uint16(input.name.byteLength),
    uint16(0),
    uint16(0),
    uint16(0),
    uint16(0),
    uint32(0),
    uint32(input.localOffset),
    input.name,
  ]);
}

export function createStoredOpenXmlZip(parts: readonly OpenXmlPart[]) {
  if (!parts.length || parts.length > MAX_PARTS) fail("XLSX 文件数量无效。");
  const names = new Set<string>();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  // Reject aggregate overflows before retaining every encoded part. Without
  // this running preflight, many individually-valid 32 MiB parts could keep
  // gigabytes alive before the final concat noticed the workbook was too big.
  let projectedArchiveBytes = 22; // End-of-central-directory record.

  for (const part of parts) {
    if (!SAFE_PART.test(part.name) || part.name.startsWith("/")
      || part.name.split("/").some((component) => component === "" || component === "." || component === "..")) {
      fail("XLSX 包含不安全的文件路径。");
    }
    if (names.has(part.name)) fail("XLSX 包含重复文件。");
    names.add(part.name);
    const name = encoder.encode(part.name);
    const fixedZipBytes = 30 + name.byteLength + 46 + name.byteLength;
    const remainingXmlBytes = MAX_XLSX_BYTES - projectedArchiveBytes - fixedZipBytes;
    if (remainingXmlBytes < 0 || part.xml.length > remainingXmlBytes) fail("XLSX 输出超过安全大小上限。");
    const data = encoder.encode(part.xml);
    if (name.byteLength > 65_535 || data.byteLength > MAX_XLSX_BYTES) fail("XLSX 文件超过安全大小上限。");
    projectedArchiveBytes += fixedZipBytes + data.byteLength;
    if (!Number.isSafeInteger(projectedArchiveBytes) || projectedArchiveBytes > MAX_XLSX_BYTES) {
      fail("XLSX 输出超过安全大小上限。");
    }
    const checksum = crc32(data);
    const header = localHeader({ name, checksum, size: data.byteLength });
    localParts.push(header, data);
    centralParts.push(centralHeader({ name, checksum, size: data.byteLength, localOffset }));
    localOffset += header.byteLength + data.byteLength;
  }

  const centralDirectory = concat(centralParts);
  const endOfCentralDirectory = concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(parts.length),
    uint16(parts.length),
    uint32(centralDirectory.byteLength),
    uint32(localOffset),
    uint16(0),
  ]);
  return concat([...localParts, centralDirectory, endOfCentralDirectory]);
}
