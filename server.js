require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');

const store = require('./data/store');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const { router: heartbeatRoutes, startMonitor } = require('./routes/heartbeat'); // <-- เพิ่ม
const { requireAuth } = require('./routes/middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- view engine ----
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---- middleware ----
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.set('trust proxy', 1); // จำเป็นสำหรับ Render (อยู่หลัง proxy)

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 วัน
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true
  }
}));

// ---- route: health check / keep-alive สำหรับ cron (กัน Render free tier หลับ) ----
app.get('/200', (req, res) => {
  res.status(200).json({ ok: true, status: 'awake', time: new Date().toISOString() });
});

// ---- auth routes (login, logout, change-password) ----
app.use('/', authRoutes);

// ---- heartbeat จากบอร์ด (ต้องอยู่ "ก่อน" /api เพื่อไม่ถูก apiRoutes ดักไว้) ----
app.use('/api/heartbeat', heartbeatRoutes); // <-- เพิ่ม

// ---- api routes (sensor data จาก MCU, ควบคุมอุปกรณ์) ----
app.use('/api', apiRoutes);

// ---- หน้า dashboard หลัก (ต้อง login ก่อน) ----
app.get('/', requireAuth, (req, res) => {
  const db = store.getDB();
  res.render('dashboard', {
    sensor: db.sensor,
    devices: db.devices,
    username: req.session.username
  });
});

// ---- 404 ----
app.use((req, res) => {
  res.status(404).send('404 Not Found');
});

app.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`);
  startMonitor(); // <-- เพิ่ม: เริ่มตรวจว่าบอร์ดเงียบหรือไม่
});