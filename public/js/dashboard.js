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

// ---------- AC controls ----------
const acSwitch = document.getElementById('ac-switch');
const acIcon = document.getElementById('ac-icon');
const acStatus = document.getElementById('ac-status');
const tempOpts = document.querySelectorAll('.temp-opt');

function renderAc(ac) {
  acSwitch.checked = ac.power;
  acIcon.classList.toggle('on', ac.power);
  acStatus.textContent = ac.power ? `กำลังทำงาน · ${ac.temp}°C` : 'ปิดอยู่';

  tempOpts.forEach(opt => {
    const t = parseInt(opt.dataset.temp, 10);
    opt.classList.toggle('active', t === ac.temp);
    opt.classList.toggle('disabled', !ac.power);
  });
}

if (acSwitch) {
  acSwitch.addEventListener('change', async () => {
    const result = await postJSON('/api/ac/power', { power: acSwitch.checked });
    if (result.ok) renderAc(result.ac);
  });
}

tempOpts.forEach(opt => {
  opt.addEventListener('click', async () => {
    if (opt.classList.contains('disabled')) return;
    const temp = opt.dataset.temp;
    const result = await postJSON('/api/ac/temp', { temp });
    if (result.ok) renderAc(result.ac);
  });
});

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

// ---------- poll for fresh sensor + device state every 5s ----------
async function pollState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok) {
      renderSensor(data.sensor);
      renderAc(data.devices.ac);
    }
  } catch (e) {
    // เงียบไว้ ไม่ต้องรบกวนผู้ใช้ด้วย error ทุก 5 วิ
  }
}

setInterval(pollState, 5000);
