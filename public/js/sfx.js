/**
 * مؤثرات صوتية مولّدة بـ Web Audio API — لا ملفات صوتية خارجية.
 * تُنشأ غرفة الصوت عند أول تفاعل من المستخدم امتثالاً لسياسة المتصفحات.
 */

let ctx = null;
let master = null;
let muted = localStorage.getItem('khazna_muted') === '1';

function audio() {
  if (muted) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function setMuted(value) {
  muted = Boolean(value);
  localStorage.setItem('khazna_muted', muted ? '1' : '0');
}

export function isMuted() {
  return muted;
}

function tone({ freq = 440, to = null, type = 'triangle', dur = 0.12, gain = 0.25, delay = 0, filter = null }) {
  const ac = audio();
  if (!ac) return;
  const start = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + dur);

  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  let node = osc;
  if (filter) {
    const bq = ac.createBiquadFilter();
    bq.type = 'lowpass';
    bq.frequency.value = filter;
    node.connect(bq);
    node = bq;
  }
  node.connect(amp);
  amp.connect(master);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

function noise({ dur = 0.3, gain = 0.2, band = 1200, delay = 0 }) {
  const ac = audio();
  if (!ac) return;
  const start = ac.currentTime + delay;
  const frames = Math.floor(ac.sampleRate * dur);
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);

  const src = ac.createBufferSource();
  src.buffer = buffer;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = band;
  bp.Q.value = 1.1;
  const amp = ac.createGain();
  amp.gain.setValueAtTime(gain, start);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(bp);
  bp.connect(amp);
  amp.connect(master);
  src.start(start);
}

/** نقرة زر الأرقام. */
export function sfxKey(digit = 0) {
  tone({ freq: 620 + Number(digit) * 45, type: 'square', dur: 0.05, gain: 0.12, filter: 2400 });
}

/** ضغطة عامة للواجهة. */
export function sfxClick() {
  tone({ freq: 420, to: 560, type: 'sine', dur: 0.08, gain: 0.14 });
}

/** دوران القرص المعدني أثناء التحقق. */
export function sfxSpin() {
  const ac = audio();
  if (!ac) return;
  for (let i = 0; i < 9; i += 1) {
    noise({ dur: 0.09, gain: 0.06, band: 900 + i * 220, delay: i * 0.1 });
  }
  tone({ freq: 90, to: 240, type: 'sawtooth', dur: 0.9, gain: 0.07, filter: 700 });
}

/** خطأ: اهتزاز منخفض. */
export function sfxError() {
  tone({ freq: 210, to: 90, type: 'sawtooth', dur: 0.34, gain: 0.22, filter: 900 });
  tone({ freq: 148, to: 70, type: 'square', dur: 0.3, gain: 0.12, delay: 0.05, filter: 700 });
}

/** فتح المزلاج. */
export function sfxUnlock() {
  noise({ dur: 0.22, gain: 0.3, band: 2600 });
  tone({ freq: 130, to: 62, type: 'square', dur: 0.22, gain: 0.2, filter: 500 });
  tone({ freq: 523, type: 'triangle', dur: 0.2, gain: 0.16, delay: 0.12 });
}

/** فوز باهت: نغمة صاعدة ثم قوس ذهبي. */
export function sfxWin() {
  const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
  notes.forEach((freq, index) => {
    tone({ freq, type: 'triangle', dur: 0.4, gain: 0.2, delay: index * 0.11 });
    tone({ freq: freq * 2, type: 'sine', dur: 0.28, gain: 0.08, delay: index * 0.11 + 0.02 });
  });
  tone({ freq: 261.63, type: 'sine', dur: 1.6, gain: 0.12, delay: 0.55, filter: 1200 });
  noise({ dur: 0.9, gain: 0.06, band: 5200, delay: 0.4 });
}

/** تنبيه لطيف (نجاح/شحن). */
export function sfxSuccess() {
  tone({ freq: 660, type: 'sine', dur: 0.14, gain: 0.16 });
  tone({ freq: 990, type: 'sine', dur: 0.18, gain: 0.14, delay: 0.1 });
}
