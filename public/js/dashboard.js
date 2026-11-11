// ---------- helper ----------
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return res.json();
}

function fmtTemp(v) {
  return (v === null || v === undefined) ? '--' : Number(v).toFixed(1);
}
function fmtHumidity(v) {
  return (v === null || v === undefined) ? '--' : Math.round(v);
}
function fmtTime(iso) {
  if (!iso) return 'ยังไม่มีข้อมูล';
  const d = new Date(iso);
  return 'อัปเดตล่าสุด ' + d.toLocaleString('th-TH', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
}
// แสดงค่า PZEM: คืน '--' ถ้าไม่มีข้อมูล (ยังไม่เคยอ่านได้ หรือ unavailable) ไม่ใช่ error <-- เพิ่ม
function fmtPzem(v, digits) {
  return (v === null || v === undefined) ? '--' : Number(v).toFixed(digits);
}

// ---------- render sensor values into DOM ----------
function renderSensor(sensor) {
  document.getElementById('outdoor-temp').textContent = fmtTemp(sensor.outdoor.temp);
  document.getElementById('outdoor-humidity').textContent = fmtHumidity(sensor.outdoor.humidity);
  document.getElementById('bedroom-temp').textContent = fmtTemp(sensor.bedroom.temp);
  document.getElementById('bedroom-humidity').textContent = fmtHumidity(sensor.bedroom.humidity);
  document.getElementById('last-update').textContent = fmtTime(sensor.lastUpdate);
}

// ---------- render PZEM values into DOM (การ์ดเดียว เรียงเป็นรายการ) ---------- <-- เพิ่ม
function renderPzem(pzem) {
  if (!pzem) return;
  document.getElementById('pzem-voltage').textContent = fmtPzem(pzem.voltage, 1) + ' V';
  document.getElementById('pzem-current').textContent = fmtPzem(pzem.current, 3) + ' A';
  document.getElementById('pzem-power').textContent = fmtPzem(pzem.power, 2) + ' W';
  document.getElementById('pzem-energy').textContent = fmtPzem(pzem.energy, 0) + ' Wh';
  document.getElementById('pzem-frequency').textContent = fmtPzem(pzem.frequency, 1) + ' Hz';
  document.getElementById('pzem-power-factor').textContent = fmtPzem(pzem.powerFactor, 2);
}

// ---------- AC controls (รีโมท IR แบบกดยิงสัญญาณ ไม่มี state จริงให้ sync) ----------
const acStatus = document.getElementById('ac-status');
const acPowerOnBtn = document.getElementById('ac-power-on');
const acPowerOffBtn = document.getElementById('ac-power-off');

// แค่โชว์ "กดอะไรไปล่าสุด" เป็นฟีดแบ็กชั่วคราว ไม่ใช่สถานะจริงของแอร์ (ไม่มี feedback จาก IR)
function showAcLastAction(action) {
  if (!acStatus) return;
  if (action === 'power_on') acStatus.textContent = 'กดล่าสุด: เปิด';
  else if (action === 'power_off') acStatus.textContent = 'กดล่าสุด: ปิด';
  else {
    const m = /^temp_(\d+)$/.exec(action);
    if (m) acStatus.textContent = 'กดล่าสุด: อุณหภูมิ ' + m[1] + '°C';
  }
}

async function sendAcAction(action, extra) {
  const result = await postJSON('/api/ac/' + (action === 'power_on' || action === 'power_off' ? 'power' : 'temp'),
    action === 'power_on' ? { action: 'power_on' } :
    action === 'power_off' ? { action: 'power_off' } :
    extra // { temp: 18..30 }
  );
  if (result.ok) showAcLastAction(action);
  return result;
}

if (acPowerOnBtn) {
  acPowerOnBtn.addEventListener('click', () => sendAcAction('power_on'));
}
if (acPowerOffBtn) {
  acPowerOffBtn.addEventListener('click', () => sendAcAction('power_off'));
}

// ---------- ตัวเลือกอุณหภูมิแบบ +/- : ปรับเลขที่จอก่อน (ยังไม่ส่งอะไร) แล้วกด "ตั้งอุณหภูมิ" ทีเดียวค่อยยิง pulse ----------
const AC_TEMP_MIN = 18;
const AC_TEMP_MAX = 30;
const AC_TEMP_STEP = 2;

const tempDecBtn = document.getElementById('temp-dec');
const tempIncBtn = document.getElementById('temp-inc');
const tempPickerDeg = document.getElementById('temp-picker-deg');
const tempSetBtn = document.getElementById('temp-set-btn');
const tempSetDeg = document.getElementById('temp-set-deg');

let pickedTemp = 24; // ค่าตั้งต้นที่โชว์บนจอ ยังไม่ได้ส่งอะไรจนกว่าจะกดปุ่ม "ตั้งอุณหภูมิ"

function renderPickedTemp() {
  if (tempPickerDeg) tempPickerDeg.textContent = pickedTemp;
  if (tempSetDeg) tempSetDeg.textContent = pickedTemp;
}

if (tempDecBtn) {
  tempDecBtn.addEventListener('click', () => {
    pickedTemp = Math.max(AC_TEMP_MIN, pickedTemp - AC_TEMP_STEP);
    renderPickedTemp();
  });
}
if (tempIncBtn) {
  tempIncBtn.addEventListener('click', () => {
    pickedTemp = Math.min(AC_TEMP_MAX, pickedTemp + AC_TEMP_STEP);
    renderPickedTemp();
  });
}
if (tempSetBtn) {
  tempSetBtn.addEventListener('click', async () => {
    tempSetBtn.disabled = true;
    try {
      const action = 'temp_' + pickedTemp;
      await sendAcAction(action, { temp: pickedTemp });
    } finally {
      tempSetBtn.disabled = false;
    }
  });
}
renderPickedTemp();

// ---------- light devices (toggle cards) ----------
document.querySelectorAll('.device-card').forEach(card => {
  card.addEventListener('click', async () => {
    const key = card.dataset.key;
    const result = await postJSON(`/api/device/${key}/toggle`);
    if (result.ok) {
      card.classList.toggle('on', result.state);
      card.querySelector('.device-status').textContent = result.state ? 'เปิดอยู่' : 'ปิดอยู่';
    }
  });
});

// ---------- relay buttons: สวิตช์ค้าง กด 1 ครั้ง = สลับ เปิด/ปิด (เหมือนปุ่มใน Home Assistant) ---------- <-- แก้
const relayStatus = document.getElementById('relay-status');
const RELAY_LABELS = {
  relayFloor1: 'First Floor',
  relayAircon: 'Air Conditioner',
  relayFloor2: 'Second Floor'
};

document.querySelectorAll('.relay-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const key = btn.dataset.key;
    btn.disabled = true;
    try {
      const result = await postJSON(`/api/relay/${key}`);
      if (relayStatus) {
        relayStatus.textContent = result.ok
          ? `สั่ง ${RELAY_LABELS[key] || key}: ${result.target === 'on' ? 'เปิด' : 'ปิด'}`
          : (result.message || 'สั่งงานไม่สำเร็จ');
      }
    } finally {
      btn.disabled = false;
    }
  });
});

