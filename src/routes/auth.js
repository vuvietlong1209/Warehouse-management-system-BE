const express = require('express');
const bcrypt = require('bcryptjs');
const { getPool, sql } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const {
  COOKIE_NAME,
  signAuthToken,
  cookieOptions,
  clearCookieOptions,
} = require('../auth/token');

const router = express.Router();
const attempts = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;

function attemptKey(req, username) {
  return `${req.ip || req.socket.remoteAddress || 'unknown'}:${String(username || '').toLowerCase()}`;
}

function activeAttempt(key) {
  const entry = attempts.get(key);
  if (!entry) return null;
  if (Date.now() - entry.startedAt >= LOCK_WINDOW_MS) {
    attempts.delete(key);
    return null;
  }
  return entry;
}

function recordFailure(key) {
  const entry = activeAttempt(key) || { count: 0, startedAt: Date.now() };
  entry.count += 1;
  attempts.set(key, entry);
}

function safeUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    role_id: user.role_id,
    role_code: user.role_code,
    role_name: user.role_name,
  };
}

router.post('/login', async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const rememberMe = req.body?.remember_me;
    if (rememberMe !== undefined && typeof rememberMe !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Lựa chọn ghi nhớ đăng nhập không hợp lệ' });
    }
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Vui lòng nhập tên đăng nhập và mật khẩu' });
    }

    const key = attemptKey(req, username);
    const entry = activeAttempt(key);
    if (entry && entry.count >= MAX_FAILED_ATTEMPTS) {
      return res.status(429).json({
        success: false,
        message: 'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút',
      });
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('username', sql.NVarChar(64), username)
      .query(`
        SELECT u.id, u.username, u.password, u.email, u.name, u.role_id, u.status,
               r.code AS role_code, r.role_name, r.status AS role_status
        FROM users u
        LEFT JOIN roles r ON r.id=u.role_id
        WHERE u.username=@username
      `);
    const user = result.recordset[0];
    const passwordMatches = user ? await bcrypt.compare(password, user.password) : false;
    if (!user || !passwordMatches || !user.status || !user.role_status) {
      recordFailure(key);
      return res.status(401).json({ success: false, message: 'Tên đăng nhập hoặc mật khẩu không đúng' });
    }
    if (user.role_code !== 'ADMIN') {
      recordFailure(key);
      return res.status(403).json({ success: false, message: 'Chỉ tài khoản quản trị viên được phép đăng nhập' });
    }

    attempts.delete(key);
    const token = signAuthToken(user, undefined, rememberMe === true);
    res.cookie(COOKIE_NAME, token, cookieOptions(rememberMe === true));
    return res.json({ success: true, user: safeUser(user) });
  } catch (error) {
    next(error);
  }
});

router.get('/me', requireAdmin, (req, res) => {
  res.json({ success: true, user: safeUser(req.user) });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, clearCookieOptions());
  res.json({ success: true, message: 'Đã đăng xuất' });
});

module.exports = router;
