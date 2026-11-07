// routes/heartbeat.js
// รับ heartbeat จากบอร์ด (Raspberry Pi / Home Assistant) และแจ้ง LINE เมื่อสัญญาณหายไป (ไฟดับ)
//
// ENV ที่ต้องตั้งบน Render:
//   HEARTBEAT_TOKEN             รหัสลับ (ต้องตรงกับที่ตั้งฝั่ง Home Assistant)
//   LINE_CHANNEL_ACCESS_TOKEN   Channel access token (long-lived) จาก LINE Developers
//   LINE_TO                     userId หรือ groupId ที่จะให้ส่งแจ้งเตือนไปหา
//   HEARTBEAT_TIMEOUT_SEC       (ไม่บังคับ) ขาดสัญญาณกี่วินาทีถึงแจ้ง ค่าเริ่มต้น 180

const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('./middleware');

const router = express.Router();

const TOKEN = process.env.HEARTBEAT_TOKEN || '';
const TIMEOUT_MS = (parseInt(process.env.HEARTBEAT_TIMEOUT_SEC, 10) || 180) * 1000;
const CHECK_INTERVAL_MS = 30 * 1000;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_TO = process.env.LINE_TO || '';

// เริ่มต้นให้ lastBeat = เวลาที่เซิร์ฟเวอร์เริ่มทำงาน
// (ถ้าเซิร์ฟเวอร์รีสตาร์ตแล้วบอร์ดยังเงียบเกินกำหนด ก็จะแจ้งเตือนตามปกติ)
const state = {
  lastBeat: Date.now(),
  lastInfo: null,
  offline: false,
  offlineSince: null
};

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
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

// ---- รับ heartbeat จากบอร์ด: POST /api/heartbeat ----
router.post('/', (req, res) => {
  if (!TOKEN) {
    return res.status(503).json({ ok: false, error: 'HEARTBEAT_TOKEN not configured' });
  }
  const given = req.get('x-heartbeat-token') || '';
  if (!safeEqual(given, TOKEN)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const now = Date.now();
  const wasOffline = state.offline;
  const downMs = wasOffline ? now - state.offlineSince : 0;

  state.lastBeat = now;
  state.lastInfo = req.body && typeof req.body === 'object' ? req.body : null;
  state.offline = false;
  state.offlineSince = null;

  if (wasOffline) {
    pushLine(
      `✅ บอร์ดกลับมาออนไลน์แล้ว\n` +
      `ขาดการติดต่อไปประมาณ ${fmtDuration(downMs)}\n` +
      `กลับมาเมื่อ: ${fmtTime(now)}`
    );
  }

  res.json({ ok: true });
});

// ---- ดูสถานะ (ต้อง login): GET /api/heartbeat/status ----
router.get('/status', requireAuth, (req, res) => {
  res.json({
    online: !state.offline,
    lastBeat: new Date(state.lastBeat).toISOString(),
    secondsSinceLastBeat: Math.round((Date.now() - state.lastBeat) / 1000),
    timeoutSec: TIMEOUT_MS / 1000,
    info: state.lastInfo
  });
});

// ---- ตัวเช็กว่าบอร์ดเงียบเกินกำหนดหรือยัง ----
function startMonitor() {
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
    }
  }, CHECK_INTERVAL_MS);
  console.log(`✓ Heartbeat monitor started (timeout ${TIMEOUT_MS / 1000}s)`);
}

module.exports = { router, startMonitor };
