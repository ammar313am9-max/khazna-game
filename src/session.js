'use strict';

/**
 * الجلسات: كوكي موقّع بـ HMAC وHttpOnly. لا تُخزَّن أي كلمة مرور أو رمز أدمن في المتصفح.
 */

const config = require('./config');
const http = require('./http');
const security = require('./security');
const store = require('./db');

const ROLE_USER = 'user';
const ROLE_ADMIN = 'admin';

function cookieName(role) {
  return role === ROLE_ADMIN ? config.cookie.adminName : config.cookie.name;
}

function readToken(req, role) {
  if (!req.__cookies) req.__cookies = http.parseCookies(req.headers.cookie || '');
  return req.__cookies[cookieName(role)] || null;
}

/** يقرأ كوكي الجلسة ويؤكد التوقيع، فيعيد { uid, role, exp } أو null. */
function readSession(req, role) {
  const raw = readToken(req, role);
  if (!raw) return null;
  return security.verifyToken(raw);
}

function issueSession(res, payload) {
  const body = { ...payload, iat: Date.now(), exp: Date.now() + config.cookie.maxAgeSeconds * 1000 };
  http.setCookie(res, cookieName(payload.role), security.signToken(body));
}

function revokeSession(res, role) {
  http.clearCookie(res, cookieName(role));
}

/** يعيد صف المستخدم من قاعدة البيانات أو null. الجلسات الصادرة قبل آخر تسجيل خروج تُلغى. */
function currentUser(req) {
  const session = readSession(req, ROLE_USER);
  if (!session || session.role !== ROLE_USER) return null;
  const row = store.get(
    `SELECT id, username, referral_code, referred_by, attempts, referral_bonus, guesses_used, wins, total_purchased, created_at, session_epoch
     FROM users WHERE id = ?`,
    session.uid
  );
  if (!row) return null;
  if ((session.iat || 0) < row.session_epoch) return null;
  return row;
}

function isAdmin(req) {
  const session = readSession(req, ROLE_ADMIN);
  if (!session || session.role !== ROLE_ADMIN) return false;
  const epoch = Number(store.getSetting('admin_epoch', 0));
  return (session.iat || 0) >= epoch;
}

/** إلغاء جلسة المستخدم: أي كوكي قديم لهذا الحساب يصبح بلا قيمة حتى لو لم يصلح في المتصفح. */
function dropUserSession(req) {
  const user = currentUser(req);
  if (user) store.run('UPDATE users SET session_epoch = ? WHERE id = ?', Date.now(), user.id);
}

function dropAdminSession() {
  store.setSetting('admin_epoch', Date.now());
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new http.HttpError(401, 'يجب تسجيل الدخول أولاً');
  return user;
}

function requireAdmin(req) {
  if (!isAdmin(req)) throw new http.HttpError(403, 'هذه العملية مخصّصة للوحة الأدمن');
}

/** الشكل العام للمستخدم الذي يُسمح بإعادته للواجهة. */
function publicUser(row) {
  if (!row) return null;
  let referrer = null;
  if (row.referred_by) {
    const parent = store.get('SELECT username, referral_code FROM users WHERE id = ?', row.referred_by);
    referrer = parent ? parent.username : null;
  }
  return {
    id: row.id,
    username: row.username,
    referralCode: row.referral_code,
    attempts: row.attempts,
    referralBonus: row.referral_bonus,
    guessesUsed: row.guesses_used,
    wins: row.wins,
    totalPurchased: row.total_purchased,
    referredBy: referrer,
    createdAt: row.created_at,
  };
}

module.exports = {
  ROLE_USER,
  ROLE_ADMIN,
  issueSession,
  revokeSession,
  readSession,
  currentUser,
  isAdmin,
  requireUser,
  requireAdmin,
  dropUserSession,
  dropAdminSession,
  publicUser,
};
