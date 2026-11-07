const express = require('express');
const router = express.Router();
const store = require('../data/store');
const heartbeat = require('./heartbeat'); // <-- เพิ่ม
const { requireAuthApi, requireMcuKey } = require('./middleware');

/**
 * MCU ส่งข้อมูลเซ็นเซอร์เข้ามาที่ endpoint นี้
 * POST /api/sensor
 * body (JSON): { outdoorTemp, outdoorHumidity, bedroomTemp, bedroomHumidity }
 * header: x-api-key: <MCU_API_KEY>   (หรือ ?key=... ต่อท้าย URL ก็ได้)
 */
router.post('/sensor', requireMcuKey, (req, res) => {
  const { outdoorTemp, outdoorHumidity, bedroomTemp, bedroomHumidity } = req.body;
  const sensor = store.updateSensor({
    outdoorTemp: outdoorTemp !== undefined ? Number(outdoorTemp) : undefined,
    outdoorHumidity: outdoorHumidity !== undefined ? Number(outdoorHumidity) : undefined,
    bedroomTemp: bedroomTemp !== undefined ? Number(bedroomTemp) : undefined,
    bedroomHumidity: bedroomHumidity !== undefined ? Number(bedroomHumidity) : undefined,
  });
  res.json({ ok: true, sensor });
});

// ให้หน้าเว็บ (หลัง login) ดึงข้อมูลล่าสุดแบบ polling
router.get('/state', requireAuthApi, (req, res) => {
  const db = store.getDB();
  res.json({ ok: true, sensor: db.sensor, devices: db.devices });
});

// ควบคุมแอร์: เปิด/ปิด
router.post('/ac/power', requireAuthApi, (req, res) => {
  const { power } = req.body;
  const ac = store.setAcPower(power);
  res.json({ ok: true, ac });
});

// ควบคุมแอร์: เลือกอุณหภูมิ 24 หรือ 30 เท่านั้น
router.post('/ac/temp', requireAuthApi, (req, res) => {
  const { temp } = req.body;
  const result = store.setAcTemp(temp);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// อ่านว่า store บอกว่าไฟดวงนี้ "เปิด" อยู่หรือไม่ (เดารูปแบบข้อมูลหลายแบบ) คืน true/false หรือ null ถ้าอ่านไม่ได้
function storeLightIsOn(key) {
  const devices = store.getDB().devices;
  const v = devices && devices[key];
  if (typeof v === 'boolean') return v;
  if (v && typeof v === 'object') {
    for (const field of ['on', 'state', 'power', 'status']) {
      const x = v[field];
      if (typeof x === 'boolean') return x;
      if (x === 'on' || x === 'ON') return true;
      if (x === 'off' || x === 'OFF') return false;
    }
  }
  return null;
}

// ควบคุมไฟ (toggle) - key: frontLight1, frontLight2, livingLight1, livingLight2
router.post('/device/:key/toggle', requireAuthApi, (req, res) => {
  const result = store.toggleDevice(req.params.key);
  if (!result.ok) return res.status(400).json(result);

  // <-- เพิ่ม: ส่งคำสั่งไปที่บอร์ดจริง ตามสถานะใหม่ที่ผู้ใช้เห็นบนเว็บ
  const on = storeLightIsOn(req.params.key);
  const cmd = heartbeat.requestLight(req.params.key, on === null ? 'toggle' : (on ? 'on' : 'off'));
  if (!cmd.ok) console.warn(`[light] ${req.params.key}: ${cmd.message}`);

  res.json(result);
});

module.exports = router;