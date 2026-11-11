const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { supabase } = require('./supabase'); // เก็บ pzem_readings ลง Supabase (รอดจาก Render restart)

const DB_FILE = path.join(__dirname, 'db.json');

// ---- helper: hash password ด้วย sha256 + salt แบบง่าย (ไม่ต้องพึ่ง lib เสริม) ----
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + password).digest('hex');
}

function defaultData() {
  const salt = crypto.randomBytes(8).toString('hex');
  return {
    user: {
      username: 'admin',
      salt: salt,
      passwordHash: hashPassword('admin@123', salt)
    },
    sensor: {
      outdoor: { temp: null, humidity: null },
      bedroom: { temp: null, humidity: null },
      lastUpdate: null
    },
    devices: {
      // แอร์: เป็น IR แบบกดยิงสัญญาณ (pulse) ไม่มี state จริงให้อ่าน
      // lastAction / lastTemp เก็บไว้แค่โชว์บนเว็บว่า "กดอะไรไปล่าสุด" ไม่ใช่สถานะจริงของแอร์
      ac: { lastAction: null, lastTemp: null, lastActionAt: null },
      frontLight1: false,                   // ไฟหน้าบ้าน ดวงที่ 1
      frontLight2: false,                   // ไฟหน้าบ้าน ดวงที่ 2
      livingLight1: false,                  // ไฟห้องนั่งเล่น ดวงที่ 1
      livingLight2: false                   // ไฟห้องนั่งเล่น ดวงที่ 2
    },
    // ค่า PZEM ล่าสุด (แสดงบนการ์ดเดียวในหน้าเว็บ) — ประวัติย้อนหลังทั้งหมดเก็บที่ Supabase ตาราง
    // pzem_readings (ดู updatePzem/insertPzemReading/getPzemHistory ด้านล่าง) ไม่ได้เก็บในไฟล์นี้
    pzem: {
      voltage: null,
      current: null,
      power: null,
      energy: null,
      frequency: null,
      powerFactor: null,
      lastUpdate: null
    }
  };
}

