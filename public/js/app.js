/**
 * منطق واجهة خزنة الجوائز.
 * كل قرارات المحاولات والتخمين والفوز تأتي من الخادم؛ هنا عرض وتفاعل فقط.
 */

import { sfxKey, sfxClick, sfxSpin, sfxError, sfxUnlock, sfxWin, sfxSuccess, setMuted, isMuted } from './sfx.js';
import { fireConfetti, stopConfetti } from './confetti.js';

/* ---------------------------------------------------------------- أدوات مساعدة */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

const SCREENS = ['auth', 'game', 'recharge', 'profile', 'admin-login', 'admin'];
const CHROME_HIDDEN = ['auth', 'admin-login'];

function showScreen(name) {
  if (!SCREENS.includes(name)) return;
  document.body.dataset.screen = name;
  for (const screen of SCREENS) $(`#screen-${screen}`)?.classList.toggle('hidden', screen !== name);
  $('#topbar').hidden = CHROME_HIDDEN.includes(name);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function currentScreen() {
  return document.body.dataset.screen || 'auth';
}

const TOAST_COLORS = { info: '', success: 'toast-success', error: 'toast-error', gold: 'toast-gold' };

function toast(message, type = 'info', ms = 3800) {
  const node = el('div', `toast ${TOAST_COLORS[type] || ''}`, message);
  $('#toasts').appendChild(node);
  setTimeout(() => {
    node.classList.add('toast-leaving');
    setTimeout(() => node.remove(), 320);
  }, ms);
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const helper = el('textarea');
    helper.value = value;
    helper.setAttribute('readonly', 'readonly');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    helper.remove();
    return ok;
  }
}

const numberFmt = new Intl.NumberFormat('en-US');

function statusText(status) {
  const map = { pending: 'قيد المراجعة', approved: 'مكتمل', rejected: 'مرفوض' };
  return map[status] || status;
}

/* ---------------------------------------------------------------- الخادم */

class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error || 'حدث خطأ غير متوقع');
    this.status = status;
    this.payload = payload || {};
  }
}

async function api(method, path, body) {
  const options = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new ApiError(0, { error: 'تعذّر الاتصال بالخادم، تحقق من الإنترنت' });
  }
  const payload = await response.json().catch(() => ({ error: 'استجابة غير متوقعة' }));
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

/* ---------------------------------------------------------------- الحالة */

const state = {
  game: { codeLength: 7, freeAttempts: 3, priceUsd: 1, attemptsPerUnit: 10, prizeLabel: '3,000,000', prizeCurrency: 'دينار عراقي' },
  payments: [],
  adminContact: { handle: '@khazna_support' },
  user: null,
  history: [],
  guess: '',
  busy: false,
  admin: false,
  adminData: null,
  adminCode: '',
  orderMethod: 'zaincash',
};

const vaultShell = $('#vault-shell');
const dial = $('#dial');
const digitsWrap = $('#digits');
const keypad = $('#keypad');

/* بناء خانات الرمز ولوحة الأرقام */
let builtLength = 0;

function buildDigits() {
  clear(digitsWrap);
  for (let i = 0; i < state.game.codeLength; i += 1) {
    const box = el('div', 'digit');
    box.dataset.index = String(i);
    box.addEventListener('click', () => focusCell(i));
    digitsWrap.appendChild(box);
  }
  builtLength = state.game.codeLength;
}

function buildKeypad() {
  clear(keypad);
  for (const value of [1, 2, 3, 4, 5, 6, 7, 8, 9]) keypad.appendChild(keyButton(value));
  keypad.appendChild(el('div', 'key key-spacer'));
  keypad.appendChild(keyButton(0));
}

function keyButton(value) {
  const button = el('button', 'key', value);
  button.type = 'button';
  button.dataset.digit = String(value);
  button.addEventListener('click', () => pressDigit(String(value)));
  return button;
}

function focusCell(index) {
  if (state.busy) return;
  state.guess = state.guess.slice(0, index);
  sfxClick();
  renderGuess();
}

function pressDigit(value) {
  if (state.busy) return;
  if (state.guess.length >= state.game.codeLength) {
    vaultStatus('الرمز مكتمل، اضغط فتح الخزنة أو امسحه للتعديل', 'hint');
    return;
  }
  state.guess += value;
  sfxKey(value);
  renderGuess();
}

