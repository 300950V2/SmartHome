// routes/heartbeat.js
// 1) รับ heartbeat + สถานะ ESP จากบอร์ด (Raspberry Pi / Home Assistant) และแจ้ง LINE เมื่อสัญญาณหาย (ไฟดับ)
// 2) ให้บอร์ดมา "ถาม" ทุกไม่กี่วินาทีว่ามีคำสั่งเปิด/ปิดไฟ หรือคำสั่งแอร์ (pulse) ค้างอยู่ไหม (POST /api/heartbeat/poll)
// 3) สถานะ online/offline เก็บไว้ที่ Supabase (ตาราง heartbeat_state) ด้วย เพื่อให้รอดจากการที่ Render
//    sleep/restart แล้ว state ในแรมหาย — กันไม่ให้แจ้ง LINE ซ้ำๆ ทุกครั้งที่เซิร์ฟเวอร์ตื่นใหม่
// 4) แจ้ง LINE เมื่อเบรกเกอร์ชั้น 1 หรือชั้น 2 ตัดไฟ (โมดูลดับ) <-- เพิ่ม
// 5) อ่านค่าไฟฟ้าจาก PZEM (โวลต์/แอมป์/วัตต์ ฯลฯ) มาโชว์ในเว็บ + ปุ่มสั่งเปิด/ปิด
//    relay ทั้ง 3 ตัว (First Floor / Air Conditioner / Second Floor) แบบสวิตช์ค้าง (เหมือนปุ่มใน HA):
//    เว็บกด 1 ครั้ง = เซิร์ฟเวอร์ส่งคำสั่งเดียว "on" หรือ "off" (สลับจากสถานะปัจจุบัน) แล้วค้างตามนั้น
//    ไม่มี off ตามหลังอัตโนมัติ และไม่ต้องแก้ HA / ESPHome <-- แก้
//
// ENV ที่ต้องตั้งบน Render:
//   HEARTBEAT_TOKEN             รหัสลับ (ต้องตรงกับที่ตั้งฝั่ง Home Assistant)
//   LINE_CHANNEL_ACCESS_TOKEN   Channel access token (long-lived) จาก LINE Developers
//   LINE_TO                     userId หรือ groupId ที่จะให้ส่งแจ้งเตือนไปหา
//   HEARTBEAT_TIMEOUT_SEC       (ไม่บังคับ) ขาดสัญญาณกี่วินาทีถึงแจ้ง ค่าเริ่มต้น 180
//   SUPABASE_URL                (ไม่บังคับ) ถ้าไม่ตั้ง จะใช้ state ในแรมอย่างเดียวเหมือนเดิม
//   SUPABASE_SERVICE_KEY        (ไม่บังคับ) คู่กับ SUPABASE_URL

const express = require('express');
const crypto = require('crypto');
const store = require('../data/store');
const { supabase } = require('../data/supabase');
const { requireAuth, requireAuthApi } = require('./middleware');

const router = express.Router();

const TOKEN = process.env.HEARTBEAT_TOKEN || '';
const TIMEOUT_MS = (parseInt(process.env.HEARTBEAT_TIMEOUT_SEC, 10) || 180) * 1000;
const CHECK_INTERVAL_MS = 30 * 1000;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_TO = process.env.LINE_TO || '';
const CMD_TTL_MS = 60 * 1000;     // คำสั่งไฟที่บอร์ดไม่ทำตามภายในเวลานี้ จะถูกทิ้ง
const AC_CMD_TTL_MS = 30 * 1000;  // คำสั่งแอร์ (pulse) ถ้าค้างนานเกินนี้โดยไม่มีบอร์ดมาเอาไป ก็ทิ้ง
const RELAY_CMD_TTL_MS = 30 * 1000; // คำสั่ง relay ถ้าค้างนานเกินนี้โดยไม่มีบอร์ดมาเอาไป ก็ทิ้ง

