// โหมดหนังสือ: จัดข้อความจากหน้าหนังสือให้เป็นย่อหน้าและหัวข้อ (ไม่พึ่ง DOM — ทดสอบด้วย Node ได้)
//
// rows: แถวข้อความตามลำดับการอ่าน [{ text, x0, y0, x1, y1 }] พิกัด 0..1 ของภาพหน้า
// aspect: ความกว้าง/ความสูงของภาพ (ใช้แปลงระยะแนวนอนให้เทียบกับความสูงบรรทัดได้)

import { textSimilarity } from './thai-text.js';

const THAI = /[฀-๿]/;
const MARKS = /[ัิ-ฺ็-๎]/g; // สระบน/ล่าง วรรณยุกต์ — ไม่กินความกว้าง
const PAGE_NUMBER = /^[\s\-–—.(\[]*(?:หน้า|page|p\.)?\s*(?:[0-9๐-๙]{1,4}|[ivxlcdm]{1,7})\s*[\-–—.)\]]*$/i;

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** ต่อท้ายบรรทัดหนังสือ: ภาษาไทยต่อกันได้เลย (ไม่เว้นวรรคระหว่างคำ) ภาษาอังกฤษเติมช่องว่าง */
export function joinLines(a, b) {
  a = String(a || '').replace(/\s+$/, '');
  b = String(b || '').replace(/^\s+/, '');
  if (!a) return b;
  if (!b) return a;
  if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b; // คำที่ตัดด้วยยัติภังค์
  if (THAI.test(a[a.length - 1]) && THAI.test(b[0])) return a + b;
  return `${a} ${b}`;
}

export function isPageNumber(text) {
  return PAGE_NUMBER.test(String(text || '').trim());
}

/** กุญแจเปรียบเทียบหัว/ท้ายกระดาษระหว่างหน้า (ตัดตัวเลขและเครื่องหมายออก) */
export function edgeKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[0-9๐-๙\s.,:;\-–—|()[\]]/g, '');
}

/** แถวบนสุดและล่างสุดของหน้า (ตามตำแหน่งจริง) */
export function edgeRows(rows) {
  const list = rows.filter((r) => String(r.text || '').trim());
  if (!list.length) return [];
  const byY = [...list].sort((a, b) => a.y0 - b.y0);
  return byY.length === 1 ? [byY[0]] : [byY[0], byY[byY.length - 1]];
}

export function edgeKeys(rows) {
  return edgeRows(rows)
    .map((r) => edgeKey(r.text))
    .filter((k) => k.length >= 3);
}

/**
 * แปลงแถวของหน้าหนังสือเป็นบล็อก (หัวข้อ/ย่อหน้า)
 * @param rows แถวตามลำดับการอ่าน
 * @param opts { aspect, otherEdges } otherEdges = edgeKeys ของหน้าอื่น ใช้หาหัวกระดาษที่ซ้ำทุกหน้า
 * @returns {{ blocks: {type:'heading'|'para', level?:number, text:string}[], startsNew: boolean, endsOpen: boolean }}
 *   startsNew = ย่อหน้าแรกของหน้าเป็นย่อหน้าใหม่ (ไม่ใช่ต่อจากหน้าก่อน), endsOpen = ย่อหน้าสุดท้ายยังไม่จบ
 */
