// scripts/seed_simulated_pzem.js
//
// อ่านไฟล์ Excel "หน่วยไฟฟ้ารายวัน" (kWh ต่อวัน) แล้วสร้างค่า PZEM ราย "นาที" (ความถี่เดียวกับที่ ESP ส่งเข้ามา
// จริงผ่าน heartbeat.js) ลงตาราง pzem_readings ใน Supabase — แถวที่ได้หน้าตาเหมือนข้อมูลจริงทุกประการ
// ไม่มีคอลัมน์ที่บอกว่าเป็นข้อมูลจำลอง (ตามที่ต้องการให้รวมเป็นฐานข้อมูลเดียวกัน)
//
// สิ่งที่สคริปต์รับประกัน:
//   - ผลรวมพลังงานของแต่ละวัน "ตรงกับ kWh ในไฟล์ Excel" (ตรวจซ้ำให้ทุกครั้งก่อน insert และพิมพ์ผลให้ดู)
//   - แบ่งวันตามเวลาไทย (UTC+7) โค้งการใช้ไฟ พีคช่วงเย็น-หัวค่ำ จะตรงกับเวลาจริงบนหน้าเว็บ
//   - วันที่ใช้ไฟเยอะกว่าปกติ จะมีสัดส่วนแอร์ช่วงกลางคืน/บ่ายมากขึ้น (ให้ดูสมจริงกว่าโค้งเดียวใช้ซ้ำทุกวัน)
//   - energy เป็นค่าสะสม (Wh) ต่อเนื่องไม่ลดลง เหมือนตัวนับของ PZEM จริง
//
// วิธีใช้:
//   1) รัน pzem_readings_schema.sql ใน Supabase SQL editor ก่อน
//   2) ตั้ง env: SUPABASE_URL, SUPABASE_SERVICE_KEY   (ใส่ในไฟล์ .env ได้ เพราะสคริปต์โหลด dotenv ให้)
//   3) วางไฟล์ Excel ไว้ที่ data/simulated_electricity_usage.xlsx (หรือส่ง path เป็นอาร์กิวเมนต์)
//   4) ลองรันแบบไม่เขียนฐานข้อมูลก่อน เพื่อดูว่าอ่านไฟล์ถูกและผลรวมตรง:
//        node scripts/seed_simulated_pzem.js --dry-run
//   5) ของจริง:
//        node scripts/seed_simulated_pzem.js
//        node scripts/seed_simulated_pzem.js path/ไปยัง/ไฟล์.xlsx
//   ถ้าในฐานข้อมูลมีข้อมูลอยู่ในช่วงวันที่เดียวกันแล้ว สคริปต์จะหยุดไม่เขียนซ้ำ — ถ้าต้องการลบช่วงนั้นแล้วสร้างใหม่ให้ใส่ --replace
//   (ระวัง: --replace ลบ "ทุกแถว" ในช่วงวันที่ของไฟล์ Excel รวมของจริงที่บังเอิญอยู่ในช่วงนั้นด้วย เพราะแยกที่มาไม่ได้แล้ว)

try { require('dotenv').config(); } catch (e) { /* ไม่มี dotenv ก็ใช้ env ของเครื่องตามปกติ */ }

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { supabase } = require('../data/supabase');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const REPLACE = args.includes('--replace');
const pathArg = args.find(a => !a.startsWith('--'));
const EXCEL_PATH = pathArg
  ? path.resolve(pathArg)
  : path.join(__dirname, '..', 'data', 'simulated_electricity_usage.xlsx');

const READINGS_PER_DAY = 24 * 60;           // 1 reading/นาที เท่าความถี่จริงของ heartbeat.js
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000; // เวลาไทย = UTC+7 (ไม่มี DST)
const CHUNK = 1000;

