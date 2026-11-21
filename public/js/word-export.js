// สร้างไฟล์ Word (.docx) จากหน้าที่สแกน — ตั้งฟอนต์ไทยแบบ complex script ให้ถูกต้อง

import { VENDOR } from '../vendor/paths.js';
import { loadScript, thaiDateLong, thaiDateTime } from './util.js';
import { imageSize } from './image-tools.js';

// A4 ขอบ 2 ซม. → พื้นที่กว้าง 17 ซม. ≈ 640px ที่ 96dpi
const PAGE = { width: 11906, height: 16838, margin: 1134 };
const MAX_IMG_W = 600;
const MAX_IMG_H = 760;

export const SOURCE_LABEL = {
  photo: 'ภาพถ่าย',
  upload: 'ไฟล์ภาพ',
  video: 'วิดีโอ',
  'video-file': 'ไฟล์วิดีโอ',
};

export async function loadDocx() {
  await loadScript(VENDOR.docx);
  return window.docx;
}

/**
 * @param pages หน้าที่สแกน (เรียงตามลำดับแล้ว)
 * @param opts {title, font, fontSize, includeImages, pageBreak, headings}
 * @returns {Promise<Blob>}
 */
export async function buildWordDocument(pages, opts = {}) {
  const docx = await loadDocx();
  const { Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType, HeadingLevel, Footer, PageNumber, LineRuleType, Tab } = docx;

  const fontName = opts.font || 'TH Sarabun New';
  const size = (opts.fontSize || 16) * 2; // หน่วย half-point
  const font = { ascii: fontName, hAnsi: fontName, cs: fontName, eastAsia: fontName };
  const lang = { value: 'th-TH', bidirectional: 'th-TH' };
  const run = (text, extra = {}) =>
    new TextRun({
      text,
      font,
      language: lang,
      ...extra,
      ...(extra.bold ? { boldComplexScript: true } : {}),
      ...(extra.size ? { sizeComplexScript: extra.size } : {}),
    });

  const children = [];
  const title = opts.title?.trim() || 'เอกสารสแกน';

  if (opts.headings !== false) {
    children.push(
      new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [run(title)] }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [
          run(`สแกนเมื่อ ${thaiDateLong(Date.now())} • จำนวน ${pages.length} หน้า`, {
            size: size - 4,
            color: '666666',
          }),
        ],
      }),
    );
  }

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const first = i === 0;

    if (opts.headings !== false) {
      const label = [SOURCE_LABEL[page.source] || 'สแกน', page.sourceDetail].filter(Boolean).join(' ');
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          pageBreakBefore: !!opts.pageBreak && !first,
          children: [run(`หน้าที่ ${i + 1}`)],
        }),
        new Paragraph({
          spacing: { after: 120 },
          children: [
            run(
              `ที่มา: ${label} • ${thaiDateTime(page.createdAt)}` +
                (page.status === 'done' && !page.edited ? ` • ความมั่นใจ OCR ${page.confidence}%` : '') +
                (page.edited ? ' • แก้ไขข้อความแล้ว' : ''),
              { size: size - 6, color: '808080' },
            ),
          ],
        }),
      );
    } else if (opts.pageBreak && !first) {
      children.push(new Paragraph({ pageBreakBefore: true, children: [] }));
    }

    if (opts.includeImages && page.image) {
      const { width, height } = await imageSize(page.image);
      const scale = Math.min(1, MAX_IMG_W / width, MAX_IMG_H / height);
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [
            new ImageRun({
              type: 'jpg',
              data: await page.image.arrayBuffer(),
              transformation: { width: Math.round(width * scale), height: Math.round(height * scale) },
              altText: { name: `หน้าที่ ${i + 1}`, title: `ภาพหน้าที่ ${i + 1}`, description: `ภาพสแกนหน้าที่ ${i + 1}` },
            }),
          ],
        }),
      );
    }

    const text = (page.text || '').trim();
    const lines = text ? text.split('\n') : ['(ไม่พบข้อความ)'];
    for (const line of lines) {
      // tab = ข้อความคนละคอลัมน์ในแถวเดียวกัน → ใส่เป็น tab ของ Word
      const runs = line
        .split('\t')
        .flatMap((part, k) => (k ? [new TextRun({ children: [new Tab()] }), run(part)] : part ? [run(part)] : []));
      children.push(new Paragraph({ children: runs }));
    }
    if (!opts.pageBreak && i < pages.length - 1) {
      children.push(new Paragraph({ spacing: { after: 240 }, children: [] }));
    }
  }

  const headingStyle = (pt, extra = {}) => ({
    run: { font, size: pt * 2, sizeComplexScript: pt * 2, bold: true, boldComplexScript: true, color: '1F3864' },
    paragraph: { spacing: { before: 240, after: 80 }, keepNext: true, ...extra },
  });
  const basePt = opts.fontSize || 16;

  const doc = new Document({
    creator: 'Thai OCR Scanner',
    title,
    description: 'เอกสารที่สแกนและอ่านข้อความด้วย OCR ภาษาไทย',
    styles: {
      default: {
        document: {
          run: { font, size, sizeComplexScript: size, language: lang },
          // ระยะบรรทัด 1.15 เท่า (ต้องระบุ lineRule ไม่อย่างนั้นบางโปรแกรมตีความเป็นความสูงคงที่ ทำให้ภาพถูกตัด)
          paragraph: { spacing: { line: 276, lineRule: LineRuleType.AUTO } },
        },
        title: headingStyle(Math.round(basePt * 1.5), { alignment: AlignmentType.CENTER }),
        heading1: headingStyle(Math.round(basePt * 1.15)),
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE.width, height: PAGE.height },
            margin: { top: PAGE.margin, right: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    font,
                    size: size - 6,
                    sizeComplexScript: size - 6,
                    color: '808080',
                    children: ['หน้า ', PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES],
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBlob(doc);
}

/** ข้อความล้วน (.txt) */
export function buildPlainText(pages, title) {
  const parts = [title || 'เอกสารสแกน', ''];
  pages.forEach((p, i) => {
    parts.push(`===== หน้าที่ ${i + 1} =====`, (p.text || '').trim().replace(/\r?\n/g, '\r\n'), '');
  });
  return new Blob(['﻿' + parts.join('\r\n')], { type: 'text/plain;charset=utf-8' });
}
