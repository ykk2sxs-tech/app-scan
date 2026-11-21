/* openthai-worker.js — OCR ภาษาไทยด้วยโมเดล OpenThai2.0-OCR-Text ของ iApp Technology (Apache-2.0)
   ทำงานใน Web Worker ด้วย onnxruntime-web แบบ WASM CPU core เดียว — ไม่มีการส่งภาพออกนอกเครื่อง

   ส่วน OT (detect → crop → recognize → จัดลำดับการอ่าน → ทำความสะอาดข้อความไทย) นำมาจาก
   openthai_worker.js ในไฟล์ invoice-to-journal.html ของผู้ใช้ ซึ่งแปลงมาจาก runtime/line_engine.py
   และ thai_norm.py ของ OpenThai2.0-OCR-Text ทีละฟังก์ชัน — คงไว้ตามเดิม ยกเว้น:
   - ส่วน init: โหลดโมเดลจากไฟล์ของแอปนี้ (public/models/openthai2.0-ocr-text) แทนข้อมูลที่ฝังใน HTML
   - read(): ส่งบรรทัดที่ถูกตัดทิ้ง (droppedLines) กลับไปด้วย ให้แอปลองอ่านซ้ำด้วย Tesseract
   ลิขสิทธิ์และ NOTICE ของโมเดล: public/models/openthai2.0-ocr-text/NOTICE */
