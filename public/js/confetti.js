/**
 * تأثير Confetti بدون مكتبات خارجية: أمطر شريطي ذهبي/نيون على كامل الشاشة.
 */

const COLORS = ['#f6c65b', '#ffe3a0', '#3ef0cf', '#4cc3ff', '#ffffff', '#ff8a4c', '#d4af37'];

let context = null;
let frame = null;
let pieces = [];
let running = false;

function resize(canvas) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * ratio);
  canvas.height = Math.floor(window.innerHeight * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function makePiece(width, height, fromTop) {
  const ribbon = Math.random() > 0.45;
  return {
    x: Math.random() * width,
    y: fromTop ? -20 - Math.random() * height * 0.4 : height * (0.5 + Math.random() * 0.2),
    vx: (Math.random() - 0.5) * 4.6,
    vy: fromTop ? 2 + Math.random() * 3.2 : -(7 + Math.random() * 7),
    w: ribbon ? 3 + Math.random() * 4 : 7 + Math.random() * 7,
    h: ribbon ? 12 + Math.random() * 16 : 7 + Math.random() * 8,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.32,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    phase: Math.random() * Math.PI * 2,
    sway: 0.6 + Math.random() * 1.6,
    life: 1,
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{count?:number, durationMs?:number}} options
 */
export function fireConfetti(canvas, options = {}) {
  const count = options.count ?? 240;
  const durationMs = options.durationMs ?? 6500;
  if (!canvas || !canvas.getContext) return;
  context = canvas.getContext('2d');
  resize(canvas);
  if (!window.__khaznaConfettiResize) {
    window.__khaznaConfettiResize = () => {
      if (running) resize(canvas);
    };
    window.addEventListener('resize', window.__khaznaConfettiResize);
  }

  const width = window.innerWidth;
  const height = window.innerHeight;
  pieces = [];
  for (let i = 0; i < count; i += 1) pieces.push(makePiece(width, height, i % 4 !== 0));

  if (!running) {
    running = true;
    const started = performance.now();

    const step = (now) => {
      const elapsed = now - started;
      context.clearRect(0, 0, width, height);
      const fading = elapsed > durationMs * 0.7;

      for (const piece of pieces) {
        piece.vy += 0.14;
        piece.vx *= 0.995;
        piece.phase += 0.06;
        piece.x += piece.vx + Math.sin(piece.phase) * piece.sway;
        piece.y += piece.vy;
        piece.rot += piece.vr;
        if (fading) piece.life -= 0.012;
        if (piece.y > height + 40 || piece.life <= 0) {
          Object.assign(piece, makePiece(width, height, true));
          if (fading) piece.life = 0;
        }

        context.save();
        context.globalAlpha = Math.max(0, Math.min(1, piece.life));
        context.translate(piece.x, piece.y);
        context.rotate(piece.rot);
        context.fillStyle = piece.color;
        context.shadowColor = piece.color;
        context.shadowBlur = 8;
        context.fillRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
        context.restore();
      }

      if (elapsed < durationMs) {
        frame = requestAnimationFrame(step);
      } else {
        context.clearRect(0, 0, width, height);
        running = false;
        pieces = [];
      }
    };

    frame = requestAnimationFrame(step);
  }
}

export function stopConfetti(canvas) {
  if (frame) cancelAnimationFrame(frame);
  frame = null;
  running = false;
  pieces = [];
  if (context && canvas) context.clearRect(0, 0, window.innerWidth, window.innerHeight);
}
