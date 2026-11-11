// scripts/seed_simulated_pzem.js
//
// สคริปต์นี้อ่านไฟล์ Excel "หน่วยไฟฟ้ารายวัน" (จำลอง 61 วัน ก.ย.-ต.ค. 2569) แล้ว gen เป็น
// PZEM reading ราย "นาที" (ความถี่เดียวกับที่ ESP ส่งเข้ามาจริงผ่าน heartbeat.js) ตลอดทั้งวัน
// โดยคุมผลรวม energy ของแต่ละวันให้ตรงกับตัวเลข kWh จริงจาก Excel เป๊ะ (สะสมตามเส้นโค้งโหลดบ้าน
// ทั่วไป: กลางวันต่ำ, พีคช่วงเย็น-หัวค่ำ, ต่ำสุดตอนดึก) แล้ว insert ลง Supabase ตาราง pzem_readings
// โดยทุกแถวจะถูก mark source = 'simulated' อย่างชัดเจน ไม่ปนกับของจริง (source = 'live')
//
// วิธีใช้:
//   1) รัน pzem_readings_schema.sql ใน Supabase SQL editor ก่อน (สร้างตารางให้เรียบร้อย)
//   2) ตั้ง env ให้ครบ: SUPABASE_URL, SUPABASE_SERVICE_KEY
//   3) วางไฟล์ Excel ไว้ที่ path ที่ระบุด้านล่าง (หรือแก้ EXCEL_PATH)
//   4) รัน:  node scripts/seed_simulated_pzem.js
//   5) สคริปต์จะเช็คก่อนว่ามีข้อมูล simulated ของช่วงนี้อยู่แล้วหรือยัง ถ้ามีจะถามก่อนเขียนทับ/เพิ่มซ้ำ
//
// ตัวเลขไฟฟ้าบ้าน (220V, single phase) ใช้สมมติฐานทั่วไป:
//   - แรงดัน (voltage): แกว่งอยู่แถว 215-230V ตามโหลด/เวลา
//   - ความถี่ (frequency): เกือบคงที่ 50Hz ของไทย (แกว่งเล็กน้อย ±0.05Hz)
//   - power factor: โหลดบ้านทั่วไปผสมเครื่องใช้ไฟฟ้า ส่วนใหญ่ 0.85-0.97
//   - power/current: คำนวณย้อนกลับจาก "พลังงานที่ควรใช้ในนาทีนั้น" ตามเส้นโค้งโหลดรายวัน

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { supabase } = require('../data/supabase');
const store = require('../data/store');

const EXCEL_PATH = path.join(__dirname, '..', 'data', 'simulated_electricity_usage.xlsx');
const READINGS_PER_DAY = 24 * 60; // 1 reading/นาที เท่าความถี่จริงของ heartbeat.js

// ---- 1) อ่านไฟล์ Excel: วันที่ (DD/MM/YYYY พ.ศ.) + หน่วยไฟที่ใช้ (kWh) ----
function loadDailyKwh() {
  const wb = xlsx.readFile(EXCEL_PATH);
  const ws = wb.Sheets['ข้อมูลรายวัน'];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, range: 3 }); // แถวที่ 4 เป็นต้นไป (header อยู่แถว 3)

  return rows
    .filter(r => r && r[0] && r[3] !== undefined && r[3] !== null)
    .map(r => {
      // คอลัมน์ "วันที่" ในไฟล์นี้เป็น ค.ศ. อยู่แล้ว (เช่น '01/09/2026') แม้ชื่อชีตจะอ้างปี พ.ศ. 2569 ก็ตาม
      // (2569 พ.ศ. = 2026 ค.ศ. พอดี เลขปีเท่ากับที่อยู่ในคอลัมน์ ไม่ต้องลบ 543 ซ้ำ)
      const [dd, mm, yyyy] = String(r[0]).split('/').map(Number);
      return { dateUTC: new Date(Date.UTC(yyyy, mm - 1, dd)), kwh: Number(r[3]) };
    });
}

