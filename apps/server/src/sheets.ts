import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import type { Entry, Pack } from '@gifts/shared';
import { tx, type Db } from './db.js';
import {
  applySync,
  createGift,
  createLocation,
  DomainError,
  listGifts,
  listLocations,
  updateGift,
  upsertCategoryByName,
  type Actor,
} from './store.js';

export interface Column {
  header: string;
  key: string;
  width?: number;
}

export type Cell = string | number | boolean | null | undefined;

// ---------- Export ----------

export async function toXlsx(sheetName: string, columns: Column[], rows: Record<string, Cell>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? Math.max(12, c.header.length + 2) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toCsv(columns: Column[], rows: Record<string, Cell>[]): string {
  const esc = (v: Cell) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.header)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(','))];
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM so Excel opens UTF-8 correctly
}

// ---------- Import ----------

export const IMPORT_COLUMNS = ['Name', 'Category', 'Unit Cost', 'Low Stock Threshold', 'Packs', 'Barcodes'] as const;
const STOCK_PREFIX = 'stock:';

export async function importTemplate(db: Db): Promise<Buffer> {
  const locs = listLocations(db).filter((l) => !l.archived);
  const columns: Column[] = [
    ...IMPORT_COLUMNS.map((h) => ({ header: h, key: h, width: h === 'Name' ? 30 : 18 })),
    ...locs.map((l) => ({ header: `Stock: ${l.name}`, key: `Stock: ${l.name}`, width: 18 })),
  ];
  const example: Record<string, Cell> = {
    Name: 'Blue logo pen',
    Category: 'Pens',
    'Unit Cost': 0.85,
    'Low Stock Threshold': 100,
    Packs: 'Carton=50; Box=10',
    Barcodes: '0123456789012',
  };
  if (locs[0]) example[`Stock: ${locs[0].name}`] = 420;
  return toXlsx('Gifts', columns, [example]);
}

export interface ImportSummary {
  created: number;
  updated: number;
  counts: number;
  errors: { row: number; message: string }[];
}

type RawRow = Record<string, string>;

export async function readSpreadsheet(file: Buffer, filename: string): Promise<RawRow[]> {
  if (/\.csv$/i.test(filename)) return parseCsv(file.toString('utf8').replace(/^﻿/, ''));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers: string[] = [];
  ws.getRow(1).eachCell((cell, col) => (headers[col] = cellText(cell.value)));
  const rows: RawRow[] = [];
  ws.eachRow((row, idx) => {
    if (idx === 1) return;
    const r: RawRow = {};
    row.eachCell((cell, col) => {
      const h = headers[col];
      if (h) r[h] = cellText(cell.value);
    });
    rows.push(r);
  });
  return rows;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('result' in v) return String(v.result ?? '');
    if ('text' in v) return String(v.text);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if (v instanceof Date) return v.toISOString();
  }
  return String(v).trim();
}

export function parseCsv(text: string): RawRow[] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') record.push(field), (field = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += ch;
  }
  if (field || record.length) record.push(field), records.push(record);
  const [header, ...body] = records.filter((r) => r.some((c) => c.trim()));
  if (!header) return [];
  return body.map((cells) => Object.fromEntries(header.map((h, i) => [h.trim(), (cells[i] ?? '').trim()])));
}

function parsePacks(text: string): Pack[] {
  if (!text) return [];
  return text.split(/[;\n]/).map((part) => {
    const m = part.trim().match(/^(.+?)\s*[=:x×]\s*(\d+)$/i);
    if (!m) throw new DomainError(`Cannot read Pack "${part.trim()}" (use e.g. Carton=50)`);
    return { name: m[1]!.trim(), pieces: Number(m[2]) };
  });
}

const num = (s: string | undefined) => (s === undefined || s.trim() === '' ? null : Number(s.replace(/[$,]/g, '')));

/**
 * Creates or updates Gifts by name (case-insensitive). Starting quantities in "Stock: <Location>" columns
 * are recorded as ordinary Counts made by the importing Admin.
 */
export function importGifts(db: Db, actor: Actor, rows: RawRow[]): ImportSummary {
  const summary: ImportSummary = { created: 0, updated: 0, counts: 0, errors: [] };
  const now = new Date().toISOString();
  const counts: Entry[] = [];

  tx(db, () => {
    rows.forEach((r, i) => {
      const rowNo = i + 2; // header is row 1
      const name = (r['Name'] ?? '').trim();
      if (!name && !Object.values(r).some((v) => v.trim())) return; // blank line
      try {
        // Each row is its own savepoint: a bad row leaves nothing half-written.
        const outcome = tx(db, () => {
          if (!name) throw new DomainError('Name is empty');
          const unitCost = num(r['Unit Cost']);
          const threshold = num(r['Low Stock Threshold']);
          if (unitCost !== null && Number.isNaN(unitCost)) throw new DomainError('Unit Cost is not a number');
          if (threshold !== null && Number.isNaN(threshold)) throw new DomainError('Low Stock Threshold is not a number');
          const input = {
            name,
            categoryId: r['Category']?.trim() ? upsertCategoryByName(db, r['Category']) : null,
            unitCost,
            lowStockThreshold: threshold,
            packs: parsePacks(r['Packs'] ?? ''),
            barcodes: (r['Barcodes'] ?? '').split(/[;,\s]+/).filter(Boolean),
          };
          const existing = listGifts(db).find((g) => g.name.toLowerCase() === name.toLowerCase());
          const gift = existing ? updateGift(db, existing.id, { ...input, archived: existing.archived }) : createGift(db, input);

          const rowCounts: Entry[] = [];
          for (const [header, value] of Object.entries(r)) {
            if (!header.toLowerCase().startsWith(STOCK_PREFIX) || value.trim() === '') continue;
            const locName = header.slice(STOCK_PREFIX.length).trim();
            const qty = Number(value);
            if (!Number.isInteger(qty) || qty < 0) throw new DomainError(`"${header}" must be a whole number`);
            const locId =
              listLocations(db).find((l) => l.name.toLowerCase() === locName.toLowerCase())?.id ?? createLocation(db, locName).id;
            rowCounts.push({ id: randomUUID(), kind: 'count', giftId: gift.id, locationId: locId, quantity: qty, userId: actor.id, occurredAt: now, note: 'Imported' });
          }
          return { created: !existing, rowCounts };
        });
        outcome.created ? summary.created++ : summary.updated++;
        counts.push(...outcome.rowCounts);
      } catch (err) {
        summary.errors.push({ row: rowNo, message: (err as Error).message });
      }
    });
  });

  if (counts.length) {
    const res = applySync(db, actor, { entries: counts });
    summary.counts = res.accepted.length;
    for (const r of res.rejected) summary.errors.push({ row: 0, message: `Count not recorded: ${r.reason}` });
  }
  return summary;
}
