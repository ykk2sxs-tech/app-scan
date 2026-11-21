// เครื่องมือจัดการภาพ: ย่อ/หมุน/ครอป, ปรับภาพก่อน OCR, วัดความคมชัด

export function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

const sizeOf = (src) => ({
  w: src.videoWidth || src.naturalWidth || src.width,
  h: src.videoHeight || src.naturalHeight || src.height,
});

/** โหลด Blob ภาพเป็น ImageBitmap (หมุนตาม EXIF ให้อัตโนมัติ) */
export async function loadBitmap(blob) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      /* fallback ด้านล่าง */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** วาดภาพ/วิดีโอลง canvas โดยจำกัดด้านยาวสุดไม่เกิน maxSide */
export function toCanvas(src, maxSide = Infinity) {
  const { w, h } = sizeOf(src);
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const c = createCanvas(w * scale, h * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('แปลงภาพไม่สำเร็จ'))), type, quality),
  );
}

/** ย่อภาพให้ไม่เกิน maxSide แล้วบีบอัดเป็น JPEG */
export async function normalizeImageBlob(blob, maxSide = 2800, quality = 0.9) {
  const bmp = await loadBitmap(blob);
  const c = toCanvas(bmp, maxSide);
  bmp.close?.();
  return canvasToBlob(c, 'image/jpeg', quality);
}

/** หมุนภาพทีละ 90 องศา (deg = 90 | -90 | 180) */
export async function rotateBlob(blob, deg) {
  const bmp = await loadBitmap(blob);
  const { w, h } = sizeOf(bmp);
  const quarter = ((deg / 90) % 4 + 4) % 4;
  const c = quarter % 2 ? createCanvas(h, w) : createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((quarter * Math.PI) / 2);
  ctx.drawImage(bmp, -w / 2, -h / 2);
  bmp.close?.();
  return canvasToBlob(c);
}

/** ครอปภาพตามสัดส่วน rect = {x, y, w, h} ค่า 0..1 */
export async function cropBlob(blob, rect) {
  const bmp = await loadBitmap(blob);
  const { w, h } = sizeOf(bmp);
  const sx = Math.round(rect.x * w);
  const sy = Math.round(rect.y * h);
  const sw = Math.max(1, Math.round(rect.w * w));
  const sh = Math.max(1, Math.round(rect.h * h));
  const c = createCanvas(sw, sh);
  c.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  bmp.close?.();
  return canvasToBlob(c);
}

/** แปลงเป็นค่าความสว่าง (grayscale) */
function toGray(data) {
  const gray = new Uint8ClampedArray(data.length / 4);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
  return gray;
}

/** ยืดช่วงความสว่าง (auto levels) ตัดหัวท้าย 1% */
function autoLevels(gray) {
  const hist = new Uint32Array(256);
  for (const v of gray) hist[v]++;
  const cut = gray.length * 0.01;
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < cut; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < cut; hi--);
  if (hi - lo < 30) return gray;
  const k = 255 / (hi - lo);
  for (let i = 0; i < gray.length; i++) gray[i] = (gray[i] - lo) * k;
  return gray;
}

/**
 * ปรับพื้นกระดาษให้ขาวเท่ากันทั้งภาพ (แก้เงาและแสงไม่สม่ำเสมอจากกล้องมือถือ)
 * ประมาณสีพื้นจากส่วนที่สว่างของแต่ละบล็อก แล้วหารออก — ตัวอักษรยังเป็นโทนเทา ไม่แตกเหมือนการทำขาว-ดำ
 */
function flattenBackground(gray, w, h) {
  const s = Math.max(16, Math.round(Math.max(w, h) / 48));
  const bw = Math.ceil(w / s);
  const bh = Math.ceil(h / s);
  if (bw < 2 || bh < 2) return gray;
  const bg = new Float32Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      let n = 0;
      for (let y = by * s; y < Math.min(h, (by + 1) * s); y += 2) {
        for (let x = bx * s; x < Math.min(w, (bx + 1) * s); x += 2) {
          hist[gray[y * w + x]]++;
          n++;
        }
      }
      // เปอร์เซ็นไทล์ที่ 90 = สีกระดาษ (ตัวอักษรเป็นส่วนมืดส่วนน้อย)
      let v = 255;
      for (let acc = 0; v > 0 && (acc += hist[v]) < n * 0.1; v--);
      bg[by * bw + bx] = v;
    }
  }
  // ขยายค่าสว่าง (max 3x3) กันบล็อกที่ตัวอักษรหนาแน่น แล้วเกลี่ยให้เรียบ (เฉลี่ย 3x3)
  const pass = (src, fn) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const vals = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) vals.push(src[yy * bw + xx]);
          }
        }
        out[y * bw + x] = fn(vals);
      }
    }
    return out;
  };
  const smooth = pass(
    pass(bg, (v) => Math.max(...v)),
    (v) => v.reduce((a, b) => a + b, 0) / v.length,
  );
  let darkest = 255;
  for (const v of smooth) darkest = Math.min(darkest, v);
  if (darkest > 235) return gray; // พื้นขาวเท่ากันอยู่แล้ว (ภาพสแกน) ไม่ต้องแก้

  const out = new Uint8ClampedArray(gray.length);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1.001, Math.max(0, y / s - 0.5));
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1.001, Math.max(0, x / s - 0.5));
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const i = y0 * bw + x0;
      const b =
        (smooth[i] * (1 - tx) + smooth[i + 1 < smooth.length ? i + 1 : i] * tx) * (1 - ty) +
        (smooth[Math.min(i + bw, smooth.length - 1)] * (1 - tx) + smooth[Math.min(i + bw + 1, smooth.length - 1)] * tx) * ty;
      out[y * w + x] = (gray[y * w + x] * 250) / Math.max(40, b);
    }
  }
  return out;
}

