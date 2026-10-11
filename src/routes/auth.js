'use strict';

/**
 * مسارات الحسابات: إنشاء حساب (مع رمز إحالة اختياري)، تسجيل الدخول، الخروج، وهوية المستخدم.
 * كل قرارات المحاولات والمكافآت تُنفَّذ هنا على الخادم داخل معاملة واحدة.
 */

const config = require('../config');
const http = require('../http');
const store = require('../db');
const security = require('../security');
const session = require('../session');

const { HttpError } = http;

const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]{3,24}$/u;

function assertValidUsername(value) {
  const username = security.normalizeUsername(value);
  if (!USERNAME_PATTERN.test(username)) {
    throw new HttpError(400, 'اسم المستخدم يجب أن يكون من 3 إلى 24 حرفاً (حروف عربية أو إنجليزية، أرقام، _ . -)');
  }
  return username;
}

function assertValidPassword(value) {
  if (!security.isValidPassword(value)) {
    throw new HttpError(400, 'كلمة المرور يجب ألا تقل عن 6 أحرف');
  }
  return String(value);
}

function generateUniqueReferralCode() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = security.randomReferralCode(8);
    if (!store.get('SELECT id FROM users WHERE referral_code = ?', code)) return code;
  }
  throw new HttpError(500, 'تعذّر توليد رمز إحالة، أعد المحاولة');
}

/** البحث عن الداعي والتأكد من صحة سلسلة الإحالة ومنع الإحالة الذاتية. */
function resolveReferrer(referralInput, { newUsernameKey, clientIp, sessionUserId }) {
  const code = security.normalizeCode(referralInput);
  if (!code) return null;

  const referrer = store.get('SELECT id, username, username_key, referral_code, attempts, referral_bonus FROM users WHERE referral_code = ?', code);
  if (!referrer) throw new HttpError(400, 'رمز الإحالة غير صحيح، تأكد من نسخه كما هو');

  if (referrer.username_key === newUsernameKey || (sessionUserId && referrer.id === sessionUserId)) {
    throw new HttpError(400, 'لا يمكنك استخدام رمز الإحالة الخاص بك');
  }

  if (referrer.referral_bonus >= config.game.maxReferralBonuses) {
    throw new HttpError(400, 'وصل هذا الحساب إلى الحد الأقصى لمكافآت الدعوة');
  }

  // منع المزارع: عدد الحسابات التي استخدمت إحالة من نفس العنوان خلال آخر 24 ساعة.
  const farmed = store.get(
    'SELECT COUNT(*) AS count FROM users WHERE created_ip = ? AND referred_by IS NOT NULL AND created_at > datetime(\'now\', \'-1 day\')',
    clientIp
  );
  if (farmed && farmed.count >= config.game.maxReferralsPerIpPerDay) {
    throw new HttpError(400, 'تجاوزت حدّ الإحالة المسموح من جهازك خلال 24 ساعة');
  }
  return referrer;
}

function register(ctx) {
  const username = assertValidUsername(ctx.payload.username);
  const password = assertValidPassword(ctx.payload.password);
  const key = security.usernameKey(username);

  if (store.get('SELECT id FROM users WHERE username_key = ?', key)) {
    throw new HttpError(409, 'اسم المستخدم محجوز، اختر اسماً آخر');
  }

  const referralInput = ctx.payload.referral;
  if (typeof referralInput !== 'undefined' && referralInput !== null && referralInput !== '') {
    if (typeof referralInput !== 'string' || referralInput.length > 32) throw new HttpError(400, 'رمز الإحالة غير صحيح');
  }

  const existingSession = session.currentUser(ctx.req);
  const referrer = resolveReferrer(referralInput, {
    newUsernameKey: key,
    clientIp: http.clientIp(ctx.req),
    sessionUserId: existingSession ? existingSession.id : null,
  });
  const referralCode = generateUniqueReferralCode();

  let attempts = config.game.freeAttempts;
  if (referrer) attempts += config.game.refereeBonus;

  const created = store.transaction(() => {
    const inserted = store.run(
      'INSERT INTO users (username, username_key, password_hash, referral_code, referred_by, attempts, referral_bonus, created_ip) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      username,
      key,
      security.hashPassword(password),
      referralCode,
      referrer ? referrer.id : null,
      attempts,
      http.clientIp(ctx.req)
    );

    if (referrer) {
      // الصديق الداعي يحصل على محاولة مجانية فوراً.
      store.run('UPDATE users SET attempts = attempts + ?, referral_bonus = referral_bonus + 1 WHERE id = ?', config.game.referrerBonus, referrer.id);
    }

    return store.get(
      `SELECT id, username, referral_code, referred_by, attempts, referral_bonus, guesses_used, wins, total_purchased, created_at
       FROM users WHERE id = ?`,
      inserted.lastInsertRowid
    );
  });

  session.issueSession(ctx.res, { uid: created.id, role: session.ROLE_USER });
  return {
    ok: true,
    user: session.publicUser(created),
    bonus: referrer
      ? { invited: true, refereeExtraAttempts: config.game.refereeBonus, referrerExtraAttempts: config.game.referrerBonus }
      : { invited: false, refereeExtraAttempts: 0, referrerExtraAttempts: 0 },
  };
}

function login(ctx) {
  const username = assertValidUsername(ctx.payload.username);
  const password = assertValidPassword(ctx.payload.password);
  const key = security.usernameKey(username);

  const user = store.get(
    `SELECT id, username, referral_code, referred_by, attempts, referral_bonus, guesses_used, wins, total_purchased, created_at, password_hash
     FROM users WHERE username_key = ?`,
    key
  );
  if (!user || !security.verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
  }

  session.issueSession(ctx.res, { uid: user.id, role: session.ROLE_USER });
  return { ok: true, user: session.publicUser(user) };
}

function logout(ctx) {
  session.dropUserSession(ctx.req);
  session.revokeSession(ctx.res, session.ROLE_USER);
  return { ok: true };
}

function me(ctx) {
  const user = session.currentUser(ctx.req);
  if (!user) return { ok: true, authenticated: false, admin: session.isAdmin(ctx.req) };
  return { ok: true, authenticated: true, admin: false, user: session.publicUser(user) };
}

module.exports = [
  { method: 'POST', path: '/api/register', handler: register, options: { rateLimit: 'registerPerHour' } },
  { method: 'POST', path: '/api/login', handler: login, options: { rateLimit: 'loginPer15Min' } },
  { method: 'POST', path: '/api/logout', handler: logout, options: { rateLimit: 'apiPerMinute' } },
  { method: 'GET', path: '/api/me', handler: me, options: { rateLimit: 'apiPerMinute' } },
];