// ---------------------------------------------------------------------------
// 1) อ่านไฟล์ Excel: วันที่ + หน่วยไฟที่ใช้ (kWh)
//    หาคอลัมน์จากหัวตารางให้เอง (คอลัมน์ที่มีคำว่า "วันที่" และ "kWh"/"หน่วย") ถ้าหาไม่เจอจะใช้เลย์เอาต์เดิม
//    (วันที่ = คอลัมน์ A, kWh = คอลัมน์ D, ข้อมูลเริ่มแถวที่ 4)
// ---------------------------------------------------------------------------
function detectLayout(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = (rows[i] || []).map(c => (c === null || c === undefined ? '' : String(c)));
    let kwhCol = cells.findIndex(c => /kwh/i.test(c));
    if (kwhCol < 0) kwhCol = cells.findIndex(c => /หน่วย/.test(c));
    const dateCol = cells.findIndex(c => /วันที่|date/i.test(c));
    if (kwhCol >= 0 && dateCol >= 0 && kwhCol !== dateCol) {
      return { dateCol, kwhCol, firstRow: i + 1, detected: true };
    }
  }
  return { dateCol: 0, kwhCol: 3, firstRow: 3, detected: false };
}

// รองรับ '01/09/2026', '2026-09-01', เลขซีเรียลของ Excel และปี พ.ศ. (ปี > 2400 จะลบ 543 ให้)
function parseDateCell(v) {
  if (v === null || v === undefined || v === '') return null;
  let y, m, d;
  if (typeof v === 'number') {
    const p = xlsx.SSF.parse_date_code(v);
    if (!p) return null;
    y = p.y; m = p.m; d = p.d;
  } else {
    const first = String(v).trim().split(/\s+/)[0];
    const parts = first.split(/[\/\-.]/).map(s => parseInt(s, 10));
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    if (parts[0] > 31) { [y, m, d] = parts; } else { [d, m, y] = parts; }
  }
  if (y > 2400) y -= 543;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return { y, m, d };
}

