import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { stockKey, type Entry, type Pack } from '@gifts/shared';
import { tx, type Db } from './db.js';
import {
  applySync,
  createGift,
  createLocation,
  DomainError,
  listCategories,
  listGifts,
  listLocations,
  stockMap,
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

// ---------- Gift CSV format (shared by export, template and import) ----------

/** Fixed columns, in order. Then one "Stock: <Location>" column per Location. */
export const GIFT_COLUMNS = ['ID', 'Name', 'Category', 'Unit Cost', 'Low Stock Threshold', 'Packs', 'Barcodes', 'Archived'] as const;
const STOCK_PREFIX = 'stock:';

const packsText = (packs: Pack[]) => packs.map((p) => `${p.name}=${p.pieces}`).join('; ');

function giftColumns(db: Db): Column[] {
  const locs = listLocations(db).filter((l) => !l.archived);
  return [
    ...GIFT_COLUMNS.map((h) => ({ header: h, key: h, width: h === 'Name' ? 30 : h === 'ID' ? 38 : 18 })),
    ...locs.map((l) => ({ header: `Stock: ${l.name}`, key: `Stock: ${l.name}`, width: 16 })),
  ];
}

/** Every Gift (including archived) in the import format, with current Stock Levels. */
export function giftsTable(db: Db): { name: string; columns: Column[]; rows: Record<string, Cell>[] } {
  const columns = giftColumns(db);
  const locs = listLocations(db).filter((l) => !l.archived);
  const cats = new Map(listCategories(db).map((c) => [c.id, c.name]));
  const levels = stockMap(db);
  const rows = listGifts(db).map((g) => {
    const row: Record<string, Cell> = {
      ID: g.id,
      Name: g.name,
      Category: g.categoryId ? (cats.get(g.categoryId) ?? '') : '',
      'Unit Cost': g.unitCost,
      'Low Stock Threshold': g.lowStockThreshold,
      Packs: packsText(g.packs),
      Barcodes: g.barcodes.join('; '),
      Archived: g.archived ? 'yes' : 'no',
    };
    for (const l of locs) row[`Stock: ${l.name}`] = levels.get(stockKey(g.id, l.id)) ?? 0;
    return row;
  });
  return { name: 'gifts', columns, rows };
}

/** The import format with one example row, for people starting a file from scratch. */
export function importTemplateRows(db: Db): { columns: Column[]; rows: Record<string, Cell>[] } {
  const columns = giftColumns(db);
  const example: Record<string, Cell> = {
    ID: '',
    Name: 'Blue logo pen',
    Category: 'Pens',
    'Unit Cost': 0.85,
    'Low Stock Threshold': 100,
    Packs: 'Carton=50; Box=10',
    Barcodes: '0123456789012',
    Archived: 'no',
  };
  const firstStock = columns.find((c) => c.header.toLowerCase().startsWith(STOCK_PREFIX));
  if (firstStock) example[firstStock.key] = 420;
  return { columns, rows: [example] };
}

export async function importTemplate(db: Db): Promise<Buffer> {
  const t = importTemplateRows(db);
  return toXlsx('Gifts', t.columns, t.rows);
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

function parseArchived(s: string | undefined): boolean | null {
  const v = (s ?? '').trim().toLowerCase();
  if (v === '') return null;
  if (['yes', 'y', 'true', '1', 'archived'].includes(v)) return true;
  if (['no', 'n', 'false', '0', 'active'].includes(v)) return false;
  throw new DomainError(`Archived must be yes or no (got "${s}")`);
}

/**
 * Creates or updates Gifts from rows in the Gift CSV format. Column names ignore case.
 * - A row with an ID updates that Gift (so it can be renamed); without an ID it matches by Name,
 *   and creates a new Gift when no Gift has that name.
 * - Each row describes the Gift completely: an empty Unit Cost, Packs, etc. clears that field.
 *   An empty Archived keeps the Gift's current state.
 * - "Stock: <Location>" values are recorded as Counts by the importing Admin. Empty cells and values
 *   equal to the current Stock Level are skipped, so re-importing an export changes nothing.
 */
export function importGifts(db: Db, actor: Actor, rawRows: RawRow[]): ImportSummary {
  const summary: ImportSummary = { created: 0, updated: 0, counts: 0, errors: [] };
  const now = new Date().toISOString();
  const counts: Entry[] = [];
  const levels = stockMap(db);
  // Match column names case-insensitively, but keep the original header for new Location names.
  const rows = rawRows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim().toLowerCase(), v ?? ''])));
  const stockHeaders = rawRows.map((r) => Object.keys(r).filter((k) => k.trim().toLowerCase().startsWith(STOCK_PREFIX)).map((k) => k.trim()));

  tx(db, () => {
    rows.forEach((r, i) => {
      const rowNo = i + 2; // header is row 1
      const name = (r['name'] ?? '').trim();
      if (!Object.values(r).some((v) => v.trim())) return; // blank line
      try {
        // Each row is its own savepoint: a bad row leaves nothing half-written.
        const outcome = tx(db, () => {
          if (!name) throw new DomainError('Name is empty');
          const unitCost = num(r['unit cost']);
          const threshold = num(r['low stock threshold']);
          if (unitCost !== null && Number.isNaN(unitCost)) throw new DomainError('Unit Cost is not a number');
          if (threshold !== null && Number.isNaN(threshold)) throw new DomainError('Low Stock Threshold is not a number');
          const archived = parseArchived(r['archived']);
          const id = (r['id'] ?? '').trim();
          const gifts = listGifts(db);
          const existing = id ? gifts.find((g) => g.id === id) : gifts.find((g) => g.name.toLowerCase() === name.toLowerCase());
          if (id && !existing) throw new DomainError(`No Gift has ID ${id}. Leave ID empty to create a new Gift.`);
          const input = {
            name,
            categoryId: r['category']?.trim() ? upsertCategoryByName(db, r['category']) : null,
            unitCost,
            lowStockThreshold: threshold,
            packs: parsePacks(r['packs'] ?? ''),
            barcodes: (r['barcodes'] ?? '').split(/[;,\s]+/).filter(Boolean),
            archived: archived ?? existing?.archived ?? false,
          };
          const gift = existing ? updateGift(db, existing.id, input) : createGift(db, input);

          const rowCounts: Entry[] = [];
          for (const header of stockHeaders[i] ?? []) {
            const value = r[header.toLowerCase()] ?? '';
            if (value.trim() === '') continue;
            const locName = header.slice(STOCK_PREFIX.length).trim();
            const qty = Number(value.trim());
            const locId = listLocations(db).find((l) => l.name.toLowerCase() === locName.toLowerCase())?.id;
            if (locId && (levels.get(stockKey(gift.id, locId)) ?? 0) === qty) continue; // unchanged
            if (!Number.isInteger(qty) || qty < 0) throw new DomainError(`"Stock: ${locName}" must be a whole number, 0 or more`);
            rowCounts.push({
              id: randomUUID(),
              kind: 'count',
              giftId: gift.id,
              locationId: locId ?? createLocation(db, locName).id,
              quantity: qty,
              userId: actor.id,
              occurredAt: now,
              note: 'Imported',
            });
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