function backspace() {
  if (state.busy || !state.guess.length) return;
  state.guess = state.guess.slice(0, -1);
  sfxClick();
  renderGuess();
}

function clearGuess() {
  state.guess = '';
  sfxClick();
  renderGuess();
  vaultStatus('أدخل الرمز الجديد', '');
}

function renderGuess() {
  const boxes = $$('.digit', digitsWrap);
  boxes.forEach((box, index) => {
    const value = state.guess[index] || '';
    box.textContent = value;
    box.classList.toggle('is-filled', Boolean(value));
    box.classList.toggle('is-cursor', index === state.guess.length);
    box.classList.remove('is-hit', 'is-warm', 'is-dead');
  });
  if (state.guess.length === state.game.codeLength) boxes.forEach((box) => box.classList.add('is-warm'));
  updateGuessEnabled();
}

function updateGuessEnabled() {
  const button = $('#btn-guess');
  const ready = state.guess.length === state.game.codeLength && !state.busy && state.user && state.user.attempts > 0;
  button.disabled = !ready;
  $('#btn-guess .btn-label').textContent = state.user && state.user.attempts === 0 ? 'لا توجد محاولات' : 'فتح الخزنة';
}

function vaultStatus(message, kind) {
  const node = $('#vault-status');
  node.textContent = message;
  node.classList.remove('is-error', 'is-hint', 'is-good');
  if (kind) node.classList.add(`is-${kind}`);
}

function flashDigits(className, ms = 950) {
  $$('.digit', digitsWrap).forEach((box) => box.classList.add(className));
  setTimeout(() => renderGuess(), ms);
}

function shakeVault() {
  vaultShell.classList.remove('is-shaking');
  void vaultShell.offsetWidth;
  vaultShell.classList.add('is-shaking');
  setTimeout(() => vaultShell.classList.remove('is-shaking'), 620);
}

/* ---------------------------------------------------------------- العرض */

function renderUser() {
  const user = state.user;
  const authed = Boolean(user);
  $('#ref-chip').hidden = !authed;
  $('#attempts-chip').hidden = !authed;
  $$('.topnav .nav-btn').forEach((button) => button.classList.toggle('is-active', button.dataset.nav === currentScreen()));

  if (!authed) {
    $('#attempts-count').textContent = '0';
    return;
  }

  $('#ref-code').textContent = user.referralCode;
  $('#attempts-count').textContent = user.attempts;
  $('#attempts-chip').classList.toggle('is-empty', user.attempts === 0);

  $('#side-attempts').textContent = user.attempts;
  $('#side-used').textContent = user.guessesUsed;
  $('#side-wins').textContent = user.wins;
  $('#progress-fill').style.width = `${Math.min(100, user.attempts * 10)}%`;

  const locked = user.attempts === 0;
  $('#lock-banner').classList.toggle('hidden', !locked);
  if (locked) vaultStatus('مقفل — اشحن المحاولات للمتابعة', 'error');

  $('#avatar-letter').textContent = (user.username || '؟').slice(0, 1);
  $('#profile-name').textContent = user.username;
  $('#profile-joined').textContent = `عضو منذ ${user.createdAt}`;
  $('#profile-ref').textContent = user.referralCode;
  $('#p-attempts').textContent = user.attempts;
  $('#p-used').textContent = user.guessesUsed;
  $('#p-invites').textContent = user.referralBonus;
  $('#p-wins').textContent = user.wins;
  $('#p-bought').textContent = user.totalPurchased;
  $('#p-referrer').textContent = user.referredBy || '—';
  updateGuessEnabled();
}

function renderHistory() {
  const list = $('#history-list');
  clear(list);
  if (!state.history.length) {
    list.appendChild(el('li', 'h-empty', 'لا تخمينات بعد — ابدأ بأول رمز.'));
    return;
  }
  for (const entry of state.history) {
    const row = el('li');
    if (entry.correct) row.classList.add('is-win');
    row.appendChild(el('span', 'h-code', entry.guess));
    const meta = el('span', 'h-meta');
    if (entry.correct) {
      meta.appendChild(el('span', 'pill pill-exact', 'مفتوحة'));
    } else {
      meta.appendChild(el('span', 'pill pill-exact', `${entry.exact} مكان`));
      meta.appendChild(el('span', 'pill pill-other', `${entry.misplaced} قريب`));
    }
    row.appendChild(meta);
    list.appendChild(row);
  }
}

