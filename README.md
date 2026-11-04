# Smart Home Dashboard (Express)

เว็บแดชบอร์ดสำหรับรับข้อมูลเซ็นเซอร์จาก MCU (อุณหภูมิ/ความชื้น ภายนอก-ห้องนอน) และควบคุมแอร์ + ไฟบ้าน
สไตล์ minimal glassmorphism รองรับทั้ง desktop และมือถือ

## ฟีเจอร์
- 🔐 หน้า Login (username: `admin`, password: `admin@123`) + หน้าเปลี่ยนรหัสผ่าน
- 🌡️ แสดงอุณหภูมิ/ความชื้น ภายนอก และห้องนอน (รับข้อมูลผ่าน API จาก MCU)
- ❄️ ปุ่มเปิด/ปิดแอร์ + เลือกอุณหภูมิได้เฉพาะ **24°C หรือ 30°C**
- 💡 ปุ่มไฟหน้าบ้าน 2 ปุ่ม + ไฟห้องนั่งเล่น 2 ปุ่ม (เปิด/ปิดแยกอิสระ)
- 🔄 หน้าเว็บ poll ข้อมูลอัตโนมัติทุก 5 วินาที
- ⏰ route `/200` สำหรับให้ cron job ยิงปลุกเว็บ (กัน Render free tier sleep)

## โครงสร้างไฟล์
```
mcu-dashboard/
├── server.js              # entry point
├── routes/
│   ├── auth.js             # login, logout, change-password
│   ├── api.js               # sensor + device control API
│   └── middleware.js        # auth guard, mcu api key guard
├── data/
│   └── store.js             # เก็บ state ลงไฟล์ data/db.json (สร้างอัตโนมัติ)
├── views/                   # EJS templates
│   ├── login.ejs
│   ├── change-password.ejs
│   └── dashboard.ejs
├── public/
│   ├── css/style.css
│   └── js/dashboard.js
├── render.yaml              # Render blueprint
└── .env.example
```

## รันทดสอบในเครื่อง

```bash
npm install
cp .env.example .env     # แล้วแก้ค่า SESSION_SECRET, MCU_API_KEY ตามต้องการ
npm start
```

เปิด `http://localhost:3000` → จะเด้งไปหน้า `/login`
Login ด้วย `admin` / `admin@123`

## วิธี Deploy บน Render

### วิธีที่ 1: ใช้ render.yaml (แนะนำ)
1. Push โค้ดนี้ขึ้น GitHub repo
2. ไปที่ Render Dashboard → **New** → **Blueprint**
3. เลือก repo นี้ → Render จะอ่าน `render.yaml` และสร้าง service ให้อัตโนมัติ
   (จะ generate `SESSION_SECRET` และ `MCU_API_KEY` แบบสุ่มให้เองด้วย)
4. กด **Apply** รอ build เสร็จ

### วิธีที่ 2: สร้าง Web Service เอง
1. Render Dashboard → **New** → **Web Service**
2. เชื่อมต่อ GitHub repo นี้
3. ตั้งค่า:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. ไปที่ **Environment** เพิ่มตัวแปร:
   - `SESSION_SECRET` = (สุ่มสตริงยาวๆ)
   - `MCU_API_KEY` = (ตั้งรหัสที่จะให้ MCU ใช้ยิงข้อมูลเข้ามา)
   - `NODE_ENV` = `production`
5. Deploy

> ⚠️ **สำคัญ:** `data/db.json` เก็บ state (รหัสผ่าน, สถานะอุปกรณ์) ไว้บน disk ของ container
> Render free tier เป็น **ephemeral filesystem** — แปลว่าทุกครั้งที่ deploy ใหม่หรือ container restart
> ข้อมูลใน `db.json` จะ**รีเซ็ตกลับเป็นค่าเริ่มต้น** (รหัสผ่านจะกลับเป็น `admin@123`, สถานะอุปกรณ์จะรีเซ็ต)
> ถ้าต้องการให้ข้อมูลคงอยู่ถาวร แนะนำอัปเกรดเป็น Render Disk (mount persistent disk ที่ path `/home/claude/mcu-dashboard/data` หรือย้ายไปใช้ database จริง เช่น PostgreSQL/Redis บน Render)

