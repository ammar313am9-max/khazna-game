'use strict';

/**
 * خزنة الجوائز — نقطة تشغيل الخادم.
 * يعمل بمكتبات Node المدمجة فقط (node:http + node:sqlite + node:crypto) فلا يحتاج npm install.
 *
 *   node server.js            → http://localhost:3000
 *   PORT=8080 node server.js  → منفذ آخر
 */

const http = require('node:http');
const config = require('./src/config');
const store = require('./src/db');
const router = require('./src/router');
const staticFiles = require('./src/static');
const vault = require('./src/vault');

const authRoutes = require('./src/routes/auth');
const gameRoutes = require('./src/routes/game');
const orderRoutes = require('./src/routes/orders');
const adminRoutes = require('./src/routes/admin');

store.init();
adminRoutes.initialize();

for (const entry of [...authRoutes, ...gameRoutes, ...orderRoutes, ...adminRoutes.routes]) {
  router.route(entry.method, entry.path, entry.handler, entry.options || {});
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;

  if (pathname.startsWith('/api/')) {
    router.dispatch(req, res).catch((error) => {
      console.error('[fatal]', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'خطأ داخلي في الخادم' }));
      }
    });
    return;
  }

  try {
    if (!staticFiles.serve(res, pathname)) {
      staticFiles.applySecurityHeaders(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — الملف غير موجود');
    }
  } catch (error) {
    console.error('[static]', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500');
    }
  }
});

server.listen(config.port, config.host, () => {
  console.log('==================================================');
  console.log('  خزنة الجوائز تعمل على:  http://localhost:' + config.port);
  console.log('  طول الرمز السري: ' + config.game.codeLength + ' أرقام | المحاولات المجانية: ' + config.game.freeAttempts);
  console.log('  قاعدة البيانات: ' + config.dbFile);
  console.log('==================================================');
  console.log('  الرمز السري الحالي للخزنة: ' + vault.currentCode());
  console.log('  (اعرضه للمستخدمين في اختبارك فقط، أو غيّره من لوحة الأدمن)');
  console.log('  رمز دخول الأدمن: من الإعدادات — افتراضياً ما هو معرّف في src/config.js');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nإيقاف السيرفر (${signal})...`);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}

module.exports = server;
