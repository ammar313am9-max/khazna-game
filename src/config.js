'use strict';

/**
 * الإعدادات المركزية للتطبيق.
 * كل القيم قابلة للتغيير من متغيّرات البيئة دون تعديل الكود.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.KHAZNA_DATA_DIR
  ? path.resolve(process.env.KHAZNA_DATA_DIR)
  : path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * سرّ ثابت للتطبيق: يولَّد مرة واحدة ويُخزَّن بجانب قاعدة البيانات.
 * يُستعمل لتوقيع كوكيز الجلسات، ولاشتقاق مفتاح تشفير رمز الخزنة في قاعدة البيانات.
 */
function loadOrCreateSecret() {
  if (process.env.KHAZNA_SESSION_SECRET && process.env.KHAZNA_SESSION_SECRET.length >= 32) {
    return process.env.KHAZNA_SESSION_SECRET;
  }
  const file = path.join(DATA_DIR, 'app.key');
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

module.exports = {
  root: ROOT,
  dataDir: DATA_DIR,
  publicDir: PUBLIC_DIR,
  dbFile: path.join(DATA_DIR, 'khazna.db'),
  host: process.env.HOST || '0.0.0.0',
  port: envNumber('PORT', 3000),
  sessionSecret: loadOrCreateSecret(),

  // رمز دخول الأدمن: لا يُرسل إلى الواجهة الأمامية أبداً، ويُخزَّن كهشّ مشفّر.
  adminCode: process.env.KHAZNA_ADMIN_CODE || '1986am$$Ay',

  game: {
    codeLength: 7,
    freeAttempts: envNumber('FREE_ATTEMPTS', 3),
    refereeBonus: 1,
    referrerBonus: 1,
    // سقف مكافآت الدعوة للمستخدم الواحد، لمنع إغراق الحساب بالمحاولات.
    maxReferralBonuses: envNumber('MAX_REFERRAL_BONUSES', 25),
    // سقف الحسابات التي تستخدم إحالة من نفس العنوان/IP خلال 24 ساعة.
    maxReferralsPerIpPerDay: envNumber('MAX_REFERRALS_PER_IP', 3),
    attemptsPerUnit: 10,
    priceUsd: 1,
    prizeAmount: 3000000,
    prizeLabel: '3,000,000',
    prizeCurrency: 'دينار عراقي',
  },

  limits: {
    bodyBytes: 64 * 1024,
    guessPerMinute: { windowMs: 60 * 1000, max: 5 },
    guessPerHour: { windowMs: 60 * 60 * 1000, max: 30 },
    // سقف أوسع للعنوان لأن عدة أسرة قد تمر عبر نفس مزوّد الخدمة (CGNAT).
    guessPerMinuteIp: { windowMs: 60 * 1000, max: 30 },
    loginPer15Min: { windowMs: 15 * 60 * 1000, max: 20 },
    registerPerHour: { windowMs: 60 * 60 * 1000, max: 8 },
    adminLoginPer15Min: { windowMs: 15 * 60 * 1000, max: 8 },
    apiPerMinute: { windowMs: 60 * 1000, max: 300 },
  },

  cookie: {
    name: 'khazna_session',
    // كوكي منفصل للوحة الأدمن حتى لا تُلغي جلسة المستخدم في نفس المتصفح.
    adminName: 'khazna_admin',
    sameSite: process.env.COOKIE_SAMESITE || 'lax',
    // فعّل secure=1 عند التشغيل خلف HTTPS.
    secure: process.env.COOKIE_SECURE === '1',
    maxAgeSeconds: 60 * 60 * 24 * 30,
  },

  // اتركه مفصولاً إلا إذا كان السيرفر خلف Reverse Proxy موثوق.
  trustProxy: process.env.TRUST_PROXY === '1',

  // معلومات الشحن المعروضة في واجهة المستخدم (الأدمن يشحن يدوياً بعد التحويل).
  adminContact: {
    handle: process.env.KHAZNA_ADMIN_CONTACT || '@khazna_support',
    instructions:
      'حوّل المبلغ بإحدى طرق الدفع ثم أرسل "رمز الإحالة الخاص بك" مع صورة التحويل إلى حساب الأدمن، وتُضاف المحاولات خلال دقائق.',
  },
  payments: [
    { id: 'zaincash', label: 'زين كاش', account: '0770 000 0000', logo: 'Z' },
    { id: 'asia', label: 'آسيا حوالة', account: '0761 000 0000', logo: 'A' },
    { id: 'vodacash', label: 'فودافون كاش', account: '0781 000 0000', logo: 'V' },
    { id: 'qnb', label: 'QNB / بطاقات', account: 'IQ 00 0000 0000 0000', logo: 'Q' },
  ],
  // جاهز للربط لاحقاً مع بوابة دفع آلية (PayMob مثلاً): المسار مُهيّأ في src/routes/orders.js
  gateway: {
    enabled: process.env.PAYMOB_ENABLED === '1',
    apiKey: process.env.PAYMOB_API_KEY || '',
  },
};
