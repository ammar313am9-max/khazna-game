'use strict';

/**
 * لوحة تحكم الأدمن: تغيير رمز الخزنة، شحن محاولات لأي مستخدم عبر رمزه، اعتماد طلبات الشحن،
 * وعرض الإحصائيات. الوصول إليها بجلسة أدمن منفصلة، ورمز الدخول مجزّأ في قاعدة البيانات.
 */

const config = require('../config');
const http = require('../http');
const store = require('../db');
const security = require('../security');
const session = require('../session');
const vault = require('../vault');

const { HttpError } = http;
const ADMIN_HASH_KEY = 'admin_code_hash';

/** يهيّئ هشّ رمز الأدمن عند أول تشغيل، ويحدّثه تلقائياً إذا تغيّر من متغيّرات البيئة. */
function initialize() {
  const stored = store.getSetting(ADMIN_HASH_KEY);
  if (stored && security.verifyPassword(config.adminCode, stored)) return;
  store.setSetting(ADMIN_HASH_KEY, security.hashPassword(config.adminCode));
}

function login(ctx) {
  const code = typeof ctx.payload.code === 'string' ? ctx.payload.code : '';
  const stored = store.getSetting(ADMIN_HASH_KEY);
  if (!stored || !code || !security.verifyPassword(code, stored)) {
    throw new HttpError(401, 'رمز الأدمن غير صحيح');
  }
  session.issueSession(ctx.res, { role: session.ROLE_ADMIN });
  return { ok: true, admin: true };
}

function logout(ctx) {
  guard(ctx);
  session.dropAdminSession();
  session.revokeSession(ctx.res, session.ROLE_ADMIN);
  return { ok: true };
}

function guard(ctx) {
  session.requireAdmin(ctx.req);
}

function changeVaultCode(ctx) {
  guard(ctx);
  const code = typeof ctx.payload.code === 'string' ? ctx.payload.code.replace(/[\s-]/g, '') : '';
  vault.setCode(code);
  return { ok: true, message: `تم تحديث رمز الخزنة إلى ${config.game.codeLength} أرقام جديدة` };
}

/** الأدمن يستطيع قراءة الرمز الحالي لتعديله أو لإبلاغه — القراءة من الخادم فقط. */
function readVaultCode(ctx) {
  guard(ctx);
  return { ok: true, code: vault.currentCode(), codeLength: config.game.codeLength };
}

function findUser(referralCode) {
  const code = security.normalizeCode(referralCode);
  if (!code) throw new HttpError(400, 'أدخل رمز الإحالة الخاص بالمستخدم');
  const row = store.get(
    `SELECT id, username, referral_code, referred_by, attempts, referral_bonus, guesses_used, wins, total_purchased, created_at
     FROM users WHERE referral_code = ?`,
    code
  );
  if (!row) throw new HttpError(404, 'لا يوجد مستخدم بهذا الرمز');
  return row;
}

function searchUser(ctx) {
  guard(ctx);
  const row = findUser(ctx.query.ref || ctx.payload.referralCode);
  const history = store.all('SELECT guess, is_correct, exact_digits, other_digits, created_at FROM guesses WHERE user_id = ? ORDER BY id DESC LIMIT 10', row.id);
  const orders = store.all('SELECT reference, attempts, amount_usd, method, status, created_at FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 10', row.id);
  return {
    ok: true,
    user: session.publicUser(row),
    history: history.map((item) => ({ guess: item.guess, correct: item.is_correct === 1, exact: item.exact_digits, misplaced: item.other_digits, createdAt: item.created_at })),
    orders,
  };
}

/** شحن مباشر لحساب المستخدم من لوحة الأدمن. */
function chargeUser(ctx) {
  guard(ctx);
  const row = findUser(ctx.payload.referralCode);
  const attempts = Number.parseInt(ctx.payload.attempts, 10);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5000) {
    throw new HttpError(400, 'عدد المحاولات يجب أن يكون بين 1 و 5000');
  }

  const updated = store.transaction(() => {
    store.run('UPDATE users SET attempts = attempts + ?, total_purchased = total_purchased + ? WHERE id = ?', attempts, attempts, row.id);
    return store.get(
      `SELECT id, username, referral_code, referred_by, attempts, referral_bonus, guesses_used, wins, total_purchased, created_at
       FROM users WHERE id = ?`,
      row.id
    );
  });

  return { ok: true, added: attempts, user: session.publicUser(updated) };
}

