// ฟังก์ชันจัดการข้อความภาษาไทยหลัง OCR (ไม่พึ่ง DOM — ทดสอบด้วย Node ได้)

const TONES = '่-๋'; // ่ ้ ๊ ๋
const ABOVE_BELOW_VOWELS = 'ัิ-ฺ็'; // ั ิ ี ึ ื ุ ู ฺ ็
// อักขระที่ "ขึ้นต้นคำไม่ได้" — สระบน/ล่าง วรรณยุกต์ การันต์ และสระหลัง
const NON_INITIAL = 'ะ-ฺๅ็-๎';
const LEADING_VOWELS = 'เ-ไ'; // เ แ โ ใ ไ
const CONSONANTS = 'ก-ฮ';
const THAI = 'ก-๛';

/**
 * แก้ข้อผิดพลาดที่พบบ่อยจาก Tesseract กับอักษรไทย
 * - "ํา" (นิคหิต + สระอา) → "ำ"
 * - "เเ" (สระเอสองตัว) → "แ"
 * - วรรณยุกต์มาก่อนสระบน/ล่าง → สลับให้ถูกลำดับ (เช่น "ก่ี" → "กี่")
 * - วรรณยุกต์/การันต์ซ้ำกัน
 */
export function fixThaiCharacters(text) {
  return text
    .replace(new RegExp(`ํ([${TONES}])า`, 'g'), '$1ำ') // ◌ํ◌่า → ◌่ำ
    .replace(/ํา/g, 'ำ')
    .replace(/เเ/g, 'แ')
    .replace(new RegExp(`([${TONES}])([${ABOVE_BELOW_VOWELS}])`, 'g'), '$2$1')
    .replace(/([่-์])\1+/g, '$1');
}

/**
 * ลบช่องว่างที่ผิดแน่นอน: ก่อนสระบน/ล่าง/วรรณยุกต์, หลังสระหน้า (เ แ โ ใ ไ)
 * และหลังไม้หันอากาศ (ั ต้องมีตัวสะกดตามเสมอ)
 */
export function fixThaiSpacing(text) {
  return text
    // ไม่ใช้ lookbehind (?<=) เพราะ Safari บน iOS ต่ำกว่า 16.4 ไม่รองรับ
    .replace(new RegExp(`([${THAI}])[ \\t]+(?=[${NON_INITIAL}])`, 'g'), '$1')
    .replace(new RegExp(`([${LEADING_VOWELS}\u0E31])[ \\t]+(?=[${CONSONANTS}])`, 'g'), '$1');
}

/** ลบช่องว่างทั้งหมดระหว่างอักษรไทย (ภาษาไทยไม่เว้นวรรคระหว่างคำ) */
export function removeSpacesBetweenThai(text) {
  return text.replace(new RegExp(`([${THAI}])[ \\t]+(?=[${THAI}])`, 'g'), '$1');
}

/** จัดรูปแบบตัวเลข/จำนวนเงิน เช่น "1, 050 . 00" → "1,050.00" */
export function fixNumbers(text) {
  return text.replace(/(\d)[ \t]*([,.])[ \t]*(?=\d)/g, '$1$2');
}

/** แปลงเลขไทย ๐-๙ เป็นเลขอารบิก 0-9 */
export function thaiDigitsToArabic(text) {
  return text.replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50));
}

/**
 * ตัดช่องว่างหัว/ท้ายบรรทัด ยุบช่องว่างซ้ำ และยุบบรรทัดว่างที่ติดกันให้เหลือบรรทัดเดียว
 * (คง tab ไว้ — ใช้คั่นข้อความคนละคอลัมน์ในแถวเดียวกัน เช่น รายการ ⇥ จำนวนเงิน)
 */
export function tidyLines(text, { removeBlankLines = false } = {}) {
  let lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/ +/g, ' ').replace(/ *\t[\t ]*/g, '\t').trim());
  if (removeBlankLines) lines = lines.filter(Boolean);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const DEFAULT_CLEAN_OPTIONS = {
  fixThai: true,
  removeThaiSpaces: false,
  fixNumbers: true,
  thaiDigits: false,
  removeBlankLines: false,
};

/** รวมทุกขั้นตอนทำความสะอาดข้อความตามตัวเลือก */
export function cleanOcrText(text, options = {}) {
  const o = { ...DEFAULT_CLEAN_OPTIONS, ...options };
  let t = String(text || '');
  if (o.fixThai) t = fixThaiSpacing(fixThaiCharacters(t));
  if (o.removeThaiSpaces) t = removeSpacesBetweenThai(t);
  if (o.thaiDigits) t = thaiDigitsToArabic(t);
  if (o.fixNumbers) t = fixNumbers(t);
  return tidyLines(t, { removeBlankLines: o.removeBlankLines });
}

function bigrams(text) {
  const s = String(text || '').replace(/\s+/g, '').toLowerCase();
  const map = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    map.set(g, (map.get(g) || 0) + 1);
  }
  return { map, size: Math.max(0, s.length - 1) };
}

/** ความคล้ายของข้อความ 0..1 (Dice coefficient ของ bigram) ใช้ตัดเฟรมวิดีโอที่ซ้ำกัน */
export function textSimilarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let overlap = 0;
  for (const [g, n] of A.map) overlap += Math.min(n, B.map.get(g) || 0);
  return (2 * overlap) / (A.size + B.size);
}

/** คะแนนคุณภาพผล OCR ใช้เลือกเฟรมที่ดีกว่าเมื่อเฟรมซ้ำกัน */
export function ocrQuality(text, confidence) {
  const len = String(text || '').replace(/\s+/g, '').length;
  return len * (Math.max(0, Number(confidence) || 0) / 100);
}
