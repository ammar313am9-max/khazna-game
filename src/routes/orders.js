'use strict';

/**
 * طلبات الشحن: كل 10 محاولات بسعر 1 دولار.
 * الوضع الحالي: الطلب يبقى pending حتى يعتمده الأدمن يدوياً بعد التحقق من التحويل.
 * عند توفّر بوابة دفع (PayMob / زين كاش API) تُستدعى createGatewaySession بدلاً من الانتظار اليدوي.
 */

const config = require('../config');
const http = require('../http');
const store = require('../db');
const security = require('../security');
const session = require('../session');

const { HttpError } = http;

const KNOWN_METHODS = new Set(config.payments.map((payment) => payment.id));

function priceFor(attempts) {
  const units = Math.ceil(attempts / config.game.attemptsPerUnit);
  return Number((units * config.game.priceUsd).toFixed(2));
}

function createOrder(ctx) {
  const user = session.requireUser(ctx.req);
  const attempts = Number.parseInt(ctx.payload.attempts, 10);
  const method = String(ctx.payload.method || '').trim();
  const note = String(ctx.payload.payerNote || '').trim().slice(0, 300);

  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 1000) {
    throw new HttpError(400, 'عدد المحاولات يجب أن يكون بين 1 و 1000');
  }
  if (!KNOWN_METHODS.has(method)) {
    throw new HttpError(400, 'اختر طريقة دفع صحيحة');
  }

  let order = null;
  for (let retry = 0; retry < 5 && !order; retry += 1) {
    const reference = `KZ-${Date.now().toString(36).toUpperCase()}-${security.randomReferralCode(4)}`;
    try {
      const inserted = store.run(
        'INSERT INTO orders (reference, user_id, attempts, amount_usd, method, payer_note) VALUES (?, ?, ?, ?, ?, ?)',
        reference,
        user.id,
        attempts,
        priceFor(attempts),
        method,
        note
      );
      order = store.get('SELECT * FROM orders WHERE id = ?', inserted.lastInsertRowid);
    } catch (error) {
      // تكرر المرجع نادرًا؛ نعيد التوليد، وما عدا ذلك خطأ حقيقي.
      if (!String(error.message).includes('UNIQUE')) throw error;
    }
  }
  if (!order) throw new HttpError(500, 'تعذّر إنشاء طلب الشحن');

  const gateway = config.gateway.enabled ? createGatewaySession(order) : null;
  return { ok: true, order: serialize(order), gateway };
}

function myOrders(ctx) {
  const user = session.requireUser(ctx.req);
  const rows = store.all('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 20', user.id);
  return { ok: true, orders: rows.map(serialize) };
}

/** نقطة الربط مع بوابة الدفع — تُترك مفصولة حتى يتم توفير مفاتيح حقيقية. */
function createGatewaySession() {
  const error = new HttpError(501, 'بوابة الدفع غير مفعّالة على هذا السيرفر. أكمل التحويل اليدوي ثم أرسل رمز الإحالة للأدمن.');
  error.details = { reason: 'gateway_disabled' };
  throw error;
}

function serialize(row) {
  return {
    reference: row.reference,
    attempts: row.attempts,
    amountUsd: row.amount_usd,
    method: row.method,
    payerNote: row.payer_note,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

module.exports = [
  { method: 'POST', path: '/api/orders', handler: createOrder, options: { rateLimit: 'apiPerMinute' } },
  { method: 'GET', path: '/api/orders', handler: myOrders, options: { rateLimit: 'apiPerMinute' } },
];
