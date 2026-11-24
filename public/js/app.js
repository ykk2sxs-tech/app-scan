// ควบคุมหน้าจอหลักของแอปสแกนเอกสาร

import { Camera } from './camera.js';
import { VideoRecorder, extractFramesFromFile } from './video-scan.js';
import { recognize, getWorker } from './ocr.js';
import { recognizeOpenThai, getOpenThai, rowsFromLines, rowsToText } from './openthai.js';
import { cleanOcrText, textSimilarity, ocrQuality, looksLikeText } from './thai-text.js';
import {
  normalizeImageBlob,
  rotateBlob,
  cropBlob,
  prepareForOcr,
  loadBitmap,
  toCanvas,
  canvasToBlob,
  imageSize,
  findGutter,
  splitSpread,
  findUnreadRegions,
} from './image-tools.js';
import { reflowRows, blocksToText, edgeKeys } from './book.js';
import { buildSearchablePdf } from './pdf-export.js';
import { pageStore, loadSettings, saveSettings, DEFAULT_SETTINGS } from './store.js';
import { buildWordDocument, buildPlainText, loadDocx, SOURCE_LABEL } from './word-export.js';
import {
  uid,
  formatDuration,
  thaiDateTime,
  fileStamp,
  safeFileName,
  downloadBlob,
  shareFile,
  canShareFiles,
} from './util.js';
import { VENDOR } from '../vendor/paths.js';

const APP_VERSION = '1.3.0';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';
const SPREAD_ASPECT = 1.2; // ภาพกว้าง/สูง ตั้งแต่นี้ขึ้นไปถือว่าเป็นหนังสือกาง 2 หน้า
// ตั้งค่าที่มีผลกับข้อความ — เปลี่ยนแล้วจัดข้อความของหน้าที่ยังไม่ได้แก้ไขใหม่ทันที (ไม่ต้อง OCR ใหม่)
const TEXT_SETTINGS = ['fixThai', 'fixNumbers', 'thaiDigits', 'removeThaiSpaces', 'removeBlankLines', 'bookMode'];
const MIN_VIDEO_TEXT = 3; // เฟรมวิดีโอที่มีตัวอักษรน้อยกว่านี้ถือว่าไม่มีข้อความ
const MIN_RETRY_TEXT = 10; // อ่านได้น้อยกว่านี้ จะลองปรับภาพอีกแบบแล้วอ่านใหม่
const countChars = (text) => String(text || '').replace(/\s+/g, '').length;
const ENGINE_LABEL = { openthai: 'OpenThai', tesseract: 'Tesseract' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  settings: loadSettings(),
  pages: [],
  tab: 'scan',
  mode: 'photo',
  recorder: null,
  capturing: null, // Promise ระหว่างถ่ายภาพ
  importing: false,
  queueRunning: false,
  dropped: 0,
  editingId: null,
  lastVideo: null,
  wakeLock: null,
};

const camera = new Camera($('#preview'));
const objectUrls = new Map();

// ---------------------------------------------------------------- utilities

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function blobUrl(key, blob) {
  if (!blob) return '';
  const cached = objectUrls.get(key);
  if (cached?.blob === blob) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(blob);
  objectUrls.set(key, { blob, url });
  return url;
}

function releaseUrls(id) {
  for (const key of [`${id}:thumb`, `${id}:image`]) {
    const c = objectUrls.get(key);
    if (c) URL.revokeObjectURL(c.url);
    objectUrls.delete(key);
  }
}

let toastTimer;
function toast(message, type = '') {
  const el = $('#toast');
  const editor = $('#editor');
  // dialog อยู่ชั้นบนสุด ต้องย้าย toast เข้าไปถึงจะมองเห็น
  const host = editor.open ? editor : document.body;
  if (el.parentElement !== host) host.appendChild(el);
  el.textContent = message;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), type === 'error' ? 5000 : 3000);
}

const activities = new Map();
function setActivity(key, text, progress) {
  if (text == null) activities.delete(key);
  else activities.set(key, { text, progress });
  const current = activities.get('import') || activities.get('ocr');
  $('#activity').hidden = !current;
  if (current) {
    $('#activity-text').textContent = current.text;
    $('#activity-bar').style.width = `${Math.round((current.progress || 0) * 100)}%`;
  }
}

const nextOrder = () => state.pages.reduce((m, p) => Math.max(m, p.order), 0) + 1;
const pageIndex = (page) => state.pages.indexOf(page) + 1;
const findPage = (id) => state.pages.find((p) => p.id === id);

async function makeThumb(blob) {
  const bmp = await loadBitmap(blob);
  const c = toCanvas(bmp, 240);
  bmp.close?.();
  return canvasToBlob(c, 'image/jpeg', 0.75);
}