// ---------- poll for fresh sensor/pzem state every 5s (ไม่ดึง ac มาทับ เพราะไม่มี state จริงให้ sync) ----------
async function pollState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok) {
      renderSensor(data.sensor);
      renderPzem(data.pzem); // <-- เพิ่ม
    }
  } catch (e) {
    // เงียบไว้ ไม่ต้องรบกวนผู้ใช้ด้วย error ทุก 5 วิ
  }
}

setInterval(pollState, 5000);

// ---------- สรุป + กราฟเทรนด์การใช้ไฟย้อนหลัง (รายวัน, kWh) ----------
// ข้อมูลทุกวันถือเป็นชุดเดียวกัน ไม่มีการแยกสีหรือบอกที่มาของข้อมูลบนกราฟ
// แต่ละวันที่ไม่มีข้อมูลเลยจะเป็น kwh = null (เช่นช่วงที่ยังไม่ได้ต่อมิเตอร์) กราฟจะลากเส้นต่อข้ามให้
const USAGE_ACCENT = '139, 143, 248'; // rgb ของสี accent (#8b8ff8) ใช้ทำ gradient/จุด
const USAGE_REFRESH_MS = 5 * 60 * 1000; // รีเฟรชกราฟทุก 5 นาที เพื่อให้ยอด "วันนี้" ขยับตาม

