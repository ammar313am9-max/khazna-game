'use strict';

/**
 * اختبار ذاتي شامل للتطبيق: node tools/selftest.js
 * يشغّل السيرفر على منفذ مستقل بقاعدة بيانات مؤقتة، ثم يمرّ على كل السيناريوهات
 * (تسجيل، إحالة، تخمين، نفاد المحاولات، حدّ المعدّل، الأدمن، الشحن، الحماية).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SELFTEST_PORT || 3999);
const DATA_DIR = path.join(ROOT, 'data', 'selftest');
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(DATA_DIR, { recursive: true, force: true });

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed: Boolean(passed), detail: detail === undefined ? '' : String(detail) });
}

/** يقرا الرمز السري الحالي من نفس قاعدة البيانات (فك تشفير على الخادم فقط). */
function readVaultCode() {
  process.env.KHAZNA_DATA_DIR = DATA_DIR;
  process.env.PORT = String(PORT);
  for (const name of ['config.js', 'security.js', 'db.js', 'vault.js']) {
    const resolved = require.resolve(path.join(ROOT, 'src', name));
    delete require.cache[resolved];
  }
  const vault = require(path.join(ROOT, 'src/vault.js'));
  return vault.currentCode();
}

async function waitForServer(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.status === 200) return true;
    } catch {
      /* لم يبدأ بعد */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('السيرفر لم يستجب خلال المهلة');
}

function cookieOf(response) {
  const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  return list.map((entry) => entry.split(';')[0]).join('; ');
}

async function api(method, endpoint, body, cookie) {
  const headers = { 'content-type': 'application/json', origin: BASE };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(BASE + endpoint, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = { raw: await response.text().catch(() => '') };
  }
  return { status: response.status, json, cookie: cookieOf(response) || cookie || null };
}

