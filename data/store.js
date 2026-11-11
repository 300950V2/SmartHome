const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { supabase } = require('./supabase'); // <-- เพิ่ม: เก็บ pzem_readings ลง Supabase (รอดจาก Render restart)

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
    // ค่า PZEM ล่าสุด (แสดงบนการ์ดเดียวในหน้าเว็บ) — ประวัติย้อนหลังเก็บแยกอยู่ที่ Supabase ตาราง
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
  // เขียนลง db.json ไว้โชว์ค่าล่าสุดเร็วๆ เหมือนเดิม และ insert เป็นแถวใหม่ลง Supabase (source: 'live')
  // เพื่อสะสมเป็นประวัติสำหรับกราฟเทรนด์ — ถ้า insert ลง Supabase ไม่สำเร็จ (เช่นยังไม่ได้ตั้ง env)
  // ค่าล่าสุดในเว็บจะยังอัปเดตปกติ แค่ประวัติจะไม่ถูกบันทึกเพิ่มเท่านั้น
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
      powerFactor: db.pzem.powerFactor,
      source: 'live'
    }).catch(err => console.error('[store] insertPzemReading (live) error:', err.message));

    return db.pzem;
  },

  // ---- PZEM: insert แถวประวัติ 1 แถวลง Supabase ตาราง pzem_readings ----
  // ใช้ทั้งจาก updatePzem() ด้านบน (source: 'live') และจากสคริปต์ seed ข้อมูลจำลอง (source: 'simulated')
  // reading: { recordedAt (ISO string), voltage, current, power, energy, dailyKwh, frequency, powerFactor, source }
  async insertPzemReading(reading) {
    if (!supabase) return { ok: false, message: 'ยังไม่ได้ตั้งค่า Supabase' };
    const source = reading.source === 'simulated' ? 'simulated' : 'live';
    const { error } = await supabase.from('pzem_readings').insert({
      recorded_at: reading.recordedAt || new Date().toISOString(),
      voltage: reading.voltage ?? null,
      current: reading.current ?? null,
      power: reading.power ?? null,
      energy: reading.energy ?? null,
      daily_kwh: reading.dailyKwh ?? null,
      frequency: reading.frequency ?? null,
      power_factor: reading.powerFactor ?? null,
      source
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  },

  // ---- PZEM: ดึงประวัติย้อนหลังสำหรับกราฟเทรนด์ ----
  // คืนรายวัน (รวม/เฉลี่ยต่อวันแล้ว) เรียงจากเก่าไปใหม่ พร้อมบอกว่าวันนั้นมี source อะไรบ้าง
  // (ปกติแต่ละวันจะมี source เดียว แต่ถ้าเผื่อคาบเกี่ยวกันจะ mark เป็น 'mixed')
  async getPzemHistory(days = 60) {
    if (!supabase) return { ok: false, message: 'ยังไม่ได้ตั้งค่า Supabase', rows: [] };
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('pzem_readings')
      .select('recorded_at, daily_kwh, energy, source')
      .gte('recorded_at', since)
      .order('recorded_at', { ascending: true });
    if (error) return { ok: false, message: error.message, rows: [] };

    // รวมเป็นรายวัน: ใช้ daily_kwh ล่าสุดของแต่ละวัน (หรือถ้าไม่มี ให้ max(energy) - min(energy) ของวันนั้น)
    const byDate = new Map(); // 'YYYY-MM-DD' -> { kwh, sources:Set }
    for (const row of data) {
      const day = row.recorded_at.slice(0, 10);
      if (!byDate.has(day)) byDate.set(day, { kwh: null, sources: new Set(), energyMin: null, energyMax: null });
      const entry = byDate.get(day);
      entry.sources.add(row.source);
      if (row.daily_kwh !== null && row.daily_kwh !== undefined) {
        entry.kwh = row.daily_kwh; // reading ล่าสุดในวันนั้นชนะ (daily_kwh สะสมขึ้นเรื่อยๆ ในวันเดียวกัน)
      }
      if (row.energy !== null && row.energy !== undefined) {
        entry.energyMin = entry.energyMin === null ? row.energy : Math.min(entry.energyMin, row.energy);
        entry.energyMax = entry.energyMax === null ? row.energy : Math.max(entry.energyMax, row.energy);
      }
    }

    const rows = [...byDate.entries()].map(([date, entry]) => ({
      date,
      kwh: entry.kwh !== null ? entry.kwh
         : (entry.energyMin !== null ? Math.round((entry.energyMax - entry.energyMin) / 1000 * 100) / 100 : null),
      source: entry.sources.size > 1 ? 'mixed' : [...entry.sources][0]
    })).sort((a, b) => a.date.localeCompare(b.date));

    return { ok: true, rows };
  }
};