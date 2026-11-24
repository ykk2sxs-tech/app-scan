// ทดสอบทั้งระบบในเบราว์เซอร์จริง (Chromium + กล้องจำลอง)
// ต้องมี: Playwright (npx playwright install chromium), ffmpeg, unzip และ pdftotext (poppler-utils)
// รัน: npm run test:e2e   (ตั้ง SCREENSHOT_DIR=โฟลเดอร์ เพื่อเก็บภาพหน้าจอ)

import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = mkdtempSync(join(tmpdir(), 'thai-ocr-e2e-'));
const shots = process.env.SCREENSHOT_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const PORT = 8099;
const BASE = `http://localhost:${PORT}/`;

const BOOK = {
  p1: 'การบันทึกบัญชีเป็นขั้นตอนแรกของวงจรบัญชี กิจการต้องบันทึกรายการค้าทุกรายการลงในสมุดรายวันทั่วไปตามลำดับวันที่ที่เกิดรายการ โดยระบุชื่อบัญชีที่เดบิตและเครดิต พร้อมคำอธิบายรายการอย่างย่อ',
  p2: 'หลักการบัญชีคู่กำหนดให้ทุกรายการค้าต้องบันทึกด้านเดบิตและด้านเครดิตด้วยจำนวนเงินที่เท่ากันเสมอ เช่น ซื้อวัสดุสำนักงานเป็นเงินสด 1,500 บาท บันทึกเดบิตวัสดุสำนักงานและเครดิตเงินสด',
  p3: 'เมื่อสิ้นงวดบัญชี กิจการต้องผ่านรายการจากสมุดรายวันไปยังบัญชีแยกประเภท แล้วจัดทำงบทดลองเพื่อตรวจสอบความถูกต้องของยอดคงเหลือ',
};

const DOCS = {
  receipt: [
    '<h1>ใบเสร็จรับเงิน / ใบกำกับภาษี</h1>',
    'บริษัท ตัวอย่าง จำกัด',
    'เลขประจำตัวผู้เสียภาษี 0105556012345',
    'วันที่ 21 พฤศจิกายน 2569',
    'รายการ: ค่าบริการทำบัญชีประจำเดือน',
    'จำนวนเงิน 15,000.00 บาท',
    'ภาษีมูลค่าเพิ่ม 7% 1,050.00 บาท',
    'รวมทั้งสิ้น 16,050.00 บาท',
  ],
  lease: [
    '<h1>สัญญาเช่าอาคารพาณิชย์</h1>',
    'เลขที่สัญญา 12/2569',
    'ผู้ให้เช่า บริษัท อาคารทดสอบ จำกัด',
    'ค่าเช่าเดือนละ 25,000.00 บาท',
    'หักภาษี ณ ที่จ่าย 5% 1,250.00 บาท',
    'ชำระภายในวันที่ 5 ของทุกเดือน',
  ],
};