// เริ่มต้นให้ lastBeat = เวลาที่เซิร์ฟเวอร์เริ่มทำงาน
// (ค่าพวกนี้คือ cache ในแรม ใช้ตอบ /status เร็วๆ — ความจริงที่ยืนยันแล้วอยู่ที่ Supabase
//  ถ้ามีการตั้งค่าไว้ จะโหลดจาก Supabase มาทับตอนสตาร์ตเซิร์ฟเวอร์ใน loadStateFromDB())
const state = {
  lastBeat: Date.now(),
  lastInfo: null,
  offline: false,
  offlineSince: null,
  esp: Object.create(null),      // สถานะ entity ของ ESP แต่ละตัว { ชื่ออุปกรณ์: { entity_id: state } } (ส่งทุก 1 นาที)
  espUpdatedAt: null,
  switches: Object.create(null), // สถานะรีเลย์ล่าสุด { entity_id: state } (ส่งทุกครั้งที่ poll สดกว่า esp)
  switchesAt: null
};

// คำสั่งไฟที่รอให้บอร์ดทำ: lightKey -> { target: 'on'|'off', at: เวลาที่สั่ง }
const pending = new Map();

// คำสั่งแอร์ที่รอให้บอร์ดยิง (pulse ครั้งเดียว แล้วลบทิ้ง ไม่ต้องรอเทียบ state):
// คิวเดียว เก็บตามลำดับ { action: 'power_on'|'power_off'|'temp_18'...'temp_30', at }
let acQueue = [];

// ---- ผูกชื่อ entity ใน HA เข้ากับค่าในระบบ (แก้ที่นี่ที่เดียว) ----
// เซนเซอร์: เอาไปอัปเดต store.updateSensor() ให้ dashboard แสดงค่าจริง
const SENSOR_MAP = {
  outdoorTemp: 'sensor.dht_sensor_esp_temperature_outdoor',
  outdoorHumidity: 'sensor.dht_sensor_esp_humidity_outdoor',
  bedroomTemp: 'sensor.dht_sensor_esp_temperature_indoor',      // สมมติว่า indoor = ห้องนอน
  bedroomHumidity: 'sensor.dht_sensor_esp_humidity_indoor'
};
// PZEM 004T: ค่าไฟฟ้าจากมิเตอร์วัด ส่งเข้า store.updatePzem() ให้เว็บโชว์เป็นการ์ดเดียว <-- เพิ่ม
// entity_id ยืนยันแล้วจาก /api/heartbeat/status (อุปกรณ์ "Consumer Unit Control" ใน HA)
const PZEM_MAP = {
  voltage: 'sensor.consumer_unit_control_voltage',
  current: 'sensor.consumer_unit_control_current',
  power: 'sensor.consumer_unit_control_power',
  energy: 'sensor.consumer_unit_control_energy',
  frequency: 'sensor.consumer_unit_control_frequency',
  powerFactor: 'sensor.consumer_unit_control_power_factor'
};
// ไฟ: ชื่อฝั่งซ้ายคือ key เดียวกับที่หน้าเว็บใช้ ฝั่งขวาคือ switch ใน HA (การจับคู่หน้า/ห้องนั่งเล่นเป็นการเดา ยังไม่ยืนยัน)
const LIGHT_MAP = {
  frontLight1: 'switch.light_control_esp_lamp_no1',
  frontLight2: 'switch.light_control_esp_lamp_no2',
  livingLight1: 'switch.light_control_esp_2_lamp_no1',
  livingLight2: 'switch.light_control_esp_2_lamp_no2'
};

// เบรกเกอร์ชั้น 1/2: แจ้ง LINE เมื่อโมดูลดับ (สถานะเปลี่ยนจาก on -> off) <-- เพิ่ม
// entity_id ยืนยันแล้วจาก Developer Tools > States ใน HA (ชั้น 2 มี prefix control_room_ เพิ่มมา
// เพราะตอนสร้าง entity ครั้งแรกชื่อ Area ถูกรวมเข้าไปด้วย ไม่ตรงแพทเทิร์นเดียวกับชั้น 1)
const BREAKER_MAP = {
  floor1: { entity: 'binary_sensor.consumer_unit_control_first_floor_status', label: 'เบรกเกอร์ชั้น 1' },
  floor2: { entity: 'binary_sensor.control_room_consumer_unit_control_second_floor_status', label: 'เบรกเกอร์ชั้น 2' }
};

