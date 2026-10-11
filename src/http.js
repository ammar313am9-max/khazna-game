'use strict';

/**
 * أدوات HTTP منخفضة المستوى: قراءة الـ JSON، الكوكيز، الاستجابات، وعنوان العميل.
 */

const config = require('./config');

class HttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

function buildCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  parts.push(`Max-Age=${options.maxAge === undefined ? config.cookie.maxAgeSeconds : options.maxAge}`);
  parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite || config.cookie.sameSite}`);
  if (config.cookie.secure) parts.push('Secure');
  return parts.join('; ');
}

function setCookie(res, name, value, options = {}) {
  res.setHeader('Set-Cookie', buildCookie(name, value, options));
}

function clearCookie(res, name) {
  res.setHeader('Set-Cookie', buildCookie(name, '', { maxAge: 0 }));
}

function clientIp(req) {
  const socketIp = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : (forwarded || '').split(',')[0];
    if (first) return first.trim();
  }
  return socketIp.replace(/^::ffff:/, '');
}

/** يقرأ جسم الطلب كـ JSON مع سقف حجم ومنع أنواع المحتوى الغريبة. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      reject(new HttpError(415, 'يجب إرسال بيانات بصيغة JSON'));
      return;
    }
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (declaredLength > config.limits.bodyBytes) {
      reject(new HttpError(413, 'حجم البيانات أكبر من المسموح'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.limits.bodyBytes) {
        reject(new HttpError(413, 'حجم البيانات أكبر من المسموح'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, 'JSON غير صالح'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'تعذّر قراءة الطلب')));
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload ?? { ok: false });
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

/**
 * حماية CSRF: نرفض أي طلب تغيير حالة مصدره نطاق مختلف.
 * متصفح الطلب يُرسل Origin تلقائياً للـ POST.
 */
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const allowed = new Set([`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`]);
    const host = req.headers.host;
    if (host) {
      allowed.add(`http://${host}`);
      allowed.add(`https://${host}`);
    }
    if (process.env.KHAZNA_ALLOWED_ORIGIN) allowed.add(process.env.KHAZNA_ALLOWED_ORIGIN);
    return allowed.has(origin);
  } catch {
    return false;
  }
}

module.exports = {
  HttpError,
  parseCookies,
  buildCookie,
  setCookie,
  clearCookie,
  clientIp,
  readJsonBody,
  sendJson,
  isSameOrigin,
};