function reviewOrder(ctx) {
  guard(ctx);
  const reference = String(ctx.payload.reference || '').trim();
  const action = String(ctx.payload.action || '').trim();
  if (!['approve', 'reject'].includes(action)) throw new HttpError(400, 'الإجراء غير معروف');

  const order = store.get('SELECT * FROM orders WHERE reference = ?', reference);
  if (!order) throw new HttpError(404, 'الطلب غير موجود');
  if (order.status !== 'pending') throw new HttpError(409, 'تمت معالجة هذا الطلب مسبقاً');

  const result = store.transaction(() => {
    if (action === 'approve') {
      store.run("UPDATE orders SET status = 'approved', reviewed_at = datetime('now') WHERE id = ?", order.id);
      store.run('UPDATE users SET attempts = attempts + ?, total_purchased = total_purchased + ? WHERE id = ?', order.attempts, order.attempts, order.user_id);
    } else {
      store.run("UPDATE orders SET status = 'rejected', reviewed_at = datetime('now') WHERE id = ?", order.id);
    }
    return store.get('SELECT * FROM orders WHERE id = ?', order.id);
  });

  return { ok: true, order: { reference: result.reference, status: result.status, attempts: result.attempts } };
}

function overview(ctx) {
  guard(ctx);
  const totals = store.get(
    `SELECT COUNT(*) AS users,
            COALESCE(SUM(attempts), 0) AS attemptsInPlay,
            COALESCE(SUM(guesses_used), 0) AS guessesUsed,
            COALESCE(SUM(wins), 0) AS totalWins,
            COALESCE(SUM(total_purchased), 0) AS purchasedAttempts
     FROM users`
  );
  const outOfAttempts = store.get('SELECT COUNT(*) AS count FROM users WHERE attempts = 0');
  const pending = store.get("SELECT COUNT(*) AS count FROM orders WHERE status = 'pending'");
  const revenue = store.get("SELECT COALESCE(SUM(amount_usd), 0) AS total FROM orders WHERE status = 'approved'");
  const vaultRow = store.get('SELECT updated_at, open_count FROM vault WHERE id = 1');

  const recentUsers = store.all(
    `SELECT id, username, referral_code, referred_by, attempts, referral_bonus, guesses_used, wins, total_purchased, created_at
     FROM users ORDER BY id DESC LIMIT 15`
  );
  const topReferrers = store.all(
    'SELECT username, referral_code, referral_bonus FROM users ORDER BY referral_bonus DESC, guesses_used DESC LIMIT 8'
  );
  const pendingOrders = store.all(
    "SELECT orders.reference, orders.user_id, orders.attempts, orders.amount_usd, orders.method, orders.payer_note, orders.created_at, users.referral_code, users.username FROM orders JOIN users ON users.id = orders.user_id WHERE orders.status = 'pending' ORDER BY orders.id DESC LIMIT 25"
  );

  return {
    ok: true,
    stats: {
      users: totals.users,
      attemptsInPlay: totals.attemptsInPlay,
      guessesUsed: totals.guessesUsed,
      totalWins: totals.totalWins,
      purchasedAttempts: totals.purchasedAttempts,
      outOfAttempts: outOfAttempts.count,
      pendingOrders: pending.count,
      approvedRevenueUsd: revenue.total,
      vaultOpenCount: vaultRow ? vaultRow.open_count : 0,
      vaultUpdatedAt: vaultRow ? vaultRow.updated_at : null,
      codeLength: config.game.codeLength,
    },
    recentUsers: recentUsers.map(session.publicUser),
    topReferrers,
    pendingOrders,
  };
}

module.exports = {
  initialize,
  routes: [
    { method: 'POST', path: '/api/admin/login', handler: login, options: { rateLimit: 'adminLoginPer15Min' } },
    { method: 'POST', path: '/api/admin/logout', handler: logout, options: { rateLimit: 'apiPerMinute' } },
    { method: 'GET', path: '/api/admin/overview', handler: overview, options: { rateLimit: 'apiPerMinute' } },
    { method: 'GET', path: '/api/admin/vault', handler: readVaultCode, options: { rateLimit: 'apiPerMinute' } },
    { method: 'POST', path: '/api/admin/vault', handler: changeVaultCode, options: { rateLimit: 'apiPerMinute' } },
    { method: 'GET', path: '/api/admin/user', handler: searchUser, options: { rateLimit: 'apiPerMinute' } },
    { method: 'POST', path: '/api/admin/charge', handler: chargeUser, options: { rateLimit: 'apiPerMinute' } },
    { method: 'POST', path: '/api/admin/order', handler: reviewOrder, options: { rateLimit: 'apiPerMinute' } },
  ],
};
