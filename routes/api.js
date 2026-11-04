const express = require('express');
const router = express.Router();
const store = require('../data/store');
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

// ควบคุมไฟ (toggle) - key: frontLight1, frontLight2, livingLight1, livingLight2
router.post('/device/:key/toggle', requireAuthApi, (req, res) => {
  const result = store.toggleDevice(req.params.key);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

module.exports = router;
