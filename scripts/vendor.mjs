// คัดลอกไลบรารีที่ต้องใช้จาก node_modules ไปไว้ที่ public/vendor
// เพื่อให้แอปทำงานได้โดยไม่ต้องพึ่ง CDN และใช้งานออฟไลน์ได้
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'public', 'vendor');

const version = (pkg) => JSON.parse(readFileSync(join(nm, pkg, 'package.json'), 'utf8')).version;

if (!existsSync(join(nm, 'tesseract.js'))) {
  console.error('ไม่พบ node_modules — ให้รัน "npm install" ก่อน');
  process.exit(1);
}

const v = {
  tesseract: version('tesseract.js'),
  core: version('tesseract.js-core'),
  docx: version('docx'),
  ort: version('onnxruntime-web'),
  pdflib: version('pdf-lib'),
  fontkit: version('@pdf-lib/fontkit'),
  sarabun: version('@expo-google-fonts/sarabun'),
};

// โฟลเดอร์มีเลขเวอร์ชันกำกับ เพื่อให้ service worker แคชแบบ cache-first ได้อย่างปลอดภัย
const dirs = {
  tesseract: `tesseract.js-${v.tesseract}`,
  core: `tesseract-core-${v.core}`,
  lang: 'lang-4.0.0_best_int',
  docx: `docx-${v.docx}`,
  ort: `onnxruntime-web-${v.ort}`,
  pdflib: `pdf-lib-${v.pdflib}`,
  font: `sarabun-${v.sarabun}`,
};

rmSync(out, { recursive: true, force: true });
const copy = (from, to) => {
  mkdirSync(dirname(join(out, to)), { recursive: true });
  cpSync(join(nm, from), join(out, to));
};

copy('tesseract.js/dist/tesseract.min.js', `${dirs.tesseract}/tesseract.min.js`);
copy('tesseract.js/dist/worker.min.js', `${dirs.tesseract}/worker.min.js`);
copy('tesseract.js/LICENSE.md', `${dirs.tesseract}/LICENSE.md`);

// ใช้เฉพาะ LSTM engine (oem = 1) จึงคัดลอกเฉพาะไฟล์ core ที่เป็น -lstm
for (const variant of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) {
  copy(`tesseract.js-core/tesseract-core-${variant}.wasm.js`, `${dirs.core}/tesseract-core-${variant}.wasm.js`);
}
copy('tesseract.js-core/LICENSE', `${dirs.core}/LICENSE`);

for (const lang of ['tha', 'eng']) {
  copy(`@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`, `${dirs.lang}/${lang}.traineddata.gz`);
}

copy('docx/dist/index.iife.js', `${dirs.docx}/docx.iife.js`);
copy('docx/LICENSE', `${dirs.docx}/LICENSE`);

// onnxruntime-web สำหรับรันโมเดล OpenThai2.0-OCR-Text (ใช้เฉพาะ WASM CPU)
for (const f of ['ort.wasm.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  copy(`onnxruntime-web/dist/${f}`, `${dirs.ort}/${f}`);
}
// pdf-lib + fontkit สำหรับสร้าง PDF ที่ค้นหาข้อความได้ และฟอนต์ Sarabun (OFL) สำหรับชั้นข้อความภาษาไทย
copy('pdf-lib/dist/pdf-lib.min.js', `${dirs.pdflib}/pdf-lib.min.js`);
copy('pdf-lib/LICENSE.md', `${dirs.pdflib}/LICENSE-pdf-lib.md`);
copy('@pdf-lib/fontkit/dist/fontkit.umd.min.js', `${dirs.pdflib}/fontkit.umd.min.js`);
// แพ็กเกจ @pdf-lib/fontkit ไม่มีไฟล์ LICENSE แยก — เขียนประกาศไว้ให้
writeFileSync(
  join(out, dirs.pdflib, 'LICENSE-fontkit'),
  '@pdf-lib/fontkit (fork of fontkit by Devon Govett) — Licensed under the MIT License: https://github.com/Hopding/fontkit\n',
);
copy('@expo-google-fonts/sarabun/400Regular/Sarabun_400Regular.ttf', `${dirs.font}/Sarabun-Regular.ttf`);
copy('@expo-google-fonts/sarabun/LICENSE_FONT', `${dirs.font}/OFL.txt`);

// แพ็กเกจ npm ไม่มีไฟล์ LICENSE แยก (ประกาศ MIT อยู่ในหัวไฟล์ ort.wasm.min.js) จึงเขียนไว้ให้
writeFileSync(
  join(out, dirs.ort, 'LICENSE'),
  'onnxruntime-web — Copyright (c) Microsoft Corporation.\nLicensed under the MIT License: https://github.com/microsoft/onnxruntime/blob/main/LICENSE\n',
);

writeFileSync(
  join(out, 'paths.js'),
  `// สร้างอัตโนมัติโดย scripts/vendor.mjs — ห้ามแก้ไขด้วยมือ
export const VENDOR = ${JSON.stringify(
    {
      tesseract: `vendor/${dirs.tesseract}/tesseract.min.js`,
      worker: `vendor/${dirs.tesseract}/worker.min.js`,
      core: `vendor/${dirs.core}`,
      lang: `vendor/${dirs.lang}`,
      docx: `vendor/${dirs.docx}/docx.iife.js`,
      ort: `vendor/${dirs.ort}/ort.wasm.min.js`,
      ortDir: `vendor/${dirs.ort}/`,
      pdflib: `vendor/${dirs.pdflib}/pdf-lib.min.js`,
      fontkit: `vendor/${dirs.pdflib}/fontkit.umd.min.js`,
      thaiFont: `vendor/${dirs.font}/Sarabun-Regular.ttf`,
      versions: v,
    },
    null,
    2,
  )};
`,
);

console.log(
  `✔ คัดลอกไลบรารีไปที่ public/vendor แล้ว (tesseract.js ${v.tesseract}, core ${v.core}, docx ${v.docx}, onnxruntime-web ${v.ort})`,
);
