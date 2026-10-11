'use strict';

/**
 * مسارات اللعب. التحقق من صحة التخمين وخصم المحاولات يتم حصراً على الخادم،
 * لذا لا يمكن التلاعب بالعدّاد من أدوات المطور (F12).
 */

const config = require('../config');
const http = require('../http');
const store = require('../db');
const security = require('../security');
const session = require('../session');
const vault = require('../vault');
const rateLimit = require('../rateLimit');

const { HttpError } = http;

function guessHistory(userId, limit = 15) {
  return store
    .all(
      'SELECT guess, is_correct, exact_digits, other_digits, created_at FROM guesses WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      userId,
      limit
    )
    .map((row) => ({
      guess: row.guess,
      correct: row.is_correct === 1,
      exact: row.exact_digits,
      misplaced: row.other_digits,
      createdAt: row.created_at,
    }));
}

function vaultMeta() {
  const row = store.get('SELECT updated_at, open_count FROM vault WHERE id = 1');
  return { updatedAt: row ? row.updated_at : null, openCount: row ? row.open_count : 0 };
}

function state(ctx) {
  const user = session.currentUser(ctx.req);
  return {
    ok: true,
    authenticated: Boolean(user),
    admin: session.isAdmin(ctx.req),
    game: {
      codeLength: config.game.codeLength,
      freeAttempts: config.game.freeAttempts,
      refereeBonus: config.game.refereeBonus,
      referrerBonus: config.game.referrerBonus,
      attemptsPerUnit: config.game.attemptsPerUnit,
      priceUsd: config.game.priceUsd,
      prizeLabel: config.game.prizeLabel,
      prizeCurrency: config.game.prizeCurrency,
    },
    payments: config.payments,
    adminContact: config.adminContact,
    vault: vaultMeta(),
    user: user ? session.publicUser(user) : null,
    history: user ? guessHistory(user.id, 10) : [],
  };
}

/** محدود معدّل خاص بالتخمين: لكل مستخدم ولالعنوان، لمنع البوتات من التخمين السريع. */
function guess(ctx) {
  const user = session.requireUser(ctx.req);
  const ip = http.clientIp(ctx.req);

  const perMinute = rateLimit.consume(`guess:user:${user.id}`, config.limits.guessPerMinute);
  const perHour = rateLimit.consume(`guess:user-hour:${user.id}`, config.limits.guessPerHour);
  const perIp = rateLimit.consume(`guess:ip:${ip}`, config.limits.guessPerMinuteIp);
  const blocked = [perMinute, perHour, perIp].find((entry) => !entry.allowed);
  if (blocked) {
    const error = new HttpError(429, 'تخمينات سريعة جداً — انتظر قليلاً قبل المحاولة التالية');
    error.details = { reason: 'rate_limited', retryAfterMs: blocked.retryAfterMs };
    throw error;
  }

  const raw = typeof ctx.payload.guess === 'string' ? ctx.payload.guess.replace(/[\s-]/g, '') : '';
  if (!security.isSevenDigits(raw, config.game.codeLength)) {
    const error = new HttpError(400, `يجب إدخال ${config.game.codeLength} أرقام بالضبط`);
    error.details = { reason: 'bad_guess' };
    throw error;
  }

  const fresh = store.get('SELECT attempts FROM users WHERE id = ?', user.id);
  if (!fresh || fresh.attempts <= 0) {
    const error = new HttpError(423, 'لا توجد محاولات متبقية — اشحن محاولات للمتابعة');
    error.details = { reason: 'no_attempts', attempts: 0 };
    throw error;
  }

  const secret = vault.currentCode();
  const result = vault.score(raw, secret);
  const correct = raw === secret;

  const outcome = store.transaction(() => {
    const spent = store.run('UPDATE users SET attempts = attempts - 1, guesses_used = guesses_used + 1 WHERE id = ? AND attempts > 0', user.id);
    if (spent.changes === 0) return null;

    store.run(
      'INSERT INTO guesses (user_id, guess, is_correct, exact_digits, other_digits) VALUES (?, ?, ?, ?, ?)',
      user.id,
      raw,
      correct ? 1 : 0,
      result.exact,
      result.misplaced
    );

    if (correct) {
      store.run('UPDATE users SET wins = wins + 1 WHERE id = ?', user.id);
      vault.markOpened();
    }

    return store.get(
      `SELECT id, username, referral_code, referred_by, attempts, referral_bonus, guesses_used, wins, total_purchased, created_at
       FROM users WHERE id = ?`,
      user.id
    );
  });

  if (!outcome) {
    const error = new HttpError(423, 'نفّذت كل محاولاتك');
    error.details = { reason: 'no_attempts', attempts: 0 };
    throw error;
  }

  return {
    ok: true,
    correct,
    guess: raw,
    attemptsLeft: outcome.attempts,
    hint: correct ? { exact: config.game.codeLength, misplaced: 0 } : { exact: result.exact, misplaced: result.misplaced },
    prize: correct
      ? {
          amount: config.game.prizeAmount,
          label: config.game.prizeLabel,
          currency: config.game.prizeCurrency,
          alreadyWon: outcome.wins > 1,
        }
      : null,
    user: session.publicUser(outcome),
  };
}

function history(ctx) {
  const user = session.requireUser(ctx.req);
  return { ok: true, history: guessHistory(user.id, 20) };
}

module.exports = [
  { method: 'GET', path: '/api/state', handler: state, options: { rateLimit: 'apiPerMinute' } },
  { method: 'POST', path: '/api/guess', handler: guess, options: { rateLimit: 'apiPerMinute' } },
  { method: 'GET', path: '/api/history', handler: history, options: { rateLimit: 'apiPerMinute' } },
];
