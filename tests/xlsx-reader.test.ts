import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import test from "node:test";

import { readXlsx, XlsxReadError } from "../lib/xlsx-reader.ts";

type ZipFixtureEntry = Readonly<{
  name: string;
  data: string;
  compression?: "store" | "deflate";
  declaredUncompressedSize?: number;
}>;

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value: number) {
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value, 0);
  return result;
}

function uint32(value: number) {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value >>> 0, 0);
  return result;
}

function localHeader(input: {
  name: Buffer;
  compression: number;
  checksum: number;
  compressedSize: number;
  uncompressedSize: number;
}) {
  return Buffer.concat([
    uint32(0x04034b50),
    uint16(20),
    uint16(0),
    uint16(input.compression),
    uint16(0),
    uint16(0),
    uint32(input.checksum),
    uint32(input.compressedSize),
    uint32(input.uncompressedSize),
    uint16(input.name.length),
    uint16(0),
    input.name,
  ]);
}

function centralHeader(input: {
  name: Buffer;
  compression: number;
  checksum: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}) {
  return Buffer.concat([
    uint32(0x02014b50),
    uint16(20),
    uint16(20),
    uint16(0),
    uint16(input.compression),
    uint16(0),
    uint16(0),
    uint32(input.checksum),
    uint32(input.compressedSize),
    uint32(input.uncompressedSize),
    uint16(input.name.length),
    uint16(0),
    uint16(0),
    uint16(0),
    uint16(0),
    uint32(0),
    uint32(input.localOffset),
    input.name,
  ]);
}

/** A deliberately tiny ZIP writer used only for non-PII unit fixtures. */
function makeZip(entries: readonly ZipFixtureEntry[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const source = Buffer.from(entry.data, "utf8");
    const compression = entry.compression === "store" ? 0 : 8;
    const compressed = compression === 0 ? source : deflateRawSync(source);
    const checksum = crc32(source);
    const declaredUncompressedSize = entry.declaredUncompressedSize ?? source.length;
    const local = localHeader({
      name,
      compression,
      checksum,
      compressedSize: compressed.length,
      uncompressedSize: declaredUncompressedSize,
    });
    localParts.push(local, compressed);
    centralParts.push(centralHeader({
      name,
      compression,
      checksum,
      compressedSize: compressed.length,
      uncompressedSize: declaredUncompressedSize,
      localOffset,
    }));
    localOffset += local.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(entries.length),
    uint16(entries.length),
    uint32(centralDirectory.length),
    uint32(localOffset),
    uint16(0),
  ]);
  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
}

function workbookXml(sheetEntries: readonly Readonly<{ name: string; relationshipId: string }>[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets>${sheetEntries.map((sheet, index) => (
        `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="${sheet.relationshipId}"/>`
      )).join("")}</sheets>
    </workbook>`;
}

function workbookRelationships(targetOverrides: Readonly<Record<string, string>> = {}) {
  const firstTarget = targetOverrides.rId1 ?? "worksheets/sheet1.xml";
  const secondTarget = targetOverrides.rId2 ?? "worksheets/sheet2.xml";
  return `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${firstTarget}"/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${secondTarget}"/>
    </Relationships>`;
}

function validWorkbookEntries(overrides: Partial<Record<string, string>> = {}): ZipFixtureEntry[] {
  return [
    {
      name: "[Content_Types].xml",
      data: overrides.contentTypes ?? `<?xml version="1.0" encoding="UTF-8"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Default Extension="xml" ContentType="application/xml"/>
        </Types>`,
    },
    {
      name: "xl/workbook.xml",
      data: overrides.workbook ?? workbookXml([
        { name: "Second", relationshipId: "rId2" },
        { name: "First", relationshipId: "rId1" },
      ]),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: overrides.relationships ?? workbookRelationships(),
    },
    {
      name: "xl/sharedStrings.xml",
      data: overrides.sharedStrings ?? `<?xml version="1.0" encoding="UTF-8"?>
        <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
          <si><t>shared &amp; value</t></si>
          <si><r><t>rich</t></r><r><t xml:space="preserve"> value</t></r></si>
        </sst>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: overrides.sheet1 ?? `<?xml version="1.0" encoding="UTF-8"?>
        <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <sheetData>
            <row r="1"><c r="A1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><r><t>inline</t></r><r><t xml:space="preserve"> value</t></r></is></c><c r="D1" t="b"><v>1</v></c><c r="E1" s="2"><f>SUM(1,2)</f><v>3</v></c><c r="F1" t="e"><v>#DIV/0!</v></c><c r="G1" t="d"><v>2026-08-18T16:00:00</v></c></row>
            <row r="3"><c r="B3"><v>42.5</v></c></row>
          </sheetData>
        </worksheet>`,
    },
    {
      name: "xl/worksheets/sheet2.xml",
      data: overrides.sheet2 ?? `<?xml version="1.0" encoding="UTF-8"?>
        <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <sheetData><row r="2"><c r="A2" t="s"><v>0</v></c></row><row r="4"/></sheetData>
        </worksheet>`,
    },
  ];
}

