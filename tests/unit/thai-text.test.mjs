import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fixThaiCharacters,
  fixThaiSpacing,
  removeSpacesBetweenThai,
  fixNumbers,
  thaiDigitsToArabic,
  tidyLines,
  cleanOcrText,
  textSimilarity,
  ocrQuality,
} from '../../public/js/thai-text.js';

test('แก้ "ํา" เป็น "ำ" (ผลจริงจาก Tesseract)', () => {
  assert.equal(fixThaiCharacters('ใบกํากับภาษี บริษัท ตัวอย่าง จํากัด'), 'ใบกำกับภาษี บริษัท ตัวอย่าง จำกัด');
  assert.equal(fixThaiCharacters('นํ้า'), 'น้ำ');
});

test('แก้ "เเ" เป็น "แ" และลำดับวรรณยุกต์', () => {
  assert.equal(fixThaiCharacters('เเบบฟอร์ม'), 'แบบฟอร์ม');
  assert.equal(fixThaiCharacters('ท่ี'), 'ที่');
  assert.equal(fixThaiCharacters('ก้้าว'), 'ก้าว');
});

test('ลบช่องว่างที่ผิดตำแหน่งแน่นอน แต่คงช่องว่างระหว่างคำไว้', () => {
  assert.equal(fixThaiSpacing('บริษั ท ตัวอย่าง'), 'บริษัท ตัวอย่าง');
  assert.equal(fixThaiSpacing('ภาษีมูลค่าเพิ ่ม'), 'ภาษีมูลค่าเพิ่ม');
  assert.equal(fixThaiSpacing('เ งิน'), 'เงิน');
  assert.equal(fixThaiSpacing('รวม 7 %'), 'รวม 7 %');
});

test('ลบช่องว่างระหว่างอักษรไทยทั้งหมด (ตัวเลือก)', () => {
  assert.equal(removeSpacesBetweenThai('ค่า บริการ ทำ บัญชี 500 บาท'), 'ค่าบริการทำบัญชี 500 บาท');
});

test('จัดรูปแบบตัวเลข/จำนวนเงิน', () => {
  assert.equal(fixNumbers('16, 050 . 00 บาท'), '16,050.00 บาท');
  assert.equal(fixNumbers('เลขที่ 0105556012345'), 'เลขที่ 0105556012345');
});

test('แปลงเลขไทยเป็นอารบิก', () => {
  assert.equal(thaiDigitsToArabic('๒๑ พ.ย. ๒๕๖๙'), '21 พ.ย. 2569');
});

test('จัดบรรทัด', () => {
  assert.equal(tidyLines('  ก  ข \n\n\n\nค  '), 'ก ข\n\nค');
  assert.equal(tidyLines('ก\n\nข', { removeBlankLines: true }), 'ก\nข');
});

test('cleanOcrText กับผลจริงจาก Tesseract', () => {
  const raw =
    'ใบเสร็จรับเงิน / ใบกํากับภาษี\n\nบริษัท ตัวอย่าง จํากัด\n\nเลขประจําตัวผู้เสียภาษี 0105556012345\n' +
    'จํานวนเงิน 15,000.00 บาท\n\nรวมทั้งสิ้น 16, 050.00 บาท\n';
  assert.equal(
    cleanOcrText(raw),
    'ใบเสร็จรับเงิน / ใบกำกับภาษี\n\nบริษัท ตัวอย่าง จำกัด\n\nเลขประจำตัวผู้เสียภาษี 0105556012345\n' +
      'จำนวนเงิน 15,000.00 บาท\n\nรวมทั้งสิ้น 16,050.00 บาท',
  );
  assert.equal(cleanOcrText(raw, { fixThai: false, fixNumbers: false }).includes('ใบกํากับ'), true);
});

test('textSimilarity ใช้ตัดเฟรมซ้ำ', () => {
  const a = 'ใบเสร็จรับเงิน รวมทั้งสิ้น 16,050.00 บาท';
  assert.equal(textSimilarity(a, a), 1);
  assert.ok(textSimilarity(a, 'ใบเสร็จรับเงิน รวมทั้งสิ้น 16,O50.00 บาห') > 0.8);
  assert.ok(textSimilarity(a, 'สัญญาเช่าอาคารพาณิชย์ เลขที่ 12/2569') < 0.3);
  assert.equal(textSimilarity('', ''), 1);
  assert.equal(textSimilarity('abc', ''), 0);
});

test('ocrQuality', () => {
  assert.ok(ocrQuality('ข้อความยาวกว่า', 90) > ocrQuality('สั้น', 90));
  assert.equal(ocrQuality('', 90), 0);
});