## ตั้ง Cron ปลุกเว็บ (กัน Render free tier sleep)

Render free tier จะ sleep เว็บถ้าไม่มีคนเข้าใน 15 นาที ใช้บริการ cron ฟรีเช่น [cron-job.org](https://cron-job.org) หรือ UptimeRobot
ตั้งให้ยิง GET ไปที่:

```
https://<your-app>.onrender.com/200
```

ทุก 10-14 นาที (ต้องถี่กว่า 15 นาทีที่ Render ใช้ sleep)
Endpoint นี้ตอบกลับ JSON `{ ok: true, status: "awake", ... }` โดยไม่ต้อง login

## วิธีให้ MCU ส่งข้อมูลเซ็นเซอร์

MCU (เช่น ESP32/ESP8266) ส่ง HTTP POST ไปที่:

```
POST https://<your-app>.onrender.com/api/sensor
Content-Type: application/json
x-api-key: <ค่า MCU_API_KEY ที่ตั้งไว้>

{
  "outdoorTemp": 32.5,
  "outdoorHumidity": 68,
  "bedroomTemp": 26.3,
  "bedroomHumidity": 55
}
```

ส่งเฉพาะ field ที่มีข้อมูลก็ได้ (ไม่ต้องส่งครบทุกตัวทุกครั้ง)

ตัวอย่างโค้ด Arduino/ESP32 (แนวทาง):
```cpp
HTTPClient http;
http.begin("https://<your-app>.onrender.com/api/sensor");
http.addHeader("Content-Type", "application/json");
http.addHeader("x-api-key", "YOUR_MCU_API_KEY");

String payload = "{\"outdoorTemp\":" + String(temp1) +
                  ",\"outdoorHumidity\":" + String(hum1) +
                  ",\"bedroomTemp\":" + String(temp2) +
                  ",\"bedroomHumidity\":" + String(hum2) + "}";

int httpCode = http.POST(payload);
http.end();
```

## API Endpoints สรุป

| Method | Path | Auth | คำอธิบาย |
|---|---|---|---|
| GET | `/200` | ไม่ต้อง | health check / cron keep-alive |
| GET/POST | `/login` | ไม่ต้อง | เข้าสู่ระบบ |
| POST | `/logout` | ต้อง login | ออกจากระบบ |
| GET/POST | `/change-password` | ต้อง login | เปลี่ยนรหัสผ่าน |
| GET | `/` | ต้อง login | หน้า dashboard |
| POST | `/api/sensor` | ต้องมี `x-api-key` | MCU ส่งข้อมูลเซ็นเซอร์ |
| GET | `/api/state` | ต้อง login | ดึงสถานะล่าสุด (sensor + devices) |
| POST | `/api/ac/power` | ต้อง login | เปิด/ปิดแอร์ body: `{power: true/false}` |
| POST | `/api/ac/temp` | ต้อง login | ตั้งอุณหภูมิแอร์ body: `{temp: 24 หรือ 30}` |
| POST | `/api/device/:key/toggle` | ต้อง login | toggle ไฟ key: `frontLight1`, `frontLight2`, `livingLight1`, `livingLight2` |

## ความปลอดภัย
- รหัสผ่าน hash ด้วย SHA-256 + salt (ไม่เก็บ plain text)
- Session cookie เป็น httpOnly + secure (บน production)
- Endpoint รับข้อมูลจาก MCU ต้องมี API key เพื่อกันคนภายนอกยิงข้อมูลปลอม
- แนะนำเปลี่ยนรหัสผ่าน default ทันทีหลัง deploy ครั้งแรก ผ่านหน้า `/change-password`
