import test from 'node:test';
import assert from 'node:assert/strict';
import { joinLines, isPageNumber, edgeKey, edgeKeys, reflowRows, blocksToText, parseBookText } from '../../public/js/book.js';

const row = (text, x0, y0, x1, h = 0.025) => ({ text, x0, y0, x1, y1: y0 + h });

// หน้าหนังสือจำลอง: หัวกระดาษ, หัวข้อตัวใหญ่, 2 ย่อหน้า (ย่อหน้าแรกเข้าไป), เลขหน้า
const PAGE = [
  row('บทที่ 1 การบัญชีเบื้องต้น', 0.3, 0.03, 0.7),
  row('การบันทึกบัญชี', 0.1, 0.1, 0.6, 0.05),
  row('การบันทึกบัญชีเป็นขั้นตอนแรกของ', 0.15, 0.17, 0.9),
  row('วงจรบัญชี ซึ่งต้องทำทุกวัน', 0.1, 0.2, 0.9),
  row('อย่างสม่ำเสมอ', 0.1, 0.23, 0.5),
  row('Double-entry book-', 0.15, 0.26, 0.9),
  row('keeping requires debits and credits', 0.1, 0.29, 0.9),
  row('ที่เท่ากันเสมอ', 0.1, 0.32, 0.9),
  row('12', 0.48, 0.95, 0.52),
];

test('joinLines: ไทยต่อกันเลย อังกฤษเว้นวรรค ยัติภังค์รวมคำ', () => {
  assert.equal(joinLines('ขั้นตอนแรกของ', 'วงจรบัญชี'), 'ขั้นตอนแรกของวงจรบัญชี');
  assert.equal(joinLines('debits and', 'credits'), 'debits and credits');
  assert.equal(joinLines('book-', 'keeping'), 'bookkeeping');
  assert.equal(joinLines('ยอดรวม', '1,000 บาท'), 'ยอดรวม 1,000 บาท');
  assert.equal(joinLines('', 'ก'), 'ก');
});

test('isPageNumber / edgeKey', () => {
  for (const t of ['12', '- 12 -', '(๑๒)', 'หน้า 5', 'xiv', 'Page 3']) assert.ok(isPageNumber(t), t);
  for (const t of ['12 บาท', 'บทที่ 1', '2569 รายงาน']) assert.ok(!isPageNumber(t), t);
  assert.equal(edgeKey('บทที่ 1 การบัญชี'), edgeKey('บทที่ 12  การบัญชี'));
});

test('reflowRows: หัวข้อ ย่อหน้า ตัดเลขหน้าและหัวกระดาษที่ซ้ำ', () => {
  const others = edgeKeys([row('บทที่ 2 การบัญชีเบื้องต้น', 0.3, 0.03, 0.7), row('13', 0.48, 0.95, 0.52)]);
  const r = reflowRows(PAGE, { aspect: 0.7, otherEdges: others });
  assert.deepEqual(r.blocks, [
    { type: 'heading', level: 1, text: 'การบันทึกบัญชี' },
    { type: 'para', text: 'การบันทึกบัญชีเป็นขั้นตอนแรกของวงจรบัญชี ซึ่งต้องทำทุกวันอย่างสม่ำเสมอ' },
    { type: 'para', text: 'Double-entry bookkeeping requires debits and credits ที่เท่ากันเสมอ' },
  ]);
  assert.equal(r.startsNew, true);
  assert.equal(r.endsOpen, true);
});

test('reflowRows: หัวกระดาษไม่ซ้ำหน้าอื่น → เก็บไว้, หน้าที่ต่อจากหน้าก่อน', () => {
  const r = reflowRows(PAGE, { aspect: 0.7 });
  assert.equal(r.blocks[0].text, 'บทที่ 1 การบัญชีเบื้องต้น');
  const cont = reflowRows([row('ต่อจากหน้าก่อน', 0.1, 0.1, 0.9), row('จบย่อหน้า', 0.1, 0.13, 0.4), row('ย่อหน้าใหม่', 0.15, 0.16, 0.9)], {
    aspect: 0.7,
  });
  assert.equal(cont.startsNew, false);
  assert.equal(cont.blocks.length, 2);
  assert.equal(cont.blocks[0].text, 'ต่อจากหน้าก่อนจบย่อหน้า');
});

test('blocksToText / parseBookText', () => {
  const blocks = [
    { type: 'heading', level: 1, text: 'บทนำ' },
    { type: 'heading', level: 2, text: 'ความเป็นมา' },
    { type: 'para', text: 'เนื้อหา' },
  ];
  const text = blocksToText(blocks);
  assert.equal(text, '# บทนำ\n\n## ความเป็นมา\n\nเนื้อหา');
  assert.deepEqual(parseBookText(text), blocks);
});

