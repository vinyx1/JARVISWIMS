// The Jarvis core: layered hologram rings around a particle core, drawn on a canvas.
// Film-HUD language: hairline tick rings, segmented and partial arcs at different depths and
// speeds, a coil of wedges, a hot core, drifting particles, a radar sweep.
//
//   const core = createReactor(canvas);
//   core.state = 'idle' | 'armed' | 'listening' | 'thinking' | 'speaking';
//   core.level = 0..1;      // voice/mic loudness: the core breathes with it
//   core.boot = 0..1;       // intro: rings draw themselves in as this rises
//   core.interactive = true // a toy: hover draws a constellation, click drops linked nodes,
//                           // drag spins the rings, double-click overcharges the core

const TAU = Math.PI * 2;
const PRESETS = {
  //          spin  glow  open   inflow sweep amber
  idle:      [0.22, 0.55,  0.00, 0.00,  0,    0.00],
  armed:     [0.10, 1.00,  0.07, 0.55,  0,    1.00],
  listening: [0.10, 0.95,  0.07, 0.55,  0,    1.00],
  thinking:  [1.45, 0.85, -0.04, 1.00,  1,    0.12],
  speaking:  [0.45, 0.90,  0.02, 0.15,  0,    0.30],
};

export function presetFor(state) { return PRESETS[state] || PRESETS.idle; }