// เก็บสถานะล่าสุดที่เคยเห็นแน่ชัด (on/off) ของแต่ละเบรกเกอร์ ไว้เทียบว่าเปลี่ยนตอนไหน
// เริ่มเป็น null เสมอ เพื่อไม่ให้แจ้งเตือนมั่วตอนเซิร์ฟเวอร์เพิ่งสตาร์ต/ตื่นจาก sleep <-- เพิ่ม
const breakerLastKnown = { floor1: null, floor2: null };

// รีเลย์คอยล์ A1/A2 ของ BCH8-16M (สั่งเปิด/ปิดโมดูลจากเว็บได้): เว็บกดครั้งเดียว
// เป็นสวิตช์ค้างใน HA: เว็บกดครั้งเดียว เซิร์ฟเวอร์สลับ on/off ส่งคำสั่งเดียว แล้วค้างสถานะนั้นไว้ <-- แก้
// entity_id ยืนยันแล้วจาก /api/heartbeat/status และหน้า Entity ID ใน HA (อุปกรณ์ "Consumer Unit Control")
const RELAY_MAP = {
  relayFloor1: 'switch.consumer_unit_control_first_floor',
  relayAircon: 'switch.consumer_unit_control_air_conditioner',
  relayFloor2: 'switch.consumer_unit_control_second_floor'
};

// แอร์: คำสั่งฝั่งเว็บ -> script entity_id ใน HA (กดแล้วจบ ไม่มี state ค้าง)
// temp_XX = ตั้งอุณหภูมิตรงๆ (สอนสัญญาณ IR ไว้ที่ 18-30 องศา ทีละ 2 องศา)
// หมายเหตุ: ตอนสร้าง script temp_18...temp_30 ใน HA ระบบเติม prefix "script_" ซ้ำให้เอง
// (ตั้งชื่อว่า "temp_18" แต่ entity_id จริงกลายเป็น "script.script_temp_18")
// ส่วน power_on/power_off ไม่เจอปัญหานี้ (ตั้งชื่อตรงมาตั้งแต่แรก จึงไม่ต้องแก้)
// ยืนยันจากหน้า Entities ใน HA เมื่อ 2026-11-13 ว่า temp_30 จริงคือ script.script_temp_30
const AC_SCRIPT_MAP = {
  power_on: 'script.power_on',
  power_off: 'script.power_off',
  temp_18: 'script.script_temp_18',
  temp_20: 'script.script_temp_20',
  temp_22: 'script.script_temp_22',
  temp_24: 'script.script_temp_24',
  temp_26: 'script.script_temp_26',
  temp_28: 'script.script_temp_28',
  temp_30: 'script.script_temp_30'
};

// อุณหภูมิที่รองรับ (ใช้เช็ค input จาก API)
const AC_ALLOWED_TEMPS = [18, 20, 22, 24, 26, 28, 30];

// ค่าที่ HA ใช้บอกว่าอุปกรณ์ไม่ตอบสนอง (ESP ดับ/หลุด Wi-Fi)
const OFFLINE_STATES = new Set(['unavailable', 'unknown', '']);

// กรองข้อมูลที่ส่งมา: จำกัดขนาด และใช้ object ไร้ prototype กัน key แปลกๆ เช่น __proto__
function sanitizeEsp(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = Object.create(null);
  let devCount = 0;
  for (const [devName, entities] of Object.entries(raw)) {
    if (++devCount > 20) break;
    if (!entities || typeof entities !== 'object' || Array.isArray(entities)) continue;
    const clean = Object.create(null);
    let n = 0;
    for (const [entityId, value] of Object.entries(entities)) {
      if (++n > 100) break;
      clean[String(entityId).slice(0, 100)] = String(value).slice(0, 100);
    }
    out[String(devName).slice(0, 60)] = clean;
  }
  return out;
}

// รับเฉพาะ switch.* แบบ { entity_id: state } สูงสุด 50 ตัว
function sanitizeSwitches(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = Object.create(null);
  let n = 0;
  for (const [entityId, value] of Object.entries(raw)) {
    if (!String(entityId).startsWith('switch.')) continue;
    if (++n > 50) break;
    out[String(entityId).slice(0, 100)] = String(value).slice(0, 20);
  }
  return out;
}

// หาสถานะ entity: ใช้ค่าจาก poll (สดกว่า) ก่อน แล้วค่อยดูจากก้อน esp
function findState(entityId) {
  if (entityId in state.switches) return state.switches[entityId];
  for (const entities of Object.values(state.esp)) {
    if (entityId in entities) return entities[entityId];
  }
  return undefined;
}

