// Star field, text particles and sparks, ported from the approved prototype.
// Loop rules: stops while the page is hidden, drift/calm are capped at 30 fps, DPR <= 2,
// and in minimal motion nothing animates (one static draw per change).
const MODES = { welcome: [0.35, 1], orbit: [0.1, 1], drift: [0.05, 0.75], calm: [0.03, 0.6] };
const DARK = { colors: ['#DCE3FF', '#DCE3FF', '#DCE3FF', '#FFD59A', '#9FF3E3', '#FFC2D0'], ink: 1, shoot: '255,236,200', grad: ['#FFB547', '#FFD9A0', '#FF8FA8', '#5EEAD4'] };
const LIGHT = { colors: ['#1D2550', '#1D2550', '#2A3366', '#B86E00', '#0B8A77', '#C2416A'], ink: 0.5, shoot: '60,72,140', grad: ['#E08600', '#E06A3A', '#D2466E', '#0E9C86'] };
const FRAME_MS = 1000 / 30;

export function createSky(canvas, opts = {}) {
  const root = document.documentElement;
  const level = () => (root.dataset.motion === 'balanced' || root.dataset.motion === 'minimal' ? root.dataset.motion : 'full');
  const fast = () => level() === 'minimal';
  const ctx = canvas.getContext('2d');
  const fxCanvas = opts.fxCanvas || null;
  const fxx = fxCanvas ? fxCanvas.getContext('2d') : null;

  const s = {
    w: 0, h: 0, stars: [], parts: [], sparks: [], shoot: [], speed: 0.3, target: 0.3, alpha: 1, targetAlpha: 1,
    mx: 0, my: 0, smx: 0, smy: 0, mode: 'welcome', last: 0, lastDraw: 0, dirty: true, partT: 0, partFade: false,
    pal: root.dataset.ui === 'light' ? LIGHT : DARK, fxDirty: false, raf: 0, wt: 0, dead: false,
  };

  const newStar = (any) => ({
    x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: any ? 0.03 + Math.random() * 0.97 : 1,
    c: s.pal.colors[(Math.random() * s.pal.colors.length) | 0], f: 0.4 + Math.random() * 1.8, p: Math.random() * 6.3,
  });

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    s.w = innerWidth; s.h = innerHeight;
    for (const [cv, c] of [[canvas, ctx], [fxCanvas, fxx]]) {
      if (!cv) continue;
      cv.width = s.w * dpr; cv.height = s.h * dpr; c.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const n = Math.round(Math.min(700, Math.max(240, s.w * s.h / 2600)) * (level() === 'balanced' ? 0.7 : 1));
    s.stars = Array.from({ length: n }, () => newStar(true));
    s.dirty = true;
    if (!s.raf) paintStatic();
  }

  function drawStars(c, dt, t, moving) {
    const w = s.w, h = s.h, v = s.speed, sc = Math.max(w, h) * 0.5;
    c.clearRect(0, 0, w, h);
    const streak = moving && Math.abs(v) > 1.2;
    for (const st of s.stars) {
      if (moving) {
        st.z -= v * dt * 0.06;
        if (st.z < 0.02) Object.assign(st, newStar(false));
        else if (st.z > 1) { Object.assign(st, newStar(true)); st.z = 0.2 + Math.random() * 0.2; st.x *= st.z; st.y *= st.z; }
      }
      const par = (1 - st.z) * 50;
      const px = w / 2 + (st.x / st.z) * sc - s.smx * par, py = h / 2 + (st.y / st.z) * sc - s.smy * par;
      if (px < -20 || px > w + 20 || py < -20 || py > h + 20) { if (moving && v > 0) Object.assign(st, newStar(false)); continue; }
      const tw = moving ? 0.62 + 0.38 * Math.sin(t * 0.001 * st.f + st.p) : 0.85;
      c.globalAlpha = Math.min(1, (1 - st.z) * 1.35) * tw * s.alpha * s.pal.ink;
      const r = (1 - st.z) * 1.9 + 0.3;
      if (streak) {
        const z2 = Math.min(1.2, st.z + v * 0.01);
        const qx = w / 2 + (st.x / z2) * sc - s.smx * par, qy = h / 2 + (st.y / z2) * sc - s.smy * par;
        c.strokeStyle = st.c; c.lineWidth = r; c.beginPath(); c.moveTo(qx, qy); c.lineTo(px, py); c.stroke();
      } else { c.fillStyle = st.c; c.fillRect(px - r / 2, py - r / 2, r, r); }
    }
    c.globalAlpha = 1;
  }

  function drawFx(dt) {
    const f = fxx || ctx;
    if (!s.sparks.length && !s.fxDirty) return;
    if (fxx) f.clearRect(0, 0, s.w, s.h);
    s.fxDirty = s.sparks.length > 0;
    for (const p of s.sparks) {
      p.life += dt; p.vy += 420 * dt; p.vx *= 0.985; p.x += p.vx * dt; p.y += p.vy * dt;
      f.globalAlpha = Math.max(0, 1 - p.life / p.max); f.fillStyle = p.c; f.beginPath(); f.arc(p.x, p.y, p.r, 0, 6.29); f.fill();
    }
    f.globalAlpha = 1;
    s.sparks = s.sparks.filter((p) => p.life < p.max);
  }

  function paintStatic() {
    if (s.dead || !s.dirty || s.raf) return;
    s.alpha = s.targetAlpha; s.speed = 0;
    drawStars(ctx, 0, 0, false);
    s.dirty = false;
  }

  function frame(t) {
    s.raf = 0;
    if (s.dead || document.hidden || fast()) return;
    s.raf = requestAnimationFrame(frame);
    const capped = (s.mode === 'drift' || s.mode === 'calm') && s.target < 1 && s.parts.length === 0 && s.sparks.length === 0;
    if (capped && t - s.lastDraw < FRAME_MS - 1) return;
    const dt = Math.min(0.05, (t - s.last) / 1000 || 0);
    s.last = t; s.lastDraw = t;
    s.speed += (s.target - s.speed) * Math.min(1, dt * 3.2);
    s.alpha += (s.targetAlpha - s.alpha) * Math.min(1, dt * 2);
    s.smx += (s.mx - s.smx) * Math.min(1, dt * 2.5); s.smy += (s.my - s.smy) * Math.min(1, dt * 2.5);
    drawStars(ctx, dt, t, true);
    if (level() === 'full' && (s.mode === 'orbit' || s.mode === 'drift') && Math.random() < dt * 0.22) {
      s.shoot.push({ x: Math.random() * s.w * 0.8, y: Math.random() * s.h * 0.35, vx: 520 + Math.random() * 300, vy: 200 + Math.random() * 140, life: 0, max: 0.9 });
    }
    for (const sh of s.shoot) {
      sh.life += dt; sh.x += sh.vx * dt; sh.y += sh.vy * dt;
      const k = 1 - sh.life / sh.max, len = 0.14;
      const g = ctx.createLinearGradient(sh.x, sh.y, sh.x - sh.vx * len, sh.y - sh.vy * len);
      g.addColorStop(0, `rgba(${s.pal.shoot},${0.9 * k})`); g.addColorStop(1, `rgba(${s.pal.shoot},0)`);
      ctx.globalAlpha = 1; ctx.strokeStyle = g; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(sh.x - sh.vx * len, sh.y - sh.vy * len); ctx.stroke();
    }
    s.shoot = s.shoot.filter((sh) => sh.life < sh.max);
    if (s.parts.length) {
      s.partT += dt;
      if (!s.partFade && s.partT > 2.05) s.partFade = true;
      for (const p of s.parts) {
        if (p.tx != null) {
          const age = s.partT, k = age < 0.3 ? 0 : Math.min(1, (age - 0.3) / 1.1) ** 2 * 70;
          p.vx += (p.tx - p.x) * k * dt; p.vy += (p.ty - p.y) * k * dt;
          const damp = Math.exp(-(age < 0.3 ? 1.5 : 7) * dt); p.vx *= damp; p.vy *= damp;
        }
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (s.partFade) p.a -= dt * (p.tx == null ? 1.4 : 1.1);
        ctx.globalAlpha = Math.max(0, p.a); ctx.fillStyle = p.c; ctx.fillRect(p.x, p.y, p.s, p.s);
      }
      if (s.parts.every((p) => p.a <= 0)) s.parts = [];
    }
    ctx.globalAlpha = 1;
    drawFx(dt);
  }

  function start() {
    if (s.raf || s.dead || document.hidden || fast()) return;
    s.last = 0; s.lastDraw = 0;
    s.raf = requestAnimationFrame(frame);
  }
  function stop() { if (s.raf) cancelAnimationFrame(s.raf); s.raf = 0; }

  function sync() {
    // Called when motion level, theme or visibility changes.
    if (fast()) { stop(); s.dirty = true; paintStatic(); } else start();
  }

  function setTheme(light) {
    s.pal = light ? LIGHT : DARK;
    for (const st of s.stars) st.c = s.pal.colors[(Math.random() * s.pal.colors.length) | 0];
    s.dirty = true;
    if (!s.raf) paintStatic();
  }

  const onMove = (e) => { s.mx = e.clientX / s.w - 0.5; s.my = e.clientY / s.h - 0.5; };
  const onVis = () => { if (document.hidden) stop(); else sync(); };
  addEventListener('resize', resize);
  addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('visibilitychange', onVis);

  let lastMotion = level();
  let lastUi = root.dataset.ui;
  const mo = new MutationObserver(() => {
    if (root.dataset.ui !== lastUi) { lastUi = root.dataset.ui; setTheme(lastUi === 'light'); }
    const m = level();
    if (m !== lastMotion) {
      lastMotion = m;
      s.alpha = s.targetAlpha; // reset eases so a level switch is clean
      resize();
    }
    sync();
  });
  mo.observe(root, { attributes: true, attributeFilter: ['data-ui', 'data-motion'] });

  const api = {
    get running() { return s.raf !== 0; },
    setMode(m) {
      if (!MODES[m]) return;
      s.mode = m; [s.target, s.targetAlpha] = MODES[m];
      if (fast()) s.alpha = s.targetAlpha;
      s.dirty = true;
      sync();
      if (fast()) paintStatic();
    },
    warp(ms) {
      if (fast()) return;
      s.target = 18; clearTimeout(s.wt); s.wt = setTimeout(() => { s.target = MODES[s.mode][0]; }, ms); start();
    },
    reverse(ms) {
      if (fast()) return;
      s.target = -8; clearTimeout(s.wt); s.wt = setTimeout(() => { s.target = MODES[s.mode][0]; }, ms); start();
    },
    buildText(el) {
      if (fast()) return;
      const words = [...el.querySelectorAll('span')];
      if (!words.length) return;
      const cs = getComputedStyle(el);
      const off = document.createElement('canvas'); off.width = s.w; off.height = s.h;
      const o = off.getContext('2d');
      o.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; o.textAlign = 'center'; o.textBaseline = 'middle'; o.fillStyle = '#fff';
      for (const w of words) {
        const r = w.getBoundingClientRect();
        o.fillText(w.textContent, r.left + r.width / 2, r.top + r.height / 2 + parseFloat(cs.fontSize) * 0.04);
      }
      const fs = parseFloat(cs.fontSize), step = Math.max(2, Math.round(fs / 24));
      const data = o.getImageData(0, 0, s.w, s.h).data, pts = [];
      for (let y = 0; y < s.h; y += step) for (let x = 0; x < s.w; x += step) if (data[(y * s.w + x) * 4 + 3] > 140) pts.push([x, y]);
      const max = level() === 'balanced' ? 900 : 2200;
      if (pts.length > max) {
        for (let i = 0; i < max; i++) { const j = i + ((Math.random() * (pts.length - i)) | 0); [pts[i], pts[j]] = [pts[j], pts[i]]; }
        pts.length = max;
      }
      if (!pts.length) return;
      let minX = Infinity, maxX = -Infinity;
      for (const p of pts) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; }
      const cx = s.w / 2, cy = s.h / 2, grad = s.pal.grad;
      s.parts = pts.map(([tx, ty]) => {
        const a = Math.random() * Math.PI * 2, sp = 200 + Math.random() * 900;
        const k = (tx - minX) / Math.max(1, maxX - minX);
        return { x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, tx, ty, c: grad[Math.min(3, (k * 3.6) | 0)], a: 1, s: Math.random() < 0.15 ? 2.2 : 1.5 };
      });
      s.partT = 0; s.partFade = false;
      start();
    },
    scatter() {
      const cx = s.w / 2, cy = s.h / 2;
      for (const p of s.parts) { p.vx = (p.x - cx) * (3 + Math.random() * 3); p.vy = (p.y - cy) * (3 + Math.random() * 3); p.tx = null; }
      s.partFade = true;
    },
    burst(x, y, n = 22, colors = ['#FFB547', '#FFD9A0', '#FF8FA8', '#5EEAD4']) {
      if (fast()) return;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = 80 + Math.random() * 260;
        s.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, life: 0, max: 0.5 + Math.random() * 0.5, c: colors[i % colors.length], r: 1 + Math.random() * 2.2 });
      }
      start();
    },
    burstAt(el, n, colors) { const r = el.getBoundingClientRect(); api.burst(r.left + r.width / 2, r.top + r.height / 2, n, colors); },
    destroy() {
      s.dead = true; stop(); clearTimeout(s.wt); mo.disconnect();
      removeEventListener('resize', resize); removeEventListener('pointermove', onMove);
      document.removeEventListener('visibilitychange', onVis);
    },
  };

  [s.target, s.targetAlpha] = MODES[MODES[opts.mode] ? opts.mode : 'welcome'];
  s.mode = MODES[opts.mode] ? opts.mode : 'welcome';
  if (fast()) s.alpha = s.targetAlpha;
  resize();
  sync();
  return api;
}