export function reflowRows(rows, { aspect = 0.75, otherEdges = [] } = {}) {
  let list = rows.filter((r) => String(r.text || '').trim());
  // ตัดเลขหน้า และหัว/ท้ายกระดาษที่ซ้ำกับหน้าอื่น
  const drop = new Set(
    edgeRows(list).filter((r) => {
      if (isPageNumber(r.text)) return true;
      const k = edgeKey(r.text);
      // 0.7: เผื่อ OCR อ่านหัวกระดาษบางหน้าเพี้ยนไปบ้าง
      return k.length >= 3 && otherEdges.some((o) => textSimilarity(k, o) >= 0.7);
    }),
  );
  list = list.filter((r) => !drop.has(r));
  if (!list.length) return { blocks: [], startsNew: true, endsOpen: false };

  const ax = (x) => x * aspect; // ระยะแนวนอนในหน่วยเดียวกับความสูง
  // ความสูงบรรทัดปกติ: ใช้ส่วนล่าง 75% กันหัวข้อ/บรรทัดที่กรอบสูงผิดปกติดึงค่าขึ้น
  const heights = list.map((r) => r.y1 - r.y0).sort((a, b) => a - b);
  const H = median(heights.slice(0, Math.max(1, Math.ceil(heights.length * 0.75)))) || 0.02;
  // ขนาดตัวอักษรจากความกว้างต่อตัวอักษร (ไม่นับสระบน/ล่าง) — แม่นกว่าความสูงกรอบ
  // เพราะบรรทัดที่ไม่มีสระบน/ล่าง เช่น "งบทดลอง" กรอบจะเตี้ยกว่าบรรทัดเนื้อหาทั้งที่ตัวใหญ่กว่า
  const baseChars = (t) => String(t).replace(MARKS, '').length;
  const charW = (r) => (baseChars(r.text) >= 3 ? ax(r.x1 - r.x0) / baseChars(r.text) : 0);
  const bodyW = list.map(charW).filter((w, i) => w && baseChars(list[i].text) >= 8);
  const CW = median(bodyW.length ? bodyW : list.map(charW).filter(Boolean)) || 0;
  // แถวที่เตี้ยผิดปกติ = เศษสระบน/วรรณยุกต์ที่ OCR แยกออกมาเป็นบรรทัด (พบบ่อยกับ Tesseract) → ตัดทิ้ง
  list = list.filter((r) => r.y1 - r.y0 >= 0.5 * H);
  if (!list.length) return { blocks: [], startsNew: true, endsOpen: false };

  // ขอบซ้าย/ขวาของคอลัมน์ = แถวอื่นที่ซ้อนทับในแนวนอน
  // ขอบคอลัมน์ของแถว = จากแถวที่อยู่ติดกัน (บน 2 ล่าง 2 ในคอลัมน์เดียวกัน) เท่านั้น
  // ภาพถ่ายเอียงแบบเปอร์สเปกทีฟ ขอบซ้าย/ขวาของบรรทัดล่างจะแคบกว่าบรรทัดบน ถ้าเทียบทั้งหน้า
  // จะเข้าใจผิดว่าบรรทัดล่างย่อหน้าเข้า/จบสั้น แล้วตัดย่อหน้าผิด
  const colOf = (r) => {
    const i = list.indexOf(r);
    const peers = list
      .slice(Math.max(0, i - 2), i + 3)
      .filter(
        (o) =>
          Math.abs((o.y0 + o.y1) / 2 - (r.y0 + r.y1) / 2) <= 3.5 * H &&
          Math.min(o.x1, r.x1) - Math.max(o.x0, r.x0) > 0.3 * (r.x1 - r.x0),
      );
    return { left: Math.min(...peers.map((o) => o.x0)), right: Math.max(...peers.map((o) => o.x1)) };
  };
  // หัวข้อ = ตัวอักษรใหญ่กว่าเนื้อหา และไม่ยาวเต็มคอลัมน์ (บรรทัดเนื้อหาบางบรรทัดมีกรอบสูงกว่าปกติจากสระบน/ล่าง)
  const headingLevel = (r) => {
    const h = r.y1 - r.y0;
    if (String(r.text).length > 90 || list.length < 3) return 0;
    const { left, right } = colOf(r);
    if (r.x1 - r.x0 > 0.9 * (right - left) && list.some((o) => o !== r && o.x1 - o.x0 > 0.9 * (right - left))) return 0;
    const hr = h / H;
    const wr = CW && charW(r) ? charW(r) / CW : hr;
    if (wr < 1.1) return 0; // ตัวอักษรไม่ได้ใหญ่กว่าเนื้อหา
    if (wr >= 1.7 || hr >= 1.8) return 1;
    if (wr >= 1.3 || hr >= 1.35) return 2;
    return 0;
  };
  const isIndented = (r) => ax(r.x0 - colOf(r).left) > 0.8 * H;
  const isShort = (r) => ax(colOf(r).right - r.x1) > 2.0 * H;

  const blocks = [];
  let prev = null;
  for (const r of list) {
    const level = headingLevel(r);
    const last = blocks[blocks.length - 1];
    if (level) {
      // หัวข้อหลายบรรทัดระดับเดียวกันที่อยู่ติดกัน → รวมเป็นหัวข้อเดียว
      if (last?.type === 'heading' && last.level === level && prev && r.y0 - prev.y1 < 0.8 * H) {
        last.text = joinLines(last.text, r.text);
      } else {
        blocks.push({ type: 'heading', level, text: r.text.trim() });
      }
    } else {
      const newPara =
        !last ||
        last.type !== 'para' ||
        r.y0 - prev.y1 > 0.9 * H || // มีช่องว่างระหว่างบรรทัด
        isShort(prev) || // บรรทัดก่อนหน้าจบก่อนถึงขอบขวา
        isIndented(r); // บรรทัดนี้ย่อหน้าเข้าไป
      if (newPara) blocks.push({ type: 'para', text: r.text.trim(), firstRow: r });
      else last.text = joinLines(last.text, r.text);
    }
    prev = r;
  }

  const first = blocks[0];
  const lastBlock = blocks[blocks.length - 1];
  const lastRow = list[list.length - 1];
  return {
    blocks: blocks.map(({ firstRow, ...b }) => b),
    startsNew: first.type !== 'para' || isIndented(first.firstRow),
    endsOpen: lastBlock.type === 'para' && !isShort(lastRow),
  };
}

/** บล็อก → ข้อความในหน้าแก้ไข: "# หัวข้อ", "## หัวข้อย่อย", 1 บรรทัด = 1 ย่อหน้า */
export function blocksToText(blocks) {
  return blocks
    .map((b) => (b.type === 'heading' ? `${'#'.repeat(b.level)} ${b.text}` : b.text))
    .join('\n\n');
}

/** ข้อความโหมดหนังสือ (ที่ผู้ใช้อาจแก้ไขแล้ว) → บล็อก สำหรับสร้างไฟล์ Word */
export function parseBookText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(#{1,3})\s+(.*)$/.exec(l);
      return m ? { type: 'heading', level: m[1].length, text: m[2] } : { type: 'para', text: l };
    });
}
