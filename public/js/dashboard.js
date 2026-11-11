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

// ---------- relay buttons: กดปุ๊บเดียวเป็น pulse ไม่ค้างสถานะ (เหมือนปุ่มแอร์) ---------- <-- เพิ่ม
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
          ? `กดล่าสุด: ${RELAY_LABELS[key] || key}`
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

// ---------- กราฟเทรนด์การใช้ไฟย้อนหลัง ----------
// วาดเส้นต่อเนื่องเดียวกันทั้งของจริง (live) และข้อมูลจำลอง (simulated) แต่ช่วงที่เป็นข้อมูลจำลอง
// จะใช้สีจางกว่า+เส้นประ ให้แยกออกได้ชัดเจนว่าช่วงไหนเป็นค่าที่วัดได้จริงจาก PZEM
async function loadPzemHistoryChart() {
  const canvas = document.getElementById('pzem-history-chart');
  const emptyMsg = document.getElementById('pzem-chart-empty');
  if (!canvas || typeof Chart === 'undefined') return;

  let data;
  try {
    const res = await fetch('/api/pzem/history?days=60');
    data = await res.json();
  } catch (e) {
    return;
  }
  if (!data.ok || !data.days || data.days.length === 0) {
    canvas.style.display = 'none';
    if (emptyMsg) emptyMsg.style.display = 'block';
    return;
  }

  const labels = data.days.map(d => {
    const dt = new Date(d.date + 'T00:00:00');
    return dt.toLocaleDateString('th-TH', { day: '2-digit', month: 'short' });
  });
  const values = data.days.map(d => d.kwh);
  const isSimulated = data.days.map(d => d.source === 'simulated');

  // แต้มสีจุดต่อจุด: จุดไหนเป็นข้อมูลจำลองให้จางกว่า จุดไหนเป็นของจริงให้เป็นสี accent
  const pointColors = isSimulated.map(sim => sim ? 'rgba(245, 246, 250, 0.35)' : '#8b8ff8');
  // เส้นประเฉพาะช่วงจำลอง: ใช้ segment callback ของ Chart.js ตาม index ของจุดปลายส่วน (p1)
  const segmentDash = (ctx) => (isSimulated[ctx.p1DataIndex] ? [6, 4] : undefined);
  const segmentColor = (ctx) => (isSimulated[ctx.p1DataIndex] ? 'rgba(245, 246, 250, 0.35)' : '#8b8ff8');

  new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'หน่วยไฟที่ใช้ (kWh/วัน)',
        data: values,
        borderWidth: 2,
        pointRadius: 2,
        pointBackgroundColor: pointColors,
        pointBorderColor: pointColors,
        tension: 0.3,
        spanGaps: true,
        segment: {
          borderColor: segmentColor,
          borderDash: segmentDash
        }
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: 'rgba(245,246,250,0.5)', maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: 'rgba(245,246,250,0.5)' }, grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: 'kWh', color: 'rgba(245,246,250,0.5)' } }
      }
    }
  });
}

loadPzemHistoryChart();