test('reflowRows: บรรทัดเนื้อหาที่กรอบสูงผิดปกติแต่ยาวเต็มบรรทัด ไม่นับเป็นหัวข้อ', () => {
  const r = reflowRows(
    [
      row('เมื่อสิ้นงวดบัญชี กิจการต้องผ่านรายการจากสมุดรายวัน', 0.16, 0.2, 0.9, 0.034),
      row('ไปยังบัญชีแยกประเภท แล้วจัดทำงบทดลองเพื่อตรวจสอบความ', 0.1, 0.243, 0.9, 0.026),
      row('ถูกต้องของยอดคงเหลือ', 0.1, 0.28, 0.4, 0.023),
    ],
    { aspect: 0.7 },
  );
  assert.deepEqual(r.blocks.map((b) => b.type), ['para']);
  assert.equal(r.blocks[0].text, 'เมื่อสิ้นงวดบัญชี กิจการต้องผ่านรายการจากสมุดรายวันไปยังบัญชีแยกประเภท แล้วจัดทำงบทดลองเพื่อตรวจสอบความถูกต้องของยอดคงเหลือ');
});

test('reflowRows: หัวข้อที่ไม่มีสระบน/ล่าง (กรอบเตี้ย) ยังตรวจได้จากความกว้างตัวอักษร', () => {
  // ค่าจริงจาก OpenThai (หน้า 900x1270): หัวข้อ "งบทดลอง" กรอบสูง 36px แต่บรรทัดเนื้อหาสูง 30–43px
  const px = (text, x0, y0, x1, h) => ({ text, x0: x0 / 900, y0: y0 / 1270, x1: x1 / 900, y1: (y0 + h) / 1270 });
  const r = reflowRows(
    [
      px('งบทดลอง', 91, 170, 279, 36.3),
      px('เมื่อสิ้นงวดบัญชี กิจการต้องผ่านรายการจากสมุดรายวัน', 145, 257, 814, 42.7),
      px('ไปยังบัญชีแยกประเภท แล้วจัดทำงบทดลองเพื่อตรวจสอบความ', 88, 308, 813, 32.8),
      px('ถูกต้องของยอดคงเหลือ', 89, 357, 358, 29.7),
    ],
    { aspect: 900 / 1270 },
  );
  assert.deepEqual(r.blocks.map((b) => [b.type, b.level]), [['heading', 2], ['para', undefined]]);
  assert.equal(r.blocks[0].text, 'งบทดลอง');
});

test('reflowRows: ตัดเศษสระที่ OCR แยกเป็นบรรทัด และหัวกระดาษที่อ่านเพี้ยนเล็กน้อย', () => {
  const others = edgeKeys([row('unit 1 การบัญชีเบื้องต้น', 0.3, 0.03, 0.7)]);
  const r = reflowRows(
    [
      row('บทที่ 1 การบัญชีเบื้องต้น', 0.3, 0.03, 0.7),
      row('การบันทึกบัญชีเป็นขั้นตอนแรกของวงจร', 0.15, 0.17, 0.9),
      row('wv Sd a qo a a a ะ o°', 0.1, 0.197, 0.85, 0.008),
      row('วันที่ที่เกิดรายการ', 0.1, 0.2, 0.45),
    ],
    { aspect: 0.7, otherEdges: others },
  );
  assert.deepEqual(r.blocks, [{ type: 'para', text: 'การบันทึกบัญชีเป็นขั้นตอนแรกของวงจรวันที่ที่เกิดรายการ' }]);
});

test('reflowRows: ภาพเอียงแบบเปอร์สเปกทีฟ (บรรทัดล่างแคบลง) ไม่ตัดย่อหน้าผิด', () => {
  // ย่อหน้าเดียว 12 บรรทัด ขอบซ้าย/ขวาค่อย ๆ หดเข้าจากบนลงล่าง บรรทัดสุดท้ายสั้น
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const shrink = i * 0.008;
    const x0 = 0.05 + shrink + (i === 0 ? 0.05 : 0);
    const x1 = i === 11 ? 0.5 : 0.95 - shrink;
    rows.push(row(`บรรทัดที่${i + 1}ของย่อหน้า`, x0, 0.1 + i * 0.035, x1));
  }
  const r = reflowRows(rows, { aspect: 0.7 });
  assert.equal(r.blocks.length, 1, JSON.stringify(r.blocks.map((b) => b.text.slice(0, 20))));
  assert.ok(r.blocks[0].text.endsWith('บรรทัดที่12ของย่อหน้า'));
  assert.equal(r.endsOpen, false);
});
