const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  // action: 'power_on' | 'power_off' | 'temp_up' | 'temp_down'
  // แค่บันทึกไว้โชว์บนเว็บว่า "กดอะไรไปล่าสุด" เท่านั้น ไม่ได้แปลว่าแอร์อยู่ในสถานะนั้นจริง
  recordAcAction(action, temp) {
    const allowed = ['power_on', 'power_off', 'temp_up', 'temp_down'];
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
  }
};