// เอาค่าเซนเซอร์จาก HA ไปอัปเดตใน store (ข้ามค่าที่เป็น unavailable / ไม่ใช่ตัวเลข)
function applySensors() {
  const update = {};
  for (const [key, entityId] of Object.entries(SENSOR_MAP)) {
    const raw = findState(entityId);
    const num = Number(raw);
    if (raw !== undefined && raw !== '' && Number.isFinite(num)) {
      update[key] = Math.round(num * 10) / 10;
    }
  }
  if (Object.keys(update).length === 0) return;
  try {
    store.updateSensor(update);
  } catch (err) {
    console.error('[heartbeat] updateSensor error:', err.message);
  }
}

// เอาค่า PZEM จาก HA ไปอัปเดตใน store (ข้ามค่าที่เป็น unavailable / ไม่ใช่ตัวเลข) <-- เพิ่ม
// store.updatePzem() จะอัปเดตค่าล่าสุด (โชว์การ์ดสดในเว็บ) และ insert แถวประวัติใหม่ลง Supabase
// ตาราง pzem_readings ด้วย (source: 'live') ให้อัตโนมัติ — ดู data/store.js
function applyPzem() {
  const update = {};
  for (const [key, entityId] of Object.entries(PZEM_MAP)) {
    const raw = findState(entityId);
    const num = Number(raw);
    if (raw !== undefined && raw !== '' && Number.isFinite(num)) {
      update[key] = Math.round(num * 100) / 100;
    }
  }
  if (Object.keys(update).length === 0) return;
  try {
    store.updatePzem(update);
  } catch (err) {
    console.error('[heartbeat] updatePzem error:', err.message);
  }
}

// เช็คว่าเบรกเกอร์ชั้น 1/2 เพิ่งตัดไฟ (on -> off) หรือกลับมาจ่ายไฟแล้ว (off -> on) แล้วแจ้ง LINE <-- เพิ่ม
function checkBreakers() {
  for (const [key, { entity, label }] of Object.entries(BREAKER_MAP)) {
    const raw = findState(entity);
    if (raw === undefined) continue;          // ยังไม่มีข้อมูลเข้ามาเลย ข้ามไปก่อน
    if (OFFLINE_STATES.has(raw)) continue;     // unavailable/unknown ปล่อยให้ตัวจับ offline หลักจัดการแทน

    const prev = breakerLastKnown[key];
    if (prev === 'on' && raw === 'off') {
      pushLine(`⚠️ ${label} ตัดไฟ (โมดูลดับ)\nเวลา: ${fmtTime(Date.now())}`);
    } else if (prev === 'off' && raw === 'on') {
      pushLine(`✅ ${label} กลับมาจ่ายไฟแล้ว\nเวลา: ${fmtTime(Date.now())}`);
    }
    breakerLastKnown[key] = raw;
  }
}

function currentLights() {
  const out = {};
  for (const [key, entityId] of Object.entries(LIGHT_MAP)) {
    out[key] = findState(entityId) || null;
  }
  return out;
}

// สรุปว่า ESP แต่ละตัวออนไลน์ไหม (ออนไลน์ = มีอย่างน้อย 1 entity ที่ไม่ใช่ unavailable/unknown)
function summarizeDevices() {
  return Object.entries(state.esp).map(([name, entities]) => ({
    name,
    online: Object.values(entities).some(v => !OFFLINE_STATES.has(v)),
    entities
  }));
}

// ---------------------------------------------------------------------
// สั่งไฟ: เว็บเรียก requestLight() แล้วบอร์ดจะมาเอาคำสั่งตอน poll
// action: 'on' | 'off' | 'toggle'  (toggle = กลับด้านจากคำสั่งที่ค้างอยู่ หรือสถานะจริงล่าสุด)
// ---------------------------------------------------------------------
function requestLight(key, action) {
  if (!Object.prototype.hasOwnProperty.call(LIGHT_MAP, key)) {
    return { ok: false, message: 'ไม่รู้จักไฟตัวนี้' };
  }
  let target = action;
  if (action === 'toggle') {
    const base = pending.has(key) ? pending.get(key).target : findState(LIGHT_MAP[key]);
    if (base !== 'on' && base !== 'off') {
      return { ok: false, message: 'บอร์ดยังไม่รายงานสถานะไฟตัวนี้' };
    }
    target = base === 'on' ? 'off' : 'on';
  }
  if (target !== 'on' && target !== 'off') {
    return { ok: false, message: 'state ต้องเป็น on, off หรือ toggle' };
  }
  pending.set(key, { target, at: Date.now() });
  return { ok: true, target };
}

