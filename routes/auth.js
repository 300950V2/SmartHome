const express = require('express');
const router = express.Router();
const store = require('../data/store');
const { requireAuth } = require('./middleware');

// หน้า Login
router.get('/login', (req, res) => {
  if (req.session && req.session.loggedIn) {
    return res.redirect('/');
  }
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (store.verifyLogin(username, password)) {
    req.session.loggedIn = true;
    req.session.username = username;
    return res.redirect('/');
  }
  return res.render('login', { error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// หน้าเปลี่ยนรหัสผ่าน
router.get('/change-password', requireAuth, (req, res) => {
  res.render('change-password', { error: null, success: null });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword, confirmPassword } = req.body;

  if (!oldPassword || !newPassword || !confirmPassword) {
    return res.render('change-password', { error: 'กรุณากรอกข้อมูลให้ครบ', success: null });
  }
  if (newPassword !== confirmPassword) {
    return res.render('change-password', { error: 'รหัสผ่านใหม่ไม่ตรงกัน', success: null });
  }
  if (newPassword.length < 6) {
    return res.render('change-password', { error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร', success: null });
  }

  const result = store.changePassword(oldPassword, newPassword);
  if (!result.ok) {
    return res.render('change-password', { error: result.message, success: null });
  }
  return res.render('change-password', { error: null, success: 'เปลี่ยนรหัสผ่านสำเร็จแล้ว' });
});

module.exports = router;
