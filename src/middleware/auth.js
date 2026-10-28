const { getPool, sql } = require('../db');
const { COOKIE_NAME, verifyAuthToken } = require('../auth/token');

function parseCookies(header = '') {
  return header.split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 1) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch (_) {
      cookies[key] = value;
    }
    return cookies;
  }, {});
}

function unauthorized(res, message = 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn') {
  return res.status(401).json({ success: false, message });
}

async function requireAdmin(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return unauthorized(res, 'Bạn cần đăng nhập để sử dụng chức năng này');

    let payload;
    try {
      payload = verifyAuthToken(token);
    } catch (_) {
      return unauthorized(res);
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, Number(payload.sub))
      .query(`
        SELECT u.id, u.username, u.email, u.name, u.role_id,
               r.code AS role_code, r.role_name
        FROM users u
        INNER JOIN roles r ON r.id=u.role_id
        WHERE u.id=@id AND u.status=1 AND r.status=1
      `);
    if (!result.recordset.length) return unauthorized(res);

    const user = result.recordset[0];
    if (user.role_code !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Tài khoản không có quyền quản trị hệ thống' });
    }
    if (payload.role_code !== 'ADMIN') return unauthorized(res);

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { parseCookies, requireAdmin };