function loadDailyKwh() {
  const wb = xlsx.readFile(EXCEL_PATH);
  const sheetName = wb.Sheets['ข้อมูลรายวัน'] ? 'ข้อมูลรายวัน' : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const layout = detectLayout(rows);
  console.log(`ชีต "${sheetName}" | คอลัมน์วันที่ = ${xlsx.utils.encode_col(layout.dateCol)}, คอลัมน์ kWh = ${xlsx.utils.encode_col(layout.kwhCol)}, เริ่มแถวที่ ${layout.firstRow + 1}` +
    (layout.detected ? '' : '  (หาหัวตารางไม่เจอ ใช้เลย์เอาต์เดิม)'));

  const days = [];
  for (let i = layout.firstRow; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const date = parseDateCell(r[layout.dateCol]);
    const kwh = Number(String(r[layout.kwhCol]).replace(/,/g, ''));
    if (!date || !Number.isFinite(kwh) || kwh < 0) continue; // ข้ามแถวสรุป/แถวว่าง
    // เที่ยงคืนเวลาไทยของวันนั้น (เป็น UTC ก็คือ 17:00 ของวันก่อนหน้า)
    const startMs = Date.UTC(date.y, date.m - 1, date.d) - BANGKOK_OFFSET_MS;
    const key = `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
    days.push({ key, startMs, kwh });
  }
  days.sort((a, b) => a.startMs - b.startMs);

  for (let i = 1; i < days.length; i++) {
    if (days[i].key === days[i - 1].key) throw new Error(`วันที่ซ้ำในไฟล์ Excel: ${days[i].key}`);
  }
  return days;
}

// ---------------------------------------------------------------------------
// 2) โค้งโหลดไฟบ้านรายชั่วโมง (น้ำหนักสัมพัทธ์ เดี๋ยว normalize ให้รวมเป็น kWh ของวันนั้นเอง)
//    ต่ำสุดตี 2-5, ขยับขึ้นเช้า, ลดลงสาย-บ่ายที่ไม่มีคนอยู่บ้าน, พีคช่วงเย็น-หัวค่ำ, ค่อยๆ ลดลงดึก
// ---------------------------------------------------------------------------
const HOURLY_WEIGHTS = [
  0.35, 0.3, 0.28, 0.28, 0.3, 0.4,   // 00-05
  0.55, 0.7, 0.6, 0.5, 0.45, 0.45,   // 06-11
  0.5, 0.55, 0.5, 0.5, 0.55, 0.75,   // 12-17
  1.3, 1.6, 1.5, 1.2, 0.9, 0.6       // 18-23
];
// วันที่ใช้ไฟเยอะ = เปิดแอร์นานขึ้น: ดันน้ำหนักช่วงกลางคืน (แอร์ห้องนอน) และบ่าย ตามความ "เยอะ" ของวันนั้น
const NIGHT_HOURS = new Set([22, 23, 0, 1, 2, 3, 4, 5]);
const AFTERNOON_HOURS = new Set([12, 13, 14, 15, 16]);

function seededRandom(seed) {
  // mulberry32: สุ่มแบบกำหนดผลได้ รันซ้ำได้ผลเหมือนเดิม
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (v, digits) => {
  const k = Math.pow(10, digits);
  return Math.round(v * k) / k;
};

// ---------------------------------------------------------------------------
// 3) สร้าง reading รายนาทีของวันเดียว ให้ผลรวมพลังงานทั้งวัน = targetKwh เป๊ะ
//    reading ของนาทีที่ m ติดเวลาต้นนาที แต่ energy คือค่าสะสม "หลังจบนาทีนั้น"
//    ดังนั้นผลต่างของ energy ระหว่าง reading ติดกัน = พลังงานที่ใช้ในนาทีนั้นพอดี
// ---------------------------------------------------------------------------
function genDayReadings(day, dayIndex, acStrength, startEnergyWh) {
  const rng = seededRandom(dayIndex * 7919 + 13);

  // น้ำหนักรายนาที = โค้งรายชั่วโมง × ตัวคูณแอร์ × noise (มีทั้ง noise ช้าๆ และสะเก็ดเล็กๆ รายนาที)
  const minuteWeights = new Array(READINGS_PER_DAY);
  let slow = 0;
  for (let m = 0; m < READINGS_PER_DAY; m++) {
    const hour = Math.floor(m / 60);
    const acBoost = NIGHT_HOURS.has(hour) ? 1.1 * acStrength : AFTERNOON_HOURS.has(hour) ? 0.5 * acStrength : 0;
    slow = slow * 0.93 + (rng() - 0.5) * 0.22;
    const noise = Math.min(1.5, Math.max(0.6, 1 + slow + (rng() - 0.5) * 0.12));
    minuteWeights[m] = HOURLY_WEIGHTS[hour] * (1 + acBoost) * noise;
  }
  const weightSum = minuteWeights.reduce((a, b) => a + b, 0);
  const targetWh = day.kwh * 1000;

  const readings = [];
  let cumulativeWh = startEnergyWh;

  for (let m = 0; m < READINGS_PER_DAY; m++) {
    const whThisMinute = (minuteWeights[m] / weightSum) * targetWh;
    cumulativeWh += whThisMinute;

    const powerW = whThisMinute * 60;                 // W เฉลี่ยของนาทีนี้ = Wh × 60
    const loadFactor = Math.min(powerW / 3500, 1);    // 0..1 ตามโหลดจริงของนาทีนั้น

    const voltage = 231 - loadFactor * 6 + (rng() - 0.5) * 2.4;        // โหลดสูง แรงดันหย่อนลงนิดหน่อย
    const powerFactor = Math.min(0.99, 0.96 - loadFactor * 0.08 + (rng() - 0.5) * 0.02);
    const current = powerW / (voltage * powerFactor);                  // A = W / (V × PF)
    const frequency = 50 + (rng() - 0.5) * 0.08;

    readings.push({
      recordedAt: new Date(day.startMs + m * 60 * 1000).toISOString(),
      voltage: round(voltage, 1),
      current: round(current, 3),
      power: round(powerW, 2),
      energy: round(cumulativeWh, 2),
      frequency: round(frequency, 2),
      powerFactor: round(powerFactor, 3)
    });
  }
  return { readings, cumulativeEnergyWhEnd: cumulativeWh };
}

// ตรวจว่าผลรวมพลังงานรายวัน (คำนวณจากผลต่างของ energy แบบเดียวกับฟังก์ชัน pzem_daily_usage) ตรงกับ Excel
function verifyDailyTotals(days, allReadings) {
  const sums = new Map();
  for (let i = 1; i < allReadings.length; i++) {
    const t = new Date(allReadings[i].recordedAt).getTime();
    const key = new Date(t + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
    const delta = allReadings[i].energy - allReadings[i - 1].energy;
    sums.set(key, (sums.get(key) || 0) + delta);
  }
  let maxErr = 0, worst = days[0].key;
  for (const d of days) {
    const got = (sums.get(d.key) || 0) / 1000;
    const err = Math.abs(got - d.kwh);
    if (err > maxErr) { maxErr = err; worst = d.key; }
  }
  return { maxErr, worst };
}

async function pickStartEnergy(simEndISO, totalWh) {
  // ถ้าฐานข้อมูลมี reading จริงหลังช่วงจำลองอยู่แล้ว ให้ต่อ energy สะสมให้ไหลต่อเนื่องกับค่านั้น (ถ้าเป็นไปได้)
  if (!supabase) return 0;
  const { data, error } = await supabase
    .from('pzem_readings')
    .select('energy')
    .gte('recorded_at', simEndISO)
    .not('energy', 'is', null)
    .order('recorded_at', { ascending: true })
    .limit(1);
  if (error || !data || data.length === 0) return 0;
  const e = Number(data[0].energy);
  return Number.isFinite(e) && e >= totalWh ? e - totalWh : 0;
}

async function main() {
  if (!fs.existsSync(EXCEL_PATH)) {
    console.error(`✗ ไม่พบไฟล์ Excel ที่ ${EXCEL_PATH}\n  วางไฟล์ไว้ที่ data/simulated_electricity_usage.xlsx หรือส่ง path ต่อท้ายคำสั่ง`);
    process.exit(1);
  }
  if (!DRY_RUN && !supabase) {
    console.error('✗ ยังไม่ได้ตั้ง SUPABASE_URL / SUPABASE_SERVICE_KEY ใน env — ยกเลิก (ใส่ --dry-run ถ้าแค่อยากตรวจไฟล์)');
    process.exit(1);
  }

  const days = loadDailyKwh();
  if (days.length === 0) {
    console.error('✗ อ่านข้อมูลรายวันจากไฟล์ไม่ได้เลย — เช็คว่าหัวตารางมีคำว่า "วันที่" และ "kWh"/"หน่วย"');
    process.exit(1);
  }
  const totalKwh = days.reduce((s, d) => s + d.kwh, 0);
  const kwhs = days.map(d => d.kwh);
  const minKwh = Math.min(...kwhs), maxKwh = Math.max(...kwhs);
  console.log(`อ่าน Excel ได้ ${days.length} วัน (${days[0].key} → ${days[days.length - 1].key}) รวม ${totalKwh.toFixed(2)} kWh | ต่ำสุด ${minKwh} สูงสุด ${maxKwh} เฉลี่ย ${(totalKwh / days.length).toFixed(2)} kWh/วัน`);

  for (let i = 1; i < days.length; i++) {
    const gapDays = Math.round((days[i].startMs - days[i - 1].startMs) / 86400000);
    if (gapDays !== 1) console.warn(`! วันที่ไม่ต่อเนื่อง: ${days[i - 1].key} → ${days[i].key} (ห่าง ${gapDays} วัน)`);
  }

  const rangeStartISO = new Date(days[0].startMs).toISOString();
  const rangeEndISO = new Date(days[days.length - 1].startMs + READINGS_PER_DAY * 60 * 1000).toISOString();

  if (!DRY_RUN) {
    const { count, error: countErr } = await supabase
      .from('pzem_readings')
      .select('id', { count: 'exact', head: true })
      .gte('recorded_at', rangeStartISO)
      .lt('recorded_at', rangeEndISO);
    if (countErr) { console.error('✗ เช็คข้อมูลเดิมไม่สำเร็จ:', countErr.message); process.exit(1); }
    if (count > 0) {
      if (!REPLACE) {
        console.error(`✗ มีข้อมูลอยู่แล้ว ${count} แถวในช่วง ${days[0].key} → ${days[days.length - 1].key} — ไม่เขียนซ้ำ\n  ถ้าต้องการลบช่วงนี้แล้วสร้างใหม่ ให้รันซ้ำพร้อม --replace`);
        process.exit(1);
      }
      const { error: delErr } = await supabase
        .from('pzem_readings').delete().gte('recorded_at', rangeStartISO).lt('recorded_at', rangeEndISO);
      if (delErr) { console.error('✗ ลบข้อมูลช่วงเดิมไม่สำเร็จ:', delErr.message); process.exit(1); }
      console.log(`ลบข้อมูลเดิมในช่วงนี้ ${count} แถวแล้ว`);
    }
  }

  const startEnergy = DRY_RUN ? 0 : await pickStartEnergy(rangeEndISO, totalKwh * 1000);

  // สร้างข้อมูลทุกวัน
  let cumulativeWh = startEnergy;
  let allReadings = [];
  days.forEach((d, i) => {
    const acStrength = maxKwh > minKwh ? (d.kwh - minKwh) / (maxKwh - minKwh) : 0.5;
    const { readings, cumulativeEnergyWhEnd } = genDayReadings(d, i, acStrength, cumulativeWh);
    cumulativeWh = cumulativeEnergyWhEnd;
    allReadings = allReadings.concat(readings);
  });

  // แถวฐาน 1 แถว (นาทีก่อนวันแรก) ถือค่าสะสมเริ่มต้น เพื่อให้พลังงานของนาทีแรกถูกนับรวมในวันแรกครบ
  const first = allReadings[0];
  allReadings.unshift({
    ...first,
    recordedAt: new Date(days[0].startMs - 60 * 1000).toISOString(),
    energy: round(startEnergy, 2)
  });

  console.log(`สร้างข้อมูลทั้งหมด ${allReadings.length} readings (${days.length} วัน × ${READINGS_PER_DAY} นาที + แถวฐาน 1 แถว)`);
  console.log(`energy สะสม: ${round(startEnergy / 1000, 2)} → ${round(cumulativeWh / 1000, 2)} kWh`);

  const { maxErr, worst } = verifyDailyTotals(days, allReadings);
  console.log(`ตรวจผลรวมรายวันเทียบ Excel: คลาดเคลื่อนสูงสุด ${maxErr.toFixed(4)} kWh (วัน ${worst})`);
  if (maxErr > 0.005) {
    console.error('✗ ผลรวมรายวันไม่ตรงกับ Excel เกินเกณฑ์ — ยกเลิก ไม่เขียนฐานข้อมูล');
    process.exit(1);
  }

  const preview = [days[0], days[1], days[days.length - 1]].filter(Boolean);
  const peak = allReadings.reduce((a, b) => (b.power > a.power ? b : a));
  console.log(`ตัวอย่างวัน: ${preview.map(d => `${d.key}=${d.kwh}kWh`).join(', ')} | โหลดสูงสุด ${peak.power} W ที่ ${peak.recordedAt}`);

  if (DRY_RUN) {
    console.log('✓ --dry-run: ตรวจเสร็จ ยังไม่ได้เขียนอะไรลงฐานข้อมูล');
    return;
  }

  let inserted = 0;
  for (let i = 0; i < allReadings.length; i += CHUNK) {
    const chunk = allReadings.slice(i, i + CHUNK).map(r => ({
      recorded_at: r.recordedAt,
      voltage: r.voltage,
      current: r.current,
      power: r.power,
      energy: r.energy,
      frequency: r.frequency,
      power_factor: r.powerFactor
    }));
    let { error } = await supabase.from('pzem_readings').insert(chunk);
    if (error) { // ลองซ้ำอีกครั้ง กันเน็ตสะดุด
      ({ error } = await supabase.from('pzem_readings').insert(chunk));
    }
    if (error) {
      console.error(`\n✗ insert ชุด ${i}-${i + chunk.length} ล้มเหลว:`, error.message);
      console.error('  ถ้าใส่ไปแล้วบางส่วน ให้รันซ้ำพร้อม --replace เพื่อล้างช่วงนี้แล้วเริ่มใหม่');
      process.exit(1);
    }
    inserted += chunk.length;
    process.stdout.write(`\rinsert แล้ว ${inserted}/${allReadings.length}`);
  }
  console.log(`\n✓ เสร็จแล้ว: บันทึก ${inserted} แถวลง pzem_readings`);
}

main().catch(err => {
  console.error('✗ เกิดข้อผิดพลาด:', err);
  process.exit(1);
});
