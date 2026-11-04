function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) {
    return next();
  }
  return res.redirect('/login');
}

function requireAuthApi(req, res, next) {
  if (req.session && req.session.loggedIn) {
    return next();
  }
  return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบ' });
}

// ตรวจสอบ API key สำหรับ MCU (กันคนภายนอกยิง sensor data มั่ว)
function requireMcuKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!process.env.MCU_API_KEY || key === process.env.MCU_API_KEY) {
    return next();
  }
  return res.status(401).json({ ok: false, message: 'Invalid API key' });
}

module.exports = { requireAuth, requireAuthApi, requireMcuKey };
