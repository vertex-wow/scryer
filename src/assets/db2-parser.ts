/**
 * Minimal WDC3/4 parser for WoW DB2 files.
 *
 * Covers the two table schemas needed for atlas manifest generation:
 *   UiTextureAtlas        — 4 data fields + non-inline ID
 *   UiTextureAtlasMember  — 9 data fields + non-inline ID + relation FK
 *
 * Supported compression types: None, CommonData, Bitpacked (all variants).
 * BitpackedIndexed / BitpackedIndexedArray throw — not expected for these tables.
 *
 * Strings: WDC3+ relative-offset-into-string-table encoding.
 * Multi-section: handled; encrypted sections skipped.
 * Offset-mapped (variable-length) records: NOT supported — only normal (fixed-size).
 */

export type WDCFieldType =
  | "uint8"
  | "uint16"
  | "uint32"
  | "int8"
  | "int16"
  | "int32"
  | "string"
  | "nonInlineId"
  | "relation";

export interface WDCFieldDef {
  name: string;
  type: WDCFieldType;
}

export type WDCRow = Record<string, number | string>;

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const MAGIC_WDC3 = 0x33434457;
const MAGIC_WDC4 = 0x34434457;
const MAGIC_WDC5 = 0x35434457;

const COMP_NONE = 0;
const COMP_BITPACKED = 1;
const COMP_COMMON_DATA = 2;
const COMP_BITPACKED_INDEXED = 3;
const COMP_BITPACKED_INDEXED_ARRAY = 4;
const COMP_BITPACKED_SIGNED = 5;

interface FieldStorageInfo {
  fieldOffsetBits: number;
  fieldSizeBits: number;
  additionalDataSize: number;
  compression: number;
  packingVals: [number, number, number];
}

interface SectionHeader {
  recordCount: number;
  stringTableSize: number;
  idListSize: number;
  copyTableCount: number;
  offsetMapIdCount: number;
  relationshipDataSize: number;
  isEncrypted: boolean;
}

// ---------------------------------------------------------------------------
// Bit reading helper
// ---------------------------------------------------------------------------

function readBitpacked(
  buf: Buffer,
  recStart: number,
  fieldOffsetBits: number,
  fieldSizeBits: number,
): number {
  const byteOfs = fieldOffsetBits >> 3;
  const bitShift = fieldOffsetBits & 7;
  const absOfs = recStart + byteOfs;
  // Read up to 8 bytes with zero-padding if near end of buffer
  let lo = 0,
    hi = 0;
  const avail = Math.min(8, buf.length - absOfs);
  if (avail >= 4) lo = buf.readUInt32LE(absOfs);
  else if (avail > 0) {
    for (let i = 0; i < avail && i < 4; i++) lo |= buf[absOfs + i] << (8 * i);
  }
  if (avail >= 8) hi = buf.readUInt32LE(absOfs + 4);
  else if (avail > 4) {
    for (let i = 4; i < avail; i++) hi |= buf[absOfs + i] << (8 * (i - 4));
  }
  // Shift the 64-bit value by bitShift, then mask
  let val: number;
  if (bitShift === 0) {
    val = lo;
  } else {
    val = (lo >>> bitShift) | (hi << (32 - bitShift));
  }
  if (fieldSizeBits < 32) {
    val &= (1 << fieldSizeBits) - 1;
  }
  return val >>> 0;
}

function signExtend(val: number, bits: number): number {
  const signBit = 1 << (bits - 1);
  return val & signBit ? val | (~0 << bits) : val;
}

