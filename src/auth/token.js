const crypto = require('crypto');

const COOKIE_NAME = 'ewarehouse_session';
const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const REMEMBER_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

function sessionLifetime(rememberMe) {
  return rememberMe === true ? REMEMBER_TOKEN_TTL_SECONDS : TOKEN_TTL_SECONDS;
}

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    const error = new Error('JWT_SECRET phải có ít nhất 32 ký tự');
    error.code = 'AUTH_CONFIGURATION_ERROR';
    throw error;
  }
  return secret;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function signatureFor(unsignedToken) {
  return crypto.createHmac('sha256', getSecret()).update(unsignedToken).digest('base64url');
}

function signAuthToken(user, nowSeconds = Math.floor(Date.now() / 1000), rememberMe = false) {
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    sub: String(user.id),
    username: user.username,
    role_code: user.role_code,
    iat: nowSeconds,
    exp: nowSeconds + sessionLifetime(rememberMe),
  });
  const unsignedToken = `${header}.${payload}`;
  return `${unsignedToken}.${signatureFor(unsignedToken)}`;
}

function verifyAuthToken(token, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string') throw new Error('Token không hợp lệ');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Token không hợp lệ');

  const unsignedToken = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(signatureFor(unsignedToken));
  const received = Buffer.from(parts[2]);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    throw new Error('Chữ ký token không hợp lệ');
  }

  const header = decode(parts[0]);
  const payload = decode(parts[1]);
  if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new Error('Thuật toán token không hợp lệ');
  if (!Number.isInteger(payload.exp) || payload.exp <= nowSeconds) throw new Error('Token đã hết hạn');
  if (!Number.isInteger(payload.iat) || payload.iat > nowSeconds + 60) throw new Error('Thời điểm token không hợp lệ');
  if (!/^\d+$/.test(String(payload.sub || ''))) throw new Error('Chủ thể token không hợp lệ');
  return payload;
}

function cookieOptions(rememberMe = false) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: sessionLifetime(rememberMe) * 1000,
    path: '/',
  };
}

function clearCookieOptions() {
  const { maxAge, ...options } = cookieOptions();
  return options;
}

module.exports = {
  COOKIE_NAME,
  TOKEN_TTL_SECONDS,
  REMEMBER_TOKEN_TTL_SECONDS,
  signAuthToken,
  verifyAuthToken,
  cookieOptions,
  clearCookieOptions,
};