// คำสั่งไฟที่ยังต้องทำ: ถ้าสถานะจริงตรงเป้าแล้ว หรือค้างนานเกินกำหนด ก็ลบทิ้ง
// (ไม่มี ack แยก: ใช้สถานะจริงที่บอร์ดรายงานเป็นตัวยืนยัน และสั่งซ้ำได้ไม่เป็นไร)
function collectLightCommands(now) {
  const commands = [];
  for (const [key, cmd] of pending) {
    const entity = LIGHT_MAP[key];
    if (findState(entity) === cmd.target || now - cmd.at > CMD_TTL_MS) {
      pending.delete(key);
      continue;
    }
    commands.push({ entity, action: cmd.target });
  }
  return commands;
}

// ---------------------------------------------------------------------
// สั่งแอร์: เว็บเรียก requestAcAction() แล้วบอร์ดจะมาเอาคำสั่งตอน poll
// เป็น "pulse" ล้วนๆ ไม่มี state ให้เทียบ เลยต่างไฟคือ: บอร์ด poll มาเจอครั้งเดียว
// ก็ถือว่ายิงไปแล้ว ลบออกจากคิวทันที (ไม่ส่งซ้ำ)
// กัน IR ชนกัน: ส่งให้บอร์ดทีละ 1 คำสั่งต่อรอบ poll (HA ยิงหลาย script พร้อมกันแล้วสัญญาณซ้อนกัน
// แอร์อาจรับเลขเพี้ยน) และถ้ากดตั้งอุณหภูมิหลายครั้งก่อนบอร์ดมาเอา จะเก็บเฉพาะค่าล่าสุด
// action: 'power_on' | 'power_off' | 'temp_18' | 'temp_20' | ... | 'temp_30'
// ---------------------------------------------------------------------
function requestAcAction(action) {
  if (!Object.prototype.hasOwnProperty.call(AC_SCRIPT_MAP, action)) {
    return { ok: false, message: 'คำสั่งแอร์ไม่ถูกต้อง' };
  }
  const now = Date.now();
  // กันคิวบวมถ้าบอร์ดหลุดไปนาน: ตัดคำสั่งเก่าที่ค้างเกิน TTL ออกก่อน
  acQueue = acQueue.filter(c => now - c.at <= AC_CMD_TTL_MS);
  // ตั้งอุณหภูมิซ้ำก่อนบอร์ดมาเอา: ทิ้งค่าเก่า เก็บแต่ค่าล่าสุด
  if (action.startsWith('temp_')) acQueue = acQueue.filter(c => !c.action.startsWith('temp_'));
  acQueue.push({ action, at: now });

  // ถ้าเป็นคำสั่งตั้งอุณหภูมิ (temp_18 ... temp_30) ให้ดึงเลขออกมาบันทึกด้วย
  const match = /^temp_(\d+)$/.exec(action);
  const temp = match ? parseInt(match[1], 10) : undefined;
  const result = store.recordAcAction(action, temp);
  return { ok: true, action, ac: result.ac };
}

// ดึงคำสั่งแอร์ที่ค้างอยู่ออกมา "ทีละ 1 คำสั่งต่อรอบ poll" (เป็น pulse ส่งครั้งเดียว ไม่ยิงซ้ำ)
// คำสั่งที่เหลือรอรอบ poll ถัดไป (~5 วิ) ไม่ให้ IR หลายสัญญาณซ้อนกัน
function collectAcCommands(now) {
  acQueue = acQueue.filter(c => now - c.at <= AC_CMD_TTL_MS);
  const next = acQueue.shift();
  return next ? [{ entity: AC_SCRIPT_MAP[next.action], action: 'press' }] : [];
}