function renderStatic() {
  $('#brand-sub').textContent = `الجائزة الكبرى ${state.game.prizeLabel} ${state.game.prizeCurrency}`;
  $('#foot-support').textContent = state.adminContact.handle;
  $('#support-handle').textContent = state.adminContact.handle;
  $('#win-amount').textContent = state.game.prizeLabel;
  $('#win-currency').textContent = state.game.prizeCurrency;
  $('#year').textContent = new Date().getFullYear();
  renderPayMethods();
}

function renderPayMethods() {
  const wrap = $('#pay-methods');
  const select = $('#order-method');
  clear(wrap);
  clear(select);
  for (const method of state.payments) {
    const card = el('button', 'pay-card');
    card.type = 'button';
    card.dataset.method = method.id;
    card.appendChild(el('div', 'pay-logo', method.logo));
    card.appendChild(el('b', null, method.label));
    card.appendChild(el('span', null, method.account));
    card.addEventListener('click', () => {
      state.orderMethod = method.id;
      select.value = method.id;
      markActiveMethod();
      sfxClick();
    });
    wrap.appendChild(card);

    const option = el('option', null, `${method.label} — ${method.account}`);
    option.value = method.id;
    select.appendChild(option);
  }
  if (state.payments.length) {
    state.orderMethod = state.payments[0].id;
    select.value = state.orderMethod;
  }
  markActiveMethod();
}

function markActiveMethod() {
  $$('.pay-card').forEach((card) => card.classList.toggle('is-active', card.dataset.method === state.orderMethod));
}

/* ---------------------------------------------------------------- العمليات */

async function refreshState() {
  const payload = await api('GET', '/api/state');
  state.game = { ...state.game, ...payload.game };
  state.payments = payload.payments || state.payments;
  state.adminContact = payload.adminContact || state.adminContact;
  state.user = payload.user;
  state.history = payload.history || [];
  if (builtLength !== state.game.codeLength) {
    buildDigits();
    renderGuess();
  }
  renderStatic();
  renderUser();
  renderHistory();
  showScreen(state.user ? 'game' : 'auth');
}

async function submitGuess() {
  if (state.busy || state.guess.length !== state.game.codeLength) return;
  if (!state.user) {
    toast('سجّل الدخول أولاً', 'error');
    return;
  }
  if (state.user.attempts <= 0) {
    toast('نفدت محاولاتك — اشحن للمتابعة', 'error');
    showScreen('recharge');
    return;
  }

  state.busy = true;
  const button = $('#btn-guess');
  button.classList.add('is-busy');
  button.disabled = true;
  dial.classList.add('is-spinning');
  vaultStatus('جارٍ فحص الرمز داخل الخزنة...', 'hint');
  sfxSpin();

  const sent = state.guess;
  let result = null;
  let failure = null;
  try {
    result = await api('POST', '/api/guess', { guess: sent });
  } catch (error) {
    failure = error;
  }

  dial.classList.remove('is-spinning');
  button.classList.remove('is-busy');
  state.busy = false;

  if (failure) {
    handleGuessError(failure);
    return;
  }

  state.user = result.user;
  state.history = [{ guess: result.guess, correct: result.correct, exact: result.hint.exact, misplaced: result.hint.misplaced, createdAt: 'الآن' }, ...state.history].slice(0, 10);
  renderUser();
  renderHistory();

  if (result.correct) {
    celebrate(sent);
    return;
  }

  shakeVault();
  sfxError();
  flashDigits('is-dead');
  vaultStatus(`رمز خاطئ — ${result.hint.exact} في مكانه الصحيح، ${result.hint.misplaced} في موضع آخر`, 'error');
  toast(`محاولاتك المتبقية: ${result.attemptsLeft}`, result.attemptsLeft === 0 ? 'error' : 'info');
  state.guess = '';
  renderGuess();
}

