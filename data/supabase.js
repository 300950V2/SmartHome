// data/supabase.js
// ตัวเชื่อมต่อ Supabase (ใช้ service key ฝั่งเซิร์ฟเวอร์เท่านั้น ห้ามส่งคีย์นี้ไปฝั่ง client)
//
// ENV ที่ต้องตั้งบน Render:
//   SUPABASE_URL          Project URL จากหน้า Settings > API
//   SUPABASE_SERVICE_KEY  Secret key (service_role) จากหน้า Settings > API Keys

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

let client = null;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false } // ฝั่งเซิร์ฟเวอร์ ไม่ต้องเก็บ session
  });
} else {
  console.warn('[supabase] ยังไม่ได้ตั้ง SUPABASE_URL / SUPABASE_SERVICE_KEY — heartbeat state จะไม่รอด restart');
}

module.exports = { supabase: client };