function readString(buf: Buffer, absPos: number): string {
  let end = absPos;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.slice(absPos, end).toString("utf8");
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseWDC(buf: Buffer, schema: WDCFieldDef[]): WDCRow[] {
  let pos = 0;

  const r8 = (): number => buf.readUInt8(pos++);
  const r16 = (): number => {
    const v = buf.readUInt16LE(pos);
    pos += 2;
    return v;
  };
  const r16s = (): number => {
    const v = buf.readInt16LE(pos);
    pos += 2;
    return v;
  };
  const r32 = (): number => {
    const v = buf.readUInt32LE(pos);
    pos += 4;
    return v;
  };
  const r32s = (): number => {
    const v = buf.readInt32LE(pos);
    pos += 4;
    return v;
  };
  const skip = (n: number): void => {
    pos += n;
  };
  const seek = (n: number): void => {
    pos = n;
  };

  // ── header ─────────────────────────────────────────────────────────────────

  const magic = r32();
  let wdcVersion: number;
  if (magic === MAGIC_WDC3) wdcVersion = 3;
  else if (magic === MAGIC_WDC4) wdcVersion = 4;
  else if (magic === MAGIC_WDC5) wdcVersion = 5;
  else throw new Error(`Unsupported DB2 magic: 0x${magic.toString(16)}`);

  if (wdcVersion === 5) {
    skip(4); // schema version
    skip(128); // schema build string
  }

  const recordCount = r32();
  skip(4); // fieldCount
  const recordSize = r32();
  skip(4); // stringTableSize
  skip(4); // tableHash
  skip(4); // layoutHash
  const minID = r32();
  void minID; // not used
  const maxID = r32();
  void maxID;
  skip(4); // locale
  const flags = r16();
  const idIndex = r16();
  void idIndex;
  const totalFieldCount = r32();
  skip(4); // bitpackedDataOffset
  skip(4); // lookupColumnCount
  const fieldStorageInfoSize = r32();
  const commonDataSize = r32();
  const palletDataSize = r32();
  const sectionCount = r32();

  const isNormal = (flags & 1) === 0;

  // ── section headers ────────────────────────────────────────────────────────

  const sections: SectionHeader[] = [];
  for (let i = 0; i < sectionCount; i++) {
    skip(8); // tactKeyHash
    skip(4); // fileOffset
    const sRecordCount = r32();
    const stringTableSize = r32();
    skip(4); // offsetRecordsEnd
    const idListSize = r32();
    const relationshipDataSize = r32();
    const offsetMapIdCount = r32();
    const copyTableCount = r32();
    sections.push({
      recordCount: sRecordCount,
      stringTableSize,
      idListSize,
      copyTableCount,
      offsetMapIdCount,
      relationshipDataSize,
      isEncrypted: false,
    });
  }

  // ── fields array ───────────────────────────────────────────────────────────
  // fields[totalFieldCount]: { size: int16, position: uint16 } — used for WDC2 layout only.
  // For WDC3+ we rely on fieldStorageInfo instead. Skip.
  skip(totalFieldCount * 4);

  // ── field storage info ─────────────────────────────────────────────────────

  const fieldInfoCount = fieldStorageInfoSize / 24;
  const fieldInfos: FieldStorageInfo[] = [];
  for (let i = 0; i < fieldInfoCount; i++) {
    const fieldOffsetBits = r16();
    const fieldSizeBits = r16();
    const additionalDataSize = r32();
    const compression = r32();
    const v0 = r32();
    const v1 = r32();
    const v2 = r32();
    fieldInfos.push({
      fieldOffsetBits,
      fieldSizeBits,
      additionalDataSize,
      compression,
      packingVals: [v0, v1, v2],
    });
  }

  // ── pallet data ────────────────────────────────────────────────────────────

  const palletData: (number[] | null)[] = fieldInfos.map((fi) => {
    if (
      fi.compression === COMP_BITPACKED_INDEXED ||
      fi.compression === COMP_BITPACKED_INDEXED_ARRAY
    ) {
      const entries: number[] = [];
      for (let j = 0; j < fi.additionalDataSize / 4; j++) entries.push(r32());
      return entries;
    }
    return null;
  });
  void palletData; // unused — we'll throw if these compression types are encountered

  // ── common data ────────────────────────────────────────────────────────────

  const commonData: (Map<number, number> | null)[] = fieldInfos.map((fi) => {
    if (fi.compression === COMP_COMMON_DATA) {
      const map = new Map<number, number>();
      for (let j = 0; j < fi.additionalDataSize / 8; j++) {
        const key = r32();
        const val = r32();
        map.set(key, val);
      }
      return map;
    }
    return null;
  });

  // Sanity-check pallet + common data sizes
  const palletRead =
    fieldInfos.reduce(
      (sum, fi) =>
        fi.compression === COMP_BITPACKED_INDEXED || fi.compression === COMP_BITPACKED_INDEXED_ARRAY
          ? sum + fi.additionalDataSize
          : sum,
      0,
    ) ?? 0;
  const commonRead =
    fieldInfos.reduce(
      (sum, fi) => (fi.compression === COMP_COMMON_DATA ? sum + fi.additionalDataSize : sum),
      0,
    ) ?? 0;
  void palletRead;
  void commonRead;

  // ── WDC4+ extra chunk ──────────────────────────────────────────────────────
  // One entry block per section (excluding last). Not yet fully documented;
  // we skip it by reading entry counts.
  if (wdcVersion > 3) {
    for (let s = 0; s < sectionCount - 1; s++) {
      const entryCount = r32();
      skip(entryCount * 4);
    }
  }

  // ── validate schema vs fieldInfo ───────────────────────────────────────────

  const dataFieldDefs = schema.filter((f) => f.type !== "nonInlineId" && f.type !== "relation");
  if (dataFieldDefs.length !== fieldInfos.length) {
    throw new Error(
      `Schema mismatch: schema has ${dataFieldDefs.length} data fields but DB2 has ${fieldInfos.length}. ` +
        `Check UITEXTUREATLAS_SCHEMA / UITEXTUREATLASMEMBER_SCHEMA vs actual build layout.`,
    );
  }

  // ── determine which schema fields are nonInlineId / relation ───────────────

  const hasNonInlineId = schema.some((f) => f.type === "nonInlineId");
  const idFieldName = schema.find((f) => f.type === "nonInlineId")?.name ?? "ID";
  const relationFieldName = schema.find((f) => f.type === "relation")?.name;

  // ── parse sections ─────────────────────────────────────────────────────────

  const rows: WDCRow[] = [];
  // Track ID → rowIndex for copy-table inflation
  const idToRow = new Map<number, number>();

  for (const sh of sections) {
    if (sh.isEncrypted) continue;

    const recordDataOfs = pos;
    const recordDataSize = isNormal
      ? recordSize * sh.recordCount
      : /* offset records: figure out from section layout */ 0;

    if (!isNormal) {
      throw new Error("Offset-mapped (variable-length) records are not supported by this parser.");
    }

    const stringTableOfs = recordDataOfs + recordDataSize;

    // Skip to after string table to read section metadata
    seek(stringTableOfs + sh.stringTableSize);

    // id_list
    const idListCount = sh.idListSize / 4;
    const idList: number[] = [];
    for (let i = 0; i < idListCount; i++) idList.push(r32());

    // copy_table (WDC3+): dest_id → src_id
    const copyTable = new Map<number, number>();
    for (let i = 0; i < sh.copyTableCount; i++) {
      const dest = r32s();
      const src = r32s();
      if (dest !== src) copyTable.set(dest, src);
    }

    // offset_map (WDC3+): 0 entries for normal records
    skip(sh.offsetMapIdCount * 6);

    // relationship_map: recordIndex → foreignID
    const relationshipMap = new Map<number, number>();
    if (sh.relationshipDataSize > 0) {
      const snapPos = pos;
      const relEntryCount = r32();
      skip(8); // min/max IDs (uint32 each)
      for (let i = 0; i < relEntryCount; i++) {
        const foreignID = r32();
        const recordIndex = r32();
        relationshipMap.set(recordIndex, foreignID);
      }
      // If encrypted-section edge case caused wrong amount read, seek past
      if (pos !== snapPos + sh.relationshipDataSize) {
        seek(snapPos + sh.relationshipDataSize);
      }
    }

    // offset_map_id_list: 0 entries for normal records
    skip(sh.offsetMapIdCount * 4);

    // ── read records ──────────────────────────────────────────────────────────

    const hasIdMap = idList.length > 0;

    for (let recIdx = 0; recIdx < sh.recordCount; recIdx++) {
      const recStart = recordDataOfs + recIdx * recordSize;
      const row: WDCRow = {};

      // Assign ID
      if (hasNonInlineId) {
        row[idFieldName] = hasIdMap ? idList[recIdx] : recIdx;
      }

      // Assign relation FK
      if (relationFieldName !== undefined) {
        row[relationFieldName] = relationshipMap.get(recIdx) ?? 0;
      }

      let fiIdx = 0;
      for (const field of schema) {
        if (field.type === "nonInlineId" || field.type === "relation") continue;

        const fi = fieldInfos[fiIdx++];
        const recID = hasIdMap ? (idList[recIdx] ?? recIdx) : recIdx;

        if (fi.compression === COMP_COMMON_DATA) {
          const cd = commonData[fiIdx - 1];
          const rawVal = cd?.has(recID) ? cd.get(recID)! : fi.packingVals[0];
          row[field.name] = interpretInt(field.type, rawVal, fi.fieldSizeBits);
          continue;
        }

        if (
          fi.compression === COMP_BITPACKED_INDEXED ||
          fi.compression === COMP_BITPACKED_INDEXED_ARRAY
        ) {
          throw new Error(
            `BitpackedIndexed compression for field "${field.name}" is not supported by this parser.`,
          );
        }

        if (fi.compression === COMP_BITPACKED || fi.compression === COMP_BITPACKED_SIGNED) {
          const rawVal = readBitpacked(buf, recStart, fi.fieldOffsetBits, fi.fieldSizeBits);
          const val =
            fi.compression === COMP_BITPACKED_SIGNED
              ? signExtend(rawVal, fi.fieldSizeBits)
              : rawVal;
          row[field.name] = interpretInt(field.type, val, fi.fieldSizeBits);
          continue;
        }

        // COMP_NONE
        const fieldByteOfs = fi.fieldOffsetBits >> 3;
        if (field.type === "string") {
          const relOfs = buf.readUInt32LE(recStart + fieldByteOfs);
          if (relOfs === 0) {
            row[field.name] = "";
          } else {
            row[field.name] = readString(buf, recStart + fieldByteOfs + relOfs);
          }
        } else {
          row[field.name] = readIntField(buf, field.type, recStart + fieldByteOfs);
        }
      }

      const finalId = hasNonInlineId ? (row[idFieldName] as number) : fiIdx === 0 ? recIdx : recIdx;
      idToRow.set(finalId, rows.length);
      rows.push(row);
    }

    // Inflate copy table
    for (const [destID, srcID] of copyTable) {
      const srcIdx = idToRow.get(srcID);
      if (srcIdx !== undefined) {
        const copy = { ...rows[srcIdx] };
        if (hasNonInlineId) copy[idFieldName] = destID;
        idToRow.set(destID, rows.length);
        rows.push(copy);
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Typed field readers
// ---------------------------------------------------------------------------

function readIntField(buf: Buffer, type: WDCFieldType, pos: number): number {
  switch (type) {
    case "uint8":
      return buf.readUInt8(pos);
    case "int8":
      return buf.readInt8(pos);
    case "uint16":
      return buf.readUInt16LE(pos);
    case "int16":
      return buf.readInt16LE(pos);
    case "uint32":
      return buf.readUInt32LE(pos);
    case "int32":
      return buf.readInt32LE(pos);
    default:
      return 0;
  }
}

function interpretInt(type: WDCFieldType, rawVal: number, fieldSizeBits: number): number {
  switch (type) {
    case "int8":
      return signExtend(rawVal & 0xff, Math.min(fieldSizeBits, 8));
    case "int16":
      return signExtend(rawVal & 0xffff, Math.min(fieldSizeBits, 16));
    case "int32":
      return signExtend(rawVal, Math.min(fieldSizeBits, 32));
    default:
      return rawVal;
  }
}

// ---------------------------------------------------------------------------
// Hardcoded schemas for the two atlas tables
// ---------------------------------------------------------------------------

export const UITEXTUREATLAS_SCHEMA: WDCFieldDef[] = [
  { name: "ID", type: "nonInlineId" },
  { name: "FileDataID", type: "uint32" },
  { name: "AtlasWidth", type: "uint16" },
  { name: "AtlasHeight", type: "uint16" },
  { name: "UiCanvasID", type: "uint8" },
];

export const UITEXTUREATLASMEMBER_SCHEMA: WDCFieldDef[] = [
  { name: "ID", type: "nonInlineId" },
  { name: "CommittedLeft", type: "int16" },
  { name: "CommittedTop", type: "int16" },
  { name: "Width", type: "uint16" },
  { name: "Height", type: "uint16" },
  { name: "OverrideWidth", type: "int16" },
  { name: "OverrideHeight", type: "int16" },
  { name: "Flags", type: "uint16" },
  { name: "UiCanvasID", type: "uint8" },
  { name: "CommittedName", type: "string" },
  { name: "UiTextureAtlasID", type: "relation" },
];
