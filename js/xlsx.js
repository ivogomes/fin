// Reading an Excel workbook (.xlsx), the first sheet, into the same rows a CSV gives: an .xlsx is a
// .zip of XML files (zip.js reads it). Text comes as it is; dates (numbers with a date format) as
// YYYY-MM-DD; other numbers with a point for decimals. Not the older binary .xls.

import { readZip } from './zip.js';

const xmlText = (s) => String(s ?? '')
  .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => (
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()]))
  // Excel writes characters XML can't hold (a carriage return, say) as _x000D_.
  .replace(/_x([\da-f]{4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
// The text of a shared string or inline string: its <t> runs, without phonetic hints (<rPh>).
const runsOf = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1])).join('');

// Excel's built-in number formats that show a date: 14–17 and 22 (18–21 are times alone), and a
// few East Asian date formats.
export const BUILT_IN_DATES = new Set([14, 15, 16, 17, 22, 27, 30, 36, 50, 57]);
// A custom format is a date when it has a day or a year, outside quoted text and [colour] parts.
export const isDateFormat = (code) => /[dy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));

// Which cell styles (by index) show dates.
function dateStyles(stylesXml) {
  if (!stylesXml) return new Set();
  // The stylesheet's own formats come first; others further down (differential formats, extensions)
  // can reuse the same numbers for something else.
  const formats = stylesXml.match(/<numFmts\b[\s\S]*?<\/numFmts>/)?.[0] ?? '';
  const custom = new Map([...formats.matchAll(/<numFmt\b[^>]*>/g)].map(([tag]) => [Number(attr(tag, 'numFmtId')), xmlText(attr(tag, 'formatCode'))]));
  const xfs = stylesXml.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/)?.[0] ?? '';
  const out = new Set();
  [...xfs.matchAll(/<xf\b[^>]*>/g)].forEach(([tag], i) => {
    const id = Number(attr(tag, 'numFmtId') ?? 0);
    if (BUILT_IN_DATES.has(id) || (custom.has(id) && isDateFormat(custom.get(id)))) out.add(i);
  });
  return out;
}

// Day number → YYYY-MM-DD. Excel counts from 1899-12-30 (it takes 1900 as a leap year, which only
// matters before March 1900), or from 1904-01-01 in workbooks made with that setting.
export const serialDate = (n, from1904) => new Date(Date.UTC(1899, 11, 30) + (Math.floor(n) + (from1904 ? 1462 : 0)) * 864e5).toISOString().slice(0, 10);
// 12.300000000000001 → "12.3": the binary float Excel stored, back to what it shows.
export const plainNumber = (n) => String(Number(n.toPrecision(15)));

const columnIndex = (ref) => [...ref.replace(/\d+$/, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

// The workbook's bytes → rows of strings (empty rows left out), or null when it isn't an .xlsx.
export async function readXlsx(bytes) {
  let files;
  try { files = await readZip(bytes); } catch { return null; }
  // Some tools write every tag with a namespace prefix (<x:row>), which is dropped here.
  const text = (name) => (files.has(name) ? new TextDecoder().decode(files.get(name)).replace(/<(\/?)[\w.-]+:(?=[\w.-]+[\s/>])/g, '<$1') : null);
  // Relationships (a .rels file) → [{ id, type, path }], paths resolved against `dir`.
  const relsOf = (name, dir) => [...(text(name) ?? '').matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => {
    const target = attr(tag, 'Target') ?? '';
    return { id: attr(tag, 'Id'), type: attr(tag, 'Type') ?? '', path: target.startsWith('/') ? target.slice(1) : `${dir}${target}`.replace(/[^/]+\/\.\.\//g, '') };
  });
  // The workbook is usually xl/workbook.xml; the package's own relationships say for sure.
  const workbookPath = relsOf('_rels/.rels', '').find((r) => r.type.endsWith('/officeDocument'))?.path ?? 'xl/workbook.xml';
  const workbook = text(workbookPath);
  if (!workbook) return null;
  const dir = workbookPath.replace(/[^/]*$/, '');
  const rels = relsOf(workbookPath.replace(/([^/]*)$/, '_rels/$1.rels'), dir);

  // The first sheet, through the workbook's relationships (its file isn't always sheet1.xml).
  const firstSheet = workbook.match(/<sheet\b[^>]*>/)?.[0];
  const relId = firstSheet?.match(/\s[\w.-]+:id="([^"]*)"/)?.[1];
  const sheetPath = rels.find((r) => r.id === relId)?.path ?? rels.find((r) => r.type.endsWith('/worksheet'))?.path;
  const sheet = (sheetPath && text(sheetPath)) ?? text(`${dir}worksheets/sheet1.xml`);
  if (!sheet) return null;
  const part = (type, fallback) => text(rels.find((r) => r.type.endsWith(type))?.path ?? fallback);

  const shared = [...(part('/sharedStrings', `${dir}sharedStrings.xml`) ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => runsOf(m[1]));
  const dates = dateStyles(part('/styles', `${dir}styles.xml`));
  const from1904 = /date1904="(1|true)"/.test(workbook);

  const rows = [];
  for (const [, rowXml] of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const m of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = m[1];
      const inner = m[2] ?? '';
      const ref = attr(tag, 'r');
      const col = ref ? columnIndex(ref) : row.length;
      const type = attr(tag, 't');
      const v = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = runsOf(inner);
      else if (type === 'str' || type === 'e') value = xmlText(v);
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (v != null && v !== '') {
        const n = Number(v);
        value = dates.has(Number(attr(tag, 's') ?? 0)) ? serialDate(n, from1904) : plainNumber(n);
      }
      while (row.length < col) row.push('');
      row[col] = value;
    }
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}