// ---- 2) รูปทรงโหลดไฟบ้านรายชั่วโมง (น้ำหนักสัมพัทธ์ รวมกัน = คงที่ ไม่ต้อง sum เป็น 1 พอดีเพราะจะ normalize ทีหลัง) ----
// ต่ำสุดตี 2-5, ขยับขึ้นเช้า, ลดลงตอนสาย-บ่ายที่ไม่มีคนอยู่บ้าน, พีคช่วงเย็น-หัวค่ำ (คนกลับบ้าน เปิดแอร์/ทำกับข้าว), ค่อยๆลดลงดึก
const HOURLY_WEIGHTS = [
  0.35, 0.3, 0.28, 0.28, 0.3, 0.4,   // 00-05
  0.55, 0.7, 0.6, 0.5, 0.45, 0.45,   // 06-11
  0.5, 0.55, 0.5, 0.5, 0.55, 0.75,   // 12-17
  1.3, 1.6, 1.5, 1.2, 0.9, 0.6       // 18-23
];

function seededRandom(seed) {
  // small deterministic PRNG (mulberry32) เพื่อให้รันซ้ำได้ผลเหมือนเดิมถ้าต้องการ debug
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 3) สร้าง reading รายนาทีของวันเดียว ให้ผลรวม energy ตรงกับ targetKwh เป๊ะ ----
function genDayReadings(dateUTC, targetKwh, dayIndex, cumulativeEnergyWhStart) {
  const rng = seededRandom(dayIndex * 7919 + 13);

  // แจกน้ำหนักรายนาที จากน้ำหนักรายชั่วโมง + noise เล็กน้อยต่อนาที ให้ไม่ราบเรียบเป๊ะเกินไป
  const minuteWeights = new Array(READINGS_PER_DAY);
  for (let m = 0; m < READINGS_PER_DAY; m++) {
    const hour = Math.floor(m / 60);
    const noise = 0.85 + rng() * 0.3; // ±15%
    minuteWeights[m] = HOURLY_WEIGHTS[hour] * noise;
  }
  const weightSum = minuteWeights.reduce((a, b) => a + b, 0);

  const targetWh = targetKwh * 1000;
  const readings = [];
  let cumulativeWh = cumulativeEnergyWhStart;

  for (let m = 0; m < READINGS_PER_DAY; m++) {
    // พลังงานที่ "ใช้ไปในนาทีนี้" (Wh) ตามสัดส่วนน้ำหนัก ให้ผลรวมทั้งวัน = targetWh พอดี
    const whThisMinute = (minuteWeights[m] / weightSum) * targetWh;
    cumulativeWh += whThisMinute;

    // power เฉลี่ยของนาทีนี้ (W) = Wh ที่ใช้ไป / (1/60 ชม.) = whThisMinute * 60
    const powerW = whThisMinute * 60;

    // voltage: 215-230V แกว่งตามเวลา (โหลดสูง -> แรงดันหย่อนลงนิดหน่อย ตามธรรมชาติของระบบไฟฟ้า)
    const hour = Math.floor(m / 60);
    const loadFactor = HOURLY_WEIGHTS[hour] / Math.max(...HOURLY_WEIGHTS);
    const voltage = 230 - loadFactor * 10 + (rng() - 0.5) * 3;

    // power factor: 0.85-0.97 โหลดสูง (มอเตอร์/แอร์) ฉุด PF ต่ำลงเล็กน้อย
    const powerFactor = 0.95 - loadFactor * 0.08 + (rng() - 0.5) * 0.02;

    // current (A) = power / (voltage * powerFactor)
    const current = powerW / (voltage * powerFactor);

    // frequency: เกือบคงที่ 50Hz
    const frequency = 50 + (rng() - 0.5) * 0.08;

    const recordedAt = new Date(dateUTC.getTime() + m * 60 * 1000);

    readings.push({
      recordedAt: recordedAt.toISOString(),
      voltage: Math.round(voltage * 10) / 10,
      current: Math.round(current * 1000) / 1000,
      power: Math.round(powerW * 100) / 100,
      energy: Math.round(cumulativeWh * 100) / 100, // Wh สะสม (เหมือนที่ PZEM จริงรายงาน)
      dailyKwh: Math.round(((cumulativeWh - cumulativeEnergyWhStart) / 1000) * 1000) / 1000,
      frequency: Math.round(frequency * 100) / 100,
      powerFactor: Math.round(powerFactor * 1000) / 1000,
      source: 'simulated'
    });
  }

  return { readings, cumulativeEnergyWhEnd: cumulativeWh };
}

