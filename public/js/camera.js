// ควบคุมกล้องมือถือ: เปิด/ปิด, สลับกล้องหน้า-หลัง, ไฟแฟลช, ถ่ายภาพความละเอียดสูง

import { toCanvas, canvasToBlob } from './image-tools.js';

const RESOLUTIONS = {
  hd: { width: 1280, height: 720 },
  fhd: { width: 1920, height: 1080 },
  uhd: { width: 3840, height: 2160 },
};

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.facingMode = 'environment';
    this.torchOn = false;
  }

  static get supported() {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  get active() {
    return !!this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  get track() {
    return this.stream?.getVideoTracks()[0] || null;
  }

  async start({ resolution = 'fhd' } = {}) {
    if (!Camera.supported) {
      throw new Error(
        window.isSecureContext
          ? 'เบราว์เซอร์นี้ไม่รองรับการใช้กล้อง'
          : 'ต้องเปิดผ่าน HTTPS จึงจะใช้กล้องได้',
      );
    }
    this.stop();
    const size = RESOLUTIONS[resolution] || RESOLUTIONS.fhd;
    // ขอความละเอียดในแนวนอน — มือถือจะสลับเป็นแนวตั้งให้เองตามการถือเครื่อง
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: this.facingMode },
        width: { ideal: size.width },
        height: { ideal: size.height },
      },
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (err.name === 'OverconstrainedError') {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      } else {
        throw new Error(describeCameraError(err));
      }
    }
    this.torchOn = false;
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play().catch(() => {});
    await waitForVideoSize(this.video);
    // ขอโฟกัสอัตโนมัติต่อเนื่อง (ถ้ากล้องรองรับ)
    const caps = this.capabilities;
    if (caps.focusMode?.includes('continuous')) {
      this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  get capabilities() {
    try {
      return this.track?.getCapabilities?.() || {};
    } catch {
      return {};
    }
  }

  get hasTorch() {
    return !!this.capabilities.torch;
  }

  async setTorch(on) {
    if (!this.hasTorch) return false;
    await this.track.applyConstraints({ advanced: [{ torch: on }] });
    this.torchOn = on;
    return on;
  }

  async switchCamera(options) {
    this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
    await this.start(options);
  }

  /** เฟรมปัจจุบันจากวิดีโอเป็น canvas */
  grabFrame(maxSide = Infinity) {
    if (!this.video.videoWidth) throw new Error('กล้องยังไม่พร้อม');
    return toCanvas(this.video, maxSide);
  }

  /**
   * ถ่ายภาพ: ใช้ ImageCapture (ได้ความละเอียดเต็มเซนเซอร์บน Android)
   * ถ้าไม่รองรับหรือช้าเกินไป จะใช้เฟรมจากวิดีโอแทน
   */
  async takePhoto({ highRes = true } = {}) {
    if (highRes && 'ImageCapture' in window && this.track) {
      try {
        const ic = new window.ImageCapture(this.track);
        const blob = await withTimeout(ic.takePhoto(), 5000);
        if (blob && blob.size > 0) {
          // บางเครื่องปิดไฟแฟลชหลัง takePhoto — เปิดกลับให้
          if (this.torchOn) this.setTorch(true).catch(() => {});
          return blob;
        }
      } catch {
        /* ใช้วิธีสำรอง */
      }
    }
    return canvasToBlob(this.grabFrame(), 'image/jpeg', 0.92);
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

function waitForVideoSize(video) {
  if (video.videoWidth) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('loadedmetadata', done);
      resolve();
    };
    video.addEventListener('loadedmetadata', done);
    setTimeout(done, 3000);
  });
}

function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'ไม่ได้รับอนุญาตให้ใช้กล้อง — กรุณาอนุญาตการเข้าถึงกล้องในการตั้งค่าเบราว์เซอร์';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'ไม่พบกล้องในอุปกรณ์นี้';
    case 'NotReadableError':
      return 'กล้องถูกใช้งานโดยแอปอื่นอยู่ — ปิดแอปอื่นแล้วลองใหม่';
    default:
      return `เปิดกล้องไม่สำเร็จ (${err?.message || err})`;
  }
}
