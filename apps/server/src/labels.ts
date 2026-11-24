import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { giftLabelPayload, type Gift } from '@gifts/shared';

/** Sticker-sheet layouts, in PDF points (72 per inch). */
const MM = 72 / 25.4;
export const SHEETS = {
  // Avery 5160 / 8160: US Letter, 3 × 10, 2.625" × 1"
  'letter-30': { size: 'LETTER', cols: 3, rows: 10, w: 2.625 * 72, h: 72, left: 0.1875 * 72, top: 0.5 * 72, dx: 2.75 * 72, dy: 72 },
  // Avery L7160: A4, 3 × 7, 63.5 × 38.1 mm
  'a4-21': { size: 'A4', cols: 3, rows: 7, w: 63.5 * MM, h: 38.1 * MM, left: 7.2 * MM, top: 15.15 * MM, dx: 66.04 * MM, dy: 38.1 * MM },
} as const;
export type SheetKind = keyof typeof SHEETS;

export interface LabelRequest {
  gift: Gift;
  category: string | null;
  copies: number;
}

/** Renders Gift Labels onto sticker sheets. `skip` leaves already-used stickers blank at the start. */
export async function renderLabelsPdf(requests: LabelRequest[], sheet: SheetKind, skip = 0): Promise<Buffer> {
  const s = SHEETS[sheet];
  const perPage = s.cols * s.rows;
  const doc = new PDFDocument({ size: s.size, margin: 0, autoFirstPage: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const qrCache = new Map<string, Buffer>();
  let slot = Math.max(0, Math.min(skip, perPage - 1));
  for (const req of requests) {
    const payload = giftLabelPayload(req.gift.id);
    let qr = qrCache.get(payload);
    if (!qr) {
      qr = await QRCode.toBuffer(payload, { margin: 0, width: 300, errorCorrectionLevel: 'M' });
      qrCache.set(payload, qr);
    }
    for (let i = 0; i < Math.max(1, req.copies); i++) {
      if (slot === perPage) {
        doc.addPage();
        slot = 0;
      }
      const col = slot % s.cols;
      const row = Math.floor(slot / s.cols);
      const x = s.left + col * s.dx;
      const y = s.top + row * s.dy;
      const pad = 6;
      const qrSize = s.h - pad * 2;
      doc.image(qr, x + pad, y + pad, { width: qrSize, height: qrSize });
      const tx = x + pad * 2 + qrSize;
      const tw = s.w - (tx - x) - pad;
      doc.font('Helvetica-Bold').fontSize(9).text(req.gift.name, tx, y + pad, { width: tw, height: qrSize * 0.7, ellipsis: true });
      if (req.category) {
        doc.font('Helvetica').fontSize(7).fillColor('#555').text(req.category, tx, y + s.h - pad - 9, { width: tw, lineBreak: false, ellipsis: true });
        doc.fillColor('black');
      }
      slot += 1;
    }
  }
  doc.end();
  return done;
}
