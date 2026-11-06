// Reading an older Excel workbook (.xls, Excel 97–2003, and Excel 5/95), the first sheet, into the
// same rows a CSV gives, like xlsx.js does for .xlsx. The file is a Compound File (a small FAT file
// system); its "Workbook" (or "Book") stream is a list of BIFF records: the shared strings, the
// number formats and cell styles, then each sheet's cells.

import { BUILT_IN_DATES, isDateFormat, plainNumber, serialDate } from './xlsx.js';

const SIGNATURE = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
export const isXls = (bytes) => SIGNATURE.every((b, i) => bytes[i] === b);

const END_OF_CHAIN = 0xFFFFFFFE;

// The Compound File's streams: Map(name → bytes).
function readCompound(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at) => view.getUint32(at, true);
  const sectorSize = 1 << view.getUint16(0x1E, true);
  const miniSize = 1 << view.getUint16(0x20, true);
  const miniCutoff = u32(0x38);
  const sector = (n) => bytes.subarray((n + 1) * sectorSize, (n + 2) * sectorSize);
  const perSector = sectorSize / 4;

  // The FAT's own sectors: 109 listed in the header, more in a chain of DIFAT sectors.
  const fatSectors = [];
  for (let i = 0; i < 109; i += 1) fatSectors.push(u32(0x4C + i * 4));
  for (let d = u32(0x44), n = u32(0x48); n > 0 && d < END_OF_CHAIN; n -= 1) {
    const s = sector(d);
    const sv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    for (let i = 0; i < perSector - 1; i += 1) fatSectors.push(sv.getUint32(i * 4, true));
    d = sv.getUint32((perSector - 1) * 4, true);
  }
  const fat = [];
  for (const f of fatSectors.slice(0, u32(0x2C))) {
    const s = sector(f);
    const sv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    for (let i = 0; i < perSector; i += 1) fat.push(sv.getUint32(i * 4, true));
  }
  // A chain of sectors, joined. Guarded against loops in a damaged file.
  const chain = (start, table, read, size) => {
    const parts = [];
    for (let n = start, guard = 0; n < END_OF_CHAIN && guard <= table.length; n = table[n], guard += 1) parts.push(read(n));
    const out = new Uint8Array(parts.length * size);
    parts.forEach((p, i) => out.set(p, i * size));
    return out;
  };
  const big = (start) => chain(start, fat, sector, sectorSize);

  const dir = big(u32(0x30));
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries = [];
  for (let at = 0; at + 128 <= dir.length; at += 128) {
    const nameLen = dv.getUint16(at + 0x40, true);
    const type = dir[at + 0x42];
    if (!type) continue;
    const name = String.fromCharCode(...new Uint16Array(dir.slice(at, at + Math.max(0, nameLen - 2)).buffer));
    entries.push({ name, type, start: dv.getUint32(at + 0x74, true), size: dv.getUint32(at + 0x78, true) });
  }
  // Small streams live in the "mini stream" (the root entry's data), in 64-byte sectors.
  const root = entries.find((e) => e.type === 5);
  const miniStream = root ? big(root.start) : new Uint8Array();
  const miniFatBytes = u32(0x40) ? big(u32(0x3C)) : new Uint8Array();
  const mfv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
  const miniFat = Array.from({ length: miniFatBytes.length / 4 }, (_, i) => mfv.getUint32(i * 4, true));
  const mini = (start) => chain(start, miniFat, (n) => miniStream.subarray(n * miniSize, (n + 1) * miniSize), miniSize);

  const streams = new Map();
  for (const e of entries.filter((x) => x.type === 2)) {
    streams.set(e.name, (e.size < miniCutoff ? mini(e.start) : big(e.start)).subarray(0, e.size));
  }
  return streams;
}

// The BIFF records: [{ type, data }].
function records(stream) {
  const out = [];
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  for (let at = 0; at + 4 <= stream.length;) {
    const type = view.getUint16(at, true);
    const len = view.getUint16(at + 2, true);
    out.push({ type, data: stream.subarray(at + 4, at + 4 + len), at });
    at += 4 + len;
  }
  return out;
}

// Reads across a record and the CONTINUE records after it, as one string table may span several.
// A string's characters that go on in the next part start with a byte saying their width again.
function reader(parts) {
  let i = 0;
  let p = 0;
  const next = () => { if (p >= parts[i].length && i < parts.length - 1) { i += 1; p = 0; } };
  const u8 = () => { next(); return parts[i][p++]; };
  const u16 = () => u8() | (u8() << 8);
  const u32 = () => (u16() | (u16() << 16)) >>> 0;
  const skip = (n) => { for (let k = 0; k < n; k += 1) u8(); };
  const done = () => i >= parts.length - 1 && p >= parts[i].length;
  // BIFF8 string: a length (16 or 8 bits), flags, then the characters (1 byte each when compressed).
  const string = (lenBytes = 2) => {
    const count = lenBytes === 2 ? u16() : u8();
    const flags = u8();
    const runs = flags & 0x08 ? u16() : 0;
    const ext = flags & 0x04 ? u32() : 0;
    let wide = flags & 0x01;
    let s = '';
    for (let k = 0; k < count; k += 1) {
      if (p >= parts[i].length && i < parts.length - 1) { i += 1; p = 0; wide = parts[i][p++] & 0x01; }
      s += String.fromCharCode(wide ? u16() : u8());
    }
    skip(runs * 4 + ext);
    return s;
  };
  return { u8, u16, u32, string, done };
}

