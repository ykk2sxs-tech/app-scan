// OCR ภาษาไทยด้วย Tesseract.js (ทำงานในเครื่องผ่าน WebAssembly ไม่ส่งภาพออกไปไหน)

import { VENDOR } from '../vendor/paths.js';
import { loadScript, absUrl } from './util.js';

let workerPromise = null;
let workerLangs = null;
let progressListener = null;

const STATUS_TH = {
  'loading tesseract core': 'กำลังโหลดเครื่องมือ OCR',
  'initializing tesseract': 'กำลังเตรียม OCR',
  'loading language traineddata': 'กำลังโหลดข้อมูลภาษา',
  'loading language traineddata (from cache)': 'กำลังโหลดข้อมูลภาษา',
  'initializing api': 'กำลังเตรียม OCR',
  'recognizing text': 'กำลังอ่านข้อความ',
};

async function createWorker(langs) {
  await loadScript(VENDOR.tesseract);
  const worker = await window.Tesseract.createWorker(langs.split('+'), 1 /* LSTM */, {
    workerPath: absUrl(VENDOR.worker),
    corePath: absUrl(VENDOR.core),
    langPath: absUrl(VENDOR.lang),
    gzip: true,
    workerBlobURL: false,
    logger: (m) => progressListener?.({ status: STATUS_TH[m.status] || m.status, progress: m.progress || 0 }),
    errorHandler: (e) => console.error('Tesseract:', e),
  });
  return worker;
}

/** สร้าง/คืน worker ที่โหลดภาษาตามที่ตั้งค่าไว้ */
export async function getWorker(langs) {
  if (workerPromise && workerLangs !== langs) {
    const w = await workerPromise.catch(() => null);
    if (w) {
      try {
        await w.reinitialize(langs.split('+'), 1);
        workerLangs = langs;
        return w;
      } catch {
        await w.terminate().catch(() => {});
        workerPromise = null;
      }
    } else {
      workerPromise = null;
    }
  }
  if (!workerPromise) {
    workerLangs = langs;
    workerPromise = createWorker(langs).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/**
 * อ่านข้อความจากภาพ
 * @param image canvas / Blob / ImageBitmap
 * @returns {Promise<{text: string, confidence: number}>}
 */
export async function recognize(image, { langs = 'tha+eng', psm = '3', onProgress } = {}) {
  progressListener = onProgress;
  try {
    const worker = await getWorker(langs);
    await worker.setParameters({
      tessedit_pageseg_mode: String(psm),
      user_defined_dpi: '300',
    });
    const { data } = await worker.recognize(image);
    return { text: data.text || '', confidence: Math.round(data.confidence || 0) };
  } finally {
    progressListener = null;
  }
}

export async function terminateOcr() {
  const w = await workerPromise?.catch(() => null);
  workerPromise = null;
  await w?.terminate().catch(() => {});
}