// ---------------------------------------------------------------------
// สั่ง relay แบบสวิตช์ค้าง: เว็บกด 1 ครั้ง = ส่งคำสั่งเดียว ("on" หรือ "off") แล้วค้างสถานะนั้นไว้
// ทำงานเหมือนปุ่มไฟ: บอร์ดจะได้รับคำสั่งจนกว่าสถานะจริงตรงเป้า (หรือค้างเกิน RELAY_CMD_TTL_MS)
// state: 'toggle' (ค่าเริ่มต้น) | 'on' | 'off'
//   toggle = กลับด้านจากคำสั่งที่ค้างอยู่ หรือสถานะจริงล่าสุดที่บอร์ดรายงาน
// ---------------------------------------------------------------------
const relayPending = new Map(); // relayKey -> { target: 'on'|'off', at }

function requestRelayToggle(key, action) {
  if (!Object.prototype.hasOwnProperty.call(RELAY_MAP, key)) {
    return { ok: false, message: 'ไม่รู้จัก relay ตัวนี้' };
  }
  let target = action || 'toggle';
  if (target === 'toggle') {
    const base = relayPending.has(key) ? relayPending.get(key).target : findState(RELAY_MAP[key]);
    if (base !== 'on' && base !== 'off') {
      return { ok: false, message: 'บอร์ดยังไม่รายงานสถานะ relay ตัวนี้' };
    }
    target = base === 'on' ? 'off' : 'on';
  }
  if (target !== 'on' && target !== 'off') {
    return { ok: false, message: 'state ต้องเป็น on, off หรือ toggle' };
  }
  relayPending.set(key, { target, at: Date.now() });
  return { ok: true, key, entity: RELAY_MAP[key], target };
}

// คำสั่ง relay ที่ยังต้องทำ: ถ้าสถานะจริงตรงเป้าแล้ว หรือค้างนานเกินกำหนด ก็ลบทิ้ง
function collectRelayCommands(now) {
  const commands = [];
  for (const [key, cmd] of relayPending) {
    const entity = RELAY_MAP[key];
    if (findState(entity) === cmd.target || now - cmd.at > RELAY_CMD_TTL_MS) {
      relayPending.delete(key);
      continue;
    }
    commands.push({ entity, action: cmd.target });
  }
  return commands;
}

// ---------------------------------------------------------------------
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function checkToken(req, res) {
  if (!TOKEN) {
    res.status(503).json({ ok: false, error: 'HEARTBEAT_TOKEN not configured' });
    return false;
  }
  const given = req.get('x-heartbeat-token') || '';
  if (!safeEqual(given, TOKEN)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

function fmtTime(ms) {
  return new Date(ms).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} นาที`;
  return `${Math.floor(min / 60)} ชม. ${min % 60} นาที`;
}

async function pushLine(text) {
  if (!LINE_TOKEN || !LINE_TO) {
    console.warn('[heartbeat] ยังไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN / LINE_TO ข้ามการส่ง LINE');
    return;
  }
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LINE_TOKEN}`
      },
      body: JSON.stringify({ to: LINE_TO, messages: [{ type: 'text', text }] })
    });
    if (!res.ok) {
      console.error('[heartbeat] LINE push ล้มเหลว', res.status, await res.text());
    }
  } catch (err) {
    console.error('[heartbeat] LINE push error:', err.message);
  }
}

// ---------------------------------------------------------------------
// Supabase persistence: เก็บ state (lastBeat/offline/offlineSince) ไว้ที่ตาราง
// heartbeat_state (แถวเดียว id=1) ให้รอดจาก Render sleep/restart
// ถ้าไม่ได้ตั้ง SUPABASE_URL/SUPABASE_SERVICE_KEY จะข้ามส่วนนี้ไปเงียบๆ
// แล้วทำงานด้วย state ในแรมอย่างเดียวเหมือนโค้ดเดิม
// ---------------------------------------------------------------------