// Excel 5/95 strings have no flags: a length, then 8-bit characters (in the workbook's code page,
// taken as Windows-1252 here).
const cp1252 = new TextDecoder('windows-1252');
const string5 = (data, at, lenBytes = 2) => {
  const n = lenBytes === 2 ? data[at] | (data[at + 1] << 8) : data[at];
  return cp1252.decode(data.subarray(at + lenBytes, at + lenBytes + n));
};

// An RK number: a 30-bit integer or the top of a double, possibly divided by 100.
function rk(value) {
  let n;
  if (value & 0x02) n = value >> 2;
  else {
    const b = new DataView(new ArrayBuffer(8));
    b.setUint32(4, value & 0xFFFFFFFC, true);
    n = b.getFloat64(0, true);
  }
  return value & 0x01 ? n / 100 : n;
}

// The workbook's bytes → rows of strings (empty rows left out), or null when it isn't an .xls.
export function readXls(bytes) {
  if (!isXls(bytes)) return null;
  const streams = readCompound(bytes);
  const stream = streams.get('Workbook') ?? streams.get('Book');
  if (!stream) return null;
  const recs = records(stream);

  const formats = new Map();
  const xfFormats = [];
  const sst = [];
  let biff8 = true;
  let from1904 = false;
  let sheetAt = null;
  // The workbook part: up to its first EOF.
  let k = 0;
  for (; k < recs.length; k += 1) {
    const { type, data } = recs[k];
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (type === 0x0809 && k === 0) biff8 = dv.getUint16(0, true) === 0x0600;
    else if (type === 0x000A) break;
    else if (type === 0x0022) from1904 = dv.getUint16(0, true) === 1;
    else if (type === 0x041E) {
      formats.set(dv.getUint16(0, true), biff8 ? reader([data.subarray(2)]).string() : string5(data, 2, 1));
    } else if (type === 0x00E0) xfFormats.push(dv.getUint16(2, true));
    else if (type === 0x0085 && sheetAt == null && data[5] === 0) sheetAt = dv.getUint32(0, true);
    else if (type === 0x00FC) {
      const parts = [data.subarray(8)];
      while (recs[k + 1]?.type === 0x003C) parts.push(recs[(k += 1)].data);
      const r = reader(parts);
      const unique = dv.getUint32(4, true);
      for (let n = 0; n < unique && !r.done(); n += 1) sst.push(r.string());
    }
  }
  const isDate = (xf) => {
    const id = xfFormats[xf];
    return id != null && (BUILT_IN_DATES.has(id) || (formats.has(id) && isDateFormat(formats.get(id))));
  };
  const number = (n, xf) => (isDate(xf) ? serialDate(n, from1904) : plainNumber(n));

  // The first worksheet: from its BOF to the matching EOF (charts inside it have their own).
  let start = sheetAt == null ? k + 1 : recs.findIndex((r) => r.at === sheetAt);
  if (start < 0) start = k + 1;
  const cells = new Map();
  const set = (row, col, value) => {
    if (!cells.has(row)) cells.set(row, []);
    cells.get(row)[col] = value;
  };
  let pendingFormula = null;
  for (let j = start, depth = 0; j < recs.length; j += 1) {
    const { type, data } = recs[j];
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (type === 0x0809) { depth += 1; continue; }
    if (type === 0x000A) { depth -= 1; if (depth <= 0) break; continue; }
    if (depth !== 1 || data.length < 6) {
      if (type === 0x0207 && pendingFormula) { set(...pendingFormula, biff8 ? reader([data]).string() : string5(data, 0)); pendingFormula = null; }
      continue;
    }
    const row = dv.getUint16(0, true);
    const col = dv.getUint16(2, true);
    const xf = dv.getUint16(4, true);
    if (type === 0x00FD) set(row, col, sst[dv.getUint32(6, true)] ?? '');
    else if (type === 0x0203) set(row, col, number(dv.getFloat64(6, true), xf));
    else if (type === 0x027E) set(row, col, number(rk(dv.getUint32(6, true)), xf));
    else if (type === 0x00BD) {
      const last = dv.getUint16(data.length - 2, true);
      for (let c = col, at = 4; c <= last; c += 1, at += 6) set(row, c, number(rk(dv.getUint32(at + 2, true)), dv.getUint16(at, true)));
    } else if (type === 0x0204 || type === 0x00D6) set(row, col, biff8 ? reader([data.subarray(6)]).string() : string5(data, 6));
    else if (type === 0x0205) set(row, col, data[7] ? '' : data[6] ? 'TRUE' : 'FALSE');
    else if (type === 0x0006) {
      // A formula's last value: a number, or (marked by 0xFFFF at the end) a string in the next
      // STRING record, a true/false, an error or nothing.
      if (dv.getUint16(12, true) !== 0xFFFF) set(row, col, number(dv.getFloat64(6, true), xf));
      else if (data[6] === 0) pendingFormula = [row, col];
      else if (data[6] === 1) set(row, col, data[8] ? 'TRUE' : 'FALSE');
    } else if (type === 0x0207 && pendingFormula) {
      set(...pendingFormula, biff8 ? reader([data]).string() : string5(data, 0));
      pendingFormula = null;
    }
  }
  return [...cells.keys()].sort((a, b) => a - b)
    .map((r) => Array.from(cells.get(r), (v) => v ?? ''))
    .filter((r) => r.some((c) => String(c).trim() !== ''));
}