export function createReactor(canvas, {reducedMotion = false} = {}) {
  const ctx = canvas.getContext('2d');
  let [spin, glow, open, inflow, sweep, amber] = PRESETS.idle;
  let target = PRESETS.idle, state = 'idle', level = 0, pulse = 0, boot = 1;
  let rot = 0, last = performance.now(), raf = 0, w = 0, h = 0, dpr = 1, showReadouts = true;
  // ---- toy mode ----
  let interactive = false, pointer = null, dragging = false, dragAngle = 0, dragMoved = 0, spinVel = 0, flare = 0;
  const nodes = [], ripples = [], NODE_LIFE = 25, MAX_NODES = 28;
  const local = e => { const r = canvas.getBoundingClientRect(); return {x: e.clientX - r.left - w / 2, y: e.clientY - r.top - h / 2}; };
  const radius = () => Math.min(w, h) * 0.42;
  const onMove = e => {
    if (!interactive) return;
    pointer = local(e);
    if (dragging) {
      const a = Math.atan2(pointer.y, pointer.x); let d = a - dragAngle;
      if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU;
      rot += d * 1.4; spinVel = spinVel * 0.6 + d * 1.4 * 0.4 * 60; dragAngle = a; dragMoved += Math.abs(d);
    }
  };
  const onDown = e => {
    if (!interactive) return;
    pointer = local(e); dragging = true; dragMoved = 0; dragAngle = Math.atan2(pointer.y, pointer.x); spinVel = 0;
    canvas.setPointerCapture?.(e.pointerId); canvas.style.cursor = 'grabbing';
  };
  const onUp = e => {
    if (!interactive || !dragging) return;
    dragging = false; canvas.style.cursor = 'crosshair';
    if (dragMoved < 0.05) {   // a click, not a drag: drop a node with a ripple
      const R = radius(), p = local(e);
      nodes.push({x: p.x / R, y: p.y / R, born: performance.now() / 1000, seed: Math.random() * TAU});
      if (nodes.length > MAX_NODES) nodes.shift();
      ripples.push({x: p.x / R, y: p.y / R, born: performance.now() / 1000, big: false});
    }
  };
  const onDouble = e => {
    if (!interactive) return;
    flare = 1; nodes.splice(-2);   // the two clicks of a double-click shouldn't leave nodes
    ripples.push({x: 0, y: 0, born: performance.now() / 1000, big: true});
    for (const p of parts) p.r = Math.min(1.45, p.r + 0.35 + Math.random() * 0.35);   // blast outward
  };
  const onLeave = () => { pointer = null; };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('dblclick', onDouble);
  const motion = reducedMotion ? 0.25 : 1;
  const parts = Array.from({length: 240}, () => newParticle(true));
  // No readouts around the core: the old CORE / SYNC / VOX / NODE numbers were made up.
  // Real figures (photos, items, camera) live in the HUD's stats strip.
  const readouts = [];

  function newParticle(anywhere) {
    return {a: Math.random() * TAU, r: anywhere ? 0.18 + Math.random() * 1.2 : 1.05 + Math.random() * 0.3,
            s: (0.25 + Math.random() * 0.9) * (Math.random() < 0.5 ? -1 : 1), z: Math.random(), f: Math.random() * TAU};
  }
  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1); w = r.width; h = r.height;
    canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro?.observe(canvas); resize();

  // amber/cyan mix for accents
  const accent = (a, k = amber) => `rgba(${Math.round(95 + 160 * k)},${Math.round(227 - 51 * k)},${Math.round(255 - 191 * k)},${a})`;
  const cyan = a => `rgba(95,227,255,${a})`;
  const reveal = (from, span) => Math.max(0, Math.min(1, (boot - from) / span));   // 0..1 per layer during boot

  function arc(r, a0, a1, width, color, dash) {
    ctx.beginPath(); ctx.arc(0, 0, r, a0, a1);
    ctx.lineWidth = width; ctx.strokeStyle = color; ctx.setLineDash(dash || []); ctx.stroke();
  }

  function draw(t, dt) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const R = Math.min(w, h) * 0.42;
    if (R <= 4) return;
    ctx.translate(w / 2, h / 2);
    ctx.globalCompositeOperation = 'lighter';
    const g = Math.min(1.4, glow * (0.85 + 0.15 * Math.sin(t * 1.3)) + flare * 0.6);

    // 1. outer tick ring
    const k1 = reveal(0, 0.35);
    if (k1) {
      ctx.save(); ctx.rotate(rot * 0.12);
      const n = 180, shown = Math.floor(n * k1);
      ctx.beginPath();
      for (let i = 0; i < shown; i++) {
        const a = i / n * TAU, len = i % 30 === 0 ? 16 : i % 5 === 0 ? 9 : 4;
        ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R); ctx.lineTo(Math.cos(a) * (R - len), Math.sin(a) * (R - len));
      }
      ctx.lineWidth = 1; ctx.strokeStyle = cyan(0.38 * g); ctx.setLineDash([]); ctx.stroke();
      ctx.restore();
      arc(R * 0.935, 0, TAU * k1, 1, cyan(0.22 * g));
    }
    // 2. framing brackets, left and right
    const k2 = reveal(0.15, 0.3);
    if (k2) for (const c of [0, Math.PI]) {
      arc(R * 1.06, c - 0.32 * k2, c + 0.32 * k2, 3, accent(0.55 * g, amber * 0.6));
      arc(R * 1.1, c - 0.12 * k2, c + 0.12 * k2, 1, cyan(0.5 * g));
    }
    // 3. segmented ring
    const k3 = reveal(0.25, 0.35);
    if (k3) {
      ctx.save(); ctx.rotate(-rot * 0.38);
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * TAU;
        arc(R * (0.85 + open * 0.4), a, a + (TAU / 12 - 0.1) * k3, 6, cyan((i % 3 === 0 ? 0.55 : 0.28) * g));
      }
      ctx.restore();
    }
    // 4. accent arcs (the ones that lock amber when he's listening)
    const k4 = reveal(0.4, 0.35);
    if (k4) {
      ctx.save(); ctx.rotate(rot * 1.05);
      const r4 = R * (0.75 + open);
      for (const [a0, span, wid] of [[0, 1.25, 9], [2.15, 0.55, 3], [3.95, 1.55, 5]]) {
        arc(r4, a0, a0 + span * k4, wid, accent(0.75 * g));
        arc(r4 + 9, a0 + 0.05, a0 + span * 0.6 * k4, 1, accent(0.45 * g));
      }
      ctx.restore();
    }
    // 5. dashed ring
    const k5 = reveal(0.5, 0.3);
    if (k5) { ctx.save(); ctx.rotate(-rot * 0.8); arc(R * (0.65 + open * 0.6), 0, TAU * k5, 1.2, cyan(0.45 * g), [2, 7]); ctx.restore(); }
    // 6. radar sweep while thinking
    if (sweep > 0.02) {
      const a = rot * 2.6;
      for (let i = 0; i < 18; i++) {
        const tail = i / 18;
        arc(R * 0.68, a - tail * 0.9, a - (tail - 1 / 18) * 0.9, R * 0.3, cyan(0.05 * sweep * (1 - tail)));
      }
      ctx.save(); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(R * 0.5, 0); ctx.lineTo(R * 0.86, 0); ctx.lineWidth = 1.5; ctx.strokeStyle = cyan(0.7 * sweep); ctx.setLineDash([]); ctx.stroke();
      ctx.restore();
    }
    // 7. coil of wedges around the core
    const k7 = reveal(0.6, 0.3);
    if (k7) {
      ctx.save(); ctx.rotate(rot * 0.3);
      const n = 10, r0 = R * 0.36, r1 = R * 0.46;
      for (let i = 0; i < Math.ceil(n * k7); i++) {
        const a = i / n * TAU, s = 0.19;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a - s) * r0, Math.sin(a - s) * r0); ctx.lineTo(Math.cos(a - s * 0.75) * r1, Math.sin(a - s * 0.75) * r1);
        ctx.lineTo(Math.cos(a + s * 0.75) * r1, Math.sin(a + s * 0.75) * r1); ctx.lineTo(Math.cos(a + s) * r0, Math.sin(a + s) * r0);
        ctx.closePath(); ctx.fillStyle = cyan(0.12 * g + 0.1 * pulse); ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = cyan(0.5 * g); ctx.setLineDash([]); ctx.stroke();
      }
      arc(R * 0.5, 0, TAU * k7, 1.5, cyan(0.5 * g));
      arc(R * 0.33, 0, TAU * k7, 1, cyan(0.35 * g));
      ctx.restore();
    }
    // 8. particles: orbit, and drift into the core when he's listening or thinking
    const k8 = reveal(0.2, 0.6);
    if (k8) {
      const reach = R * 0.3, near = [];
      for (const p of parts) {
        p.a += dt * p.s * (0.12 + spin * 0.55) * motion;
        p.r -= dt * (0.04 + 0.32 * inflow) * p.r * motion;
        if (p.r < 0.14) Object.assign(p, newParticle(false));
        let x = Math.cos(p.a) * R * p.r, y = Math.sin(p.a) * R * p.r * 0.985;
        let excite = 0;
        if (pointer && !dragging) {   // drift toward the cursor, and light up near it
          const dx = pointer.x - x, dy = pointer.y - y, d = Math.hypot(dx, dy);
          if (d < reach) {
            excite = 1 - d / reach;
            const pr = Math.hypot(pointer.x, pointer.y) / R, pa = Math.atan2(pointer.y, pointer.x);
            let da = pa - p.a; if (da > Math.PI) da -= TAU; if (da < -Math.PI) da += TAU;
            p.a += da * dt * 1.2 * excite; p.r += (pr - p.r) * dt * 1.2 * excite;
            near.push([x, y, excite]);
          }
        }
        const tw = 0.45 + 0.55 * Math.sin(t * (2 + p.z * 3) + p.f);
        ctx.fillStyle = (p.z > 0.86 || excite > 0.5 ? accent : cyan)(Math.min(1, k8 * tw * (0.25 + 0.55 * p.z) * g + excite * 0.8));
        const size = 0.8 + p.z * 1.6 + excite * 1.6;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
        p.x = x; p.y = y;
      }
      // a small targeting ring follows the cursor
      if (pointer && interactive) {
        ctx.setLineDash([]); ctx.lineWidth = 1; ctx.strokeStyle = accent(dragging ? 0.8 : 0.55, 0.7);
        ctx.beginPath(); ctx.arc(pointer.x, pointer.y, dragging ? 14 : 10, t * 2, t * 2 + TAU * 0.75); ctx.stroke();
      }
      // constellation: cursor to nearby particles, and those particles to each other
      if (pointer && !dragging && near.length) {
        ctx.lineWidth = 0.8; ctx.setLineDash([]);
        for (let i = 0; i < near.length; i++) {
          const [x, y, e] = near[i];
          ctx.strokeStyle = cyan(0.7 * e); ctx.beginPath(); ctx.moveTo(pointer.x, pointer.y); ctx.lineTo(x, y); ctx.stroke();
          for (let j = i + 1; j < near.length; j++) {
            const [x2, y2, e2] = near[j];
            if (Math.hypot(x - x2, y - y2) < reach * 0.4) { ctx.strokeStyle = cyan(0.42 * Math.min(e, e2)); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke(); }
          }
        }
      }
    }
    // 9. the core
    const k9 = reveal(0.55, 0.45);
    if (k9) {
      const rc = R * (0.2 + 0.05 * pulse + 0.07 * level + 0.12 * flare) * k9;
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rc * 1.9);
      grad.addColorStop(0, `rgba(255,255,255,${0.95 * g})`);
      grad.addColorStop(0.18, accent(0.85 * g, Math.max(amber * 0.5, flare)));
      grad.addColorStop(0.5, cyan(0.22 * g));
      grad.addColorStop(1, cyan(0));
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0, 0, rc * 1.9, 0, TAU); ctx.fill();
      arc(rc * 0.62, 0, TAU, 1, `rgba(255,255,255,${0.55 * g})`);
    }
    // 9b. toy mode: dropped nodes (linked to each other and to nearby particles) and ripples
    const now = performance.now() / 1000;
    for (let i = nodes.length - 1; i >= 0; i--) if (now - nodes[i].born > NODE_LIFE) nodes.splice(i, 1);
    if (nodes.length) {
      const life = n => Math.min(1, (NODE_LIFE - (now - n.born)) / 4) * Math.min(1, (now - n.born) * 4);
      ctx.setLineDash([]);
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i], ax = a.x * R + Math.cos(t * 0.7 + a.seed) * 3, ay = a.y * R + Math.sin(t * 0.9 + a.seed) * 3, la = life(a);
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j], bx = b.x * R, by = b.y * R, d = Math.hypot(ax - bx, ay - by);
          if (d < R * 0.75) { ctx.lineWidth = 1.2; ctx.strokeStyle = accent(0.85 * (1 - d / (R * 0.75)) * Math.min(la, life(b)), 0.7); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); }
        }
        for (const p of parts) {
          if (p.x === undefined) continue;
          const d = Math.hypot(ax - p.x, ay - p.y);
          if (d < R * 0.16) { ctx.lineWidth = 0.8; ctx.strokeStyle = cyan(0.55 * (1 - d / (R * 0.16)) * la); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(p.x, p.y); ctx.stroke(); }
        }
        const pulseN = 0.6 + 0.4 * Math.sin(t * 3 + a.seed);
        ctx.fillStyle = accent(0.25 * la * pulseN, 0.7); ctx.beginPath(); ctx.arc(ax, ay, 9, 0, TAU); ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${0.9 * la})`; ctx.beginPath(); ctx.arc(ax, ay, 2.6, 0, TAU); ctx.fill();
      }
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i], age = now - r.born, span = r.big ? 1.2 : 0.8;
      if (age > span) { ripples.splice(i, 1); continue; }
      const k = age / span, rr = (r.big ? R * 1.25 : R * 0.22) * (0.15 + 0.85 * k);
      ctx.beginPath(); ctx.arc(r.x * R, r.y * R, rr, 0, TAU);
      ctx.lineWidth = r.big ? 3 * (1 - k) + 1 : 1.5; ctx.strokeStyle = (r.big ? accent : cyan)(0.8 * (1 - k)); ctx.setLineDash([]); ctx.stroke();
    }

    // 10. readouts with leader lines
    const k10 = showReadouts ? reveal(0.8, 0.2) : 0;   // hidden behind the intro title
    if (k10) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.font = `${Math.max(8, R * 0.028)}px Michroma, Eurostile, sans-serif`;
      for (const r of readouts) {
        // leader lines stay inside the canvas (its edge is ~1.19 R from the centre)
        const x0 = Math.cos(r.angle) * R * 0.97, y0 = Math.sin(r.angle) * R * 0.97;
        const right = Math.cos(r.angle) >= 0, x1 = x0 + (right ? 1 : -1) * R * 0.08, y1 = y0 + Math.sign(y0 || 1) * R * 0.07;
        const x2 = x1 + (right ? 1 : -1) * R * 0.1;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x2, y1);
        ctx.lineWidth = 1; ctx.strokeStyle = cyan(0.35 * k10); ctx.setLineDash([]); ctx.stroke();
        ctx.fillStyle = cyan(0.75 * k10); ctx.textAlign = right ? 'right' : 'left';
        ctx.fillText(`${r.label} ${r.value()}`, x2, y1 - 5);
      }
    }
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const k = 1 - Math.exp(-dt * 3.2);
    [spin, glow, open, inflow, sweep, amber] = [spin, glow, open, inflow, sweep, amber].map((v, i) => v + (target[i] - v) * k);
    pulse += ((state === 'speaking' ? level : level * 0.5) - pulse) * (1 - Math.exp(-dt * 12));
    rot += dt * spin * motion;
    if (!dragging && Math.abs(spinVel) > 0.001) { rot += spinVel * dt; spinVel *= Math.exp(-dt * 1.6); }   // flung rings coast down
    flare = Math.max(0, flare - dt * 0.7);
    draw(now / 1000, dt);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    get state() { return state; },
    set state(s) { state = s; target = presetFor(s); },
    set level(v) { level = Math.max(0, Math.min(1, v || 0)); },
    set boot(v) { boot = Math.max(0, Math.min(1, v)); },
    set readouts(v) { showReadouts = !!v; },
    set interactive(v) { interactive = !!v; canvas.style.cursor = v ? 'crosshair' : ''; canvas.style.touchAction = v ? 'none' : ''; if (!v) { pointer = null; dragging = false; } },
    destroy() {
      cancelAnimationFrame(raf); ro?.disconnect();
      for (const [ev, fn] of [['pointermove', onMove], ['pointerdown', onDown], ['pointerup', onUp], ['pointercancel', onUp], ['pointerleave', onLeave], ['dblclick', onDouble]]) canvas.removeEventListener(ev, fn);
    },
  };
}
