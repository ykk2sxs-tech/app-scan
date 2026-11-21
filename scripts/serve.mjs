// เซิร์ฟเวอร์ไฟล์ static สำหรับทดสอบในเครื่อง (ไม่ต้องติดตั้งอะไรเพิ่ม)
// ใช้: npm start  แล้วเปิด http://localhost:8080
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const port = Number(process.env.PORT) || 8080;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  // ไฟล์ .traineddata.gz ต้องส่งเป็นไฟล์ gzip ดิบ (ห้ามใส่ Content-Encoding)
  '.gz': 'application/gzip',
  '.md': 'text/plain; charset=utf-8',
};

if (!existsSync(join(root, 'vendor', 'paths.js'))) {
  console.warn('⚠ ยังไม่มี public/vendor — ให้รัน "npm install" (หรือ "npm run build") ก่อน');
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (path.startsWith('..')) {
    res.writeHead(403).end();
    return;
  }
  let file = join(root, path);
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    statSync(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('ไม่พบไฟล์');
    return;
  }
  res.writeHead(200, {
    'Content-Type': types[extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  createReadStream(file).pipe(res);
}).listen(port, '0.0.0.0', () => {
  console.log(`เปิดแอปได้ที่ http://localhost:${port}`);
  for (const nets of Object.values(networkInterfaces())) {
    for (const n of nets || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  (ในวง LAN: http://${n.address}:${port} — มือถือต้องใช้ HTTPS จึงจะเปิดกล้องได้)`);
    }
  }
});
