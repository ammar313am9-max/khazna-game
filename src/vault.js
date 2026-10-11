'use strict';

/**
 * إدارة الخزنة: الرمز السري المكوّن من 7 أرقام يُخزَّن مشفراً في قاعدة البيانات
 * ولا يغادر الخادم أبداً — الواجهة تستنتج نتيجتها من التلميحات فقط.
 */

const config = require('./config');
const store = require('./db');
const security = require('./security');
const { HttpError } = require('./http');

/** يقرأ الرمز الحالي، ويولّد رمزاً عشوائياً جديداً في أول تشغيل فقط. */
function currentCode() {
  const row = store.get('SELECT code_cipher FROM vault WHERE id = 1');
  if (row) return security.decryptSecret(row.code_cipher);

  const code = security.randomVaultCode(config.game.codeLength);
  store.run(
    'INSERT INTO vault (id, code_cipher, updated_at, open_count) VALUES (1, ?, datetime(\'now\'), 0)',
    security.encryptSecret(code)
  );
  return code;
}

function setCode(code) {
  if (!security.isSevenDigits(code, config.game.codeLength)) {
    throw new HttpError(400, `الرمز يجب أن يكون ${config.game.codeLength} أرقام`);
  }
  store.run(
    'UPDATE vault SET code_cipher = ?, updated_at = datetime(\'now\') WHERE id = 1',
    security.encryptSecret(code)
  );
}

function markOpened() {
  store.run("UPDATE vault SET open_count = open_count + 1 WHERE id = 1");
}

/**
 * تلميح على طريقة Mastermind: كم رقم في مكانه الصحيح، وكم رقم صحيح لكنه في موضع آخر.
 * يجعل اللعبة قابلة للحل بدل احتمال 1 من 10 ملايين.
 */
function score(guess, secret) {
  let exact = 0;
  const secretRest = new Map();
  const guessRest = new Map();
  for (let i = 0; i < secret.length; i += 1) {
    if (guess[i] === secret[i]) {
      exact += 1;
      continue;
    }
    secretRest.set(secret[i], (secretRest.get(secret[i]) || 0) + 1);
    guessRest.set(guess[i], (guessRest.get(guess[i]) || 0) + 1);
  }
  let misplaced = 0;
  for (const [digit, count] of guessRest) {
    misplaced += Math.min(count, secretRest.get(digit) || 0);
  }
  return { exact, misplaced };
}

module.exports = { currentCode, setCode, markOpened, score };