async function run() {
  const stamp = Date.now().toString(36).slice(-5);
  await waitForServer();
  const secret = readVaultCode();

  // _إعدادات عامة
  const state = await api('GET', '/api/state');
  check('GET /api/state يعمل', state.status === 200);
  check('طول الرمز 7 والمجانيات 3', state.json.game.codeLength === 7 && state.json.game.freeAttempts === 3, JSON.stringify(state.json.game));
  check('لا يتسرب رمز الأدمن في /api/state', !JSON.stringify(state.json).includes('1986am'));

  // _حسابات وإحالة
  const a = await api('POST', '/api/register', { username: `ahmed${stamp}`, password: 'test1234' });
  check('حساب جديد بدون إحالة = 3 محاولات', a.status === 200 && a.json.user.attempts === 3, a.json.user && a.json.user.attempts);

  const b = await api('POST', '/api/register', { username: `sara${stamp}`, password: 'test1234', referral: a.json.user.referralCode });
  check('حساب مُدعى = 4 محاولات', b.status === 200 && b.json.user.attempts === 4, b.json.user && b.json.user.attempts);

  const aLogin = await api('POST', '/api/login', { username: `ahmed${stamp}`, password: 'test1234' });
  check('الداعي حصل على محاولة إضافية فوراً', aLogin.status === 200 && aLogin.json.user.attempts === 4, aLogin.json.user && aLogin.json.user.attempts);
  const aCookie = aLogin.cookie;

  const selfRef = await api('POST', '/api/register', { username: `mutaz${stamp}`, password: 'test1234', referral: b.json.user.referralCode }, b.cookie);
  check('منع استخدام رمز الإحالة الخاص بنفسك', selfRef.status === 400, selfRef.json.error);

  const badRef = await api('POST', '/api/register', { username: `badref${stamp}`, password: 'test1234', referral: 'ZZZZZZZZ' });
  check('رمز إحالة غير موجود مرفوض', badRef.status === 400, badRef.json.error);

  const dup = await api('POST', '/api/register', { username: `AHMED${stamp}`, password: 'test1234' });
  check('اسم المستخدم المكرر مرفوض (غير حساس للكبير/الصغير)', dup.status === 409, dup.json.error);

  const shortPass = await api('POST', '/api/login', { username: `shorty${stamp}`, password: '123' });
  check('كلمة المرور الأقصر من 6 مرفوضة', shortPass.status === 400, shortPass.json.error);

  const wrongLogin = await api('POST', '/api/login', { username: `ahmed${stamp}`, password: 'wrongpass1' });
  check('تسجيل دخول بكلمة خاطئة 401', wrongLogin.status === 401, wrongLogin.json.error);

  const me = await api('GET', '/api/me', undefined, aCookie);
  check('جلسة الكوكي تعمل بعد تسجيل الدخول', me.status === 200 && me.json.authenticated === true && me.json.user.username === `ahmed${stamp}`, JSON.stringify(me.json).slice(0, 120));

  const anonMe = await api('GET', '/api/me');
  check('/api/me للمجهول يعيد authenticated=false', anonMe.status === 200 && anonMe.json.authenticated === false);

  // _اللعب
  const badDigits = await api('POST', '/api/guess', { guess: '12' }, aCookie);
  check('تخمين غير مكتمل 400', badDigits.status === 400 && badDigits.json.reason === 'bad_guess', badDigits.json.error);

  const noCookie = await api('POST', '/api/guess', { guess: '1234567' });
  check('تخمين بدون جلسة 401', noCookie.status === 401);

  const wrong = await api('POST', '/api/guess', { guess: '0000000' }, aCookie);
  check('تخمين خاطئ يخصم محاولة', wrong.status === 200 && wrong.json.correct === false && wrong.json.attemptsLeft === 3, JSON.stringify(wrong.json).slice(0, 120));
  check('التخمين الخاطئ يعيد تلميحاً رقمياً', typeof wrong.json.hint.exact === 'number' && typeof wrong.json.hint.misplaced === 'number', JSON.stringify(wrong.json.hint));
  check('الرمز السري لا يظهر في استجابة التخمين', !JSON.stringify(wrong.json).includes(secret));

  const win = await api('POST', '/api/guess', { guess: secret }, b.cookie);
  check('التخمين الصحيح يفتح الخزنة', win.status === 200 && win.json.correct === true, JSON.stringify(win.json).slice(0, 140));
  check('الجائزة الكبرى 3,000,000 دينار', win.json.prize && win.json.prize.label === '3,000,000' && win.json.prize.currency === 'دينار عراقي', JSON.stringify(win.json.prize));

  const history = await api('GET', '/api/history', undefined, aCookie);
  check('سجل التخمينات متاح لصاحبه فقط', history.status === 200 && history.json.history.length === 1, history.json.history && history.json.history.length);

  // _حد المعدّل ونفاد المحاولات
  const c = await api('POST', '/api/register', { username: `burst${stamp}`, password: 'test1234' });
  const statuses = [];
  for (let i = 0; i < 7; i += 1) {
    const g = await api('POST', '/api/guess', { guess: `111111${i}` }, c.cookie);
    statuses.push(g.status);
  }
  check('Rate limiting يوقف التخمين السريع', statuses.filter((s) => s === 429).length >= 1, statuses.join(','));

  const d = await api('POST', '/api/register', { username: `empty${stamp}`, password: 'test1234' });
  for (let i = 0; i < 3; i += 1) await api('POST', '/api/guess', { guess: `222222${i}` }, d.cookie);
  const exhausted = await api('POST', '/api/guess', { guess: '3333333' }, d.cookie);
  check('نفاد المحاولات يقفل التخمين (423)', exhausted.status === 423 && exhausted.json.reason === 'no_attempts', JSON.stringify(exhausted.json));

  // _توقيع الكوكي
  const parts = aCookie.split('=');
  const forged = `${parts[0]}=${Buffer.from(JSON.stringify({ uid: 1, role: 'user', iat: Date.now(), exp: Date.now() + 9e5 })).toString('base64url')}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  const forgedRes = await api('GET', '/api/me', undefined, forged);
  check('كوكي مزوّر لا يُقبل', forgedRes.status === 200 && forgedRes.json.authenticated === false);

  const adminForged = await api('GET', '/api/admin/overview', undefined, `${parts[0]}=${Buffer.from(JSON.stringify({ role: 'admin', iat: Date.now(), exp: Date.now() + 9e5 })).toString('base64url')}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
  check('كوكي أدمن مزوّر مرفوض', adminForged.status === 403, adminForged.json.error);

  // _الأدمن
  const userTryAdmin = await api('GET', '/api/admin/overview', undefined, aCookie);
  check('المستخدم العادي لا يصل للوحة الأدمن', userTryAdmin.status === 403);

  const adminBad = await api('POST', '/api/admin/login', { code: 'wrongcode' });
  check('رمز أدمن خاطئ 401', adminBad.status === 401, adminBad.json.error);

  const admin = await api('POST', '/api/admin/login', { code: '1986am$$Ay' });
  check('دخول الأدمن بالرمز الصحيح', admin.status === 200 && admin.json.admin === true);

  const badVault = await api('POST', '/api/admin/vault', { code: '123' }, admin.cookie);
  check('رفض رمز خزنة غير مكوّن من 7 أرقام', badVault.status === 400, badVault.json.error);

  const newCode = '4839201';
  const setVault = await api('POST', '/api/admin/vault', { code: newCode }, admin.cookie);
  check('تغيير رمز الخزنة من اللوحة', setVault.status === 200, setVault.json.message);
  check('الرمز الجديد هو الفاعل', readVaultCode() === newCode, readVaultCode());

  const winNew = await api('POST', '/api/guess', { guess: newCode }, aCookie);
  check('تخمين الرمز الجديد يفتح الخزنة', winNew.status === 200 && winNew.json.correct === true);

  const search = await api('GET', `/api/admin/user?ref=${d.json.user.referralCode}`, undefined, admin.cookie);
  check('البحث عن مستخدم برمز الإحالة', search.status === 200 && search.json.user.referralCode === d.json.user.referralCode);
  check('البحث يعيد سجل التخمينات والطلبات', Array.isArray(search.json.history) && Array.isArray(search.json.orders));

  const charge = await api('POST', '/api/admin/charge', { referralCode: d.json.user.referralCode, attempts: 20 }, admin.cookie);
  check('شحن محاولات لمستخدم من اللوحة', charge.status === 200 && charge.json.user.attempts === 20, charge.json.user && charge.json.user.attempts);

  const chargeUnknown = await api('POST', '/api/admin/charge', { referralCode: 'NOPE1234', attempts: 5 }, admin.cookie);
  check('شحن رمز غير موجود 404', chargeUnknown.status === 404, chargeUnknown.json.error);

  const canGuessAgain = await api('POST', '/api/guess', { guess: '9999999' }, d.cookie);
  check('المستخدم يستطيع التخمين بعد الشحن', canGuessAgain.status === 200 && canGuessAgain.json.attemptsLeft === 19, canGuessAgain.json.attemptsLeft);

  // _طلبات الشحن
  const buyer = await api('POST', '/api/register', { username: `buyer${stamp}`, password: 'test1234' });
  const order = await api('POST', '/api/orders', { attempts: 25, method: 'zaincash', payerNote: '07701234567' }, buyer.cookie);
  check('إنشاء طلب شحن (كل 10 محاولات = 1 دولار، تقريب لأعلى)', order.status === 200 && order.json.order.amountUsd === 3 && order.json.order.status === 'pending', JSON.stringify(order.json.order));

  const badMethod = await api('POST', '/api/orders', { attempts: 10, method: 'bitcoin' }, buyer.cookie);
  check('رفض طريقة دفع غير معروفة', badMethod.status === 400, badMethod.json.error);

  const rejectMe = await api('POST', '/api/admin/order', { reference: order.json.order.reference, action: 'approve' }, aCookie);
  check('غير الأدمن لا يعتمد الطلبات', rejectMe.status === 403);

  const approved = await api('POST', '/api/admin/order', { reference: order.json.order.reference, action: 'approve' }, admin.cookie);
  check('اعتماد طلب الشحن من اللوحة', approved.status === 200 && approved.json.order.status === 'approved', JSON.stringify(approved.json));

  const afterApprove = await api('GET', '/api/me', undefined, buyer.cookie);
  check('المحاولات أُضيفت للحساب بعد الاعتماد', afterApprove.json.user.attempts === 28, afterApprove.json.user.attempts);

  const doubleApprove = await api('POST', '/api/admin/order', { reference: order.json.order.reference, action: 'approve' }, admin.cookie);
  check('لا يُعالج الطلب مرتين', doubleApprove.status === 409, doubleApprove.json.error);

  const myOrders = await api('GET', '/api/orders', undefined, buyer.cookie);
  check('قائمة طلبات المستخدم', myOrders.status === 200 && myOrders.json.orders.length === 1);

  const userLogout = await api('POST', '/api/logout', {}, buyer.cookie);
  check('تسجيل خروج المستخدم ناجح', userLogout.status === 200);
  const afterUserLogout = await api('GET', '/api/me', undefined, buyer.cookie);
  check('الكوكي القديم لا يعمل بعد تسجيل الخروج', afterUserLogout.status === 200 && afterUserLogout.json.authenticated === false, JSON.stringify(afterUserLogout.json).slice(0, 80));

  const stats = await api('GET', '/api/admin/overview', undefined, admin.cookie);
  const expectedUsers = 5;
  check('الإحصائيات تعرض عدد المستخدمين', stats.status === 200 && stats.json.stats.users >= expectedUsers, JSON.stringify(stats.json.stats));
  check('الإحصائيات تعرض المحاولات الجارية', typeof stats.json.stats.attemptsInPlay === 'number');
  check('قائمة المستخدمين الأخيرة موجودة', Array.isArray(stats.json.recentUsers) && stats.json.recentUsers.length > 0);

  const logout = await api('POST', '/api/admin/logout', {}, admin.cookie);
  check('خروج الأدمن يُبطل الجلسة', logout.status === 200);
  const afterLogout = await api('GET', '/api/admin/overview', undefined, admin.cookie);
  check('بعد الخروج لا تعمل عمليات الأدمن', afterLogout.status === 403, afterLogout.json.error);

  // _الحماية على مستوى HTTP
  const csrf = await fetch(`${BASE}/api/guess`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example', cookie: aCookie },
    body: JSON.stringify({ guess: '1111111' }),
  });
  check('طلب من نطاق أجنبي يُرفض (CSRF)', csrf.status === 403, csrf.status);

  const wrongType = await fetch(`${BASE}/api/guess`, { method: 'POST', headers: { origin: BASE, 'content-type': 'text/plain' }, body: 'guess=1111111' });
  check('نوع محتوى غير JSON مرفوض', wrongType.status === 415, wrongType.status);

  const notFound = await api('GET', '/api/unknown');
  check('مسار API غير موجود 404', notFound.status === 404);

  const wrongMethod = await fetch(`${BASE}/api/guess`, { method: 'GET', headers: { origin: BASE } });
  check('طريقة غير مسموحة 405', wrongMethod.status === 405, wrongMethod.status);

  const traversal = await fetch(`${BASE}/%2e%2e%2fserver.js`);
  const traversalText = await traversal.text();
  check('منع قراءة ملفات الخادم (path traversal)', traversal.status === 404 || !traversalText.includes('createServer'), traversal.status);

  const index = await fetch(`${BASE}/`);
  const indexText = await index.text();
  check('الواجهة الرئيسية تُقدَّم', index.status === 200 && indexText.includes('خزنة الجوائز'), index.status);
  check('ترويسات الأمان موجودة', index.headers.get('content-security-policy') !== null && index.headers.get('x-content-type-options') === 'nosniff');

  const noSecretInFrontend = !fs.existsSync(path.join(ROOT, 'public'))
    ? false
    : fs
        .readdirSync(path.join(ROOT, 'public'), { recursive: true })
        .filter((entry) => typeof entry === 'string')
        .every((entry) => {
          const file = path.join(ROOT, 'public', entry);
          try {
            return !fs.readFileSync(file, 'utf8').includes('1986am');
          } catch {
            return true;
          }
        });
  check('رمز الأدمن غير موجود في ملفات الواجهة', noSecretInFrontend);
}

const serverProcess = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), KHAZNA_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
serverProcess.stdout.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
serverProcess.stderr.on('data', (chunk) => {
  serverOutput += chunk.toString();
});

run()
  .then(async () => {
    await fetch(`${BASE}/api/admin/logout`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE } }).catch(() => {});
  })
  .catch((error) => {
    results.push({ name: 'فشل تنفيذ الاختبار', passed: false, detail: error.message });
  })
  .finally(() => {
    serverProcess.kill();
    const passed = results.filter((entry) => entry.passed).length;
    const failed = results.filter((entry) => !entry.passed);
    for (const entry of results) {
      console.log(`${entry.passed ? '  OK  ' : ' FAIL '} ${entry.name}${entry.detail ? `  →  ${entry.detail}` : ''}`);
    }
    console.log('\n----------------------------------------------');
    console.log(`النتيجة: ${passed} نجح / ${results.length} كلية`);
    if (failed.length) {
      console.log('التفاصيل:\n' + JSON.stringify(failed, null, 2));
      console.log('--- مخرجات السيرفر ---\n' + serverOutput.slice(-2000));
    }
    process.exit(failed.length ? 1 : 0);
  });
