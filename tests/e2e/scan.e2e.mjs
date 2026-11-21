// ทดสอบทั้งระบบในเบราว์เซอร์จริง (Chromium + กล้องจำลอง)
// ต้องมี: Playwright (npx playwright install chromium), ffmpeg และคำสั่ง unzip
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