/**
 * Adaptive threshold (Bradley–Roth) ทำภาพขาว-ดำ ทนต่อเงาและแสงไม่สม่ำเสมอ
 * ซึ่งพบบ่อยเวลาถ่ายเอกสารด้วยมือถือ
 */
function adaptiveThreshold(gray, w, h, t = 0.15) {
  const s = Math.max(16, Math.round(Math.max(w, h) / 16)) >> 1;
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + rowSum;
    }
  }
  const out = new Uint8ClampedArray(gray.length);
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - s);
    const y2 = Math.min(h, y + s + 1);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - s);
      const x2 = Math.min(w, x + s + 1);
      const count = (x2 - x1) * (y2 - y1);
      const sum =
        integral[y2 * (w + 1) + x2] - integral[y1 * (w + 1) + x2] - integral[y2 * (w + 1) + x1] + integral[y1 * (w + 1) + x1];
      out[y * w + x] = gray[y * w + x] * count <= sum * (1 - t) ? 0 : 255;
    }
  }
  return out;
}

/**
 * เตรียมภาพสำหรับ Tesseract
 * mode: 'auto' = ปรับพื้นให้ขาวเท่ากัน + ปรับคอนทราสต์ เก็บโทนเทาไว้ (ค่าเริ่มต้น)
 *       'bw'   = ปรับพื้นแล้วทำขาว-ดำแบบ adaptive (ตัวอักษรจาง/ซีดมาก)
 *       'none' = ใช้ภาพตามเดิม
 */
export async function prepareForOcr(blob, mode = 'auto') {
  const bmp = await loadBitmap(blob);
  const { w, h } = sizeOf(bmp);
  // ขนาดที่เหมาะกับ Tesseract: ไม่ใหญ่เกิน (ช้า) และไม่เล็กเกิน (ตัวอักษรเล็กอ่านไม่ออก)
  const longSide = Math.max(w, h);
  const target = longSide > 2600 ? 2600 : longSide < 1200 ? Math.min(1800, longSide * 2) : longSide;
  const scale = target / longSide;
  const c = createCanvas(w * scale, h * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  if (mode === 'none') return c;

  const img = ctx.getImageData(0, 0, c.width, c.height);
  let gray = autoLevels(flattenBackground(toGray(img.data), c.width, c.height));
  if (mode === 'bw') gray = adaptiveThreshold(gray, c.width, c.height);
  const d = img.data;
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    d[i] = d[i + 1] = d[i + 2] = gray[j];
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * วิเคราะห์เฟรมแบบเร็ว (ภาพย่อ) คืนค่า
 * - sharpness: ความคมชัด (variance of Laplacian) ยิ่งสูงยิ่งชัด
 * - signature: ภาพย่อ 32x32 ใช้เทียบว่าฉากเปลี่ยนหรือไม่
 */
export function analyzeFrame(src, workCanvas) {
  const { w, h } = sizeOf(src);
  const W = 320;
  const H = Math.max(1, Math.round((h / w) * W));
  const c = workCanvas || createCanvas(W, H);
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, W, H);
  const gray = toGray(ctx.getImageData(0, 0, W, H).data);

  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - W] - gray[i + W];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  const sharpness = sumSq / n - mean * mean;

  const S = 32;
  const signature = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      signature[y * S + x] = gray[Math.floor((y * H) / S) * W + Math.floor((x * W) / S)];
    }
  }
  return { sharpness, signature };
}

/** ค่าความต่างเฉลี่ยของ signature สองภาพ (0..255) */
export function signatureDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

/** ขนาดภาพจริงของ Blob */
export async function imageSize(blob) {
  const bmp = await loadBitmap(blob);
  const s = sizeOf(bmp);
  bmp.close?.();
  return { width: s.w, height: s.h };
}
