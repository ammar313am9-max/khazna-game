'use strict';

/**
 * تقديم ملفات الواجهة الأمامية من مجلد public/ مع منع الخروج عنه (Path Traversal).
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // السكربتات من ملفات المشروع فقط (لا inline JS)، أما الأنماط فتسمح بالتعبير داخل العناصر للرسومات.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
};

function applySecurityHeaders(res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname مسار الطلب
 * @returns {boolean} true عند تقديم ملف فعلي
 */
function serve(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  if (requested.startsWith('/api/')) return false;

  const resolved = path.resolve(config.publicDir, `.${path.posix.normalize(requested)}`);
  if (!resolved.startsWith(config.publicDir + path.sep) && resolved !== config.publicDir) return false;

  let target = resolved;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // SPA: أي مسار غير موجود يعيد الصفحة الرئيسية.
    target = path.join(config.publicDir, 'index.html');
  }
  if (!fs.existsSync(target)) return false;

  const ext = path.extname(target).toLowerCase();
  const isHtml = ext === '.html';
  const body = fs.readFileSync(target);

  applySecurityHeaders(res);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
  });
  res.end(body);
  return true;
}

module.exports = { serve, applySecurityHeaders };