// โหลด state ล่าสุดจาก Supabase มาทับค่าที่ตั้งต้นในแรม ตอนเซิร์ฟเวอร์เพิ่งสตาร์ต
// สำคัญมาก: ถ้าไม่โหลด ทุกครั้งที่ Render sleep/wake จะเห็น lastBeat = "ตอนนี้" เสมอ
// (เข้าใจผิดว่าบอร์ดเพิ่งส่งสัญญาณมา ทั้งที่จริงอาจขาดการติดต่อมานานแล้ว)
async function loadStateFromDB() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('heartbeat_state')
      .select('last_beat, offline, offline_since')
      .eq('id', 1)
      .single();
    if (error) {
      console.error('[heartbeat] โหลด state จาก Supabase ไม่สำเร็จ:', error.message);
      return;
    }
    if (data) {
      state.lastBeat = new Date(data.last_beat).getTime();
      state.offline = data.offline;
      state.offlineSince = data.offline_since ? new Date(data.offline_since).getTime() : null;
      console.log('[heartbeat] โหลด state จาก Supabase สำเร็จ:', {
        lastBeat: fmtTime(state.lastBeat),
        offline: state.offline
      });
    }
  } catch (err) {
    console.error('[heartbeat] loadStateFromDB error:', err.message);
  }
}

// เขียน state ปัจจุบันกลับไปที่ Supabase (เรียกทุกครั้งที่ state เปลี่ยนจริงๆ ไม่ใช่ทุก heartbeat
// เพื่อประหยัด quota — ดู markAlive/startMonitor ว่าเรียกตอนไหนบ้าง)
async function saveStateToDB() {
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from('heartbeat_state')
      .update({
        last_beat: new Date(state.lastBeat).toISOString(),
        offline: state.offline,
        offline_since: state.offlineSince ? new Date(state.offlineSince).toISOString() : null
      })
      .eq('id', 1);
    if (error) {
      console.error('[heartbeat] บันทึก state ไป Supabase ไม่สำเร็จ:', error.message);
    }
  } catch (err) {
    console.error('[heartbeat] saveStateToDB error:', err.message);
  }
}

// บันทึกว่าบอร์ดยังมีชีวิต (ทั้ง heartbeat และ poll นับ) และแจ้ง LINE ถ้าเพิ่งกลับมาจากออฟไลน์
function markAlive(now) {
  const wasOffline = state.offline;
  const downMs = wasOffline ? now - state.offlineSince : 0;

  state.lastBeat = now;
  state.offline = false;
  state.offlineSince = null;

  if (wasOffline) {
    pushLine(
      `✅ บอร์ดกลับมาออนไลน์แล้ว\n` +
      `ขาดการติดต่อไปประมาณ ${fmtDuration(downMs)}\n` +
      `กลับมาเมื่อ: ${fmtTime(now)}`
    );
    // offline -> online คือการเปลี่ยนแปลงสำคัญ บันทึกทันที
    saveStateToDB();
  } else {
    // กรณีปกติ (ไม่ได้เพิ่งเปลี่ยนสถานะ) ไม่ต้องรอ await เพื่อไม่ให้ response ช้า
    // แค่เขียน lastBeat ล่าสุดกลับไปเรื่อยๆ กัน Render restart แล้ว state เก่าเกินไป
    saveStateToDB();
  }
}

// ---- รับ heartbeat + สถานะ ESP จากบอร์ด: POST /api/heartbeat (ทุก 1 นาที) ----
router.post('/', (req, res) => {
  if (!checkToken(req, res)) return;

  const now = Date.now();
  markAlive(now);

  const body = req.body && typeof req.body === 'object' ? req.body : null;
  state.lastInfo = body ? { device: String(body.device || '').slice(0, 60) } : null;
  const esp = body ? sanitizeEsp(body.esp) : null;
  if (esp) {
    state.esp = esp;
    state.espUpdatedAt = now;
    applySensors();
    applyPzem(); // <-- เพิ่ม
    checkBreakers(); // <-- เพิ่ม
  }

  res.json({ ok: true });
});

