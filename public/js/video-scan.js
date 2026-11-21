// โหมดวิดีโอ: อัดวิดีโอจากกล้องพร้อมเลือกเฟรมที่คมชัดที่สุดในแต่ละช่วงเวลาไปทำ OCR
// และดึงเฟรมจากไฟล์วิดีโอที่มีอยู่ในเครื่อง

import { analyzeFrame, signatureDiff, createCanvas, canvasToBlob } from './image-tools.js';

const SAMPLE_MS = 250; // วิเคราะห์เฟรมทุก 0.25 วินาที
const SCENE_DIFF = 6; // ความต่างของภาพขั้นต่ำ (0-255) ที่ถือว่าเป็นหน้าใหม่
export const MAX_FRAMES = 60;

/**
 * เลือก "เฟรมที่คมชัดที่สุด" ในแต่ละช่วงเวลา และข้ามเฟรมที่เป็นฉากเดิม
 * (ยังค้างอยู่ที่เอกสารแผ่นเดิม) ก่อนส่งไป OCR เพื่อประหยัดเวลา
 */
class FramePicker {
  constructor({ intervalMs, maxFrames = MAX_FRAMES }) {
    this.intervalMs = intervalMs;
    this.maxFrames = maxFrames;
    this.work = createCanvas(320, 240);
    this.bestCanvas = null;
    this.best = null;
    this.windowStart = 0;
    this.last = null;
    this.count = 0;
  }

  get full() {
    return this.count >= this.maxFrames;
  }

  offer(src, timeMs) {
    if (this.full) return null;
    const a = analyzeFrame(src, this.work);
    if (!this.best || a.sharpness > this.best.sharpness) {
      const w = src.videoWidth || src.width;
      const h = src.videoHeight || src.height;
      if (!this.bestCanvas || this.bestCanvas.width !== w || this.bestCanvas.height !== h) {
        this.bestCanvas = createCanvas(w, h);
      }
      this.bestCanvas.getContext('2d').drawImage(src, 0, 0, w, h);
      this.best = { ...a, time: timeMs };
    }
    if (timeMs - this.windowStart >= this.intervalMs) return this.flush(timeMs);
    return null;
  }

  flush(nextStart = 0) {
    const b = this.best;
    const canvas = this.bestCanvas;
    this.best = null;
    this.windowStart = nextStart;
    if (!b || this.full) return null;
    // ฉากเดิม และไม่ได้คมชัดขึ้นอย่างมีนัยสำคัญ → ข้าม
    if (
      this.last &&
      signatureDiff(b.signature, this.last.signature) < SCENE_DIFF &&
      b.sharpness < this.last.sharpness * 1.5
    ) {
      return null;
    }
    this.last = b;
    this.count++;
    this.bestCanvas = null; // ส่ง canvas นี้ออกไป แล้วสร้างใหม่รอบหน้า
    return { canvas, time: b.time, sharpness: b.sharpness };
  }
}

function pickMimeType() {
  if (!('MediaRecorder' in window)) return null;
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return types.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
}

/** อัดวิดีโอจากกล้อง + เก็บเฟรมสำหรับ OCR ระหว่างอัด */
export class VideoRecorder {
  constructor(camera, { intervalSec = 2, keepVideo = true, onFrame, onTick } = {}) {
    this.camera = camera;
    this.intervalMs = intervalSec * 1000;
    this.keepVideo = keepVideo;
    this.onFrame = onFrame;
    this.onTick = onTick;
    this.recording = false;
    this.pending = [];
  }

  start() {
    if (!this.camera.active) throw new Error('กล้องยังไม่เปิด');
    this.picker = new FramePicker({ intervalMs: this.intervalMs });
    this.chunks = [];
    this.pending = [];
    this.startedAt = performance.now();
    this.recording = true;

    const mime = this.keepVideo ? pickMimeType() : null;
    if (mime !== null && this.keepVideo) {
      try {
        this.recorder = new MediaRecorder(this.camera.stream, mime ? { mimeType: mime } : undefined);
        this.recorder.ondataavailable = (e) => e.data?.size && this.chunks.push(e.data);
        this.recorder.start(1000);
      } catch {
        this.recorder = null;
      }
    }

    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    this.sample();
  }

  get elapsedMs() {
    return this.recording ? performance.now() - this.startedAt : 0;
  }

  sample() {
    const video = this.camera.video;
    if (!video.videoWidth) return;
    const t = performance.now() - this.startedAt;
    const out = this.picker.offer(video, t);
    if (out) this.emit(out);
    this.onTick?.(t, this.picker.count, this.picker.full);
  }

  emit(out) {
    const p = canvasToBlob(out.canvas, 'image/jpeg', 0.9).then((blob) => this.onFrame?.({ blob, time: out.time }));
    this.pending.push(p);
  }

  async stop() {
    if (!this.recording) return null;
    clearInterval(this.timer);
    this.recording = false;
    const last = this.picker.flush();
    if (last) this.emit(last);
    await Promise.allSettled(this.pending);

    let videoBlob = null;
    if (this.recorder && this.recorder.state !== 'inactive') {
      videoBlob = await new Promise((resolve) => {
        this.recorder.onstop = () =>
          resolve(this.chunks.length ? new Blob(this.chunks, { type: this.recorder.mimeType || 'video/webm' }) : null);
        this.recorder.stop();
      });
    }
    return { videoBlob, frameCount: this.picker.count, durationMs: performance.now() - this.startedAt };
  }
}

function once(target, event, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout: ${event}`));
    }, timeoutMs);
    const ok = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error('อ่านไฟล์วิดีโอไม่ได้ (อาจเป็นรูปแบบที่เบราว์เซอร์ไม่รองรับ)'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, ok);
      target.removeEventListener('error', fail);
    };
    target.addEventListener(event, ok);
    target.addEventListener('error', fail);
  });
}

/** ดึงเฟรมจากไฟล์วิดีโอในเครื่อง (เลือกเฟรมคมที่สุดทุก ๆ intervalSec วินาที) */
export async function extractFramesFromFile(file, { intervalSec = 2, onFrame, onProgress, isCancelled } = {}) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await once(video, 'loadeddata');
    // iOS ต้องเล่นก่อนครั้งหนึ่งจึงจะ seek แล้ววาดเฟรมได้
    await video.play().catch(() => {});
    video.pause();
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('ไม่ทราบความยาววิดีโอ');

    const picker = new FramePicker({ intervalMs: intervalSec * 1000 });
    const step = Math.max(0.2, intervalSec / 3);
    let count = 0;
    const emit = async (out) => {
      const blob = await canvasToBlob(out.canvas, 'image/jpeg', 0.9);
      count++;
      await onFrame?.({ blob, time: out.time });
    };

    for (let t = 0; t < duration && !picker.full; t += step) {
      if (isCancelled?.()) break;
      video.currentTime = Math.min(t, duration - 0.05);
      await once(video, 'seeked', 8000).catch(() => {});
      const out = picker.offer(video, t * 1000);
      if (out) await emit(out);
      onProgress?.(Math.min(1, t / duration));
    }
    const last = picker.flush();
    if (last) await emit(last);
    onProgress?.(1);
    return { frameCount: count, durationMs: duration * 1000 };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
