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
  res.json({ ok: true, sensor: db.sensor, devices: db.devices, pzem: db.pzem }); // <-- เพิ่ม pzem
});

// ประวัติการใช้ไฟรายวัน สำหรับกราฟเทรนด์ (ดึงจาก Supabase ตาราง pzem_readings) <-- เพิ่ม
// GET /api/pzem/history?days=60  (ไม่ส่ง days มา default 60 วัน)
// แต่ละวันจะมี source บอกด้วยว่าเป็น 'live' (ของจริงจาก ESP) หรือ 'simulated' (ข้อมูลจำลอง backfill)
// เพื่อให้หน้าเว็บวาดกราฟแยกสี/เส้นประช่วงข้อมูลจำลองได้ ไม่ปนจนแยกไม่ออก
router.get('/pzem/history', requireAuthApi, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 60, 1), 180);
  const result = await store.getPzemHistory(days);
  if (!result.ok) return res.status(503).json(result);
  res.json({ ok: true, days: result.rows });
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

// ควบคุมแอร์: ตั้งอุณหภูมิ 18-30 องศา (เฉพาะเลขคู่) ยิง pulse temp_XX ครั้งเดียว ไม่ใช่ไต่ทีละองศา
// body: { "temp": 18 | 20 | 22 | 24 | 26 | 28 | 30 }
const AC_ALLOWED_TEMPS = [18, 20, 22, 24, 26, 28, 30];
router.post('/ac/temp', requireAuthApi, (req, res) => {
  const temp = parseInt(req.body && req.body.temp, 10);
  if (!AC_ALLOWED_TEMPS.includes(temp)) {
    return res.status(400).json({ ok: false, message: 'เลือกได้เฉพาะ 18, 20, 22, 24, 26, 28 หรือ 30 องศาเท่านั้น' });
  }
  const action = `temp_${temp}`;
  const result = heartbeat.requestAcAction(action);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// ควบคุม relay ทั้ง 3 ตัว (First Floor / Air Conditioner / Second Floor): กดปุ๊บเดียว
// เป็น pulse (on แล้วปิดเองอัตโนมัติ) ไม่ต้องกดซ้ำเพื่อปิดเหมือนปุ่มไฟปกติ <-- เพิ่ม
// key: relayFloor1 | relayAircon | relayFloor2
router.post('/relay/:key', requireAuthApi, (req, res) => {
  const result = heartbeat.requestRelayPulse(req.params.key);
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