// ---- บอร์ดมาถามคำสั่ง: POST /api/heartbeat/poll (ทุก ~5 วินาที) ----
// body:  { "switches": { "switch.xxx": "on", ... } }  สถานะรีเลย์จริงตอนนี้
// ตอบ:   { "ok": true, "commands": [ { "entity": "switch.xxx", "action": "on" | "off" | "press" } ] }
//   - ไฟ: action เป็น "on"/"off" (ยิงซ้ำได้จนกว่า state จะตรง)
//   - relay: action เป็น "on"/"off" เหมือนไฟ (สวิตช์ค้าง ยิงซ้ำได้จนกว่า state จะตรง)
//   - แอร์: action เป็น "press" (เรียก script.turn_on กับ entity นั้น แล้วจบ ไม่ยิงซ้ำ)
router.post('/poll', (req, res) => {
  if (!checkToken(req, res)) return;

  const now = Date.now();
  markAlive(now);

  const sw = req.body ? sanitizeSwitches(req.body.switches) : null;
  if (sw) {
    state.switches = sw;
    state.switchesAt = now;
    checkBreakers(); // <-- เพิ่ม: poll มาถี่กว่า heartbeat (ทุก ~5 วิ) เช็คตรงนี้ด้วยจะจับการตัดไฟได้ไวขึ้น
  }

  const commands = [...collectLightCommands(now), ...collectAcCommands(now), ...collectRelayCommands(now)];
  res.json({ ok: true, commands });
});

// ---- สั่งไฟจากหน้าเว็บ (ต้อง login): POST /api/heartbeat/light/:key  body { "state": "on" | "off" | "toggle" } ----
router.post('/light/:key', requireAuthApi, (req, res) => {
  const result = requestLight(req.params.key, req.body && req.body.state);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// ---- สั่ง relay แบบสวิตช์ค้าง (ต้อง login): POST /api/heartbeat/relay/:key  body (ไม่บังคับ) { "state": "on" | "off" | "toggle" } ----
// key: relayFloor1 | relayAircon | relayFloor2 (ไม่ส่ง body = toggle กดครั้งเดียวสลับสถานะแล้วค้างไว้)
router.post('/relay/:key', requireAuthApi, (req, res) => {
  const result = requestRelayToggle(req.params.key, req.body && req.body.state);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// ---- ดูสถานะ (ต้อง login): GET /api/heartbeat/status ----
router.get('/status', requireAuth, (req, res) => {
  res.json({
    online: !state.offline,
    lastBeat: new Date(state.lastBeat).toISOString(),
    secondsSinceLastBeat: Math.round((Date.now() - state.lastBeat) / 1000),
    timeoutSec: TIMEOUT_MS / 1000,
    info: state.lastInfo,
    espUpdatedAt: state.espUpdatedAt ? new Date(state.espUpdatedAt).toISOString() : null,
    lights: currentLights(),
    breakers: breakerLastKnown, // <-- เพิ่ม: เผื่ออยากดูสถานะล่าสุดผ่าน /status
    pending: Object.fromEntries(pending),
    acPending: acQueue.map(c => c.action),
    relayPending: Object.fromEntries(relayPending),
    devices: summarizeDevices(),
    persistedToDB: !!supabase
  });
});

// ---- ตัวเช็กว่าบอร์ดเงียบเกินกำหนดหรือยัง ----
function startMonitor() {
  // โหลด state จาก Supabase ก่อนเริ่มตรวจ (สำคัญตอนเซิร์ฟเวอร์เพิ่งตื่นจาก sleep)
  loadStateFromDB().then(() => {
    setInterval(() => {
      const silentMs = Date.now() - state.lastBeat;
      if (!state.offline && silentMs > TIMEOUT_MS) {
        state.offline = true;
        state.offlineSince = state.lastBeat;
        console.warn('[heartbeat] บอร์ดขาดการติดต่อ');
        pushLine(
          `⚠️ บอร์ดขาดการติดต่อ (สงสัยไฟดับ)\n` +
          `ไม่ได้รับสัญญาณมาแล้ว ${fmtDuration(silentMs)}\n` +
          `สัญญาณล่าสุด: ${fmtTime(state.lastBeat)}`
        );
        saveStateToDB(); // บันทึกทันทีตอนเปลี่ยนเป็น offline
      }
    }, CHECK_INTERVAL_MS);
  });
  console.log(`✓ Heartbeat monitor started (timeout ${TIMEOUT_MS / 1000}s, persist: ${supabase ? 'Supabase' : 'in-memory only'})`);
}

// requestRelayPulse คงชื่อเดิมไว้เป็น alias กันไฟล์อื่นที่ import อยู่พัง (ตอนนี้ทำงานแบบ toggle)
module.exports = { router, startMonitor, requestLight, requestAcAction, requestRelayToggle, requestRelayPulse: requestRelayToggle };