async function renderFixtures(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const files = {};
  for (const [name, lines] of Object.entries(DOCS)) {
    await page.setContent(
      `<html><body style="margin:0;background:#9aa3ad;display:flex;justify-content:center;align-items:center;height:720px">
        <div style="background:#fff;width:1040px;padding:30px 50px;font:30px/1.55 Loma,'Noto Sans Thai',sans-serif;color:#111;box-shadow:0 4px 18px #0004">
          ${lines.map((l) => (l.startsWith('<') ? l.replace('<h1>', '<h1 style="font-size:40px;margin:0 0 6px">') : `<div>${l}</div>`)).join('')}
        </div></body></html>`,
    );
    files[name] = join(work, `${name}.png`);
    await page.screenshot({ path: files[name] });
  }
  await page.close();
  const y4m = (out, parts) => {
    const args = ['-y', '-loglevel', 'error'];
    for (const [png, sec] of parts) args.push('-loop', '1', '-t', String(sec), '-framerate', '5', '-i', png);
    const inputs = parts.map((_, i) => `[${i}:v]`).join('');
    args.push('-filter_complex', `${inputs}concat=n=${parts.length}:v=1,format=yuv420p[v]`, '-map', '[v]', '-r', '5', out);
    execFileSync('ffmpeg', args);
    return out;
  };
  // หน้าหนังสือ: หัวกระดาษซ้ำทุกหน้า หัวข้อตัวใหญ่ ย่อหน้าที่ตัดบรรทัด และเลขหน้า
  const book = await browser.newPage({ viewport: { width: 900, height: 1270 } });
  const bookPage = (num, title, paras) =>
    `<html><body style="margin:0"><div style="width:900px;height:1270px;box-sizing:border-box;padding:50px 90px;position:relative;font:27px/1.65 Loma,'Noto Sans Thai',sans-serif;color:#111;text-align:justify;background:#fff">
      <div style="font-size:21px;color:#444;text-align:center">บทที่ 1 การบัญชีเบื้องต้น</div>
      <div style="font-size:46px;font-weight:bold;margin:70px 0 30px">${title}</div>
      ${paras.map((t) => `<p style="text-indent:60px;margin:0 0 18px">${t}</p>`).join('')}
      <div style="position:absolute;bottom:40px;left:0;right:0;text-align:center;font-size:21px">${num}</div></div></body></html>`;
  await book.setContent(bookPage(12, 'การบันทึกบัญชี', [BOOK.p1, BOOK.p2]));
  files.book12 = join(work, 'book12.png');
  await book.screenshot({ path: files.book12 });
  await book.setContent(bookPage(13, 'งบทดลอง', [BOOK.p3]));
  files.book13 = join(work, 'book13.png');
  await book.screenshot({ path: files.book13 });
  // หน้าเต็มที่ย่อหน้าท้ายเบลอ (เหมือนภาพถ่ายที่ส่วนล่างหลุดโฟกัส)
  await book.setContent(
    bookPage(14, 'การปิดบัญชี', [BOOK.p1, BOOK.p2, BOOK.p3, BOOK.p1]).replace(
      /<p style="text-indent:60px;margin:0 0 18px">([^<]*)<\/p>(?![\s\S]*<p )/,
      '<p style="text-indent:60px;margin:0 0 18px;filter:blur(4px);opacity:.75">$1</p>',
    ),
  );
  files.blurBottom = join(work, 'blur-bottom.png');
  await book.screenshot({ path: files.blurBottom });
  await book.close();

  files.photoY4m = y4m(join(work, 'photo.y4m'), [[files.receipt, 2]]);
  files.videoY4m = y4m(join(work, 'video.y4m'), [
    [files.receipt, 6],
    [files.lease, 40], // ยาวกว่าเวลาอัด เพื่อไม่ให้วิดีโอวนกลับไปหน้าแรก
  ]);
  return files;
}

