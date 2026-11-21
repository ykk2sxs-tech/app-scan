// เก็บหน้าที่สแกนไว้ใน IndexedDB (อยู่ในเครื่องเท่านั้น ไม่ส่งขึ้นเซิร์ฟเวอร์)
// และเก็บการตั้งค่าใน localStorage

const DB_NAME = 'thai-ocr-scanner';
const STORE = 'pages';
let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('บันทึกข้อมูลไม่สำเร็จ (พื้นที่เก็บข้อมูลอาจเต็ม)'));
  });
}

export const pageStore = {
  async all() {
    const pages = await tx('readonly', (s) => s.getAll());
    return pages.sort((a, b) => a.order - b.order);
  },
  put: (page) => tx('readwrite', (s) => s.put(page)),
  delete: (id) => tx('readwrite', (s) => s.delete(id)),
  clear: () => tx('readwrite', (s) => s.clear()),
};

export const DEFAULT_SETTINGS = {
  docTitle: 'เอกสารสแกน',
  ocrLang: 'tha+eng',
  psm: '3',
  enhance: 'bw',
  fixThai: true,
  removeThaiSpaces: false,
  fixNumbers: true,
  thaiDigits: false,
  removeBlankLines: false,
  resolution: 'fhd',
  highResPhoto: true,
  videoInterval: 2,
  dedupe: true,
  dedupeThreshold: 80,
  keepVideo: true,
  wordFont: 'TH Sarabun New',
  wordFontSize: 16,
  wordImages: true,
  wordPageBreak: true,
  wordHeadings: true,
};

const SETTINGS_KEY = 'thai-ocr-scanner:settings';

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* โหมดส่วนตัว / ปิดการเก็บข้อมูล — ใช้ค่าในหน่วยความจำต่อไป */
  }
}