const errorCode = (code: XlsxReadError["code"]) =>
  (error: unknown) => error instanceof XlsxReadError && error.code === code;

test("reads workbook-order worksheets and row/column-order typed cells without evaluating formulas", () => {
  const workbook = readXlsx(makeZip(validWorkbookEntries()));

  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Second", "First"]);
  assert.deepEqual(workbook.worksheets[0].rows.map((row) => row.index), [2, 4]);
  assert.deepEqual(workbook.worksheets[0].rows[0].cells, [{
    reference: "A2",
    row: 2,
    column: 1,
    type: "string",
    value: "shared & value",
    rawValue: "0",
  }]);

  const [firstDataRow, thirdRow] = workbook.worksheets[1].rows;
  assert.deepEqual(firstDataRow.cells.map(({ reference, type, value, formula, styleIndex }) => ({
    reference,
    type,
    value,
    formula,
    styleIndex,
  })), [
    { reference: "A1", type: "string", value: "rich value", formula: undefined, styleIndex: undefined },
    { reference: "C1", type: "string", value: "inline value", formula: undefined, styleIndex: undefined },
    { reference: "D1", type: "boolean", value: true, formula: undefined, styleIndex: undefined },
    { reference: "E1", type: "number", value: 3, formula: "SUM(1,2)", styleIndex: 2 },
    { reference: "F1", type: "error", value: "#DIV/0!", formula: undefined, styleIndex: undefined },
    { reference: "G1", type: "date", value: "2026-08-18T16:00:00", formula: undefined, styleIndex: undefined },
  ]);
  assert.equal(thirdRow.index, 3);
  assert.deepEqual(thirdRow.cells[0], {
    reference: "B3",
    row: 3,
    column: 2,
    type: "number",
    value: 42.5,
    rawValue: "42.5",
  });
});

test("fails closed for corrupt ZIP archives, malformed XML, unsafe relationships, and duplicate parts", () => {
  assert.throws(() => readXlsx(Buffer.from([1, 2, 3])), errorCode("invalid_zip"));

  assert.throws(
    () => readXlsx(makeZip(validWorkbookEntries({ workbook: "<workbook><sheets>" }))),
    errorCode("invalid_xml"),
  );

  assert.throws(
    () => readXlsx(makeZip(validWorkbookEntries({ relationships: workbookRelationships({ rId1: "../worksheets/sheet1.xml" }) }))),
    errorCode("unsafe_relationship_target"),
  );

  assert.throws(
    () => readXlsx(makeZip([
      ...validWorkbookEntries(),
      { name: "xl/workbook.xml", data: "<workbook/>" },
    ])),
    errorCode("duplicate_archive_entry"),
  );
});

test("rejects DTD-bearing XML and entries that declare an unsafe expansion size before parsing workbook data", () => {
  assert.throws(
    () => readXlsx(makeZip(validWorkbookEntries({
      sharedStrings: `<!DOCTYPE sst [<!ENTITY hidden "unsafe">]><sst uniqueCount="0"/>`,
    }))),
    errorCode("unsafe_xml"),
  );

  const oversizedEntry: ZipFixtureEntry = {
    name: "xl/unused.xml",
    data: "x",
    declaredUncompressedSize: 33 * 1024 * 1024,
  };
  assert.throws(
    () => readXlsx(makeZip([...validWorkbookEntries(), oversizedEntry])),
    errorCode("archive_entry_too_large"),
  );
});
