// สร้าง PDF ที่ "หน้าตาเหมือนต้นฉบับ" และค้นหา/คัดลอกข้อความได้
// แต่ละหน้า = ภาพที่สแกน + ชั้นข้อความที่มองไม่เห็น (text render mode 3) วางทับตำแหน่งบรรทัดจริงจาก OCR

import { VENDOR } from '../vendor/paths.js';
import { loadScript, absUrl } from './util.js';

const A4 = [595.28, 841.89]; // หน่วย point

async function loadPdfLib() {
  await loadScript(VENDOR.pdflib);
  await loadScript(VENDOR.fontkit);
  return { PDFLib: window.PDFLib, fontkit: window.fontkit };
}

/**
 * บรรทัดข้อความพร้อมตำแหน่ง (0..1) ของหน้า
 * - ใช้ตำแหน่งจาก OCR ถ้ามีและผู้ใช้ยังไม่ได้แก้ข้อความ
 * - ถ้าแก้ข้อความแล้ว (ตำแหน่งเดิมใช้ไม่ได้) จะเรียงข้อความที่แก้ไว้จากบนลงล่าง ให้ยังค้นหาได้
 */
export function textLinesOf(page, cleanLine = (t) => t) {
  const lines = page.layout?.lines || [];
  if (lines.length && !page.edited) {
    return lines.map((l) => ({ ...l, text: cleanLine(l.text) })).filter((l) => l.text.trim());
  }
  const texts = String(page.text || '')
    .split(/\r?\n/)
    .map((t) => t.replace(/^#{1,3}\s+/, '').trim())
    .filter(Boolean);
  const h = Math.min(0.04, 0.9 / Math.max(texts.length, 1));
  return texts.map((text, i) => ({ text, x0: 0.05, x1: 0.95, y0: 0.05 + i * h, y1: 0.05 + (i + 1) * h * 0.9 }));
}

/**
 * @param pages หน้าที่สแกน (เรียงแล้ว) — ใช้ page.image (JPEG), page.layout, page.text
 * @param opts { title, cleanLine }
 * @returns {Promise<Blob>}
 */
export async function buildSearchablePdf(pages, { title = 'เอกสารสแกน', cleanLine, visibleText = false } = {}) {
  const { PDFLib, fontkit } = await loadPdfLib();
  const { PDFDocument, pushGraphicsState, popGraphicsState, setTextRenderingMode, TextRenderingMode, setCharacterSqueeze } =
    PDFLib;

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(title);
  doc.setCreator('Thai OCR Scanner');
  doc.setProducer('Thai OCR Scanner (pdf-lib)');
  doc.setLanguage('th-TH');

  const fontBytes = await (await fetch(absUrl(VENDOR.thaiFont))).arrayBuffer();
  // ปิด ccmp: ฟอนต์จะแตก "ำ" เป็น 2 glyph ทำให้คัดลอกข้อความออกมาเป็น "ำา"
  const font = await doc.embedFont(fontBytes, { subset: true, features: { ccmp: false } });

  for (const page of pages) {
    const jpg = await doc.embedJpg(await page.image.arrayBuffer());
    const [maxW, maxH] = jpg.width > jpg.height ? [A4[1], A4[0]] : A4;
    const scale = Math.min(maxW / jpg.width, maxH / jpg.height);
    const W = jpg.width * scale;
    const H = jpg.height * scale;
    const p = doc.addPage([W, H]);
    p.drawImage(jpg, { x: 0, y: 0, width: W, height: H });

    for (const line of textLinesOf(page, cleanLine)) {
      const text = line.text.replace(/\t/g, ' ');
      // วางเป็นแนวนอนเสมอ (ข้อความเอียงทำให้โปรแกรมอ่าน PDF ตัดคำ/ตัวเลขเป็นท่อน ค้นหาไม่เจอ)
      // ถ้า OpenThai ให้กรอบเอียงมา ใช้ความสูงจริงของบรรทัด และวางกึ่งกลางกรอบ
      const boxW = (line.x1 - line.x0) * W;
      const boxH = line.quad ? line.quad.h * H : (line.y1 - line.y0) * H;
      if (boxW < 1 || boxH < 1) continue;
      const size = Math.max(2, Math.min(boxH * 0.8, 200));
      const natural = font.widthOfTextAtSize(text, size);
      const squeeze = natural > 0 ? Math.max(5, Math.min(1000, (boxW / natural) * 100)) : 100;
      const midY = H - ((line.y0 + line.y1) / 2) * H;
      // ข้อความล่องหน (render mode 3) ยืด/หดให้กว้างเท่ากรอบบรรทัดจริง เพื่อให้ไฮไลต์ตรงกับภาพ
      const mode = visibleText ? TextRenderingMode.Fill : TextRenderingMode.Invisible; // visibleText = ไว้ตรวจตำแหน่งตอนพัฒนา
      p.pushOperators(pushGraphicsState(), setTextRenderingMode(mode), setCharacterSqueeze(squeeze));
      p.drawText(text, { x: line.x0 * W, y: midY - boxH * 0.28, size, font, color: PDFLib.rgb(0.9, 0, 0) });
      p.pushOperators(popGraphicsState());
    }
  }
  return new Blob([await doc.save()], { type: 'application/pdf' });
}
