# การใช้ไฟ: ประวัติ PZEM + กราฟเทรนด์

## สรุปสิ่งที่เพิ่ม
- ตาราง Supabase ใหม่ `pzem_readings` — เก็บทุก reading ของ PZEM (โวลต์/แอมป์/วัตต์/พลังงาน/ความถี่/PF)
  พร้อมคอลัมน์ `source` บอกว่าเป็น `'live'` (ของจริงจาก ESP) หรือ `'simulated'` (ข้อมูลจำลอง backfill จาก Excel)
- `store.js` — เพิ่ม `updatePzem()` (เดิมแค่เก็บในแรม/db.json ตอนนี้ insert ประวัติลง Supabase ด้วย),
  `insertPzemReading()`, `getPzemHistory()`
- `api.js` — เพิ่ม `GET /api/pzem/history?days=60` ให้หน้าเว็บดึงไปวาดกราฟ
- `dashboard.ejs` / `dashboard.js` — เพิ่มกราฟเทรนด์การใช้ไฟรายวัน ต่อจากการ์ด PZEM เดิม (ใช้ Chart.js จาก CDN)
- `seed_simulated_pzem.js` — สคริปต์ที่รันครั้งเดียว อ่าน Excel 61 วันของคุณ → gen เป็น reading รายนาที
  (ความถี่เดียวกับที่ ESP ส่งจริงทุก 1 นาที) → insert ลง Supabase โดย mark `source: 'simulated'`

## ทำไมต้องมีคอลัมน์ `source` แยก live/simulated
กราฟและการ์ดบนหน้าเว็บโชว์ตัวเลขไฟฟ้าให้คนดูเชื่อว่าคือค่าที่วัดได้จริง ถ้าข้อมูลจำลองปนกับของจริงจน
แยกไม่ออก จะไม่มีทางรู้ภายหลังว่าช่วงไหนในกราฟเป็นค่าจริง ช่วงไหนเป็นค่าที่แต่งขึ้น — เป็นปัญหาถ้าใช้อ้างอิง
เรื่องบิลค่าไฟ หรือ debug ปัญหาไฟฟ้าจริงในอนาคต จึงเก็บ `source` ไว้ในคอลัมน์เดียวกันของตารางเดียวกัน
(query ร่วมกันได้ปกติ ไม่ต้อง join ข้ามตาราง ตามที่ต้องการ) แค่ไม่ลบทิ้งคอลัมน์นี้ไป

กราฟหน้าเว็บจะวาดเป็นเส้นต่อเนื่องเส้นเดียวตามปกติ (ไม่รบกวนการดู) แต่ช่วงที่เป็นข้อมูลจำลองจะเป็น
สีจาง+เส้นประ ให้สังเกตได้

## ขั้นตอนติดตั้ง

### 1. สร้างตารางใน Supabase
เปิด Supabase Dashboard → SQL Editor → New query → วางเนื้อหาจาก `pzem_readings_schema.sql` → Run

### 2. แทนที่ไฟล์เดิมในโปรเจกต์
คัดลอกทับไฟล์เดิม (path อิงจากโครงสร้างที่เห็นในโค้ดคุณ):
- `data/store.js`
- `routes/heartbeat.js`
- `routes/api.js`
- `views/dashboard.ejs`
- `public/js/dashboard.js`

### 3. วาง Excel + รันสคริปต์ seed (รันครั้งเดียว)
```bash
# วางไฟล์ Excel ไว้ที่
cp simulated_electricity_usage.xlsx data/simulated_electricity_usage.xlsx

# ติดตั้ง dependency ที่ยังไม่มี
npm install xlsx

# วาง seed_simulated_pzem.js ไว้ที่ scripts/seed_simulated_pzem.js
# ตรวจว่า env SUPABASE_URL / SUPABASE_SERVICE_KEY ตั้งไว้แล้ว (ในเครื่อง หรือ export ชั่วคราวก่อนรัน)
node scripts/seed_simulated_pzem.js
```
สคริปต์จะเช็คก่อนว่ามีข้อมูล `source='simulated'` อยู่แล้วหรือยัง ถ้ามีจะไม่ insert ซ้ำ (กันกดรันซ้ำโดยไม่ตั้งใจ)
ถ้าต้องการ seed ใหม่ ให้ลบของเดิมก่อน:
```sql
delete from pzem_readings where source = 'simulated';
```

### 4. Deploy ขึ้น Render ตามปกติ
ของจริงจาก ESP จะเริ่มถูกบันทึกลง `pzem_readings` อัตโนมัติ (`source: 'live'`) ทุกครั้งที่ heartbeat
เข้ามา (ทุก 1 นาที) ผ่าน `store.updatePzem()` ที่แก้ไว้แล้ว ไม่ต้องทำอะไรเพิ่ม

## หมายเหตุ
- ผลรวมพลังงานจำลองต่อวันถูกคุมให้ตรงกับตัวเลข kWh จริงจากไฟล์ Excel ของคุณเป๊ะ (รวม 61 วัน = 587.02 kWh)
  รูปแบบรายชั่วโมงใช้เส้นโค้งโหลดบ้านทั่วไป (ต่ำตอนดึก/กลางวันไม่มีคนอยู่ พีคช่วงเย็น-หัวค่ำ)
- `GET /api/pzem/history?days=60` ต้อง login (ใช้ cookie เดียวกับหน้าเว็บ) — เรียกจาก dashboard.js อัตโนมัติ
- ถ้ายังไม่ได้ตั้ง Supabase env ทุกอย่างยังทำงานปกติเหมือนเดิม แค่กราฟจะโชว์ "ยังไม่มีข้อมูลย้อนหลัง"
