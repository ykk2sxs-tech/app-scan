// ฟังก์ชันช่วยทั่วไป

const scriptCache = new Map();

/** โหลดสคริปต์ภายนอก (ครั้งเดียว) */
export function loadScript(src) {
  if (!scriptCache.has(src)) {
    scriptCache.set(
      src,
      new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => {
          scriptCache.delete(src);
          reject(new Error(`โหลดไฟล์ไม่สำเร็จ: ${src}`));
        };
        document.head.appendChild(s);
      }),
    );
  }
  return scriptCache.get(src);
}

export const absUrl = (path) => new URL(path, document.baseURI).href;

export const uid = () =>
  (crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** วันที่แบบไทย (พ.ศ.) */
export function thaiDateTime(ts, withTime = true) {
  const d = new Date(ts);
  const opts = { day: 'numeric', month: 'short', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('th-TH', opts);
}

export function thaiDateLong(ts) {
  return new Date(ts).toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** สร้างชื่อไฟล์ เช่น เอกสารสแกน_2569-11-21_1030 */
export function fileStamp(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear() + 543}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

export function safeFileName(name) {
  return (name || 'เอกสารสแกน').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'เอกสารสแกน';
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** แชร์ไฟล์ผ่านเมนูแชร์ของมือถือ (LINE, อีเมล, Drive ฯลฯ) — คืน false ถ้าไม่รองรับ */
export async function shareFile(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  if (!navigator.canShare?.({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], title });
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
  return true;
}

export function canShareFiles(type) {
  try {
    return !!navigator.canShare?.({ files: [new File(['x'], 'x', { type })] });
  } catch {
    return false;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