function startServer() {
  const proc = spawn(process.execPath, [join(root, 'scripts', 'serve.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve) => proc.stdout.once('data', () => resolve(proc)));
}

async function openApp(videoFile) {
  const browser = await chromium.launch({
    // ต้องเป็น locale UTF-8 ไม่อย่างนั้น Chromium จะไม่ยอมตั้งชื่อไฟล์ดาวน์โหลดเป็นภาษาไทย
    env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${videoFile}`,
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    acceptDownloads: true,
    permissions: ['camera'],
    locale: 'th-TH',
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('console:', m.text()));
  await page.goto(BASE);
  await page.waitForFunction(() => document.querySelector('#preview').videoWidth > 0, null, { timeout: 15000 });
  return { browser, page };
}

async function waitForOcr(page, timeout = 180000) {
  await page.click('.tabbar [data-tab="pages"]');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.page-item').length > 0 &&
      !document.querySelector('.st-pending, .st-processing') &&
      document.querySelector('#activity').hidden,
    null,
    { timeout },
  );
  return page.$$eval('.page-item', (items) =>
    items.map((li) => ({
      text: li.querySelector('.pi-text').textContent,
      head: li.querySelector('.pi-head').textContent.replace(/\s+/g, ' ').trim(),
    })),
  );
}

const shot = (page, name) => shots && page.screenshot({ path: join(shots, `${name}.png`) });

async function testPhoto(files) {
  const { browser, page } = await openApp(files.photoY4m);
  await shot(page, '1-scan-photo');
  await page.click('#btn-shutter');
  const pages = await waitForOcr(page);
  await shot(page, '2-pages');
  assert.equal(pages.length, 1);
  for (const expected of ['ใบกำกับภาษี', 'บริษัท ตัวอย่าง จำกัด', '0105556012345', '16,050.00']) {
    assert.ok(pages[0].text.includes(expected), `ไม่พบ "${expected}" ใน: ${pages[0].text}`);
  }
  assert.ok(!pages[0].text.includes('ํา'), 'ยังมี "ํา" ที่ไม่ได้แก้เป็น "ำ"');
  assert.ok(!/ตรวจ \d+ จุด/.test(pages[0].head), `ภาพชัดไม่ควรถูกเตือนว่าข้อความไม่ครบ: ${pages[0].head}`);

  // เปิดหน้าแก้ไข แก้ข้อความ แล้วส่งออก Word
  await page.click('.page-item [data-act="open"]');
  await page.waitForSelector('#editor[open]');
  assert.match(await page.textContent('#ed-status'), /OpenThai/, 'ค่าเริ่มต้นควรอ่านด้วย OpenThai');
  await shot(page, '3-editor');
  await page.fill('#ed-text', `${await page.inputValue('#ed-text')}\nหมายเหตุ: ตรวจสอบแล้ว`);
  await page.click('#ed-close');

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-word')]);
  const docxPath = join(work, download.suggestedFilename());
  await download.saveAs(docxPath);
  assert.match(download.suggestedFilename(), /\.docx$/);
  const xml = execFileSync('unzip', ['-p', docxPath, 'word/document.xml'], { encoding: 'utf8' });
  const styles = execFileSync('unzip', ['-p', docxPath, 'word/styles.xml'], { encoding: 'utf8' });
  for (const expected of ['ใบกำกับภาษี', '16,050.00', 'หมายเหตุ: ตรวจสอบแล้ว', 'หน้าที่ 1']) {
    assert.ok(xml.includes(expected), `ไฟล์ Word ไม่มี "${expected}"`);
  }
  assert.ok(xml.includes('<pic:pic'), 'ไฟล์ Word ไม่มีภาพ');
  assert.ok(/w:cs="TH Sarabun New"/.test(styles), 'ไม่ได้ตั้งฟอนต์ complex script');
  assert.ok(/w:bidi="th-TH"/.test(styles), 'ไม่ได้ตั้งภาษาไทย');
  console.log(`✔ โหมดถ่ายรูป + ส่งออก Word (${download.suggestedFilename()})`);

  // reload แล้วข้อมูลต้องยังอยู่
  await page.reload();
  await page.click('.tabbar [data-tab="pages"]');
  await page.waitForSelector('.page-item');
  assert.ok((await page.textContent('.pi-text')).includes('หมายเหตุ: ตรวจสอบแล้ว'), 'ข้อมูลหายหลังรีโหลด');
  console.log('✔ ข้อมูลยังอยู่หลังรีโหลดหน้า');

  // นำเข้าไฟล์ภาพ
  await page.click('.tabbar [data-tab="scan"]');
  await page.setInputFiles('#file-input', files.lease);
  const after = await waitForOcr(page);
  assert.equal(after.length, 2);
  assert.ok(after[1].text.includes('สัญญาเช่าอาคารพาณิชย์'), after[1].text);
  assert.ok(after[1].text.includes('25,000.00'), after[1].text);
  console.log('✔ นำเข้าไฟล์ภาพ (OpenThai)');

  // เปลี่ยนเป็น Tesseract แล้วสั่งอ่านหน้าที่ 2 ใหม่
  await page.click('.tabbar [data-tab="settings"]');
  await page.selectOption('[data-setting="ocrEngine"]', 'tesseract');
  await page.click('.tabbar [data-tab="pages"]');
  await page.click('.page-item:nth-child(2) [data-act="open"]');
  await page.click('#ed-tools [data-act="ocr"]');
  await page.waitForFunction(() => /Tesseract/.test(document.querySelector('#ed-status').textContent), null, { timeout: 120000 });
  const tessText = await page.inputValue('#ed-text');
  assert.ok(tessText.includes('สัญญาเช่าอาคารพาณิชย์') && tessText.includes('25,000.00'), tessText);
  await page.click('#ed-close');
  console.log('✔ อ่านด้วย Tesseract (ตัวสำรอง)');
  await browser.close();
  return docxPath;
}

async function testBook(files) {
  const { browser, page } = await openApp(files.photoY4m);
  await page.click('.tabbar [data-tab="pages"]');
  await page.check('.book-toggle input');
  await page.click('.tabbar [data-tab="scan"]');
  await page.setInputFiles('#file-input', [files.book12, files.book13]);
  await waitForOcr(page);
  const texts = [];
  for (let i = 0; i < 2; i++) {
    await page.click(`.page-item:nth-child(${i + 1}) [data-act="open"]`);
    texts.push(await page.inputValue('#ed-text'));
    await page.click('#ed-close');
  }
  await shot(page, '6-book-pages');
  assert.ok(!/ตรวจ \d+ จุด/.test(await page.textContent('#page-list')), 'หน้าหนังสือที่ชัดไม่ควรถูกเตือน');
  const [t12, t13] = texts;
  assert.match(t12, /^#{1,2} การบันทึกบัญชี$/m, t12);
  assert.ok(t12.includes(BOOK.p1), `ย่อหน้าแรกไม่ถูกรวมเป็นบรรทัดเดียว:\n${t12}`);
  assert.ok(t12.includes(BOOK.p2), `ย่อหน้าที่สองไม่ถูกรวม:\n${t12}`);
  assert.ok(!t12.includes('บทที่ 1') && !/^12$/m.test(t12), `ยังมีหัวกระดาษ/เลขหน้า:\n${t12}`);
  assert.match(t13, /^#{1,2} งบทดลอง$/m, `หัวข้อ "งบทดลอง" หาย (ต้องอ่านซ้ำด้วย Tesseract):\n${t13}`);
  assert.ok(t13.includes(BOOK.p3), t13);
  console.log('✔ โหมดหนังสือ: รวมย่อหน้า แยกหัวข้อ ตัดหัวกระดาษ/เลขหน้า');

  const [dw] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-word')]);
  const docx = join(work, 'book.docx');
  await dw.saveAs(docx);
  const xml = execFileSync('unzip', ['-p', docx, 'word/document.xml'], { encoding: 'utf8' });
  assert.ok(/<w:pStyle w:val="Heading[12]"\/>.*?การบันทึกบัญชี/.test(xml), 'Word: หัวข้อไม่ได้เป็น Heading');
  assert.ok(xml.includes(BOOK.p1), 'Word: ย่อหน้าไม่ครบ');
  assert.ok(!xml.includes('<pic:pic'), 'Word โหมดหนังสือไม่ควรแนบภาพ');

  const [dp] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-pdf')]);
  const pdf = join(work, 'book.pdf');
  await dp.saveAs(pdf);
  assert.match(dp.suggestedFilename(), /\.pdf$/);
  const pdfText = execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8' }).replace(/\s+/g, '');
  for (const expected of ['การบันทึกบัญชี', 'ซื้อวัสดุสำนักงานเป็นเงินสด1,500บาท', 'งบทดลอง', 'ถูกต้องของยอดคงเหลือ']) {
    assert.ok(pdfText.includes(expected), `PDF ค้นหา "${expected}" ไม่เจอ`);
  }
  assert.ok(!pdfText.includes('ำา'), 'PDF: สระอำถูกแยกเป็น ำา');
  const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
  assert.match(info, /Pages:\s+2/);
  console.log('✔ ส่งออก Word (หัวข้อ/ย่อหน้า) และ PDF ที่ค้นหาข้อความภาษาไทยได้');
  await browser.close();
}

async function testUnreadBottom(files) {
  const { browser, page } = await openApp(files.photoY4m);
  await page.setInputFiles('#file-input', [files.blurBottom]);
  await waitForOcr(page);
  const chip = await page.textContent('.page-item .pi-head');
  assert.match(chip, /ตรวจ \d+ จุด/, `ไม่เตือนว่าข้อความท้ายหน้าอาจไม่ครบ: ${chip}`);
  await page.click('.page-item [data-act="open"]');
  await page.waitForSelector('#ed-flag-note:not([hidden])');
  assert.ok((await page.$$('#ed-flags .flag')).length > 0, 'ไม่มีกรอบบอกตำแหน่งบนภาพ');
  const [sh, ch] = await page.$eval('#ed-text', (t) => [t.scrollHeight, t.clientHeight]);
  assert.ok(ch >= sh - 4, `ช่องข้อความไม่ยืดตามความยาว (${ch} < ${sh}) ข้อความท้ายหน้าจะซ่อนอยู่`);
  await shot(page, '7-unread-bottom');
  console.log('✔ ภาพท้ายหน้าเบลอ: เตือนและตีกรอบตำแหน่งที่อ่านไม่ได้, ช่องข้อความแสดงครบทั้งหน้า');
  await browser.close();
}

async function testVideo(files) {
  const { browser, page } = await openApp(files.videoY4m);
  await page.click('.mode-switch [data-mode="video"]');
  await page.click('#btn-shutter');
  await page.waitForTimeout(1500);
  await shot(page, '4-recording');
  await page.waitForTimeout(10500);
  await page.click('#btn-shutter');
  await page.waitForSelector('#btn-save-video:not([hidden])', { timeout: 10000 });
  const pages = await waitForOcr(page);
  await shot(page, '5-video-pages');
  const texts = pages.map((p) => p.text);
  assert.ok(texts.some((t) => t.includes('ใบกำกับภาษี')), `ไม่พบหน้าใบเสร็จ: ${JSON.stringify(pages)}`);
  assert.ok(texts.some((t) => t.includes('สัญญาเช่า')), `ไม่พบหน้าสัญญาเช่า: ${JSON.stringify(pages)}`);
  assert.equal(pages.length, 2, `ควรเหลือ 2 หน้าหลังตัดเฟรมซ้ำ: ${JSON.stringify(pages.map((p) => p.head))}`);

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.tabbar [data-tab="scan"]').then(() => page.click('#btn-save-video'))]);
  assert.match(download.suggestedFilename(), /\.(webm|mp4)$/);
  console.log(`✔ โหมดวิดีโอ: ได้ ${pages.length} หน้า (ตัดเฟรมซ้ำแล้ว) + ดาวน์โหลดวิดีโอ ${download.suggestedFilename()}`);
  await browser.close();
}

const server = await startServer();
let exitCode = 0;
try {
  const b = await chromium.launch();
  const files = await renderFixtures(b);
  await b.close();
  const docx = await testPhoto(files);
  await testBook(files);
  await testUnreadBottom(files);
  await testVideo(files);
  writeFileSync(join(work, 'done'), docx);
  console.log(`\nผ่านทั้งหมด — ไฟล์ทดสอบอยู่ที่ ${work}`);
} catch (err) {
  console.error('✘', err);
  exitCode = 1;
} finally {
  server.kill();
}
process.exit(exitCode);
