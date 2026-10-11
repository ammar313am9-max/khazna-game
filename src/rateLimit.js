'use strict';

/**
 * محدود معدّل (Rate Limiting) بنافذة منزلقة داخل الذاكرة.
 * يمنع بوتات التخمين السريع وتكرار تسجيل الدخول أو التسجيل من نفس الجهاز.
 */

const buckets = new Map();

/**
 * @param {string} key   معرف العملية مثل `guess:1234:1.2.3.4`
 * @param {{windowMs:number,max:number}} rule
 * @returns {{allowed:boolean, remaining:number, retryAfterMs:number}}
 */
function consume(key, rule) {
  const now = Date.now();
  const since = now - rule.windowMs;
  let hits = buckets.get(key);
  if (!hits) {
    hits = [];
    buckets.set(key, hits);
  }
  while (hits.length && hits[0] <= since) hits.shift();

  if (hits.length >= rule.max) {
    const retryAfterMs = Math.max(0, hits[0] + rule.windowMs - now);
    return { allowed: false, remaining: 0, retryAfterMs };
  }
  hits.push(now);
  return { allowed: true, remaining: rule.max - hits.length, retryAfterMs: 0 };
}

/** المسح الدوري حتى لا يكبر حجم الخريطة مع الوقت. */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of buckets) {
    while (hits.length && hits[0] < now - 60 * 60 * 1000) hits.shift();
    if (!hits.length) buckets.delete(key);
  }
}, 5 * 60 * 1000);
sweeper.unref();

module.exports = { consume, buckets };
