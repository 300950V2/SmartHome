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

// ---------- render sensor values into DOM ----------
function renderSensor(sensor) {
  document.getElementById('outdoor-temp').textContent = fmtTemp(sensor.outdoor.temp);
  document.getElementById('outdoor-humidity').textContent = fmtHumidity(sensor.outdoor.humidity);
  document.getElementById('bedroom-temp').textContent = fmtTemp(sensor.bedroom.temp);
  document.getElementById('bedroom-humidity').textContent = fmtHumidity(sensor.bedroom.humidity);
  document.getElementById('last-update').textContent = fmtTime(sensor.lastUpdate);
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

// ---------- poll for fresh sensor state every 5s (ไม่ดึง ac มาทับ เพราะไม่มี state จริงให้ sync) ----------
async function pollState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok) {
      renderSensor(data.sensor);
    }
  } catch (e) {
    // เงียบไว้ ไม่ต้องรบกวนผู้ใช้ด้วย error ทุก 5 วิ
  }
}

setInterval(pollState, 5000);