async function main() {
  if (!supabase) {
    console.error('✗ ยังไม่ได้ตั้ง SUPABASE_URL / SUPABASE_SERVICE_KEY ใน env — ยกเลิกการ seed');
    process.exit(1);
  }
  if (!fs.existsSync(EXCEL_PATH)) {
    console.error(`✗ ไม่พบไฟล์ Excel ที่ ${EXCEL_PATH} — ย้ายไฟล์ไปไว้ที่ data/simulated_electricity_usage.xlsx ก่อน`);
    process.exit(1);
  }

  // กันข้อมูลซ้ำซ้อน: เช็คว่ามีแถว simulated อยู่แล้วหรือยัง
  const { count, error: countErr } = await supabase
    .from('pzem_readings')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'simulated');
  if (countErr) {
    console.error('✗ เช็คข้อมูลเดิมไม่สำเร็จ:', countErr.message);
    process.exit(1);
  }
  if (count > 0) {
    console.error(`✗ พบข้อมูล source='simulated' อยู่แล้ว ${count} แถว — ลบของเดิมก่อนถ้าต้องการ seed ใหม่:
   delete from pzem_readings where source = 'simulated';`);
    process.exit(1);
  }

  const daily = loadDailyKwh();
  console.log(`อ่าน Excel ได้ ${daily.length} วัน, รวม ${daily.reduce((s, d) => s + d.kwh, 0).toFixed(2)} kWh`);

  let cumulativeWh = 0; // เริ่มจาก 0 (เดือนแรกของประวัติจำลอง) — ถ้าต้องการให้ต่อเนื่องกับเลข energy สะสมของ PZEM จริง
                         // ที่มีอยู่แล้ว ให้แก้บรรทัดนี้เป็นค่าที่ db.pzem.energy ปัจจุบันลบด้วยผลรวม kWh ทั้งหมด

  let allReadings = [];
  daily.forEach((d, i) => {
    const { readings, cumulativeEnergyWhEnd } = genDayReadings(d.dateUTC, d.kwh, i, cumulativeWh);
    cumulativeWh = cumulativeEnergyWhEnd;
    allReadings = allReadings.concat(readings);
  });

  console.log(`สร้างข้อมูลจำลองทั้งหมด ${allReadings.length} readings (${daily.length} วัน x ${READINGS_PER_DAY} นาที/วัน)`);
  console.log(`ตรวจสอบผลรวม: energy สะสมสุดท้าย = ${(cumulativeWh / 1000).toFixed(2)} kWh (ของจริงจาก Excel = ${daily.reduce((s, d) => s + d.kwh, 0).toFixed(2)} kWh)`);

  // insert เป็น batch (Supabase/Postgres รับทีละหลายพันแถวได้ แต่กันพลาดด้วยการแบ่ง chunk)
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < allReadings.length; i += CHUNK) {
    const chunk = allReadings.slice(i, i + CHUNK).map(r => ({
      recorded_at: r.recordedAt,
      voltage: r.voltage,
      current: r.current,
      power: r.power,
      energy: r.energy,
      daily_kwh: r.dailyKwh,
      frequency: r.frequency,
      power_factor: r.powerFactor,
      source: r.source
    }));
    const { error } = await supabase.from('pzem_readings').insert(chunk);
    if (error) {
      console.error(`✗ insert chunk ${i}-${i + chunk.length} ล้มเหลว:`, error.message);
      process.exit(1);
    }
    inserted += chunk.length;
    process.stdout.write(`\rinsert แล้ว ${inserted}/${allReadings.length}`);
  }
  console.log(`\n✓ เสร็จแล้ว: บันทึกข้อมูลจำลอง (source='simulated') ${inserted} แถวลง Supabase สำเร็จ`);
}

main().catch(err => {
  console.error('✗ เกิดข้อผิดพลาด:', err);
  process.exit(1);
});
