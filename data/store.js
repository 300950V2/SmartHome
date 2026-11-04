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
      ac: { power: false, temp: 24 },      // แอร์: เปิด/ปิด + อุณหภูมิ (24 หรือ 30 เท่านั้น)
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
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
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

  // ---- devices ----
  setAcPower(power) {
    db.devices.ac.power = !!power;
    save(db);
    return db.devices.ac;
  },
  setAcTemp(temp) {
    const t = parseInt(temp, 10);
    if (t !== 24 && t !== 30) {
      return { ok: false, message: 'เลือกได้เฉพาะ 24 หรือ 30 องศาเท่านั้น' };
    }
    db.devices.ac.temp = t;
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
