'use strict';

/**
 * موجّه (Router) صغير بنمط Express: تسجيل المسارات ثم توزيع الطلب عليها،
 * مع تطبيق موحّد لحماية CSRF ومحدّد المعدّل العام ومعالجة الأخطاء.
 */

const config = require('./config');
const http = require('./http');
const rateLimit = require('./rateLimit');

const routes = [];

function route(method, path, handler, options = {}) {
  routes.push({ method, path, handler, options });
}

function findRoute(method, pathname) {
  let pathExists = false;
  for (const entry of routes) {
    if (entry.path !== pathname) continue;
    pathExists = true;
    if (entry.method === method) return entry;
  }
  if (pathExists) {
    const error = new http.HttpError(405, 'طريقة الطلب غير مسموحة لهذا المسار');
    error.code = 'METHOD_NOT_ALLOWED';
    throw error;
  }
  return null;
}

async function dispatch(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  const ctx = {
    req,
    res,
    url,
    pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    status: 200,
    body: null,
  };

  try {
    const entry = findRoute(req.method, pathname);
    if (!entry) {
      http.sendJson(res, 404, { ok: false, error: pathname.startsWith('/api/') ? 'المسار غير موجود' : 'الصفحة غير موجودة' });
      return;
    }

    if (!http.isSameOrigin(req)) throw new http.HttpError(403, 'مصدر الطلب غير مسموح');

    if (entry.options.rateLimit) {
      const rule = config.limits[entry.options.rateLimit] || config.limits.apiPerMinute;
      const key = `${entry.method}:${pathname}:${http.clientIp(req)}`;
      const result = rateLimit.consume(key, rule);
      if (!result.allowed) {
        const error = new http.HttpError(429, 'محاولات كثيرة جداً، انتظر قليلاً ثم أعد المحاولة');
        error.details = { retryAfterMs: result.retryAfterMs };
        throw error;
      }
      ctx.rateRemaining = result.remaining;
    }

    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' || req.method === 'DELETE') {
      ctx.payload = await http.readJsonBody(req);
    } else {
      ctx.payload = {};
    }

    const output = await entry.handler(ctx);
    if (!res.headersSent) http.sendJson(res, ctx.status, output ?? { ok: true });
  } catch (error) {
    if (res.headersSent) return;
    const status = error instanceof http.HttpError ? error.status : 500;
    if (status >= 500) console.error('[server]', error);
    const payload = { ok: false, error: status >= 500 ? 'خطأ داخلي في الخادم' : error.message };
    if (error.details) Object.assign(payload, error.details);
    http.sendJson(res, status, payload);
  }
}

module.exports = { route, routes, dispatch };
