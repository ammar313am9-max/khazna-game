'use strict';

/**
 * أدوات الأمان: تجزئة كلمات المرور، توقيع الجلسات، وتشفير رمز الخزنة في قاعدة البيانات.
 * كل العمليات هنا على الخادم فقط، ولا يُرسل أي منها إلى المتصفح.
 */

const crypto = require('node:crypto');
const config = require('./config');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;

function deriveKey(purpose, length) {
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(config.sessionSecret, 'utf8'), Buffer.from(`khazna.salt.v1`, 'utf8'), Buffer.from(purpose, 'utf8'), length)
  );
}

const sessionKey = deriveKey('session-signature', 32);
const vaultKey = deriveKey('vault-code-encryption', 32);

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    // نقارن مع قيمة عشوائية بنفس الطول حتى لا يكشف التوقيت طول المُدخلات.
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ---------------------------------- كلمات المرور --------------------------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, SCRYPT_PARAMS);
  return ['scrypt', SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p, salt.toString('base64'), hash.toString('base64')].join(':');
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const params = { ...SCRYPT_PARAMS, N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  try {
    const actual = crypto.scryptSync(password, salt, expected.length, params);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ---------------------------------- تشفير الرمز السري ----------------------------------
 * رمز الخزنة يجب أن يقارنه الخادم رقمًا برقم لإنتاج تلميح عدد الأرقام الصحيحة،
 * لذلك يُخزَّن مشفراً (AES-256-GCM) وليس مجزّأ، بحيث لا يظهر نصه الصريح في ملف القاعدة.
 */

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptSecret(payload) {
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('BAD_CIPHER_FORMAT');
  const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey, Buffer.from(parts[1], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
}

/* ---------------------------------- الجلسات ---------------------------------- */

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', sessionKey).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', sessionKey).update(body).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

/* ---------------------------------- مولّدات العشوائية ---------------------------------- */

const REFERRAL_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomReferralCode(length = 8) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += REFERRAL_ALPHABET[crypto.randomInt(REFERRAL_ALPHABET.length)];
  }
  return out;
}

function randomVaultCode(length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += crypto.randomInt(0, 10).toString();
  return out;
}

function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/* ---------------------------------- التحقق من المدخلات ---------------------------------- */

function normalizeUsername(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function usernameKey(value) {
  return normalizeUsername(value).toLowerCase();
}

function normalizeCode(value) {
  return String(value || '').replace(/[\s-]/g, '').toUpperCase();
}

function isValidPassword(value) {
  return typeof value === 'string' && value.length >= 6 && value.length <= 200;
}

function isSevenDigits(value, length) {
  return typeof value === 'string' && value.length === length && /^[0-9]+$/.test(value);
}

module.exports = {
  hashPassword,
  verifyPassword,
  encryptSecret,
  decryptSecret,
  signToken,
  verifyToken,
  randomReferralCode,
  randomVaultCode,
  randomId,
  safeEqual,
  normalizeUsername,
  usernameKey,
  normalizeCode,
  isValidPassword,
  isSevenDigits,
};