function handleGuessError(error) {
  const payload = error.payload || {};
  if (error.status === 429) {
    const seconds = Math.max(1, Math.ceil((payload.retryAfterMs || 20000) / 1000));
    vaultStatus(`صمّم قليلاً ${seconds} ثانية ثم أعد المحاولة`, 'hint');
    toast('تخمينات سريعة جداً — انتظر قليلاً', 'error');
    return;
  }
  if (error.status === 423 || payload.reason === 'no_attempts') {
    vaultStatus('لا توجد محاولات متبقية', 'error');
    toast('نفدت المحاولات — اشحن 10 محاولات بدولار', 'error');
    showScreen('recharge');
    refreshState().catch(() => {});
    return;
  }
  if (error.status === 401) {
    state.user = null;
    renderUser();
    showScreen('auth');
    toast('انتهت الجلسة، سجّل الدخول من جديد', 'error');
    return;
  }
  if (error.status === 400) {
    vaultStatus(error.message, 'error');
    toast(error.message, 'error');
    return;
  }
  vaultStatus(error.message, 'error');
  toast(error.message, 'error');
}

function celebrate(code) {
  vaultShell.classList.add('is-open');
  dial.classList.add('is-unlocked');
  $$('.digit', digitsWrap).forEach((box) => box.classList.add('is-hit'));
  vaultStatus('الخزنة مفتوحة!', 'good');
  sfxUnlock();
  setTimeout(() => sfxWin(), 260);
  fireConfetti($('#confetti'), { count: 280, durationMs: 7000 });
  $('#win-code-line').textContent = `الرمز الفائز: ${code}`;
  $('#win-overlay').classList.remove('hidden');
  toast('مبروك! ربحت الجائزة الكبرى', 'gold', 6000);
  refreshOrders().catch(() => {});
}

function closeWin() {
  $('#win-overlay').classList.add('hidden');
  stopConfetti($('#confetti'));
  vaultShell.classList.remove('is-open');
  dial.classList.remove('is-unlocked');
  state.guess = '';
  renderGuess();
  vaultStatus('دورة جديدة — جرّب رمزاً آخر', '');
}

/* ---------------------------------------------------------------- المصادقة */

function switchAuthTab(tab) {
  $$('.auth-card .tab').forEach((button) => button.classList.toggle('is-active', button.dataset.tab === tab));
  $('#form-login').classList.toggle('hidden', tab !== 'login');
  $('#form-register').classList.toggle('hidden', tab !== 'register');
  sfxClick();
}

