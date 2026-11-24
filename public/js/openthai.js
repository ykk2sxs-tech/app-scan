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
 * แปลงพิกัดกรอบบรรทัดจากภาพที่ worker หมุน/แก้เอียงแล้ว กลับเป็นพิกัด 0..1 ของภาพที่แอปเก็บไว้
 * (ภาพที่เก็บจะถูกหมุนตาม rotation ด้วย แต่ไม่ได้แก้เอียง)
 * ลำดับใน worker: หมุน 90/270 → แก้เอียง หรือ แก้เอียง → กลับหัว 180
 */
export function layoutFromOpenThai(r, Wc, Hc) {
  const rot = r.rotation || 0;
  const sideways = rot === 90 || rot === 270;
  const [Wb, Hb] = sideways ? [Hc, Wc] : [Wc, Hc]; // ขนาดภาพก่อนแก้เอียง
  let D = null;
  if (r.skew) {
    const a = (r.skew * Math.PI) / 180;
    const al = Math.cos(a);
    const be = Math.sin(a);
    const nW = Math.round(Hb * Math.abs(be) + Wb * Math.abs(al));
    const nH = Math.round(Hb * Math.abs(al) + Wb * Math.abs(be));
    D = {
      al,
      be,
      nW,
      nH,
      m02: (1 - al) * (Wb / 2) - be * (Hb / 2) + nW / 2 - Wb / 2,
      m12: be * (Wb / 2) + (1 - al) * (Hb / 2) + nH / 2 - Hb / 2,
    };
  }
  const undoDeskew = (x, y) =>
    D ? [D.al * (x - D.m02) - D.be * (y - D.m12), D.be * (x - D.m02) + D.al * (y - D.m12)] : [x, y];
  const map = ([x, y]) => {
    if (rot === 180) {
      [x, y] = undoDeskew((D ? D.nW : Wc) - 1 - x, (D ? D.nH : Hc) - 1 - y);
      return [(Wc - 1 - x) / Wc, (Hc - 1 - y) / Hc];
    }
    [x, y] = undoDeskew(x, y);
    return [x / Wb, y / Hb];
  };
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const toBox = (l) => {
    const pts = l.box.map(map);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    // กรอบเอียง (ภาพถ่ายมักเอียงเล็กน้อย) — เก็บมุมไว้ให้ชั้นข้อความใน PDF เอียงตามบรรทัดจริง
    const px = pts.map(([x, y]) => [x * Wb, y * Hb]).sort((a, b) => a[0] - b[0]);
    const [tl, bl] = px.slice(0, 2).sort((a, b) => a[1] - b[1]);
    const [tr] = px.slice(2).sort((a, b) => a[1] - b[1]);
    return {
      text: l.text,
      conf: l.conf,
      ri: l.row,
      x0: clamp(Math.min(...xs)),
      y0: clamp(Math.min(...ys)),
      x1: clamp(Math.max(...xs)),
      y1: clamp(Math.max(...ys)),
      quad: {
        x: bl[0] / Wb, // มุมล่างซ้าย (0..1)
        y: bl[1] / Hb,
        w: Math.hypot(tr[0] - tl[0], tr[1] - tl[1]) / Wb, // ความยาวขอบบน (สัดส่วนของความกว้างภาพ)
        h: Math.hypot(bl[0] - tl[0], bl[1] - tl[1]) / Hb, // ความสูงกรอบ (สัดส่วนของความสูงภาพ)
        a: Math.atan2(tr[1] - tl[1], tr[0] - tl[0]), // มุมเอียง (เรเดียน, ตามเข็มนาฬิกาในภาพ)
      },
    };
  };
  const lines = (r.lines || []).map(toBox);
  return { aspect: Wb / Hb, lines, rows: rowsFromLines(lines), dropped: (r.droppedLines || []).map(toBox) };
}

/**
 * รวมส่วนย่อยที่อยู่แถวเดียวกัน (ri เดียวกัน) เป็นแถว เรียงตามลำดับการอ่านของ worker
 * row.parts = ข้อความแต่ละคอลัมน์ในแถว (ใช้ tab คั่นตอนแสดงผล)
 */
export function rowsFromLines(lines) {
  const byRow = new Map();
  for (const l of [...lines].sort((a, b) => a.ri - b.ri || a.x0 - b.x0)) {
    const row = byRow.get(l.ri);
    if (!row) {
      byRow.set(l.ri, { ri: l.ri, text: l.text, parts: [l.text], x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 });
    } else {
      row.parts.push(l.text);
      row.text = row.parts.join(' ');
      row.x0 = Math.min(row.x0, l.x0);
      row.y0 = Math.min(row.y0, l.y0);
      row.x1 = Math.max(row.x1, l.x1);
      row.y1 = Math.max(row.y1, l.y1);
    }
  }
  return [...byRow.values()];
}

export const rowsToText = (rows) => rows.map((row) => row.parts.join('\t')).join('\n');

/**
 * อ่านข้อความจาก canvas
 * @returns {Promise<{text: string, confidence: number, rotation: number, layout: object, ms: number}>}
 *   rotation = องศาที่ต้องหมุนภาพตามเข็มนาฬิกาให้ตั้งตรง (0/90/180/270)
 */
export async function recognizeOpenThai(canvas) {
  const e = await getOpenThai();
  const { width: w, height: h } = canvas;
  const buf = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data.buffer;
  const r = await e.call({ type: 'read', w, h, buf }, [buf]);
  const layout = layoutFromOpenThai(r, w, h);
  return {
    // ข้อความในแถวเดียวกันที่อยู่คนละคอลัมน์ คั่นด้วย tab (เช่น รายการ ⇥ จำนวนเงิน)
    text: rowsToText(layout.rows),
    confidence: Math.round((r.confidence || 0) * 100),
    rotation: r.rotation || 0,
    layout,
    ms: r.ms,
  };
}
