"""Gift Label sticker sheets as PDF (QR code + Gift name + Category)."""
from __future__ import annotations

import io

from reportlab.graphics import renderPDF
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib.colors import HexColor, black
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

from .rules import gift_label_payload

MM = 72 / 25.4
# Sticker-sheet layouts, in PDF points (72 per inch), measured from the top-left corner.
SHEETS = {
    # Avery 5160 / 8160: US Letter, 3 x 10, 2.625" x 1"
    'letter-30': dict(size=LETTER, cols=3, rows=10, w=2.625 * 72, h=72, left=0.1875 * 72, top=0.5 * 72, dx=2.75 * 72, dy=72),
    # Avery L7160: A4, 3 x 7, 63.5 x 38.1 mm
    'a4-21': dict(size=A4, cols=3, rows=7, w=63.5 * MM, h=38.1 * MM, left=7.2 * MM, top=15.15 * MM, dx=66.04 * MM, dy=38.1 * MM),
}

_ASCENT = 0.718  # Helvetica ascender, as a fraction of the font size
_LINE = 1.16  # line height, as a fraction of the font size


def _fit(text: str, font: str, size: float, width: float) -> str:
    """Shortens text with an ellipsis so it fits on one line."""
    if stringWidth(text, font, size) <= width:
        return text
    while text and stringWidth(text + '…', font, size) > width:
        text = text[:-1]
    return text.rstrip() + '…'


def _draw_qr(c: canvas.Canvas, payload: str, x: float, y: float, size: float):
    widget = QrCodeWidget(payload, barLevel='M', barBorder=0)
    x0, y0, x1, y1 = widget.getBounds()
    d = Drawing(size, size, transform=[size / (x1 - x0), 0, 0, size / (y1 - y0), 0, 0])
    d.add(widget)
    renderPDF.draw(d, c, x, y)


def render_labels_pdf(requests: list[dict], sheet: str, skip: int = 0) -> bytes:
    """requests: [{'gift': ..., 'category': str | None, 'copies': int}]. `skip` leaves used stickers blank."""
    s = SHEETS[sheet]
    page_w, page_h = s['size']
    per_page = s['cols'] * s['rows']
    out = io.BytesIO()
    c = canvas.Canvas(out, pagesize=s['size'])
    try:
        skip = int(skip)
    except (TypeError, ValueError):
        skip = 0
    slot = max(0, min(skip, per_page - 1))
    pad = 6
    for req in requests:
        payload = gift_label_payload(req['gift']['id'])
        for _ in range(max(1, req['copies'])):
            if slot == per_page:
                c.showPage()
                slot = 0
            col, row = slot % s['cols'], slot // s['cols']
            x = s['left'] + col * s['dx']
            top = s['top'] + row * s['dy']  # from the top of the page
            qr = s['h'] - pad * 2
            _draw_qr(c, payload, x + pad, page_h - (top + pad) - qr, qr)

            tx = x + pad * 2 + qr
            tw = s['w'] - (tx - x) - pad
            # Name: wrapped, as many lines as fit in 70% of the QR height, the last one shortened with "…".
            size = 9
            max_lines = max(1, int((qr * 0.7) // (size * _LINE)))
            lines = simpleSplit(req['gift']['name'], 'Helvetica-Bold', size, tw) or ['']
            if len(lines) > max_lines:
                lines = lines[:max_lines]
                last = lines[-1]
                while last and stringWidth(last + '…', 'Helvetica-Bold', size) > tw:
                    last = last[:-1]
                lines[-1] = last.rstrip() + '…'
            c.setFont('Helvetica-Bold', size)
            c.setFillColor(black)
            for n, line in enumerate(lines):
                c.drawString(tx, page_h - (top + pad + size * _ASCENT + n * size * _LINE), _fit(line, 'Helvetica-Bold', size, tw))
            if req.get('category'):
                c.setFont('Helvetica', 7)
                c.setFillColor(HexColor('#555555'))
                c.drawString(tx, page_h - (top + s['h'] - pad - 9 + 7 * _ASCENT), _fit(req['category'], 'Helvetica', 7, tw))
                c.setFillColor(black)
            slot += 1
    c.save()
    return out.getvalue()