async function savePage(page) {
  try {
    await pageStore.put(page);
  } catch (err) {
    toast(`บันทึกข้อมูลไม่สำเร็จ: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------- tabs

async function showTab(tab) {
  // หยุดอัดให้เสร็จก่อนปิดกล้อง ไม่อย่างนั้นไฟล์วิดีโออาจไม่สมบูรณ์
  if (state.recorder && tab !== 'scan') await stopRecording();
  state.tab = tab;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));
  $$('.tabbar button').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.body.classList.toggle('scan-mode', tab === 'scan');
  if (tab === 'scan') startCamera();
  else stopCameraWhenIdle();
  if (tab === 'pages') renderPages();
  if (tab === 'settings') renderStorageInfo();
}

// ---------------------------------------------------------------- camera

function showCameraMessage(text) {
  $('#camera-msg').hidden = !text;
  $('#camera-msg-text').textContent = text || '';
}

/** ปิดกล้อง — ถ้ากำลังถ่ายภาพอยู่ ให้ถ่ายเสร็จก่อน (ไม่ให้ภาพหาย) */
function stopCameraWhenIdle() {
  const stop = () => {
    if (state.tab !== 'scan' || document.hidden) camera.stop();
  };
  if (state.capturing) state.capturing.finally(stop);
  else stop();
}

async function startCamera() {
  if (camera.active || state.tab !== 'scan' || document.hidden) return;
  showCameraMessage(null);
  try {
    await camera.start({ resolution: state.settings.resolution });
    if (state.tab !== 'scan' || document.hidden) {
      camera.stop();
      return;
    }
    const torch = $('#btn-torch');
    torch.hidden = !camera.hasTorch;
    torch.setAttribute('aria-pressed', 'false');
  } catch (err) {
    showCameraMessage(err.message);
  }
}

function setMode(mode) {
  if (state.recorder) return;
  state.mode = mode;
  $$('.mode-switch button').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  const shutter = $('#btn-shutter');
  shutter.classList.toggle('video', mode === 'video');
  shutter.setAttribute('aria-label', mode === 'video' ? 'เริ่มอัดวิดีโอ' : 'ถ่ายภาพ');
  const input = $('#file-input');
  input.accept = mode === 'video' ? 'video/*' : 'image/*';
  input.multiple = mode !== 'video';
  $('#import-label').textContent = mode === 'video' ? 'นำเข้าวิดีโอ' : 'นำเข้ารูป';
  $('#mode-hint').textContent =
    mode === 'video'
      ? `กดอัดแล้วค่อย ๆ เลื่อนกล้องผ่านเอกสารทีละหน้า ระบบจะเก็บภาพที่คมที่สุดทุก ${state.settings.videoInterval} วินาที`
      : 'วางเอกสารให้อยู่ในกรอบ ถือให้นิ่ง แล้วกดถ่าย';
}

function capturePhoto() {
  if (state.capturing || !camera.active) return;
  $('#btn-shutter').disabled = true;
  const flash = $('#flash');
  flash.classList.remove('go');
  void flash.offsetWidth;
  flash.classList.add('go');
  navigator.vibrate?.(25);
  state.capturing = (async () => {
    try {
      const blob = await camera.takePhoto({ highRes: state.settings.highResPhoto });
      const page = await addImagePage(blob, 'photo');
      toast(`เพิ่มหน้าที่ ${pageIndex(page)} แล้ว — กำลังอ่านข้อความ`, 'ok');
    } catch (err) {
      toast(`ถ่ายภาพไม่สำเร็จ: ${err.message}`, 'error');
    } finally {
      state.capturing = null;
      $('#btn-shutter').disabled = false;
    }
  })();
}

async function startRecording() {
  if (!camera.active) return;
  const s = state.settings;
  const groupId = uid();
  const recorder = new VideoRecorder(camera, {
    intervalSec: Number(s.videoInterval) || 2,
    keepVideo: s.keepVideo,
    onFrame: ({ blob, time }) =>
      addImagePage(blob, 'video', { groupId, time, detail: `เฟรม ${formatDuration(time)}` }).catch((err) =>
        toast(err.message, 'error'),
      ),
    onTick: (t, count, full) => {
      $('#rec-time').textContent = formatDuration(t);
      $('#rec-frames').textContent = String(count);
      if (full) {
        toast('เก็บเฟรมครบจำนวนสูงสุดแล้ว — หยุดอัดอัตโนมัติ');
        stopRecording();
      }
    },
  });
  try {
    recorder.start();
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  state.recorder = recorder;
  navigator.vibrate?.(40);
  $('#btn-shutter').classList.add('recording');
  $('#btn-shutter').setAttribute('aria-label', 'หยุดอัดวิดีโอ');
  $('#rec-indicator').hidden = false;
  $('#btn-switch').hidden = true;
  $('#btn-save-video').hidden = true;
  $('.mode-switch').classList.add('locked');
  $('#mode-hint').textContent = 'กำลังอัด… เลื่อนกล้องช้า ๆ ทีละหน้า กดปุ่มอีกครั้งเพื่อหยุด';
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* ไม่รองรับ */
  }
}

async function stopRecording() {
  const recorder = state.recorder;
  if (!recorder) return;
  state.recorder = null;
  $('#btn-shutter').classList.remove('recording');
  $('#btn-shutter').setAttribute('aria-label', 'เริ่มอัดวิดีโอ');
  $('#rec-indicator').hidden = true;
  $('#btn-switch').hidden = false;
  $('.mode-switch').classList.remove('locked');
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
  setMode('video');
  const result = await recorder.stop();
  if (!result) return;
  toast(
    result.frameCount
      ? `อัดวิดีโอ ${formatDuration(result.durationMs)} ได้ ${result.frameCount} เฟรม — กำลังอ่านข้อความ`
      : 'ไม่ได้เฟรมจากวิดีโอ ลองอัดให้นานขึ้นและถือกล้องให้นิ่ง',
    result.frameCount ? 'ok' : 'error',
  );
  if (result.videoBlob) {
    state.lastVideo = result.videoBlob;
    $('#btn-save-video').hidden = false;
  }
}

function saveLastVideo() {
  const blob = state.lastVideo;
  if (!blob) return;
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  downloadBlob(blob, `วิดีโอสแกน_${fileStamp()}.${ext}`);
}

// ---------------------------------------------------------------- import

async function importFiles(files) {
  const list = [...files];
  if (!list.length) return;
  for (const file of list) {
    if (file.type.startsWith('video/')) {
      await importVideo(file);
    } else if (file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|bmp|gif)$/i.test(file.name)) {
      try {
        await addImagePage(file, 'upload', { detail: file.name });
      } catch (err) {
        toast(`เปิดไฟล์ ${file.name} ไม่ได้: ${err.message}`, 'error');
      }
    } else {
      toast(`ไม่รองรับไฟล์ ${file.name}`, 'error');
    }
  }
  if (list.length > 1 || !list[0].type.startsWith('video/')) {
    toast(`นำเข้า ${list.length} ไฟล์แล้ว — กำลังอ่านข้อความ`, 'ok');
  }
}

async function importVideo(file) {
  if (state.importing) return toast('กำลังนำเข้าวิดีโออื่นอยู่ กรุณารอสักครู่');
  state.importing = true;
  const groupId = uid();
  setActivity('import', `กำลังดึงภาพจากวิดีโอ ${file.name}`, 0);
  try {
    const { frameCount } = await extractFramesFromFile(file, {
      intervalSec: Number(state.settings.videoInterval) || 2,
      onFrame: ({ blob, time }) => addImagePage(blob, 'video-file', { groupId, time, detail: formatDuration(time) }),
      onProgress: (p) => setActivity('import', `กำลังดึงภาพจากวิดีโอ ${Math.round(p * 100)}%`, p),
    });
    toast(`ดึงภาพจากวิดีโอได้ ${frameCount} เฟรม — กำลังอ่านข้อความ`, 'ok');
  } catch (err) {
    toast(`นำเข้าวิดีโอไม่สำเร็จ: ${err.message}`, 'error');
  } finally {
    state.importing = false;
    setActivity('import', null);
  }
}

// ---------------------------------------------------------------- pages + OCR queue

async function addImagePage(blob, source, extra = {}) {
  const image = await normalizeImageBlob(blob, 2800, 0.9);
  const s = state.settings;
  if (s.bookMode && s.splitSpreads) {
    const { width, height } = await imageSize(image);
    if (width / height >= SPREAD_ASPECT) {
      // หนังสือกาง 2 หน้า → แยกเป็นหน้าซ้ายและขวา
      const [left, right] = await splitSpread(image);
      const detail = extra.detail ? `${extra.detail} ` : '';
      const first = await addSinglePage(left, source, { ...extra, side: 'L', detail: `${detail}(ซ้าย)` });
      await addSinglePage(right, source, { ...extra, side: 'R', detail: `${detail}(ขวา)` });
      return first;
    }
  }
  return addSinglePage(image, source, extra);
}

async function addSinglePage(image, source, extra = {}) {
  const thumb = await makeThumb(image);
  // คำนวณลำดับหลัง await ทั้งหมด เพื่อไม่ให้หน้าที่เพิ่มพร้อมกันได้ลำดับซ้ำ
  const page = {
    id: uid(),
    order: nextOrder(),
    createdAt: Date.now(),
    source,
    sourceDetail: extra.detail || '',
    groupId: extra.groupId || null,
    side: extra.side || null,
    image,
    original: null,
    layout: null,
    thumb,
    text: '',
    rawText: '',
    confidence: 0,
    status: 'pending',
    edited: false,
  };
  state.pages.push(page);
  await savePage(page);
  navigator.storage?.persist?.().catch(() => {});
  updateCounters();
  if (state.tab === 'pages') renderPages();
  processQueue();
  return page;
}

async function removePage(id) {
  const page = findPage(id);
  if (!page) return;
  state.pages = state.pages.filter((p) => p !== page);
  releaseUrls(id);
  await pageStore.delete(id).catch(() => {});
  updateCounters();
  if (state.tab === 'pages') renderPages();
}

async function processQueue() {
  if (state.queueRunning) return;
  state.queueRunning = true;
  try {
    for (;;) {
      const page = state.pages.find((p) => p.status === 'pending');
      if (!page) break;
      await ocrPage(page);
    }
  } finally {
    state.queueRunning = false;
    setActivity('ocr', null);
    if (state.dropped) {
      toast(`ตัดเฟรมวิดีโอที่ซ้ำ/ไม่มีข้อความออก ${state.dropped} เฟรม`);
      state.dropped = 0;
    }
  }
}

async function ocrPage(page) {
  const s = state.settings;
  const image = page.image;
  page.status = 'processing';
  refreshPage(page);
  const remaining = state.pages.filter((p) => p.status === 'pending').length;
  const label = `หน้าที่ ${pageIndex(page)}${remaining ? ` (รออีก ${remaining})` : ''}`;
  setActivity('ocr', `กำลังเตรียมภาพ ${label}`, 0);
  try {
    const result = await readPageText(page, image, label);
    if (!state.pages.includes(page)) return; // ถูกลบระหว่างอ่าน
    if (page.image !== image) {
      page.status = 'pending'; // ภาพถูกแก้ระหว่างอ่าน → อ่านใหม่
      return;
    }
    page.rawText = result.text;
    page.layout = result.layout || null;
    page.confidence = result.confidence;
    page.engine = result.engine;
    page.status = 'done';
    page.edited = false;
    page.error = '';
    page.flags = []; // บรรทัดที่อ่านไม่ชัด/อ่านไม่ได้ (ตีกรอบให้ตรวจในหน้าแก้ไข)
    // OpenThai พบว่าภาพตะแคง/กลับหัว → หมุนภาพที่เก็บไว้ให้ตั้งตรง (ข้อความอ่านจากภาพที่ตั้งตรงแล้ว)
    if (result.rotation) {
      if (!page.original) page.original = page.image;
      page.image = await rotateBlob(image, result.rotation);
      page.thumb = await makeThumb(page.image);
    }
    if (result.engine === 'openthai' && result.layout?.dropped?.length) {
      await rescueDroppedLines(page, result.layout);
    }
    // บริเวณที่มีตัวอักษรแต่ OCR ไม่เห็นเป็นบรรทัดเลย (มักเป็นท้ายหน้าที่เบลอ/มืด) → ตีกรอบเตือน
    if (page.layout?.lines?.length) {
      try {
        for (const r of await findUnreadRegions(page.image, page.layout.lines)) page.flags.push({ kind: 'missing', ...r });
      } catch (err) {
        console.warn('findUnreadRegions:', err);
      }
    }
    page.text = composeText(page);
    await savePage(page);
    if (page.flags.some((f) => f.kind !== 'uncertain')) {
      toast(`หน้าที่ ${pageIndex(page)}: ข้อความอาจไม่ครบ (บางส่วนของภาพไม่ชัด) — เปิดดูกรอบที่ต้องตรวจในแท็บเอกสาร`, 'error');
    }
    // โหมดหนังสือ: หัวกระดาษที่ซ้ำกันจะรู้ได้เมื่อมีหลายหน้า → จัดข้อความหน้าอื่นใหม่ด้วย
    if (s.bookMode) await recomposeAll(page);
    if (page.groupId && s.dedupe) await dedupeVideoFrame(page);
  } catch (err) {
    console.error(err);
    if (!state.pages.includes(page)) return;
    page.status = 'error';
    page.error = err?.message || String(err);
    await savePage(page);
    toast(`อ่านข้อความไม่สำเร็จ: ${page.error}`, 'error');
  } finally {
    if (state.pages.includes(page)) refreshPage(page);
  }
}

/**
 * บรรทัดที่ OpenThai อ่านแล้วไม่มั่นใจจนตัดทิ้ง (มักเป็นหัวข้อตัวหนาขนาดใหญ่) → ให้ Tesseract อ่านซ้ำเฉพาะบรรทัดนั้น
 * ใช้เฉพาะกรอบที่ขนาดเท่าบรรทัดข้อความจริง (ไม่ใช่เศษเล็ก ๆ เช่นเลขหน้า/รอยเปื้อน)
 */
async function rescueDroppedLines(page, layout) {
  const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1] || 0;
  const H = median(layout.lines.map((l) => l.y1 - l.y0)) || 0.02;
  const candidates = layout.dropped
    .filter((d) => d.y1 - d.y0 >= 0.7 * H && (d.x1 - d.x0) * layout.aspect >= 1.5 * (d.y1 - d.y0))
    .slice(0, 30);
  if (!candidates.length) return;
  const bmp = await loadBitmap(page.image);
  const W = bmp.width;
  const Hh = bmp.height;
  let added = 0;
  const flag = (d, kind) => page.flags.push({ kind, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 });
  try {
    for (const d of candidates) {
      const pad = (d.y1 - d.y0) * 0.2;
      const sx = Math.max(0, (d.x0 - pad / layout.aspect) * W);
      const sy = Math.max(0, (d.y0 - pad) * Hh);
      const sw = Math.min(W - sx, (d.x1 - d.x0 + (2 * pad) / layout.aspect) * W);
      const sh = Math.min(Hh - sy, (d.y1 - d.y0 + 2 * pad) * Hh);
      if (sw < 4 || sh < 4) continue;
      const k = Math.max(1, 48 / sh); // ตัวอักษรเล็กเกินไป Tesseract อ่านไม่ออก → ขยาย
      const c = document.createElement('canvas');
      c.width = Math.round(sw * k);
      c.height = Math.round(sh * k);
      c.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
      const r = await recognize(c, { langs: state.settings.ocrLang, psm: '7' });
      let text = r.text.replace(/\s+/g, ' ').trim();
      if (r.confidence < 70 || countChars(text) < 2) {
        // ไม่มั่นใจทั้งสองตัว (มักเป็นบรรทัดท้ายหน้าที่เบลอ/โค้ง/มีเงา) — ไม่ทิ้งเงียบ ๆ:
        // เก็บผลที่ดูเป็นข้อความจริงและมั่นใจกว่าไว้ แล้วตีกรอบให้ผู้ใช้ตรวจในหน้าแก้ไข
        const best = [
          [text, r.confidence],
          [String(d.text || '').trim(), Math.round((d.conf || 0) * 100)],
        ]
          .filter(([t, c]) => c >= 40 && looksLikeText(t))
          .sort((a, b) => b[1] - a[1])[0];
        if (!best) {
          flag(d, 'unreadable');
          continue;
        }
        text = best[0];
        flag(d, 'uncertain');
      }
      layout.lines.push({ text, ri: d.ri, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, quad: d.quad });
      added++;
    }
  } catch (err) {
    console.warn('rescue:', err);
  } finally {
    bmp.close?.();
  }
  if (!added) return;
  layout.lines.sort((a, b) => a.ri - b.ri || a.x0 - b.x0);
  layout.rows = rowsFromLines(layout.lines);
  page.rawText = rowsToText(layout.rows);
}

/** ข้อความของหน้าจากผล OCR ตามการตั้งค่าปัจจุบัน (โหมดหนังสือ = รวมบรรทัดเป็นย่อหน้า แยกหัวข้อ) */
function composeText(page) {
  const s = state.settings;
  const rows = page.layout?.rows;
  if (s.bookMode && rows?.length) {
    const clean = (t) => cleanOcrText(t, { ...s, removeBlankLines: true }).replace(/\s*\n\s*/g, ' ');
    const others = state.pages.filter((p) => p !== page && p.layout?.rows?.length).flatMap((p) => edgeKeys(p.layout.rows));
    const res = reflowRows(
      rows.map((r) => ({ ...r, text: clean(r.text) })),
      { aspect: page.layout.aspect, otherEdges: others },
    );
    page.flow = { startsNew: res.startsNew, endsOpen: res.endsOpen };
    return blocksToText(res.blocks);
  }
  page.flow = null;
  return cleanOcrText(page.rawText, s);
}

/** จัดข้อความใหม่ทุกหน้าที่อ่านแล้วและผู้ใช้ยังไม่ได้แก้ไข */
async function recomposeAll(except) {
  const changed = [];
  for (const p of state.pages) {
    if (p === except || p.status !== 'done' || p.edited) continue;
    const text = composeText(p);
    if (text !== p.text) {
      p.text = text;
      changed.push(p);
    }
  }
  await Promise.all(changed.map(savePage));
  if (state.tab === 'pages') renderPages();
  if (state.editingId && changed.some((p) => p.id === state.editingId)) fillEditor();
  return changed.length;
}

/**
 * อ่านข้อความหนึ่งหน้า: ใช้ OpenThai (iApp) เป็นหลัก ถ้าเครื่องนี้ใช้ไม่ได้หรืออ่านหน้านั้นพลาด
 * จะใช้ Tesseract แทนให้อัตโนมัติ
 */
async function readPageText(page, image, label) {
  const s = state.settings;
  const report = (status, progress) => {
    setActivity('ocr', `${status} ${label}`, progress);
    if (state.editingId === page.id) $('#ed-status').textContent = `${status}…`;
  };

  if (s.ocrEngine === 'openthai' && !state.openThaiBroken) {
    let ready = false;
    try {
      report('กำลังเตรียม OpenThai OCR', 0.15);
      await getOpenThai();
      ready = true;
      report('กำลังอ่านข้อความ (OpenThai)', 0.5);
      const bmp = await loadBitmap(image);
      const canvas = toCanvas(bmp, 2400);
      bmp.close?.();
      const r = await recognizeOpenThai(canvas);
      return { ...r, engine: 'openthai' };
    } catch (err) {
      console.warn('OpenThai:', err);
      if (!ready) {
        state.openThaiBroken = true; // เครื่อง/เบราว์เซอร์นี้รันไม่ได้ — ใช้ Tesseract ไปจนปิดแอป
        toast(`ใช้ OpenThai OCR ในเครื่องนี้ไม่ได้ — เปลี่ยนไปใช้ Tesseract (${err.message})`, 'error');
      }
    }
  }

  const run = async (mode) =>
    recognize(await prepareForOcr(image, mode), {
      langs: s.ocrLang,
      psm: s.psm,
      onProgress: ({ status, progress }) => report(status, progress),
    });
  let r = await run(s.enhance);
  // อ่านได้น้อยมาก → ลองปรับภาพอีกแบบ แล้วเลือกผลที่ได้ข้อความมากกว่า
  if (s.enhance !== 'none' && countChars(r.text) < MIN_RETRY_TEXT && state.pages.includes(page)) {
    const alt = await run(s.enhance === 'bw' ? 'auto' : 'bw');
    if (countChars(alt.text) > countChars(r.text)) r = alt;
  }
  return { ...r, rotation: 0, engine: 'tesseract' };
}

/** ตัดเฟรมวิดีโอที่ไม่มีข้อความ หรือข้อความซ้ำกับเฟรมก่อนหน้า (เก็บเฟรมที่อ่านได้ดีกว่า) */
async function dedupeVideoFrame(page) {
  if (countChars(page.text) < MIN_VIDEO_TEXT) {
    state.dropped++;
    await removePage(page.id);
    return;
  }
  const prev = state.pages
    .filter(
      (p) => p.groupId === page.groupId && p.side === page.side && p !== page && p.status === 'done' && p.order < page.order,
    )
    .at(-1);
  if (!prev) return;
  const similarity = textSimilarity(prev.text, page.text) * 100;
  if (similarity < state.settings.dedupeThreshold) return;
  const keepCurrent = !prev.edited && ocrQuality(page.text, page.confidence) > ocrQuality(prev.text, prev.confidence);
  state.dropped++;
  if (keepCurrent) {
    page.order = prev.order;
    await savePage(page);
    await removePage(prev.id);
    state.pages.sort((a, b) => a.order - b.order);
  } else {
    await removePage(page.id);
  }
  if (state.tab === 'pages') renderPages();
}

// ---------------------------------------------------------------- rendering

function updateCounters() {
  const n = state.pages.length;
  const badge = $('#badge');
  badge.hidden = n === 0;
  badge.textContent = String(n);
  $('#last-count').textContent = `${n} หน้า`;
  const last = state.pages.at(-1);
  const img = $('#last-thumb');
  img.hidden = !last;
  if (last) img.src = blobUrl(`${last.id}:thumb`, last.thumb);
}

function statusChip(page) {
  switch (page.status) {
    case 'pending':
      return '<span class="st st-pending">รออ่าน</span>';
    case 'processing':
      return '<span class="st st-processing">กำลังอ่าน…</span>';
    case 'error':
      return '<span class="st st-error">อ่านไม่สำเร็จ</span>';
    default:
      if (page.edited) return '<span class="st st-done">แก้ไขแล้ว</span>';
      return (
        `<span class="st ${page.confidence >= 70 ? 'st-done' : 'st-low'}">ความมั่นใจ ${page.confidence}%</span>` +
        (page.flags?.length ? ` <span class="st st-low">⚠ ตรวจ ${page.flags.length} จุด</span>` : '')
      );
  }
}

/** ตีกรอบบนภาพในหน้าแก้ไข: บรรทัดที่อ่านไม่ชัด (ส้ม) / อ่านไม่ได้ (แดง) */
function drawFlags() {
  const layer = $('#ed-flags');
  const page = currentPage();
  const flags = (!crop.active && page?.status === 'done' && page.flags) || [];
  layer.replaceChildren();
  $('#ed-flag-note').hidden = !flags.length;
  if (!flags.length) return;
  const n = (k) => flags.filter((f) => f.kind === k).length;
  const parts = [
    n('uncertain') && `กรอบส้ม = อ่านไม่ชัด ${n('uncertain')} บรรทัด`,
    n('unreadable') && `กรอบแดง = อ่านไม่ได้ ${n('unreadable')} บรรทัด`,
    n('missing') && `กรอบแดงประ = มีข้อความแต่ OCR อ่านไม่เห็น ${n('missing')} จุด`,
  ].filter(Boolean);
  $('#ed-flag-note').textContent =
    `⚠ ข้อความอาจไม่ครบ ควรตรวจกับภาพ (${parts.join(', ')}) — ` +
    'ถ่ายใหม่ให้ชัดทั้งหน้า (แสงพอ ถือกล้องขนานกับหน้า) หรือครอปเฉพาะส่วนนั้นแล้วกด "อ่านใหม่" แล้วรวมข้อความเอง';
  const r = imageRectInWrap();
  for (const f of flags) {
    const box = document.createElement('i');
    box.className = `flag ${f.kind}`;
    Object.assign(box.style, {
      left: `${r.x + f.x0 * r.w}px`,
      top: `${r.y + f.y0 * r.h}px`,
      width: `${(f.x1 - f.x0) * r.w}px`,
      height: `${(f.y1 - f.y0) * r.h}px`,
    });
    layer.appendChild(box);
  }
}

/** ช่องข้อความยืดตามความยาว — เห็นข้อความทั้งหน้าโดยเลื่อนหน้าจอปกติ ไม่ต้องเลื่อนภายในช่อง */
function autoGrowText() {
  const t = $('#ed-text');
  t.style.height = 'auto';
  t.style.height = `${t.scrollHeight + 2}px`;
}

function pageSnippet(page) {
  if (page.status === 'error') return page.error || 'เกิดข้อผิดพลาด';
  if (page.status !== 'done') return 'กำลังรอ OCR…';
  return page.text.trim().replace(/\n{2,}/g, '\n') || '(ไม่พบข้อความ — ลองหมุนภาพ ครอป หรือถ่ายใหม่ให้ชัดขึ้น)';
}

function renderPages() {
  const list = $('#page-list');
  const pages = state.pages;
  $('#empty-state').hidden = pages.length > 0;
  const done = pages.filter((p) => p.status === 'done').length;
  const waiting = pages.filter((p) => p.status === 'pending' || p.status === 'processing').length;
  $('#pages-summary').textContent = pages.length
    ? `${pages.length} หน้า • อ่านแล้ว ${done}${waiting ? ` • รอ ${waiting}` : ''}`
    : '';
  $('#btn-export-word').disabled = pages.length === 0;
  $('#btn-export-pdf').disabled = pages.length === 0;
  list.innerHTML = pages
    .map(
      (p, i) => `
      <li class="page-item" data-id="${p.id}">
        <button class="pi-main" data-act="open" aria-label="เปิดหน้าที่ ${i + 1}">
          <img class="pi-thumb" src="${blobUrl(`${p.id}:thumb`, p.thumb)}" alt="" loading="lazy">
          <span class="pi-info">
            <span class="pi-head"><b>หน้าที่ ${i + 1}</b>
              <span class="chip">${escapeHtml(SOURCE_LABEL[p.source] || '')}${p.sourceDetail ? ` ${escapeHtml(p.sourceDetail)}` : ''}</span>
              ${statusChip(p)}</span>
            <span class="pi-text">${escapeHtml(pageSnippet(p))}</span>
          </span>
        </button>
        <span class="pi-actions">
          <button data-act="up" aria-label="เลื่อนขึ้น" ${i === 0 ? 'disabled' : ''}><svg><use href="#i-up"/></svg></button>
          <button data-act="down" aria-label="เลื่อนลง" ${i === pages.length - 1 ? 'disabled' : ''}><svg><use href="#i-down"/></svg></button>
        </span>
      </li>`,
    )
    .join('');
}

function refreshPage(page) {
  updateCounters();
  if (state.tab === 'pages') renderPages();
  if (state.editingId === page.id) fillEditor();
}

async function movePage(id, delta) {
  const i = state.pages.findIndex((p) => p.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= state.pages.length) return;
  const a = state.pages[i];
  const b = state.pages[j];
  [a.order, b.order] = [b.order, a.order];
  state.pages.sort((x, y) => x.order - y.order);
  renderPages();
  await Promise.all([savePage(a), savePage(b)]);
}

// ---------------------------------------------------------------- editor

const editor = $('#editor');
let textSaveTimer;

function currentPage() {
  return findPage(state.editingId);
}

function openEditor(id) {
  state.editingId = id;
  exitCropMode();
  fillEditor();
  if (!editor.open) editor.showModal();
  $('#editor .editor-body').scrollTop = 0;
  // ขนาดภาพ/ช่องข้อความรู้ได้หลังเปิดหน้าต่างแล้ว
  autoGrowText();
  drawFlags();
}

function fillEditor() {
  const page = currentPage();
  if (!page) return;
  $('#ed-title').textContent = `หน้าที่ ${pageIndex(page)}`;
  const img = $('#ed-image');
  const src = blobUrl(`${page.id}:image`, page.image);
  if (img.getAttribute('src') !== src) img.src = src;
  const busy = page.status === 'pending' || page.status === 'processing';
  const textarea = $('#ed-text');
  if (document.activeElement !== textarea || busy) textarea.value = page.text;
  textarea.disabled = busy;
  $$('#ed-tools button').forEach((b) => (b.disabled = busy && b.dataset.act !== 'crop'));
  $('#ed-tools [data-act="reset"]').disabled = busy || !page.original;
  const info = {
    pending: 'รออ่านข้อความ…',
    processing: 'กำลังอ่านข้อความ…',
    error: `อ่านไม่สำเร็จ: ${page.error || ''}`,
    done: page.edited
      ? 'แก้ไขข้อความแล้ว'
      : `${ENGINE_LABEL[page.engine] || 'OCR'} ความมั่นใจ ${page.confidence}%`,
  };
  $('#ed-status').textContent = `${SOURCE_LABEL[page.source] || ''} • ${thaiDateTime(page.createdAt)} • ${info[page.status]}`;
  updateCharCount();
  autoGrowText();
  if (img.complete) drawFlags();
}

function updateCharCount() {
  $('#ed-count').textContent = `${$('#ed-text').value.length.toLocaleString('th-TH')} ตัวอักษร`;
}

function flushTextSave() {
  clearTimeout(textSaveTimer);
  const page = currentPage();
  const value = $('#ed-text').value;
  if (!page || page.status !== 'done' || page.text === value) return;
  page.text = value;
  page.edited = true;
  savePage(page);
  updateCounters();
}

function closeEditor() {
  flushTextSave();
  exitCropMode();
  state.editingId = null;
  if (editor.open) editor.close();
  if (state.tab === 'pages') renderPages();
}

async function applyImageEdit(page, transform) {
  if (page.edited && !confirm('ข้อความที่แก้ไขไว้จะถูกแทนที่ด้วยผลการอ่านใหม่ ต้องการทำต่อหรือไม่?')) return;
  try {
    const next = await transform(page.image);
    if (!page.original) page.original = page.image;
    page.image = next;
    page.thumb = await makeThumb(next);
    page.status = 'pending';
    page.edited = false;
    await savePage(page);
    refreshPage(page);
    processQueue();
  } catch (err) {
    toast(`แก้ไขภาพไม่สำเร็จ: ${err.message}`, 'error');
  }
}

async function editorAction(act) {
  const page = currentPage();
  if (!page) return;
  switch (act) {
    case 'rotl':
      return applyImageEdit(page, (b) => rotateBlob(b, -90));
    case 'rotr':
      return applyImageEdit(page, (b) => rotateBlob(b, 90));
    case 'crop':
      return enterCropMode();
    case 'crop-cancel':
      return exitCropMode();
    case 'crop-apply': {
      const rect = cropRectFraction();
      exitCropMode();
      if (rect) await applyImageEdit(page, (b) => cropBlob(b, rect));
      return;
    }
    case 'reset':
      if (!page.original) return;
      if (page.edited && !confirm('ข้อความที่แก้ไขไว้จะถูกแทนที่ด้วยผลการอ่านใหม่ ต้องการทำต่อหรือไม่?')) return;
      page.image = page.original;
      page.original = null;
      page.thumb = await makeThumb(page.image);
      page.status = 'pending';
      page.edited = false;
      await savePage(page);
      refreshPage(page);
      return processQueue();
    case 'ocr':
      if (page.edited && !confirm('ข้อความที่แก้ไขไว้จะถูกแทนที่ด้วยผลการอ่านใหม่ ต้องการทำต่อหรือไม่?')) return;
      page.status = 'pending';
      page.edited = false;
      await savePage(page);
      refreshPage(page);
      return processQueue();
    case 'split':
      return splitPage(page);
  }
}

/** แบ่งภาพหนังสือกาง 2 หน้า: หน้านี้เป็นหน้าซ้าย และเพิ่มหน้าขวาต่อท้าย */
async function splitPage(page) {
  if (!confirm('แบ่งภาพนี้เป็น 2 หน้า (ซ้าย/ขวา) ตามแนวสันหนังสือ?')) return;
  try {
    const [left, right] = await splitSpread(page.image, await findGutter(page.image));
    const i = state.pages.indexOf(page);
    const next = state.pages[i + 1];
    const rightPage = {
      ...page,
      id: uid(),
      order: next ? (page.order + next.order) / 2 : page.order + 1,
      createdAt: Date.now(),
      side: 'R',
      sourceDetail: `${page.sourceDetail || ''} (ขวา)`.trim(),
      image: right,
      original: null,
      thumb: await makeThumb(right),
      layout: null,
      text: '',
      rawText: '',
      status: 'pending',
      edited: false,
    };
    Object.assign(page, {
      side: 'L',
      sourceDetail: `${page.sourceDetail || ''} (ซ้าย)`.trim(),
      image: left,
      original: null,
      thumb: await makeThumb(left),
      layout: null,
      status: 'pending',
      edited: false,
    });
    state.pages.splice(i + 1, 0, rightPage);
    await Promise.all([savePage(page), savePage(rightPage)]);
    refreshPage(page);
    toast('แบ่งเป็น 2 หน้าแล้ว — กำลังอ่านข้อความใหม่', 'ok');
    processQueue();
  } catch (err) {
    toast(`แบ่งหน้าไม่สำเร็จ: ${err.message}`, 'error');
  }
}

function updateBookHints() {
  const on = !!state.settings.bookMode;
  $('#ed-book-hint').hidden = !on;
}

// ----- crop

const crop = { active: false, box: null, drag: null };

function imageRectInWrap() {
  const wrap = $('#ed-image-wrap').getBoundingClientRect();
  const img = $('#ed-image').getBoundingClientRect();
  return { x: img.left - wrap.left, y: img.top - wrap.top, w: img.width, h: img.height };
}

function enterCropMode() {
  const r = imageRectInWrap();
  if (!r.w || !r.h) return;
  crop.active = true;
  drawFlags();
  crop.box = { x: r.x + r.w * 0.05, y: r.y + r.h * 0.05, w: r.w * 0.9, h: r.h * 0.9 };
  drawCropBox();
  $('#crop-box').hidden = false;
  $('#ed-tools').hidden = true;
  $('#ed-crop-actions').hidden = false;
}

function exitCropMode() {
  crop.active = false;
  crop.drag = null;
  $('#crop-box').hidden = true;
  $('#ed-tools').hidden = false;
  $('#ed-crop-actions').hidden = true;
  if (editor.open) drawFlags();
}

function drawCropBox() {
  const el = $('#crop-box');
  const b = crop.box;
  Object.assign(el.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
}

function cropRectFraction() {
  const r = imageRectInWrap();
  const b = crop.box;
  if (!b || !r.w) return null;
  return {
    x: Math.max(0, (b.x - r.x) / r.w),
    y: Math.max(0, (b.y - r.y) / r.h),
    w: Math.min(1, b.w / r.w),
    h: Math.min(1, b.h / r.h),
  };
}

function onCropPointerDown(e) {
  if (!crop.active) return;
  e.preventDefault();
  crop.drag = { handle: e.target.dataset.h || 'move', x: e.clientX, y: e.clientY, start: { ...crop.box } };
  $('#crop-box').setPointerCapture(e.pointerId);
}

function onCropPointerMove(e) {
  if (!crop.drag) return;
  const r = imageRectInWrap();
  const MIN = 40;
  const dx = e.clientX - crop.drag.x;
  const dy = e.clientY - crop.drag.y;
  const s = crop.drag.start;
  let { x, y, w, h } = s;
  const hdl = crop.drag.handle;
  if (hdl === 'move') {
    x = Math.min(Math.max(r.x, s.x + dx), r.x + r.w - s.w);
    y = Math.min(Math.max(r.y, s.y + dy), r.y + r.h - s.h);
  } else {
    let left = s.x;
    let top = s.y;
    let right = s.x + s.w;
    let bottom = s.y + s.h;
    if (hdl.includes('w')) left = Math.min(Math.max(r.x, s.x + dx), right - MIN);
    if (hdl.includes('e')) right = Math.max(Math.min(r.x + r.w, right + dx), left + MIN);
    if (hdl.includes('n')) top = Math.min(Math.max(r.y, s.y + dy), bottom - MIN);
    if (hdl.includes('s')) bottom = Math.max(Math.min(r.y + r.h, bottom + dy), top + MIN);
    x = left;
    y = top;
    w = right - left;
    h = bottom - top;
  }
  crop.box = { x, y, w, h };
  drawCropBox();
}

// ---------------------------------------------------------------- export

function wordOptions() {
  const s = state.settings;
  return {
    title: s.docTitle,
    font: s.wordFont,
    fontSize: Number(s.wordFontSize) || 16,
    includeImages: s.wordImages,
    pageBreak: s.wordPageBreak,
    headings: s.wordHeadings,
    bookMode: s.bookMode,
  };
}

async function exportWord({ share = false } = {}) {
  flushTextSave();
  const pages = state.pages;
  if (!pages.length) return toast('ยังไม่มีหน้าที่สแกน');
  const waiting = pages.filter((p) => p.status === 'pending' || p.status === 'processing').length;
  if (waiting && !confirm(`ยังอ่านข้อความไม่เสร็จอีก ${waiting} หน้า ต้องการบันทึกเลยหรือไม่?`)) return;
  const btn = share ? $('#btn-share-word') : $('#btn-export-word');
  btn.classList.add('busy');
  try {
    const blob = await buildWordDocument(pages, wordOptions());
    const name = `${safeFileName(state.settings.docTitle)}_${fileStamp()}.docx`;
    if (share && (await shareFile(blob, name, state.settings.docTitle))) return;
    downloadBlob(blob, name);
    toast(`บันทึกไฟล์ Word แล้ว: ${name}`, 'ok');
  } catch (err) {
    console.error(err);
    toast(`สร้างไฟล์ Word ไม่สำเร็จ: ${err.message}`, 'error');
  } finally {
    btn.classList.remove('busy');
  }
}

async function exportPdf({ share = false } = {}) {
  flushTextSave();
  const pages = state.pages;
  if (!pages.length) return toast('ยังไม่มีหน้าที่สแกน');
  const waiting = pages.filter((p) => p.status === 'pending' || p.status === 'processing').length;
  if (waiting && !confirm(`ยังอ่านข้อความไม่เสร็จอีก ${waiting} หน้า ต้องการบันทึกเลยหรือไม่?`)) return;
  const btn = share ? $('#btn-share-pdf') : $('#btn-export-pdf');
  btn.classList.add('busy');
  try {
    const s = state.settings;
    const blob = await buildSearchablePdf(pages, {
      title: s.docTitle,
      cleanLine: (t) => cleanOcrText(t, { ...s, removeBlankLines: true }).replace(/\s*\n\s*/g, ' '),
    });
    const name = `${safeFileName(s.docTitle)}_${fileStamp()}.pdf`;
    if (share && (await shareFile(blob, name, s.docTitle))) return;
    downloadBlob(blob, name);
    toast(`บันทึก PDF แล้ว: ${name}`, 'ok');
  } catch (err) {
    console.error(err);
    toast(`สร้าง PDF ไม่สำเร็จ: ${err.message}`, 'error');
  } finally {
    btn.classList.remove('busy');
  }
}

function allText() {
  return state.pages.map((p) => (p.text || '').trim()).filter(Boolean).join('\n\n');
}

async function copyText(text) {
  if (!text) return toast('ยังไม่มีข้อความ');
  try {
    await navigator.clipboard.writeText(text);
    toast('คัดลอกข้อความแล้ว', 'ok');
  } catch {
    toast('คัดลอกไม่สำเร็จ — กดค้างที่ข้อความเพื่อคัดลอกเอง', 'error');
  }
}

async function clearAll() {
  if (!state.pages.length) return;
  if (!confirm(`ลบหน้าที่สแกนทั้งหมด ${state.pages.length} หน้า? (กู้คืนไม่ได้)`)) return;
  state.pages.forEach((p) => releaseUrls(p.id));
  state.pages = [];
  await pageStore.clear();
  updateCounters();
  renderPages();
  toast('ลบทั้งหมดแล้ว');
}

// ---------------------------------------------------------------- settings

function bindSettings() {
  $$('[data-setting]').forEach((el) => {
    const key = el.dataset.setting;
    const value = state.settings[key];
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = String(value);
    const evt = el.type === 'text' || el.type === 'range' ? 'input' : 'change';
    el.addEventListener(evt, () => {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (typeof DEFAULT_SETTINGS[key] === 'number') v = Number(v);
      state.settings[key] = v;
      saveSettings(state.settings);
      syncSettingInputs(key, el);
      onSettingChanged(key);
    });
  });
  $('#dedupe-value').textContent = String(state.settings.dedupeThreshold);
}

/** ตั้งค่าเดียวกันอาจมีช่องให้เลือกหลายที่ (เช่น โหมดหนังสือ) — ทำให้ตรงกันทุกช่อง */
function syncSettingInputs(key, source) {
  for (const el of $$(`[data-setting="${key}"]`)) {
    if (el === source) continue;
    if (el.type === 'checkbox') el.checked = !!state.settings[key];
    else el.value = String(state.settings[key]);
  }
}

function setSettings(values) {
  Object.assign(state.settings, values);
  saveSettings(state.settings);
  for (const key of Object.keys(values)) syncSettingInputs(key);
}

async function onSettingChanged(key) {
  if (key === 'bookMode') {
    // ค่าที่เหมาะกับหนังสือ: ข้อความต่อเนื่อง ไม่แนบภาพ ไม่ขึ้นหน้าใหม่ทุกหน้า (เปลี่ยนเองได้ในตัวเลือก Word)
    const on = state.settings.bookMode;
    setSettings({ wordImages: !on, wordPageBreak: !on, wordHeadings: !on });
    updateBookHints();
  }
  if (TEXT_SETTINGS.includes(key)) {
    const n = await recomposeAll();
    if (key === 'bookMode') {
      toast(state.settings.bookMode ? `เปิดโหมดหนังสือแล้ว — จัดย่อหน้าใหม่ ${n} หน้า` : `ปิดโหมดหนังสือแล้ว (${n} หน้า)`, 'ok');
    }
  }
  if (key === 'dedupeThreshold') $('#dedupe-value').textContent = String(state.settings.dedupeThreshold);
  if (key === 'resolution' && camera.active) {
    camera.stop();
    startCamera();
  }
  if (key === 'videoInterval') setMode(state.mode);
  if (key === 'ocrEngine') state.openThaiBroken = false;
}

async function renderStorageInfo() {
  const el = $('#storage-info');
  try {
    const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) || {};
    const mb = (n) => (n / 1024 / 1024).toLocaleString('th-TH', { maximumFractionDigits: 1 });
    el.textContent = quota ? `ใช้พื้นที่เก็บข้อมูล ${mb(usage)} MB จาก ${mb(quota)} MB` : '';
  } catch {
    el.textContent = '';
  }
}

async function preloadOffline() {
  const btn = $('#btn-preload');
  btn.classList.add('busy');
  setActivity('import', 'กำลังเตรียม OCR…', 0.1);
  try {
    if (state.settings.ocrEngine === 'openthai') {
      await getOpenThai();
      setActivity('import', 'กำลังเตรียม Tesseract (ตัวสำรอง)…', 0.5);
    }
    await getWorker(state.settings.ocrLang);
    setActivity('import', 'กำลังเตรียมตัวสร้างไฟล์ Word…', 0.8);
    await loadDocx();
    toast('พร้อมใช้งานแบบออฟไลน์แล้ว', 'ok');
  } catch (err) {
    toast(`เตรียมไม่สำเร็จ: ${err.message}`, 'error');
  } finally {
    btn.classList.remove('busy');
    setActivity('import', null);
  }
}

// ---------------------------------------------------------------- events

function bindEvents() {
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));
  $$('.mode-switch button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  $('#btn-shutter').addEventListener('click', () => {
    if (state.mode === 'photo') capturePhoto();
    else if (state.recorder) stopRecording();
    else startRecording();
  });
  $('#btn-switch').addEventListener('click', async () => {
    try {
      await camera.switchCamera({ resolution: state.settings.resolution });
      $('#btn-torch').hidden = !camera.hasTorch;
    } catch (err) {
      showCameraMessage(err.message);
    }
  });
  $('#btn-torch').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try {
      const on = await camera.setTorch(!camera.torchOn);
      btn.setAttribute('aria-pressed', String(on));
    } catch {
      toast('เปิดไฟแฟลชไม่ได้', 'error');
    }
  });
  $('#btn-last').addEventListener('click', () => showTab('pages'));
  $('#btn-save-video').addEventListener('click', saveLastVideo);
  $('#btn-camera-retry').addEventListener('click', startCamera);
  $('#btn-camera-system').addEventListener('click', () => $('#system-camera-input').click());

  for (const id of ['#file-input', '#system-camera-input']) {
    $(id).addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      await importFiles(files);
    });
  }

  // รายการหน้า
  $('#page-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const item = e.target.closest('.page-item');
    if (!btn || !item) return;
    const id = item.dataset.id;
    if (btn.dataset.act === 'open') openEditor(id);
    if (btn.dataset.act === 'up') movePage(id, -1);
    if (btn.dataset.act === 'down') movePage(id, 1);
  });
  $('#btn-export-word').addEventListener('click', () => exportWord());
  $('#btn-export-pdf').addEventListener('click', () => exportPdf());
  $('#btn-share-pdf').addEventListener('click', () => exportPdf({ share: true }));
  $('#btn-share-word').addEventListener('click', () => exportWord({ share: true }));
  $('#btn-export-txt').addEventListener('click', () => {
    if (!state.pages.length) return toast('ยังไม่มีหน้าที่สแกน');
    downloadBlob(buildPlainText(state.pages, state.settings.docTitle), `${safeFileName(state.settings.docTitle)}_${fileStamp()}.txt`);
  });
  $('#btn-copy-all').addEventListener('click', () => copyText(allText()));
  $('#btn-clear-all').addEventListener('click', clearAll);
  $('#btn-share-word').hidden = !canShareFiles(DOCX_MIME);
  $('#btn-share-pdf').hidden = !canShareFiles(PDF_MIME);

  // editor
  $('#ed-close').addEventListener('click', closeEditor);
  editor.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeEditor();
  });
  $('#ed-delete').addEventListener('click', async () => {
    const page = currentPage();
    if (!page || !confirm(`ลบหน้าที่ ${pageIndex(page)}?`)) return;
    closeEditor();
    await removePage(page.id);
    toast('ลบหน้าแล้ว');
  });
  $('#ed-tools').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) editorAction(b.dataset.act);
  });
  $('#ed-crop-actions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) editorAction(b.dataset.act);
  });
  $('#ed-text').addEventListener('input', () => {
    updateCharCount();
    autoGrowText();
    clearTimeout(textSaveTimer);
    textSaveTimer = setTimeout(flushTextSave, 500);
  });
  $('#ed-copy').addEventListener('click', () => copyText($('#ed-text').value));
  const cropBox = $('#crop-box');
  cropBox.addEventListener('pointerdown', onCropPointerDown);
  cropBox.addEventListener('pointermove', onCropPointerMove);
  cropBox.addEventListener('pointerup', () => (crop.drag = null));
  cropBox.addEventListener('pointercancel', () => (crop.drag = null));
  window.addEventListener('resize', () => {
    if (crop.active) exitCropMode();
    if (editor.open) {
      drawFlags();
      autoGrowText();
    }
  });
  $('#ed-image').addEventListener('load', drawFlags);

  $('#btn-preload').addEventListener('click', preloadOffline);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.recorder) stopRecording().finally(stopCameraWhenIdle);
      else stopCameraWhenIdle();
    } else if (state.tab === 'scan') {
      startCamera();
    }
  });
  window.addEventListener('beforeunload', flushTextSave);
}

// ---------------------------------------------------------------- init

async function init() {
  bindSettings();
  bindEvents();
  setMode('photo');
  updateBookHints();
  document.body.classList.add('scan-mode');
  $('#app-version').textContent =
    `เวอร์ชัน ${APP_VERSION} • OpenThai2.0-OCR-Text (iApp) • onnxruntime-web ${VENDOR.versions.ort} • ` +
    `Tesseract.js ${VENDOR.versions.tesseract} • docx ${VENDOR.versions.docx}`;

  try {
    state.pages = await pageStore.all();
    for (const p of state.pages) {
      if (p.status === 'processing') p.status = 'pending';
    }
  } catch (err) {
    toast(`เปิดข้อมูลที่บันทึกไว้ไม่ได้: ${err.message}`, 'error');
  }
  updateCounters();
  startCamera();
  processQueue();

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW:', err));
  }
}

init();
