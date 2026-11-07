const express = require('express');
const router = express.Router();
const store = require('../data/store');
const heartbeat = require('./heartbeat');
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

// ควบคุมแอร์: กดปุ่ม "เปิด" หรือ "ปิด" (ยิง pulse/IR ครั้งเดียว ไม่ใช่ toggle ค้างสถานะ)
// body: { "action": "power_on" | "power_off" }
router.post('/ac/power', requireAuthApi, (req, res) => {
  const action = req.body && req.body.power === false ? 'power_off'
               : req.body && req.body.power === true ? 'power_on'
               : req.body && req.body.action;
  if (action !== 'power_on' && action !== 'power_off') {
    return res.status(400).json({ ok: false, message: 'action ต้องเป็น power_on หรือ power_off' });
  }
  const result = heartbeat.requestAcAction(action);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// ควบคุมแอร์: กดปุ่มอุณหภูมิ 24 หรือ 30 (ยิง pulse temp_up/temp_down ครั้งเดียว ไม่ใช่ตั้งค่าตรงๆ)
// body: { "temp": 24 | 30 }
router.post('/ac/temp', requireAuthApi, (req, res) => {
  const temp = parseInt(req.body && req.body.temp, 10);
  if (temp !== 24 && temp !== 30) {
    return res.status(400).json({ ok: false, message: 'เลือกได้เฉพาะ 24 หรือ 30 องศาเท่านั้น' });
  }
  const action = temp === 24 ? 'temp_down' : 'temp_up';
  const result = heartbeat.requestAcAction(action);
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

  // ส่งคำสั่งไปที่บอร์ดจริง ตามสถานะใหม่ที่ผู้ใช้เห็นบนเว็บ
  const on = storeLightIsOn(req.params.key);
  const cmd = heartbeat.requestLight(req.params.key, on === null ? 'toggle' : (on ? 'on' : 'off'));
  if (!cmd.ok) console.warn(`[light] ${req.params.key}: ${cmd.message}`);

  res.json(result);
});

module.exports = router;