'use strict';
var OT = (function () {
  // ---------------- config (DEFAULTS + det.yml + config.json) ----------------
  var CFG = {
    det: { limit: 1280, thresh: 0.2, box_thresh: 0.4, unclip: 1.4, min_size: 3, max_candidates: 3000, split_gap: 1.2 },
    rec: { height: 48, max_w: 3200, batch: 16, drop_below: 0.8, min_chars: 2, junk_below: 0.9, junk_invalid: 0.05 },
    ori: { enabled: true, sample: 8, flip_below: 0.8, flip_margin: 0.15, deskew_above: 2.5 }
  };
  var MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
  var det = null, rec = null, CHARS = null;

  // ---------------- small numeric helpers ----------------
  function median(a) {
    if (!a.length) return NaN;
    var s = Array.prototype.slice.call(a).sort(function (x, y) { return x - y; }), n = s.length, m = n >> 1;
    return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : NaN; }
  function norm2(p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1]); }
  function sat8(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }
  function clip(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ---------------- images: {w,h,c:3,data:Uint8 BGR? -> we keep RGBA} ----------------
  // img = {w, h, rgba: Uint8ClampedArray}; gray plane cached as Float32Array (cv2 BGR2GRAY weights)
  function grayOf(img) {
    if (img.gray) return img.gray;
    var n = img.w * img.h, g = new Float32Array(n), d = img.rgba;
    for (var i = 0, j = 0; i < n; i++, j += 4) g[i] = Math.round(0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]);
    img.gray = g;
    return g;
  }
  function rot90img(img, k) {        // np.rot90(img, k): k=1 ทวนเข็ม, k=-1 ตามเข็ม, k=2 กลับหัว
    var w = img.w, h = img.h, s = img.rgba, nw = (k === 2) ? w : h, nh = (k === 2) ? h : w, o = new Uint8ClampedArray(nw * nh * 4), x, y, sx, sy;
    for (y = 0; y < nh; y++) for (x = 0; x < nw; x++) {
      if (k === 1) { sx = w - 1 - y; sy = x; }
      else if (k === -1) { sx = y; sy = h - 1 - x; }
      else { sx = w - 1 - x; sy = h - 1 - y; }
      var si = (sy * w + sx) * 4, di = (y * nw + x) * 4;
      o[di] = s[si]; o[di + 1] = s[si + 1]; o[di + 2] = s[si + 2]; o[di + 3] = 255;
    }
    return { w: nw, h: nh, rgba: o };
  }
  function rot90gray(c, k) {
    var w = c.w, h = c.h, nw = (k === 2) ? w : h, nh = (k === 2) ? h : w, o = new Float32Array(nw * nh), x, y;
    for (y = 0; y < nh; y++) for (x = 0; x < nw; x++) {
      var sx, sy;
      if (k === 1) { sx = w - 1 - y; sy = x; } else if (k === -1) { sx = y; sy = h - 1 - x; } else { sx = w - 1 - x; sy = h - 1 - y; }
      o[y * nw + x] = c.data[sy * w + sx];
    }
    return { w: nw, h: nh, data: o };
  }
  // bilinear sample of a single-channel float plane, border replicate
  function samp(g, w, h, x, y) {
    if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
    if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
    var x0 = x | 0, y0 = y | 0, x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0, fx = x - x0, fy = y - y0;
    var a = g[y0 * w + x0], b = g[y0 * w + x1], c = g[y1 * w + x0], d = g[y1 * w + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  // cv2.resize INTER_LINEAR on a gray plane -> rounded uint8 values in Float32Array
  function resizeGray(c, nw, nh) {
    var o = new Float32Array(nw * nh), sx = c.w / nw, sy = c.h / nh, x, y;
    for (y = 0; y < nh; y++) {
      var yy = (y + 0.5) * sy - 0.5; if (yy < 0) yy = 0;
      for (x = 0; x < nw; x++) {
        var xx = (x + 0.5) * sx - 0.5; if (xx < 0) xx = 0;
        o[y * nw + x] = sat8(samp(c.data, c.w, c.h, xx, yy));
      }
    }
    return { w: nw, h: nh, data: o };
  }

  // ---------------- geometry ----------------
  function order_points(pts) {
    var p = pts.map(function (q, i) { return [q[0], q[1], i]; }).sort(function (a, b) { return a[0] - b[0] || a[2] - b[2]; });
    var left = [p[0], p[1]].sort(function (a, b) { return a[1] - b[1] || a[2] - b[2]; });
    var right = [p[2], p[3]].sort(function (a, b) { return a[1] - b[1] || a[2] - b[2]; });
    return [[left[0][0], left[0][1]], [right[0][0], right[0][1]], [right[1][0], right[1][1]], [left[1][0], left[1][1]]];
  }
  function hull(points) {           // monotone chain, points [[x,y]...]
    var p = points.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    if (p.length < 3) return p;
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lo = [], up = [], i;
    for (i = 0; i < p.length; i++) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p[i]) <= 0) lo.pop(); lo.push(p[i]); }
    for (i = p.length - 1; i >= 0; i--) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p[i]) <= 0) up.pop(); up.push(p[i]); }
    up.pop(); lo.pop();
    return lo.concat(up);
  }
  /* cv2.minAreaRect + boxPoints + order_points -> {box, side, w, h, c, u, v} */
  function minAreaRect(points) {
    var H = hull(points), best = null;
    if (H.length === 1) H = [H[0], H[0]];
    for (var i = 0; i < H.length; i++) {
      var a = H[i], b = H[(i + 1) % H.length], ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey);
      if (!L) { if (H.length > 2) continue; ex = 1; ey = 0; L = 1; }
      var ux = ex / L, uy = ey / L, vx = -uy, vy = ux, minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (var j = 0; j < H.length; j++) {
        var pu = H[j][0] * ux + H[j][1] * uy, pv = H[j][0] * vx + H[j][1] * vy;
        if (pu < minU) minU = pu; if (pu > maxU) maxU = pu; if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
      }
      var area = (maxU - minU) * (maxV - minV);
      if (!best || area < best.area - 1e-9) best = { area: area, ux: ux, uy: uy, vx: vx, vy: vy, minU: minU, maxU: maxU, minV: minV, maxV: maxV };
    }
    if (!best) best = { ux: 1, uy: 0, vx: 0, vy: 1, minU: H[0][0], maxU: H[0][0], minV: H[0][1], maxV: H[0][1] };
    return rectFrom(best.ux, best.uy, best.vx, best.vy, best.minU, best.maxU, best.minV, best.maxV, 0);
  }
  function rectFrom(ux, uy, vx, vy, minU, maxU, minV, maxV, grow) {
    minU -= grow; maxU += grow; minV -= grow; maxV += grow;
    function pt(u, v) { return [u * ux + v * vx, u * uy + v * vy]; }
    var box = order_points([pt(minU, minV), pt(maxU, minV), pt(maxU, maxV), pt(minU, maxV)]);
    return { box: box, side: Math.min(maxU - minU, maxV - minV), ux: ux, uy: uy, vx: vx, vy: vy, minU: minU, maxU: maxU, minV: minV, maxV: maxV };
  }
  function polyArea(b) { var s = 0; for (var i = 0; i < b.length; i++) { var p = b[i], q = b[(i + 1) % b.length]; s += p[0] * q[1] - q[0] * p[1]; } return Math.abs(s) / 2; }
  function polyLen(b) { var s = 0; for (var i = 0; i < b.length; i++) s += norm2(b[i], b[(i + 1) % b.length]); return s; }
  function box_score(prob, pw, ph, box) {
    var xs = box.map(function (p) { return p[0]; }), ys = box.map(function (p) { return p[1]; });
    var x0 = clip(Math.floor(Math.min.apply(null, xs)), 0, pw - 1), x1 = clip(Math.ceil(Math.max.apply(null, xs)), 0, pw - 1);
    var y0 = clip(Math.floor(Math.min.apply(null, ys)), 0, ph - 1), y1 = clip(Math.ceil(Math.max.apply(null, ys)), 0, ph - 1);
    var poly = box.map(function (p) { return [Math.trunc(p[0]), Math.trunc(p[1])]; });
    var area2 = 0; for (var i = 0; i < 4; i++) { var a = poly[i], b = poly[(i + 1) % 4]; area2 += a[0] * b[1] - b[0] * a[1]; }
    var sgn = area2 >= 0 ? 1 : -1, sum = 0, cnt = 0;
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
      var inside = true;
      for (var k = 0; k < 4 && inside; k++) {
        var p = poly[k], q = poly[(k + 1) % 4];
        if (sgn * ((q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])) < -1e-9) inside = false;
      }
      if (inside) { sum += prob[y * pw + x]; cnt++; }
    }
    return cnt ? sum / cnt : 0;
  }

  // ---------------- detection ----------------
  function detect(img) {
    var c = CFG.det, H0 = img.h, W0 = img.w;
    var pad = Math.max(8, Math.trunc(0.05 * Math.min(H0, W0))), h = H0 + 2 * pad, w = W0 + 2 * pad;
    var s = c.limit ? Math.min(c.limit / Math.max(h, w), 4.0) : 1.0;
    var rh = Math.max(32, Math.round(h * s / 32) * 32), rw = Math.max(32, Math.round(w * s / 32) * 32);
    // padded (white) + cv2.resize linear, BGR normalise, CHW
    var x = new Float32Array(3 * rh * rw), d = img.rgba, sx = w / rw, sy = h / rh, plane = rh * rw;
    for (var yy = 0; yy < rh; yy++) {
      var fy = (yy + 0.5) * sy - 0.5; if (fy < 0) fy = 0; if (fy > h - 1) fy = h - 1;
      var y0 = fy | 0, y1 = Math.min(y0 + 1, h - 1), ty = fy - y0;
      for (var xx = 0; xx < rw; xx++) {
        var fx = (xx + 0.5) * sx - 0.5; if (fx < 0) fx = 0; if (fx > w - 1) fx = w - 1;
        var x0 = fx | 0, x1 = Math.min(x0 + 1, w - 1), tx = fx - x0;
        var X0 = x0 - pad, X1 = x1 - pad, Y0 = y0 - pad, Y1 = y1 - pad;
        var i00 = (X0 < 0 || Y0 < 0 || X0 >= W0 || Y0 >= H0) ? -1 : (Y0 * W0 + X0) * 4, i10 = (X1 < 0 || Y0 < 0 || X1 >= W0 || Y0 >= H0) ? -1 : (Y0 * W0 + X1) * 4;
        var i01 = (X0 < 0 || Y1 < 0 || X0 >= W0 || Y1 >= H0) ? -1 : (Y1 * W0 + X0) * 4, i11 = (X1 < 0 || Y1 < 0 || X1 >= W0 || Y1 >= H0) ? -1 : (Y1 * W0 + X1) * 4;
        for (var ch = 0; ch < 3; ch++) {           // ch 0=B 1=G 2=R
          var off = 2 - ch;
          var a00 = i00 < 0 ? 255 : d[i00 + off], a10 = i10 < 0 ? 255 : d[i10 + off], a01 = i01 < 0 ? 255 : d[i01 + off], a11 = i11 < 0 ? 255 : d[i11 + off];
          var v = (a00 * (1 - tx) + a10 * tx) * (1 - ty) + (a01 * (1 - tx) + a11 * tx) * ty;
          x[ch * plane + yy * rw + xx] = (sat8(v) / 255 - MEAN[ch]) / STD[ch];
        }
      }
    }
    return det.run(x, [1, 3, rh, rw]).then(function (out) {
      var prob = out.data, pw = out.dims[3], ph = out.dims[2];
      // connected components (8-neighbour) of prob > thresh  ~ cv2.findContours(RETR_LIST)
      var lab = new Int32Array(pw * ph), n = 0, stack = new Int32Array(pw * ph), comps = [];
      for (var i = 0; i < pw * ph; i++) {
        if (lab[i] || !(prob[i] > c.thresh)) continue;
        n++; var sp = 0, pts = []; stack[sp++] = i; lab[i] = n;
        while (sp) {
          var p = stack[--sp], py = (p / pw) | 0, pxx = p - py * pw;
          pts.push([pxx, py]);
          for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var qx = pxx + dx, qy = py + dy;
            if (qx < 0 || qy < 0 || qx >= pw || qy >= ph) continue;
            var q = qy * pw + qx;
            if (!lab[q] && prob[q] > c.thresh) { lab[q] = n; stack[sp++] = q; }
          }
        }
        comps.push(pts);
        if (comps.length >= c.max_candidates) break;
      }
      var ssx = w / pw, ssy = h / ph, boxes = [];
      comps.forEach(function (pts) {
        var r0 = minAreaRect(boundary(pts));
        if (r0.side < c.min_size || box_score(prob, pw, ph, r0.box) < c.box_thresh) return;
        var dist = polyArea(r0.box) * c.unclip / Math.max(polyLen(r0.box), 1e-9);
        if (!polyLen(r0.box)) return;
        var r1 = rectFrom(r0.ux, r0.uy, r0.vx, r0.vy, r0.minU, r0.maxU, r0.minV, r0.maxV, dist);
        if (r1.side < c.min_size + 2) return;
        var b = r1.box.map(function (p) { return [clip(p[0] * ssx - pad, 0, W0 - 1), clip(p[1] * ssy - pad, 0, H0 - 1)]; });
        var bx = b.map(function (p) { return p[0]; }), by = b.map(function (p) { return p[1]; });
        if (Math.max.apply(null, bx) - Math.min.apply(null, bx) >= 2 && Math.max.apply(null, by) - Math.min.apply(null, by) >= 2) boxes.push(b);
      });
      return boxes;
    });
  }
  function boundary(pts) {          // เฉพาะจุดซ้าย/ขวาสุดของแต่ละแถว (hull เท่ากับของทั้งก้อน)
    var rows = {};
    pts.forEach(function (p) { var r = rows[p[1]]; if (!r) rows[p[1]] = [p[0], p[0]]; else { if (p[0] < r[0]) r[0] = p[0]; if (p[0] > r[1]) r[1] = p[0]; } });
    var out = [];
    Object.keys(rows).forEach(function (y) { var r = rows[y]; y = +y; out.push([r[0], y]); if (r[1] !== r[0]) out.push([r[1], y]); });
    return out;
  }

  // ---------------- crops ----------------
  function solve8(A, b) {           // Gaussian elimination
    var n = 8, M = A.map(function (r, i) { return r.concat([b[i]]); }), i, j, k;
    for (i = 0; i < n; i++) {
      var piv = i; for (j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[piv][i])) piv = j;
      var t = M[i]; M[i] = M[piv]; M[piv] = t;
      if (Math.abs(M[i][i]) < 1e-12) return null;
      for (j = i + 1; j < n; j++) { var f = M[j][i] / M[i][i]; for (k = i; k <= n; k++) M[j][k] -= f * M[i][k]; }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) { var s = M[i][n]; for (j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
    return x;
  }
  function homography(src, dst) {   // maps src -> dst
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var X = src[i][0], Y = src[i][1], u = dst[i][0], v = dst[i][1];
      A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]); b.push(u);
      A.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]); b.push(v);
    }
    var h = solve8(A, b);
    return h ? h.concat([1]) : null;
  }
  function crop_line(img, box) {    // turn=0 เสมอในเส้นทางที่ใช้จริง
    var w = Math.trunc(Math.max(norm2(box[0], box[1]), norm2(box[2], box[3])));
    var h = Math.trunc(Math.max(norm2(box[0], box[3]), norm2(box[1], box[2])));
    w = Math.max(w, 1); h = Math.max(h, 1);
    var g = grayOf(img), Hm = homography([[0, 0], [w, 0], [w, h], [0, h]], box), o = new Float32Array(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var X, Y;
      if (Hm) { var z = Hm[6] * x + Hm[7] * y + 1; X = (Hm[0] * x + Hm[1] * y + Hm[2]) / z; Y = (Hm[3] * x + Hm[4] * y + Hm[5]) / z; }
      else { X = box[0][0] + x; Y = box[0][1] + y; }
      o[y * w + x] = sat8(samp(g, img.w, img.h, X, Y));
    }
    return { w: w, h: h, data: o };
  }
  function line_height(boxes) {
    var hs = boxes.map(function (b) { return Math.max(norm2(b[0], b[3]), 1.0); });
    var lines = hs.filter(function (h, i) { return norm2(boxes[i][0], boxes[i][1]) >= 2 * h; });
    return hs.length ? median(lines.length >= 3 ? lines : hs) : 1.0;
  }
  function _flatten(c) {            // c: {w,h,data(uint8 values)} -> new uint8 plane
    var h = c.h, w = c.w, g = c.data, k = Math.max(2, Math.floor(h / 6)), bg = new Float32Array(w), x, y, col = [];
    for (x = 0; x < w; x++) {
      col.length = 0;
      for (y = 0; y < k && y < h; y++) col.push(g[y * w + x]);
      for (y = Math.max(0, h - k); y < h; y++) col.push(g[y * w + x]);
      bg[x] = Math.trunc(median(col));
    }
    var win = Math.max(3, Math.min(h | 1, 255)), half = win >> 1, hist = new Int32Array(256), sm = new Float32Array(w);
    function at(i) { return bg[i < 0 ? 0 : i >= w ? w - 1 : i]; }
    for (x = -half; x <= half; x++) hist[at(x)]++;
    var need = half + 1;
    for (x = 0; x < w; x++) {
      var acc = 0, v = 0; for (; v < 256; v++) { acc += hist[v]; if (acc >= need) break; }
      sm[x] = v;
      hist[at(x - half)]--; hist[at(x + half + 1)]++;
    }
    var d = new Float32Array(w * h), H2 = new Float64Array(256);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) { var dv = Math.abs(g[y * w + x] - sm[x]); d[y * w + x] = dv; H2[Math.min(255, Math.trunc(dv))]++; }
    var total = w * h, cum = 0, hi = 0;
    for (var i = 0; i < 256; i++) { cum += H2[i]; if (cum >= 0.98 * total) { hi = i; break; } }
    hi = Math.max(hi, 24.0);
    var o = new Float32Array(w * h);
    for (i = 0; i < w * h; i++) o[i] = Math.trunc(255 - clip(d[i] * (255.0 / hi), 0, 255));
    return { w: w, h: h, data: o };
  }
  function split_one(img, b, ratio) {
    if (!ratio) return [b];
    var c = crop_line(img, b), h = c.h, w = c.w;
    if (w < 4 * h || h < 4) return [b];
    var f = _flatten(c), ink = new Uint8Array(w), x, y;
    for (x = 0; x < w; x++) for (y = 0; y < h; y++) if (f.data[y * w + x] < 128) { ink[x] = 1; break; }
    var segs = [], start = null, blank = 0;
    for (x = 0; x < w; x++) {
      if (ink[x]) {
        if (start === null) start = x;
        else if (blank >= ratio * h) { segs.push([start, x - blank]); start = x; }
        blank = 0;
      } else if (start !== null) blank++;
    }
    if (start !== null) segs.push([start, w - blank]);
    if (!segs.length || (segs.length === 1 && segs[0][0] < ratio * h && w - segs[0][1] < ratio * h)) return [b];
    var top = [b[1][0] - b[0][0], b[1][1] - b[0][1]], bot = [b[2][0] - b[3][0], b[2][1] - b[3][1]], pad = 0.15 * h;
    return segs.map(function (s) {
      var t0 = Math.max(0.0, (s[0] - pad) / w), t1 = Math.min(1.0, (s[1] + pad) / w);
      return [[b[0][0] + t0 * top[0], b[0][1] + t0 * top[1]], [b[0][0] + t1 * top[0], b[0][1] + t1 * top[1]],
        [b[3][0] + t1 * bot[0], b[3][1] + t1 * bot[1]], [b[3][0] + t0 * bot[0], b[3][1] + t0 * bot[1]]];
    });
  }

  // ---------------- recognition ----------------
  function recognize_detail(crops) {
    var c = CFG.rec, H = c.height;
    crops = crops.map(function (cr) { return _flatten(resizeGray(cr, Math.max(1, Math.ceil(H * cr.w / Math.max(cr.h, 1))), H)); });
    var ratios = crops.map(function (cr) { return cr.w / Math.max(cr.h, 1); });
    var out = crops.map(function () { return ['', 0.0, []]; });
    var order = crops.map(function (_, i) { return i; }).sort(function (a, b) { return ratios[a] - ratios[b] || a - b; });
    var seq = Promise.resolve();
    for (var b = 0; b < order.length; b += c.batch) (function (idx) {
      seq = seq.then(function () {
        var W = Math.min(c.max_w, Math.max(16, Math.ceil(H * Math.max.apply(null, idx.map(function (i) { return ratios[i]; })))));
        var n = idx.length, batch = new Float32Array(n * 3 * H * W), widths = [];
        idx.forEach(function (i, k) {
          var rw = Math.min(W, Math.max(1, Math.ceil(H * ratios[i]))), im = crops[i];
          if (im.w !== rw) im = resizeGray(im, rw, H);
          widths.push(rw);
          for (var ch = 0; ch < 3; ch++) {
            var base = ((k * 3 + ch) * H) * W;
            for (var y = 0; y < H; y++) for (var x = 0; x < rw; x++) batch[base + y * W + x] = (im.data[y * rw + x] / 255 - 0.5) / 0.5;
          }
        });
        return rec.run(batch, [n, 3, H, W]).then(function (p) {
          var T = p.dims[1], C = p.dims[2];
          idx.forEach(function (i, k) { out[i] = ctc_detail(p.data, k * T * C, T, C, W / T, widths[k]); });
        });
      });
    })(order.slice(b, b + c.batch));
    return seq.then(function () { return out; });
  }
  function recognize(crops) { return recognize_detail(crops).then(function (r) { return r.map(function (x) { return [x[0], x[1]]; }); }); }
  function ctc_detail(P, off, T, C, stride, width) {
    var ids = new Int32Array(T), conf = new Float32Array(T), t, k;
    for (t = 0; t < T; t++) {
      var best = 0, bv = -1, o = off + t * C;
      for (k = 0; k < C; k++) if (P[o + k] > bv) { bv = P[o + k]; best = k; }
      ids[t] = best; conf[t] = bv;
    }
    var chars = [], probs = [];
    t = 0;
    while (t < T) {
      var end = t + 1;
      while (end < T && ids[end] === ids[t]) end++;
      if (ids[t] !== 0) {
        var ch = ids[t] < CHARS.length ? CHARS[ids[t]] : '';
        chars.push([ch, Math.min(1.0, t * stride / width), Math.min(1.0, end * stride / width), conf[t]]);
        probs.push(conf[t]);
      }
      t = end;
    }
    return [chars.map(function (c) { return c[0]; }).join(''), probs.length ? mean(probs) : 0.0, chars];
  }

  // ---------------- thai_norm.canonical + fix_scripts ----------------
  var PUA = { 0xF700: 0x0E10, 0xF701: 0x0E34, 0xF702: 0x0E35, 0xF703: 0x0E36, 0xF704: 0x0E37, 0xF705: 0x0E48, 0xF706: 0x0E49, 0xF707: 0x0E4A, 0xF708: 0x0E4B, 0xF709: 0x0E4C,
    0xF70A: 0x0E48, 0xF70B: 0x0E49, 0xF70C: 0x0E4A, 0xF70D: 0x0E4B, 0xF70E: 0x0E4C, 0xF70F: 0x0E0D, 0xF710: 0x0E31, 0xF711: 0x0E4D, 0xF712: 0x0E47, 0xF713: 0x0E48,
    0xF714: 0x0E49, 0xF715: 0x0E4A, 0xF716: 0x0E4B, 0xF717: 0x0E4C, 0xF718: 0x0E38, 0xF719: 0x0E39, 0xF71A: 0x0E3A };
  var VOWEL = 'ัิีึืฺุู็', TONE = '่้๊๋์๎', NIK = 'ํ';
  var MARK_RUN = new RegExp('[' + VOWEL + TONE + NIK + ']{2,}', 'g');
  var SARA_AM = /([่-๋]?)ํ([่-๋]?)า/g;
  function canonical(text) {
    var s = '', i;
    text = text || '';
    for (i = 0; i < text.length; i++) {
      var cp = text.charCodeAt(i);
      if (PUA[cp]) s += String.fromCharCode(PUA[cp]);
      else if (cp === 0x200B || cp === 0x200C || cp === 0x200D || cp === 0x2060 || cp === 0x00AD || cp === 0xFEFF) continue;
      else if (cp === 0x00A0) s += ' ';
      else s += text.charAt(i);
    }
    s = s.normalize('NFC');
    s = s.replace(MARK_RUN, function (run) {
      var arr = run.split('').map(function (ch, k) { return [VOWEL.indexOf(ch) >= 0 ? 0 : TONE.indexOf(ch) >= 0 ? 1 : 2, k, ch]; });
      arr.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
      var out = [];
      arr.forEach(function (x) { if (!out.length || out[out.length - 1] !== x[2]) out.push(x[2]); });
      return out.join('');
    });
    s = s.replace(SARA_AM, function (m, a, b) { return a + b + 'ำ'; });
    s = s.split('เเ').join('แ').split('ำำ').join('ำ');
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return s.split('\n').map(function (l) { return l.replace(/[ \t\f\v]+/g, ' ').trim(); }).join('\n').trim();
  }
  var LONE_W = /(?<![A-Za-z])[Ww](?=\.?[ก-ฮเ-ไ])/g;
  var ZERO_IN_THAI = /(?<=[๐-๙])[Oo0]|[Oo0](?=[๐-๙])/g;
  function fix_scripts(t) { return t.replace(LONE_W, 'พ').replace(ZERO_IN_THAI, '๐'); }
  var MARKS = 'ัิีึืฺุู็่้๊๋์ํ๎', LEADING = 'เแโใไ';
  function isCons(ch) { return ch >= 'ก' && ch <= 'ฮ'; }
  function invalid_share(text) {
    var thai = 0, bad = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (!(ch >= '฀' && ch <= '๿')) continue;
      thai++;
      var prev = i ? text.charAt(i - 1) : ' ';
      if (MARKS.indexOf(ch) >= 0 && !(isCons(prev) || (MARKS.indexOf(prev) >= 0 && i >= 2 && isCons(text.charAt(i - 2))))) bad++;
      else if (LEADING.indexOf(ch) >= 0 && !(i + 1 < text.length && isCons(text.charAt(i + 1)))) bad++;
    }
    return thai ? bad / thai : 0.0;
  }

  // ---------------- layout ----------------
  function _vertical(box, ratio) {
    var w = norm2(box[0], box[1]), h = norm2(box[0], box[3]);
    return h >= ratio * Math.max(w, 1.0) ? 1 : w >= ratio * Math.max(h, 1.0) ? -1 : 0;
  }
  function page_skew(boxes) {
    var a = [];
    boxes.forEach(function (b) {
      var dx = b[1][0] - b[0][0], dy = b[1][1] - b[0][1], h = norm2(b[0], b[3]);
      if (Math.hypot(dx, dy) >= 3 * Math.max(h, 1.0)) a.push(Math.atan2(dy, dx) * 180 / Math.PI);
    });
    return a.length ? median(a) : 0.0;
  }
  function _gaps(iv, min_gap) {
    iv = iv.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var out = [], reach = iv[0][1];
    for (var i = 1; i < iv.length; i++) { if (iv[i][0] - reach >= min_gap) out.push([reach, iv[i][0]]); reach = Math.max(reach, iv[i][1]); }
    return out;
  }
  var DIGITS = '0123456789๐๑๒๓๔๕๖๗๘๙';
  function _enum(text) {
    var m = /^\s*\(?([0-9๐-๙]{1,4})\s*[.)]/.exec(text);
    if (!m) return null;
    return parseInt(m[1].replace(/[๐-๙]/g, function (d) { return String(d.charCodeAt(0) - 0x0E50); }), 10);
  }
  function _numbered_across(lcol, rcol, ext, hmed, texts) {
    if (!texts) return false;
    var pairs = 0;
    lcol.forEach(function (i) {
      var a = _enum(texts[i]); if (a === null) return;
      var cy = (ext[i][2] + ext[i][3]) / 2;
      if (rcol.some(function (j) { return _enum(texts[j]) === a + 1 && Math.abs((ext[j][2] + ext[j][3]) / 2 - cy) <= 0.5 * hmed; })) pairs++;
    });
    return pairs >= 0.5 * Math.min(lcol.length, rcol.length);
  }
  function _prose(col, ext, hmed, texts) {
    if (col.length < 12) return false;
    var widths = col.map(function (i) { return ext[i][1] - ext[i][0]; });
    var span = Math.max.apply(null, col.map(function (i) { return ext[i][1]; })) - Math.min.apply(null, col.map(function (i) { return ext[i][0]; }));
    if (median(widths) < 7 * hmed || mean(widths.map(function (w) { return w >= 0.75 * span ? 1 : 0; })) < 0.5) return false;
    if (texts) {
      var all = 0, dg = 0;
      col.forEach(function (i) { for (var k = 0; k < texts[i].length; k++) { var ch = texts[i].charAt(k); if (/\s/.test(ch)) continue; all++; if (DIGITS.indexOf(ch) >= 0) dg++; } });
      if (all && dg > 0.3 * all) return false;
    }
    return true;
  }
  function _next_to(side, ext, hmed, gutter_on_right) {
    if (!side.length) return side;
    var g = _gaps(side.map(function (i) { return [ext[i][0], ext[i][1]]; }), 0.8 * hmed);
    if (!g.length) return side;
    if (gutter_on_right) return side.filter(function (i) { return ext[i][0] >= g[g.length - 1][1]; });
    return side.filter(function (i) { return ext[i][1] <= g[0][0]; });
  }
  function _blocks(idx, ext, hmed, texts, depth) {
    depth = depth || 0;
    if (idx.length < 6 || depth > 12) return [idx];
    var cuts = [];
    _gaps(idx.map(function (i) { return [ext[i][0], ext[i][1]]; }), 0.8 * hmed).forEach(function (g) {
      var left = idx.filter(function (i) { return ext[i][1] <= g[0]; }), right = idx.filter(function (i) { return ext[i][0] >= g[1]; });
      var lcol = _next_to(left, ext, hmed, true), rcol = _next_to(right, ext, hmed, false);
      if (_prose(lcol, ext, hmed, texts) && _prose(rcol, ext, hmed, texts) && !_numbered_across(lcol, rcol, ext, hmed, texts)) cuts.push([g[1] - g[0], left, right]);
    });
    if (cuts.length) {
      var best = cuts.reduce(function (a, b) { return b[0] > a[0] ? b : a; });
      return _blocks(best[1], ext, hmed, texts, depth + 1).concat(_blocks(best[2], ext, hmed, texts, depth + 1));
    }
    var hg = _gaps(idx.map(function (i) { return [ext[i][2], ext[i][3]]; }), 0.8 * hmed);
    if (!hg.length) return [idx];
    var g = hg.reduce(function (a, b) { return (b[1] - b[0]) > (a[1] - a[0]) ? b : a; });
    var top = idx.filter(function (i) { return ext[i][3] <= g[0]; }), bottom = idx.filter(function (i) { return ext[i][2] >= g[1]; });
    return _blocks(top, ext, hmed, texts, depth + 1).concat(_blocks(bottom, ext, hmed, texts, depth + 1));
  }
  function reading_order(boxes, angle, texts) {
    if (!boxes.length) return [];
    var a = -(angle === null || angle === undefined ? page_skew(boxes) : angle) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    var ext = boxes.map(function (b) {
      var xs = [], ys = [];
      b.forEach(function (p) { xs.push(p[0] * ca - p[1] * sa); ys.push(p[0] * sa + p[1] * ca); });
      return [Math.min.apply(null, xs), Math.max.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, ys)];
    });
    var hmed = line_height(boxes), idx = boxes.map(function (_, i) { return i; });
    var blocks = _blocks(idx, ext, hmed, texts);
    var cy = ext.map(function (e) { return (e[2] + e[3]) / 2; }), rx = ext.map(function (e) { return (e[0] + e[1]) / 2; });
    var hs = boxes.map(function (b) { return Math.max(norm2(b[0], b[3]), 1.0); }), tol = 0.5 * hmed, rows = [];
    blocks.forEach(function (blk) {
      var full = blk.filter(function (i) { return hs[i] >= 0.6 * hmed; }); if (!full.length) full = blk.slice();
      var fullSet = {}; full.forEach(function (i) { fullSet[i] = 1; });
      var small = blk.filter(function (i) { return !fullSet[i]; }), brows = [];
      full.slice().sort(function (p, q) { return cy[p] - cy[q] || p - q; }).forEach(function (i) {
        if (brows.length && Math.abs(cy[i] - mean(brows[brows.length - 1].map(function (j) { return cy[j]; }))) <= tol) brows[brows.length - 1].push(i);
        else brows.push([i]);
      });
      var centre = brows.map(function (r) { return mean(r.map(function (j) { return cy[j]; })); });
      small.forEach(function (i) {
        var d = centre.map(function (c) { return Math.abs(cy[i] - c); });
        var mi = d.length ? d.indexOf(Math.min.apply(null, d)) : -1;
        if (mi >= 0 && d[mi] <= tol + 0.5 * hs[i]) brows[mi].push(i); else { brows.push([i]); centre.push(cy[i]); }
      });
      brows.map(function (_, r) { return r; }).sort(function (p, q) { return centre[p] - centre[q] || p - q; })
        .forEach(function (r) { rows.push(brows[r].slice().sort(function (p, q) { return rx[p] - rx[q] || p - q; })); });
    });
    return rows;
  }
  function _fragments(boxes, recd) {
    var out = {};
    if (boxes.length < 3) return out;
    var hs = boxes.map(function (b) { return norm2(b[0], b[3]); }), hmed = line_height(boxes);
    boxes.forEach(function (b, i) {
      if (hs[i] >= 0.35 * hmed || (recd[i] ? recd[i][0] : '').replace(/ /g, '').length > 3) return;
      var xs = b.map(function (p) { return p[0]; }), ys = b.map(function (p) { return p[1]; });
      var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
      for (var j = 0; j < boxes.length; j++) {
        if (j === i || hs[j] < 0.6 * hmed) continue;
        var c = boxes[j], cx = c.map(function (p) { return p[0]; }), cyy = c.map(function (p) { return p[1]; });
        if (Math.min.apply(null, cx) <= x1 && x0 <= Math.max.apply(null, cx) &&
          Math.min(Math.abs(y0 - Math.max.apply(null, cyy)), Math.abs(Math.min.apply(null, cyy) - y1)) <= 0.5 * hmed) { out[i] = 1; break; }
      }
    });
    return out;
  }

  // ---------------- page ----------------
  function _read_boxes(img, boxes) {
    var raw = boxes.map(function (b) { return crop_line(img, b); });
    var tall = []; raw.forEach(function (c, n) { if (c.h >= 1.5 * c.w) tall.push(n); });
    var extra = [];
    [1, -1].forEach(function (k) { tall.forEach(function (n) { extra.push(rot90gray(raw[n], k)); }); });
    return recognize_detail(raw.concat(extra)).then(function (res) {
      var out = res.slice(0, raw.length);
      tall.forEach(function (n, j) {
        [res[raw.length + j], res[raw.length + tall.length + j]].forEach(function (alt) { if (alt[1] > out[n][1]) out[n] = [alt[0], alt[1], null]; });
      });
      return out;
    });
  }
  function _page(img, boxes) {
    var groups = boxes.map(function (b) { return split_one(img, b, CFG.det.split_gap); });
    var changed = boxes.map(function (b, i) { return groups[i].length > 1 || groups[i][0] !== b; });
    var pieces = [].concat.apply([], groups), whole = boxes.filter(function (_, i) { return changed[i]; });
    return _read_boxes(img, pieces.concat(whole)).then(function (res) {
      var fin = [], out = [], k = 0, e = pieces.length;
      boxes.forEach(function (b, bi) {
        var g = groups[bi], r = res.slice(k, k + g.length); k += g.length;
        if (changed[bi]) {
          var alt = res[e]; e++;
          var nP = r.reduce(function (s, x) { return s + x[0].replace(/ /g, '').length; }, 0);
          if (Math.min.apply(null, r.map(function (x) { return x[1]; })) < CFG.rec.drop_below || nP < 0.9 * alt[0].replace(/ /g, '').length) { fin.push(b); out.push(alt); return; }
        }
        g.forEach(function (p) { fin.push(p); }); r.forEach(function (x) { out.push(x); });
      });
      var angle = page_skew(fin);
      var rows = reading_order(fin, angle, out.map(function (x) { return x[0]; }));
      return { rows: rows, angle: angle, rec: out.map(function (x) { return [x[0], x[1]]; }), boxes: fin };
    });
  }
  function _sideways(img, boxes) {
    var votes = boxes.map(function (b) { return _vertical(b, 2.0); });
    var vert = boxes.filter(function (_, i) { return votes[i] === 1; });
    if (vert.length < 3 || vert.length <= votes.filter(function (v) { return v === -1; }).length) return Promise.resolve(0);
    vert.sort(function (a, b) { return norm2(b[0], b[3]) - norm2(a[0], a[3]); });
    var raw = vert.slice(0, CFG.ori.sample).map(function (b) { return crop_line(img, b); });
    var crops = raw.map(function (c) { return rot90gray(c, 1); }).concat(raw.map(function (c) { return rot90gray(c, -1); }));
    return recognize(crops).then(function (res) {
      var ccw = 0, cw = 0;
      res.forEach(function (r, i) { if (i < raw.length) ccw += r[1]; else cw += r[1]; });
      return ccw > cw ? 1 : -1;
    });
  }
  function _upside_down(img, boxes, page) {
    var confs = page.rec.filter(function (r) { return r[0].length >= 2; }).map(function (r) { return r[1]; });
    if (confs.length < 3 || median(confs) >= CFG.ori.flip_below) return Promise.resolve(false);
    var idx = page.rec.map(function (_, i) { return i; }).filter(function (i) { return _vertical(boxes[i], 2.0) === -1; })
      .sort(function (a, b) { return norm2(boxes[b][0], boxes[b][1]) - norm2(boxes[a][0], boxes[a][1]); }).slice(0, CFG.ori.sample);
    if (idx.length < 3) return Promise.resolve(false);
    var up = mean(idx.map(function (i) { return page.rec[i][1]; }));
    return recognize(idx.map(function (i) { return rot90gray(crop_line(img, boxes[i]), 2); })).then(function (fl) {
      return mean(fl.map(function (x) { return x[1]; })) > up + CFG.ori.flip_margin;
    });
  }
  function deskew(img, angle) {
    var W = img.w, H = img.h, a = angle * Math.PI / 180, al = Math.cos(a), be = Math.sin(a), cx = W / 2, cy = H / 2;
    var m = [[al, be, (1 - al) * cx - be * cy], [-be, al, be * cx + (1 - al) * cy]];
    var c = Math.abs(al), s = Math.abs(be), nW = Math.round(H * s + W * c), nH = Math.round(H * c + W * s);
    m[0][2] += nW / 2 - W / 2; m[1][2] += nH / 2 - H / 2;
    var det_ = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    var inv = [[m[1][1] / det_, -m[0][1] / det_], [-m[1][0] / det_, m[0][0] / det_]];
    var edge = [[], [], []], d = img.rgba, x, y, ch;
    function pushPx(X, Y) { var i = (Y * W + X) * 4; edge[0].push(d[i]); edge[1].push(d[i + 1]); edge[2].push(d[i + 2]); }
    for (x = 0; x < W; x++) { pushPx(x, 0); pushPx(x, H - 1); }
    for (y = 0; y < H; y++) { pushPx(0, y); pushPx(W - 1, y); }
    var fill = edge.map(function (e) { return Math.trunc(median(e)); });
    var o = new Uint8ClampedArray(nW * nH * 4);
    for (y = 0; y < nH; y++) for (x = 0; x < nW; x++) {
      var X = x - m[0][2], Y = y - m[1][2], sx = inv[0][0] * X + inv[0][1] * Y, sy = inv[1][0] * X + inv[1][1] * Y, di = (y * nW + x) * 4;
      if (sx < 0 || sy < 0 || sx > W - 1 || sy > H - 1) { o[di] = fill[0]; o[di + 1] = fill[1]; o[di + 2] = fill[2]; o[di + 3] = 255; continue; }
      var x0 = sx | 0, y0 = sy | 0, x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1), fx = sx - x0, fy = sy - y0;
      for (ch = 0; ch < 3; ch++) {
        var v = (d[(y0 * W + x0) * 4 + ch] * (1 - fx) + d[(y0 * W + x1) * 4 + ch] * fx) * (1 - fy) + (d[(y1 * W + x0) * 4 + ch] * (1 - fx) + d[(y1 * W + x1) * 4 + ch] * fx) * fy;
        o[di + ch] = v;
      }
      o[di + 3] = 255;
    }
    return { w: nW, h: nH, rgba: o };
  }
  function read(img) {
    var t0 = Date.now(), rotation = 0, skew = 0, boxes;
    return detect(img).then(function (b) {
      boxes = b;
      if (!boxes.length && img.h <= 200 && img.w >= 1.5 * img.h) boxes = [[[0, 0], [img.w - 1, 0], [img.w - 1, img.h - 1], [0, img.h - 1]]];
      return _sideways(img, boxes);
    }).then(function (k) {
      if (!k) return null;
      img = rot90img(img, k); rotation = k === -1 ? 90 : 270;
      return detect(img).then(function (b) { boxes = b; });
    }).then(function () {
      skew = page_skew(boxes);
      if (Math.abs(skew) >= CFG.ori.deskew_above) { img = deskew(img, skew); return detect(img).then(function (b) { boxes = b; }); }
      skew = 0;
    }).then(function () { return _page(img, boxes); }).then(function (page) {
      if (rotation) return page;
      return _upside_down(img, page.boxes, page).then(function (flip) {
        if (!flip) return page;
        img = rot90img(img, 2); rotation = 180;
        return detect(img).then(function (b) { return _page(img, b); });
      });
    }).then(function (page) {
      var rc = CFG.rec, frag = _fragments(page.boxes, page.rec), rows = [], lines = [], dropped = 0, droppedLines = [];
      page.rows.forEach(function (r, ri) {
        var parts = [];
        r.forEach(function (i) {
          if (frag[i]) return;
          var text = fix_scripts(canonical(page.rec[i][0])), conf = page.rec[i][1], bad = false;
          if (!text) bad = true;
          else if (conf < rc.drop_below) bad = true;
          else if (text.replace(/ /g, '').length < rc.min_chars) bad = true;
          else if (conf < rc.junk_below && invalid_share(text) > rc.junk_invalid) bad = true;
          if (bad) { dropped++; droppedLines.push({ text: text, conf: conf, row: ri, box: page.boxes[i] }); return; }
          parts.push(text);
          var b = page.boxes[i];
          lines.push({ text: text, conf: conf, row: ri, box: b });
        });
        if (parts.length) rows.push({ text: parts.join('     '), parts: parts });
      });
      var chars = 0, wsum = 0;
      lines.forEach(function (l) { chars += l.text.length; wsum += l.conf * l.text.length; });
      return { rows: rows, lines: lines, rotation: rotation, skew: skew, angle: page.angle, dropped: dropped, droppedLines: droppedLines,
        confidence: chars ? wsum / chars : 0, ms: Date.now() - t0 };
    });
  }

  // ---------------- init: โหลด onnxruntime-web และโมเดลจาก URL ของแอป ----------------
  function Model(sess) { this.sess = sess; this.name = sess.inputNames[0]; this.out = sess.outputNames[0]; }
  Model.prototype.run = function (data, dims) {
    var feeds = {}; feeds[this.name] = new ort.Tensor('float32', data, dims);
    var o = this.out;
    return this.sess.run(feeds).then(function (r) { return r[o]; });
  };
  function get(url, asText) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('โหลด ' + url + ' ไม่สำเร็จ (' + r.status + ')');
      return asText ? r.text() : r.arrayBuffer();
    });
  }
  /* a = { ort, ortDir, det, rec, dict } — URL แบบเต็มทั้งหมด; a.cfg = ปรับค่า CFG บางส่วน (ไม่บังคับ) */
  function init(a) {
    if (a.cfg) Object.keys(a.cfg).forEach(function (k) { if (CFG[k]) Object.assign(CFG[k], a.cfg[k]); });
    if (typeof ort === 'undefined') importScripts(a.ort);
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = a.ortDir;
    ort.env.logLevel = 'error';
    return Promise.all([get(a.det), get(a.rec), get(a.dict, true)]).then(function (r) {
      var opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      return ort.InferenceSession.create(new Uint8Array(r[0]), opt).then(function (s1) {
        det = new Model(s1);
        return ort.InferenceSession.create(new Uint8Array(r[1]), opt);
      }).then(function (s2) {
        rec = new Model(s2);
        CHARS = [''].concat(r[2].split('\n').filter(function (c) { return c; })).concat([' ']);
        if (CHARS.length !== 530) throw new Error('rec_dict.txt มี ' + (CHARS.length - 2) + ' ตัว (ต้องเป็น 528)');
      });
    });
  }
  return { init: init, read: read, canonical: canonical, fix_scripts: fix_scripts, CFG: CFG };
})();

var otChain = Promise.resolve();
self.onmessage = function (e) {
  var m = e.data;
  otChain = otChain.then(function () {
    if (m.type === 'init') return OT.init(m).then(function () { self.postMessage({ id: m.id, ok: true }); });
    if (m.type === 'read') {
      var img = { w: m.w, h: m.h, rgba: new Uint8ClampedArray(m.buf) };
      return OT.read(img).then(function (r) { self.postMessage({ id: m.id, ok: true, result: r }); });
    }
  }).catch(function (err) { self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) }); });
};