function load() {
  if (!fs.existsSync(DB_FILE)) {
    const fresh = defaultData();
    fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    // migrate: ถ้าเป็น db.json เก่าที่ ac ยังเป็น { power, temp } ให้แปลงเป็นรูปแบบใหม่
    if (data.devices && data.devices.ac && typeof data.devices.ac.power === 'boolean') {
      data.devices.ac = { lastAction: null, lastTemp: null, lastActionAt: null };
      save(data);
    }
    return data;
  } catch (e) {
    const fresh = defaultData();
    fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

function save(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let db = load();

module.exports = {
  hashPassword,
  getDB: () => db,
  reload: () => { db = load(); return db; },
  persist: () => save(db),

  // ---- user ----
  verifyLogin(username, password) {
    if (username !== db.user.username) return false;
    const hash = hashPassword(password, db.user.salt);
    return hash === db.user.passwordHash;
  },
  changePassword(oldPassword, newPassword) {
    if (!this.verifyLogin(db.user.username, oldPassword)) {
      return { ok: false, message: 'รหัสผ่านเดิมไม่ถูกต้อง' };
    }
    const salt = crypto.randomBytes(8).toString('hex');
    db.user.salt = salt;
    db.user.passwordHash = hashPassword(newPassword, salt);
    save(db);
    return { ok: true };
  },

  // ---- sensor ----
  updateSensor({ outdoorTemp, outdoorHumidity, bedroomTemp, bedroomHumidity }) {
    if (outdoorTemp !== undefined) db.sensor.outdoor.temp = outdoorTemp;
    if (outdoorHumidity !== undefined) db.sensor.outdoor.humidity = outdoorHumidity;
    if (bedroomTemp !== undefined) db.sensor.bedroom.temp = bedroomTemp;
    if (bedroomHumidity !== undefined) db.sensor.bedroom.humidity = bedroomHumidity;
    db.sensor.lastUpdate = new Date().toISOString();
    save(db);
    return db.sensor;
  },

  // ---- devices: AC (แบบกดยิงสัญญาณ ไม่ใช่ toggle) ----
  // action: 'power_on' | 'power_off' | 'temp_18' | 'temp_20' | 'temp_22' | 'temp_24' | 'temp_26' | 'temp_28' | 'temp_30'
  // แค่บันทึกไว้โชว์บนเว็บว่า "กดอะไรไปล่าสุด" เท่านั้น ไม่ได้แปลว่าแอร์อยู่ในสถานะนั้นจริง
  recordAcAction(action, temp) {
    const allowed = ['power_on', 'power_off', 'temp_18', 'temp_20', 'temp_22', 'temp_24', 'temp_26', 'temp_28', 'temp_30'];
    if (!allowed.includes(action)) {
      return { ok: false, message: 'คำสั่งแอร์ไม่ถูกต้อง' };
    }
    db.devices.ac.lastAction = action;
    db.devices.ac.lastActionAt = new Date().toISOString();
    if (temp !== undefined) db.devices.ac.lastTemp = temp;
    save(db);
    return { ok: true, ac: db.devices.ac };
  },

  toggleDevice(key) {
    const allowed = ['frontLight1', 'frontLight2', 'livingLight1', 'livingLight2'];
    if (!allowed.includes(key)) return { ok: false, message: 'ไม่พบอุปกรณ์นี้' };
    db.devices[key] = !db.devices[key];
    save(db);
    return { ok: true, state: db.devices[key] };
  },

  // ---- PZEM: ค่าไฟฟ้าล่าสุด (สำหรับการ์ดสดบนหน้าเว็บ) ----
  // update: { voltage, current, power, energy, frequency, powerFactor } (ค่าไหนไม่ส่งมาจะคงค่าเดิมไว้)
  // เขียนลง db.json ไว้โชว์ค่าล่าสุดเร็วๆ และ insert เป็นแถวใหม่ลง Supabase ตาราง pzem_readings เพื่อสะสมเป็นประวัติ
  // ถ้า insert ลง Supabase ไม่สำเร็จ (เช่นยังไม่ได้ตั้ง env) ค่าล่าสุดในเว็บจะยังอัปเดตปกติ แค่ประวัติจะไม่ถูกบันทึกเพิ่ม
  updatePzem({ voltage, current, power, energy, frequency, powerFactor }) {
    if (voltage !== undefined) db.pzem.voltage = voltage;
    if (current !== undefined) db.pzem.current = current;
    if (power !== undefined) db.pzem.power = power;
    if (energy !== undefined) db.pzem.energy = energy;
    if (frequency !== undefined) db.pzem.frequency = frequency;
    if (powerFactor !== undefined) db.pzem.powerFactor = powerFactor;
    db.pzem.lastUpdate = new Date().toISOString();
    save(db);

    // บันทึกประวัติลง Supabase แบบ fire-and-forget (ไม่ await ไม่ให้ heartbeat endpoint ช้า)
    this.insertPzemReading({
      recordedAt: db.pzem.lastUpdate,
      voltage: db.pzem.voltage,
      current: db.pzem.current,
      power: db.pzem.power,
      energy: db.pzem.energy,
      frequency: db.pzem.frequency,
      powerFactor: db.pzem.powerFactor
    }).then(r => {
      if (!r.ok && supabase) console.error('[store] insertPzemReading error:', r.message);
    }).catch(err => console.error('[store] insertPzemReading error:', err.message));

    return db.pzem;
  },

  // ---- PZEM: insert แถวประวัติ 1 แถวลง Supabase ตาราง pzem_readings ----
  // reading: { recordedAt (ISO string), voltage, current, power, energy, frequency, powerFactor }
  // ทุกแถวเหมือนกันหมด ไม่มีคอลัมน์บอกที่มา (ข้อมูลที่ backfill ด้วย scripts/seed_simulated_pzem.js ก็อยู่ในตารางเดียวกัน)
  async insertPzemReading(reading) {
    if (!supabase) return { ok: false, message: 'ยังไม่ได้ตั้งค่า Supabase' };
    const { error } = await supabase.from('pzem_readings').insert({
      recorded_at: reading.recordedAt || new Date().toISOString(),
      voltage: reading.voltage ?? null,
      current: reading.current ?? null,
      power: reading.power ?? null,
      energy: reading.energy ?? null,
      frequency: reading.frequency ?? null,
      power_factor: reading.powerFactor ?? null
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  },

  // ---- PZEM: หน่วยไฟรายวัน (kWh) ย้อนหลัง สำหรับกราฟเทรนด์ ----
  // คำนวณในฐานข้อมูลด้วยฟังก์ชัน pzem_daily_usage() (ดู pzem_readings_schema.sql) เพราะ Supabase ตอบได้แค่ 1,000 แถว
  // ต่อคำขอ แต่ข้อมูลรายนาทีมีวันละ 1,440 แถว — ถ้า select แถวดิบมาสรุปเองที่ Node จะได้ไม่ครบ
  // คืนครบทุกวันในช่วง เรียงเก่า -> ใหม่ : [{ date: 'YYYY-MM-DD', kwh: number | null }]
  // (วันไหนไม่มีข้อมูลเลยจะเป็น kwh = null, วันนับตามเวลาไทย, วันนี้เป็นยอดสะสมถึงตอนนี้)
  async getPzemHistory(days = 60) {
    if (!supabase) return { ok: false, message: 'ยังไม่ได้ตั้งค่า Supabase', rows: [] };
    const { data, error } = await supabase.rpc('pzem_daily_usage', { p_days: days });
    if (error) return { ok: false, message: error.message, rows: [] };
    const rows = (data || []).map(r => ({
      date: String(r.usage_date).slice(0, 10),
      kwh: r.kwh === null || r.kwh === undefined ? null : Number(r.kwh)
    }));
    return { ok: true, rows };
  }
};
