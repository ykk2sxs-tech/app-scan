# OpenThai2.0-OCR-Text (iApp Technology)

| ไฟล์ | คืออะไร |
|---|---|
| `det.onnx` | โมเดลหาบรรทัดข้อความ (PP-OCRv6_tiny_det) |
| `rec.onnx` | โมเดลอ่านบรรทัด (PP-OCRv6_tiny_rec ที่ iApp ฝึกเพิ่มด้วยตัวจำแนกภาษาไทย) |
| `rec_dict.txt` | รายการตัวอักษร 528 ตัว (ลำดับต้องตรงกับ rec.onnx) |
| `LICENSE`, `NOTICE` | Apache License 2.0 และประกาศลิขสิทธิ์ที่ต้องแนบไปด้วย |
| `SHA256SUMS` | ค่าแฮชของไฟล์โมเดล |

ต้นฉบับ: https://huggingface.co/iapp/OpenThai2.0-OCR-Text

ไฟล์ชุดนี้ดึงออกมาจากไฟล์ `invoice-to-journal.html` ของผู้ใช้ ยังไม่ได้เทียบกับไฟล์บน Hugging Face โดยตรง
ถ้าต้องการเปลี่ยนเป็นรุ่นใหม่ (เช่น OpenThai2.1) ให้วางไฟล์ทั้งสามชุดใหม่ในโฟลเดอร์ชื่อใหม่
แล้วแก้ `OPENTHAI_MODEL_DIR` ใน `public/js/openthai.js` ชื่อโฟลเดอร์ต้องเปลี่ยน เพราะ service worker แคชโฟลเดอร์ `models/` แบบ cache-first