let pzemChartInstance = null;
let pzemChartCurrentDays = 60;

// วันที่ปัจจุบันเป็น 'YYYY-MM-DD' ตามเวลาไทย (ไม่ขึ้นกับเขตเวลาของเครื่องที่เปิดเว็บ)
function todayBangkokKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

function fmtKwh(v, digits) {
  return (v === null || v === undefined || !Number.isFinite(v))
    ? '--'
    : v.toLocaleString('th-TH', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtDayShort(dateKey) {
  return new Date(dateKey + 'T00:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
}
function fmtDayLong(dateKey) {
  return new Date(dateKey + 'T00:00:00').toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ตัวเลขสรุปเหนือกราฟ: วันนี้ / เฉลี่ยต่อวัน / รวมทั้งช่วง / วันที่ใช้สูงสุด
function renderUsageStats(days) {
  const todayKey = todayBangkokKey();
  const withData = days.filter(d => d.kwh !== null && d.kwh !== undefined);

  // "เฉลี่ย" และ "สูงสุด" ไม่นับวันนี้ เพราะวันนี้ยังไม่จบ ยอดจะต่ำกว่าความจริงและทำให้ค่าเฉลี่ยเพี้ยน
  const complete = withData.filter(d => d.date !== todayKey);
  const total = withData.reduce((s, d) => s + d.kwh, 0);
  const avg = complete.length ? complete.reduce((s, d) => s + d.kwh, 0) / complete.length : null;
  const peak = complete.length ? complete.reduce((a, b) => (b.kwh > a.kwh ? b : a)) : null;
  const today = withData.find(d => d.date === todayKey);

  setText('usage-today', today ? fmtKwh(today.kwh, 1) : '--');
  setText('usage-avg', fmtKwh(avg, 1));
  setText('usage-total', fmtKwh(total, 0));
  setText('usage-peak', peak ? fmtKwh(peak.kwh, 1) : '--');
  setText('usage-peak-date', peak ? fmtDayShort(peak.date) : '');
}

function usageGradient(ctx) {
  const { chart } = ctx;
  const area = chart.chartArea;
  if (!area) return `rgba(${USAGE_ACCENT}, 0.18)`;
  const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
  g.addColorStop(0, `rgba(${USAGE_ACCENT}, 0.38)`);
  g.addColorStop(1, `rgba(${USAGE_ACCENT}, 0)`);
  return g;
}

function buildUsageChart(canvas, days) {
  const todayKey = todayBangkokKey();
  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: days.map(d => fmtDayShort(d.date)),
      datasets: [{
        label: 'หน่วยไฟที่ใช้ (kWh/วัน)',
        data: days.map(d => d.kwh),
        borderColor: `rgb(${USAGE_ACCENT})`,
        backgroundColor: usageGradient,
        fill: true,
        borderWidth: 2.5,
        tension: 0.35,
        spanGaps: true,
        pointRadius: days.length <= 14 ? 3.5 : 0,   // ช่วงสั้นโชว์จุด ช่วงยาวซ่อนจุดให้เส้นดูสะอาด
        pointHoverRadius: 6,
        pointBackgroundColor: `rgb(${USAGE_ACCENT})`,
        pointBorderColor: 'rgba(255,255,255,0.85)',
        pointBorderWidth: 1.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 450 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          padding: 10,
          backgroundColor: 'rgba(20, 22, 40, 0.92)',
          titleColor: 'rgba(245,246,250,0.75)',
          bodyColor: '#fff',
          bodyFont: { size: 14, weight: '600' },
          callbacks: {
            title: (items) => (items.length ? fmtDayLong(chartDays[items[0].dataIndex].date) : ''),
            label: (ctx) => `${fmtKwh(ctx.parsed.y, 2)} kWh`,
            afterLabel: (ctx) => (chartDays[ctx.dataIndex].date === todayKey ? 'ยอดสะสมของวันนี้ (ยังไม่จบวัน)' : '')
          }
        }
      },
      scales: {
        x: {
          ticks: { color: 'rgba(245,246,250,0.5)', maxTicksLimit: 8, maxRotation: 0 },
          grid: { display: false },
          border: { display: false }
        },
        y: {
          beginAtZero: true,
          ticks: { color: 'rgba(245,246,250,0.5)', maxTicksLimit: 5 },
          grid: { color: 'rgba(255,255,255,0.06)' },
          border: { display: false },
          title: { display: true, text: 'kWh', color: 'rgba(245,246,250,0.45)' }
        }
      }
    }
  });
}

// เก็บชุดข้อมูลปัจจุบันไว้ให้ tooltip อ้างถึง (callback ของ Chart.js อ่านตัวแปรนี้ตอนชี้/แตะ)
let chartDays = [];

async function loadPzemHistoryChart(days, opts) {
  days = days || pzemChartCurrentDays;
  pzemChartCurrentDays = days;
  const silent = opts && opts.silent; // รีเฟรชเงียบๆ ไม่ต้องกระพริบปุ่ม

  const canvas = document.getElementById('pzem-history-chart');
  const emptyMsg = document.getElementById('pzem-chart-empty');
  if (!canvas || typeof Chart === 'undefined') return;

  if (!silent) updateRangeButtonsActive(days);

  let data;
  try {
    const res = await fetch('/api/pzem/history?days=' + encodeURIComponent(days));
    data = await res.json();
  } catch (e) {
    return; // เน็ตหลุดชั่วคราว คงกราฟเดิมไว้
  }
  if (days !== pzemChartCurrentDays) return; // ผู้ใช้กดเปลี่ยนช่วงใหม่ระหว่างรอ ทิ้งผลเก่า

  const rows = data && data.ok && Array.isArray(data.days) ? data.days : [];
  const hasData = rows.some(d => d.kwh !== null && d.kwh !== undefined);

  renderUsageStats(rows);

  if (!hasData) {
    if (pzemChartInstance) { pzemChartInstance.destroy(); pzemChartInstance = null; }
    canvas.parentElement.style.display = 'none';
    if (emptyMsg) emptyMsg.style.display = 'block';
    return;
  }
  canvas.parentElement.style.display = 'block';
  if (emptyMsg) emptyMsg.style.display = 'none';

  chartDays = rows;
  if (pzemChartInstance) {
    // อัปเดตข้อมูลในกราฟเดิม (เปลี่ยนช่วง/รีเฟรช) แทนการสร้างใหม่ ให้เลื่อนเส้นนุ่มๆ
    const ds = pzemChartInstance.data.datasets[0];
    pzemChartInstance.data.labels = rows.map(d => fmtDayShort(d.date));
    ds.data = rows.map(d => d.kwh);
    ds.pointRadius = rows.length <= 14 ? 3.5 : 0;
    pzemChartInstance.update();
  } else {
    pzemChartInstance = buildUsageChart(canvas, rows);
  }
}

// ---------- ปุ่มเลือกช่วงเวลาย้อนหลัง (7 / 30 / 60 วัน) ----------
function updateRangeButtonsActive(days) {
  document.querySelectorAll('.usage-range-btn').forEach(btn => {
    const active = Number(btn.dataset.days) === Number(days);
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

document.querySelectorAll('.usage-range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    loadPzemHistoryChart(Number(btn.dataset.days));
  });
});

loadPzemHistoryChart(60);
setInterval(() => loadPzemHistoryChart(null, { silent: true }), USAGE_REFRESH_MS);