// OCR ภาษาไทยด้วยโมเดล OpenThai2.0-OCR-Text ของ iApp (Apache-2.0) — รันใน Web Worker ในเครื่อง
// โมเดลเล็ก (~4 MB) อ่านภาษาไทยได้แม่นกว่า Tesseract และไม่ต้องใช้อินเทอร์เน็ตหลังโหลดครั้งแรก

import { VENDOR } from '../vendor/paths.js';
import { absUrl } from './util.js';

export const OPENTHAI_MODEL_DIR = 'models/openthai2.0-ocr-text/';
const INIT_TIMEOUT_MS = 90_000;

let engine = null;

function start() {
  const worker = new Worker(absUrl('js/openthai-worker.js'));
  const pending = new Map();
  let seq = 0;
  const failAll = (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  const call = (msg, transfer = []) =>
    new Promise((resolve, reject) => {
      msg.id = ++seq;
      pending.set(msg.id, { resolve, reject });
      worker.postMessage(msg, transfer);
    });
  worker.onmessage = (e) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error));
  };
  worker.onerror = (e) => failAll(new Error(`OpenThai worker: ${e.message || 'เริ่มทำงานไม่ได้'}`));

  const init = call({
    type: 'init',
    ort: absUrl(VENDOR.ort),
    ortDir: absUrl(VENDOR.ortDir),
    det: absUrl(`${OPENTHAI_MODEL_DIR}det.onnx`),
    rec: absUrl(`${OPENTHAI_MODEL_DIR}rec.onnx`),
    dict: absUrl(`${OPENTHAI_MODEL_DIR}rec_dict.txt`),
  });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('เริ่ม OpenThai OCR ไม่สำเร็จ (หมดเวลา)')), INIT_TIMEOUT_MS),
  );
  const ready = Promise.race([init, timeout]);
  return { worker, call, ready };
}

/** เตรียม engine (โหลด onnxruntime + โมเดล) — เรียกซ้ำได้ */
export async function getOpenThai() {
  if (!engine) {
    const e = start();
    engine = e;
    e.ready.catch(() => {
      e.worker.terminate();
      if (engine === e) engine = null;
    });
  }
  const e = engine;
  await e.ready;
  return e;
}

/**
 * อ่านข้อความจาก canvas
 * @returns {Promise<{text: string, confidence: number, rotation: number, ms: number}>}
 *   rotation = องศาที่ต้องหมุนภาพตามเข็มนาฬิกาให้ตั้งตรง (0/90/180/270)
 */
export async function recognizeOpenThai(canvas) {
  const e = await getOpenThai();
  const { width: w, height: h } = canvas;
  const buf = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data.buffer;
  const r = await e.call({ type: 'read', w, h, buf }, [buf]);
  return {
    // ข้อความในแถวเดียวกันที่อยู่คนละคอลัมน์ คั่นด้วย tab (เช่น รายการ ⇥ จำนวนเงิน)
    text: r.rows.map((row) => (row.parts || [row.text]).join('\t')).join('\n'),
    confidence: Math.round((r.confidence || 0) * 100),
    rotation: r.rotation || 0,
    ms: r.ms,
  };
}