async function handleLogin(event) {
  event.preventDefault();
  const button = $('#login-submit');
  button.disabled = true;
  try {
    const payload = await api('POST', '/api/login', {
      username: $('#login-username').value.trim(),
      password: $('#login-password').value,
    });
    state.user = payload.user;
    $('#form-login').reset();
    await refreshState();
    renderHistory();
    sfxSuccess();
    toast(`أهلاً بعودتك ${payload.user.username}`, 'success');
  } catch (error) {
    toast(error.message, 'error');
    sfxError();
  } finally {
    button.disabled = false;
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const username = $('#register-username').value.trim();
  const password = $('#register-password').value;
  const password2 = $('#register-password2').value;
  const referral = $('#register-referral').value.trim();

  if (password !== password2) {
    toast('كلمتا المرور غير متطابقتين', 'error');
    return;
  }

  const button = $('#register-submit');
  button.disabled = true;
  try {
    const payload = await api('POST', '/api/register', { username, password, ...(referral ? { referral } : {}) });
    state.user = payload.user;
    $('#form-register').reset();
    await refreshState();
    sfxSuccess();
    toast(payload.bonus?.invited ? 'تم تفعيل دعوة صديق — لديك 4 محاولات مجانية' : 'حسابك جاهز — 3 محاولات مجانية', 'gold', 5000);
  } catch (error) {
    toast(error.message, 'error');
    sfxError();
    if (error.payload?.error?.includes('رمز الإحالة')) $('#register-referral').focus();
  } finally {
    button.disabled = false;
  }
}

async function handleLogout() {
  try {
    await api('POST', '/api/logout', {});
  } catch {
    /* الخروج المحلي مطلوب حتى لو فشل الاتصال */
  }
  state.user = null;
  state.history = [];
  stopConfetti($('#confetti'));
  closeWin();
  renderUser();
  renderHistory();
  showScreen('auth');
  toast('تم تسجيل الخروج', 'info');
}

/* ---------------------------------------------------------------- الشحن */

function recalcPrice() {
  const attempts = Number($('#order-attempts').value) || 0;
  const units = Math.max(1, Math.ceil(attempts / state.game.attemptsPerUnit));
  $('#order-price').textContent = `$${(units * state.game.priceUsd).toFixed(2)}`;
}

async function createOrder(event) {
  event.preventDefault();
  const attempts = Number($('#order-attempts').value);
  if (!Number.isInteger(attempts) || attempts < 1) {
    toast('اختر عدد محاولات صحيحاً', 'error');
    return;
  }
  const button = $('#order-submit');
  button.disabled = true;
  try {
    const payload = await api('POST', '/api/orders', {
      attempts,
      method: state.orderMethod,
      payerNote: $('#order-note').value.trim(),
    });
    toast(`تم إرسال الطلب ${payload.order.reference} — أرسل رمزك للأدمن لتأكيد الشحن`, 'success', 6000);
    sfxSuccess();
    $('#order-note').value = '';
    await refreshOrders();
  } catch (error) {
    toast(error.message, 'error');
    if (error.status === 401) showScreen('auth');
  } finally {
    button.disabled = false;
  }
}

async function refreshOrders() {
  if (!state.user) return;
  try {
    const payload = await api('GET', '/api/orders');
    const list = $('#orders-list');
    clear(list);
    if (!payload.orders.length) {
      list.appendChild(el('li', 'o-empty', 'لا توجد طلبات شحن بعد.'));
      return;
    }
    for (const order of payload.orders) {
      const row = el('li');
      const left = el('div');
      left.appendChild(el('div', 'o-ref', order.reference));
      left.appendChild(el('div', 'tiny', `${order.attempts} محاولة • $${order.amountUsd.toFixed(2)} • ${order.method}`));
      row.appendChild(left);
      row.appendChild(el('span', `status-pill status-${order.status}`, statusText(order.status)));
      list.appendChild(row);
    }
  } catch {
    /* الطلبات اختيارية في العرض */
  }
}

/* ---------------------------------------------------------------- الأدمن */

async function adminLogin(event) {
  event.preventDefault();
  const code = $('#admin-code').value;
  if (!code) return;
  const button = $('#form-admin-login button[type="submit"]');
  button.disabled = true;
  try {
    await api('POST', '/api/admin/login', { code });
    state.admin = true;
    $('#admin-code').value = '';
    toast('مرحباً بك في لوحة التحكم', 'gold');
    sfxSuccess();
    showScreen('admin');
    await loadAdmin();
  } catch (error) {
    toast(error.message, 'error');
    sfxError();
    $('#admin-code').select();
  } finally {
    button.disabled = false;
  }
}

async function loadAdmin() {
  const payload = await api('GET', '/api/admin/overview');
  state.adminData = payload;
  renderAdminStats(payload);
  renderAdminOrders(payload.pendingOrders);
  renderAdminUsers(payload.recentUsers, payload.topReferrers);
}

const STAT_LABELS = [
  ['users', 'المستخدمون'],
  ['attemptsInPlay', 'محاولات في اللعب'],
  ['guessesUsed', 'إجمالي التخمينات'],
  ['totalWins', 'مرات فتح الخزنة'],
  ['outOfAttempts', 'حسابات بلا محاولات'],
  ['pendingOrders', 'طلبات شحن معلّقة'],
  ['approvedRevenueUsd', 'إيرادات معتمدة ($)'],
  ['purchasedAttempts', 'محاولات مشحونة'],
];

function renderAdminStats(payload) {
  const wrap = $('#stat-cards');
  clear(wrap);
  for (const [key, label] of STAT_LABELS) {
    const card = el('div', 'stat-card');
    card.appendChild(el('b', null, numberFmt.format(payload.stats[key] ?? 0)));
    card.appendChild(el('span', null, label));
    wrap.appendChild(card);
  }
  $('#admin-current-code').value = '';
  state.adminCode = '';
}

function renderAdminOrders(orders) {
  const body = $('#orders-rows');
  clear(body);
  if (!orders || !orders.length) {
    const row = el('tr', 'empty-row');
    const cell = el('td', null, 'لا توجد طلبات معلّقة الآن.');
    cell.colSpan = 7;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  for (const order of orders) {
    const row = el('tr');
    row.appendChild(el('td', null, order.reference));
    row.appendChild(el('td', 'dir-ar', `${order.username} (${order.referral_code})`));
    row.appendChild(el('td', null, order.attempts));
    row.appendChild(el('td', null, `$${Number(order.amount_usd).toFixed(2)}`));
    row.appendChild(el('td', 'dir-ar', order.method));
    row.appendChild(el('td', 'dir-ar', order.payer_note || '—'));

    const cell = el('td');
    const approve = el('button', 'btn btn-gold btn-sm', 'اعتماد');
    approve.type = 'button';
    approve.addEventListener('click', () => reviewOrder(order.reference, 'approve'));
    const reject = el('button', 'btn btn-ghost btn-sm', 'رفض');
    reject.type = 'button';
    reject.addEventListener('click', () => reviewOrder(order.reference, 'reject'));
    cell.append(approve, reject);
    row.appendChild(cell);
    body.appendChild(row);
  }
}

function renderAdminUsers(users, referrers) {
  const body = $('#users-rows');
  clear(body);
  if (!users.length) {
    const row = el('tr', 'empty-row');
    const cell = el('td', null, 'لا يوجد مستخدمون بعد.');
    cell.colSpan = 7;
    row.appendChild(cell);
    body.appendChild(row);
  }
  for (const user of users) {
    const row = el('tr');
    row.appendChild(el('td', 'dir-ar', user.username));
    row.appendChild(el('td', null, user.referralCode));
    row.appendChild(el('td', null, user.attempts));
    row.appendChild(el('td', null, user.guessesUsed));
    row.appendChild(el('td', null, user.referralBonus));
    row.appendChild(el('td', null, user.wins));
    row.appendChild(el('td', null, user.createdAt));
    body.appendChild(row);
  }

  const chips = $('#top-referrers');
  clear(chips);
  if (!referrers.length) chips.appendChild(el('li', null, 'لا دعوات بعد'));
  for (const referrer of referrers) {
    chips.appendChild(el('li', null, `${referrer.username} — ${referrer.referral_bonus} دعوة (${referrer.referral_code})`));
  }
}

async function revealVaultCode() {
  const input = $('#admin-current-code');
  if (state.adminCode) {
    input.value = state.adminCode;
    $('#btn-reveal-code').textContent = 'إخفاء';
    return;
  }
  try {
    const payload = await api('GET', '/api/admin/vault');
    state.adminCode = payload.code;
    input.value = payload.code;
    $('#btn-reveal-code').textContent = 'إخفاء';
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function saveVaultCode() {
  const code = $('#admin-new-code').value.replace(/[\s-]/g, '');
  const button = $('#btn-save-code');
  button.disabled = true;
  try {
    const payload = await api('POST', '/api/admin/vault', { code });
    toast(payload.message || 'تم تحديث الرمز', 'success');
    sfxSuccess();
    $('#admin-new-code').value = '';
    state.adminCode = code;
    $('#admin-current-code').value = code;
    await loadAdmin();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function searchAdminUser() {
  const ref = $('#charge-ref').value.trim();
  if (!ref) {
    toast('أدخل رمز الإحالة', 'error');
    return;
  }
  try {
    const payload = await api('GET', `/api/admin/user?ref=${encodeURIComponent(ref)}`);
    renderAdminUserResult(payload);
    sfxClick();
  } catch (error) {
    toast(error.message, 'error');
    clear($('#user-result'));
  }
}

function renderAdminUserResult(payload) {
  const wrap = $('#user-result');
  clear(wrap);
  const lines = [
    ['الحساب', payload.user.username],
    ['الرمز', payload.user.referralCode],
    ['المحاولات المتبقية', payload.user.attempts],
    ['التخمينات المستخدمة', payload.user.guessesUsed],
    ['الدعوات المفعّلة', payload.user.referralBonus],
    ['مرات الفوز', payload.user.wins],
    ['محاولات مشحونة', payload.user.totalPurchased],
    ['آخر تخمين', payload.history[0] ? `${payload.history[0].guess} (${payload.history[0].exact} مكان / ${payload.history[0].misplaced} قريب)` : '—'],
    ['طلبات', payload.orders.length ? payload.orders.map((order) => `${order.reference}:${order.status}`).join(' | ') : '—'],
  ];
  for (const [label, value] of lines) {
    const row = el('div', 'row');
    row.appendChild(el('span', null, label));
    row.appendChild(el('b', null, value));
    wrap.appendChild(row);
  }
}

async function chargeUser() {
  const ref = $('#charge-ref').value.trim();
  const attempts = Number($('#charge-attempts').value);
  if (!ref) {
    toast('أدخل رمز الإحالة', 'error');
    return;
  }
  const button = $('#btn-charge-user');
  button.disabled = true;
  try {
    const payload = await api('POST', '/api/admin/charge', { referralCode: ref, attempts });
    toast(`تم شحن ${payload.added} محاولة لحساب ${payload.user.username}`, 'success', 5000);
    sfxSuccess();
    await searchAdminUser();
    await loadAdmin();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function reviewOrder(reference, action) {
  try {
    await api('POST', '/api/admin/order', { reference, action });
    toast(action === 'approve' ? `اعتمدنا الطلب ${reference}` : `رفضنا الطلب ${reference}`, action === 'approve' ? 'success' : 'info');
    await loadAdmin();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function exitAdmin() {
  try {
    await api('POST', '/api/admin/logout', {});
  } catch {
    /* تجاهل */
  }
  state.admin = false;
  state.adminCode = '';
  await refreshState();
  showScreen(state.user ? 'game' : 'auth');
  toast('خرجت من لوحة التحكم', 'info');
}

/* ---------------------------------------------------------------- ربط الأحداث */

function wire() {
  $$('.auth-card .tab').forEach((button) => button.addEventListener('click', () => switchAuthTab(button.dataset.tab)));
  $('#form-login').addEventListener('submit', handleLogin);
  $('#form-register').addEventListener('submit', handleRegister);
  $('#logout-btn').addEventListener('click', () => {
    sfxClick();
    handleLogout();
  });
  $('#copy-ref').addEventListener('click', async () => {
    if (!state.user) return;
    const ok = await copyText(state.user.referralCode);
    toast(ok ? 'تم نسخ الرمز — أرسله للشحن أو الدعوة' : 'تعذّر النسخ، انسخه يدوياً', ok ? 'success' : 'error');
    sfxClick();
  });
  $('#copy-ref-2').addEventListener('click', async () => {
    if (!state.user) return;
    const ok = await copyText(state.user.referralCode);
    toast(ok ? 'تم نسخ رمز حسابك' : 'تعذّر النسخ', ok ? 'success' : 'error');
  });
  $('#share-btn').addEventListener('click', async () => {
    if (!state.user) return;
    const link = `${location.origin}/?ref=${state.user.referralCode}`;
    const text = `سجّل في خزنة الجوائز بلعبتي وافتح الخزنة معي، استخدم رمز الإحالة: ${state.user.referralCode} — ${link}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'خزنة الجوائز', text });
        return;
      } catch {
        /* أُلغيت المشاركة */
      }
    }
    const ok = await copyText(text);
    toast(ok ? 'نُسخت رسالة الدعوة، الصقها لأصدقائك' : 'تعذّر النسخ', ok ? 'success' : 'error');
  });

  $$('.nav-btn, [data-nav]').forEach((button) => {
    button.addEventListener('click', () => {
      sfxClick();
      const destination = button.dataset.nav;
      if (!state.user && destination !== 'game') {
        toast('سجّل الدخول أولاً', 'error');
        showScreen('auth');
        return;
      }
      if (destination === 'recharge') refreshOrders().catch(() => {});
      showScreen(destination);
      $$('.topnav .nav-btn').forEach((item) => item.classList.toggle('is-active', item.dataset.nav === destination));
    });
  });

  $('#sound-btn').addEventListener('click', () => {
    const next = !isMuted();
    setMuted(next);
    $('#sound-btn').setAttribute('aria-pressed', String(!next));
    $('#sound-btn').classList.toggle('is-muted', next);
    if (!next) sfxClick();
    toast(next ? 'الصوت مطفأ' : 'الصوت شغّال', 'info', 1800);
  });
  $('#sound-btn').classList.toggle('is-muted', isMuted());
  $('#sound-btn').setAttribute('aria-pressed', String(!isMuted()));

  $('#btn-guess').addEventListener('click', submitGuess);
  $('#btn-clear').addEventListener('click', clearGuess);
  $('#btn-backspace').addEventListener('click', backspace);

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyA') {
      event.preventDefault();
      openAdminGate();
      return;
    }
    const overlayOpen = !$('#win-overlay').classList.contains('hidden');
    if (overlayOpen && event.key === 'Escape') {
      closeWin();
      return;
    }
    if (currentScreen() !== 'game' || overlayOpen) return;
    const target = event.target;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      pressDigit(event.key);
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      backspace();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      submitGuess();
    } else if (event.key === 'Escape') {
      clearGuess();
    }
  });

  document.addEventListener('paste', (event) => {
    if (currentScreen() !== 'game') return;
    const text = (event.clipboardData || window.clipboardData).getData('text') || '';
    const digits = text.replace(/\D/g, '').slice(0, state.game.codeLength);
    if (digits.length >= 3) {
      state.guess = digits;
      renderGuess();
      toast('لصق الرمز في الخزنة', 'info', 2000);
    }
  });

  $('#win-close').addEventListener('click', closeWin);
  $('#win-share').addEventListener('click', async () => {
    const text = `فتحت خزنة الجوائز وربحت ${state.game.prizeLabel} ${state.game.prizeCurrency}! رمز حسابي ${state.user?.referralCode || ''}`;
    if (navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch {
        /* أُلغيت */
      }
    }
    const ok = await copyText(text);
    toast(ok ? 'نُسخت رسالة الفوز' : 'تعذّر النسخ', ok ? 'success' : 'error');
  });

  $('#form-order').addEventListener('submit', createOrder);
  $('#order-attempts').addEventListener('input', recalcPrice);
  $('#order-method').addEventListener('change', (event) => {
    state.orderMethod = event.target.value;
    markActiveMethod();
  });

  // بوابة الأدمن: ضغطات على الشعار، زر التذييل، أو اختصار لوحة المفاتيح.
  let brandTaps = 0;
  let brandTimer = null;
  $('#brand-btn').addEventListener('click', () => {
    brandTaps += 1;
    clearTimeout(brandTimer);
    brandTimer = setTimeout(() => {
      brandTaps = 0;
    }, 2600);
    if (brandTaps >= 5) {
      brandTaps = 0;
      openAdminGate();
    } else if (state.user) {
      showScreen('game');
    }
  });
  $('#foot-admin').addEventListener('click', openAdminGate);
  $('#form-admin-login').addEventListener('submit', adminLogin);
  $('#admin-cancel').addEventListener('click', () => showScreen(state.user ? 'game' : 'auth'));

  $('#btn-refresh-admin').addEventListener('click', () => loadAdmin().catch((error) => toast(error.message, 'error')));
  $('#btn-admin-exit').addEventListener('click', exitAdmin);
  $$('.admin-tabs .tab').forEach((button) => {
    button.addEventListener('click', () => {
      $$('.admin-tabs .tab').forEach((item) => item.classList.toggle('is-active', item === button));
      $$('.admin-panel').forEach((panel) => panel.classList.add('hidden'));
      $(`#atab-${button.dataset.atab}`).classList.remove('hidden');
      sfxClick();
    });
  });
  $('#btn-reveal-code').addEventListener('click', revealVaultCode);
  $('#btn-save-code').addEventListener('click', saveVaultCode);
  $('#btn-search-user').addEventListener('click', searchAdminUser);
  $('#btn-charge-user').addEventListener('click', chargeUser);
  $('#admin-new-code').addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/\D/g, '').slice(0, state.game.codeLength);
  });
}

function openAdminGate() {
  sfxClick();
  showScreen('admin-login');
  setTimeout(() => $('#admin-code').focus(), 120);
}

/* ---------------------------------------------------------------- الإقلاع */

async function boot() {
  buildDigits();
  buildKeypad();
  renderGuess();
  wire();
  recalcPrice();

  // رابط الدعوة يملأ الحقل تلقائياً.
  const invited = new URLSearchParams(location.search).get('ref');
  if (invited) {
    $('#register-referral').value = invited.toUpperCase();
    switchAuthTab('register');
  }

  try {
    await refreshState();
    if (state.user) await refreshOrders();
    if (invited && state.user) toast('أنت مسجّل بالفعل — سجّل الخروج أولاً لتستخدم رمز صديقك', 'info', 5200);
  } catch (error) {
    toast(error.message, 'error');
    showScreen('auth');
  }
}

boot();
