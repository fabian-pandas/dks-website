/* dks-terminal.js — DKS_KI Mutator terminal (POC iteration target)
 *
 * Bündelt das Verhalten der Chat-Box im KI-ERLEBEN-CTA:
 *   - open / close morph
 *   - typewriter + Pretext-driven reveal
 *   - boot sequence
 *   - idea catcher (`/ideen`)
 *   - connect-the-concepts graph builder (`/graph`)
 *   - default chat fallback (window.claude.complete)
 *
 * Abhängigkeiten:
 *   - HTML-Struktur in index-pretext.html (#ctaChat, .chat-pane, #chatLog,
 *     #chatForm, #chatField, .chat-close, .chat-send)
 *   - CSS bleibt vorerst in index-pretext.html (idea-arena, graph-overlay,
 *     reveal-char, etc.)
 *
 * Iteration: nur diese Datei editieren — kein HTML/CSS-Refactor erforderlich.
 */

(async function initDksTerminal() {
  // ------------------------------------------------------------------
  // Pretext loader (optional; falls back to typewriter if unavailable)
  // ------------------------------------------------------------------
  try {
    const pretext = await import('https://esm.sh/@chenglou/pretext@0.0.6');
    window.__pretext = { prepare: pretext.prepare, layout: pretext.layout };
    window.dispatchEvent(new Event('pretext-ready'));
  } catch (e) {
    console.warn('[pretext] load failed, falling back to typewriter:', e);
  }

  // ------------------------------------------------------------------
  // Wait for DOM
  // ------------------------------------------------------------------
  if (document.readyState === 'loading') {
    await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
  }

  // ------------------------------------------------------------------
  // CTA → Chat morph + chat behavior
  // (was: section 5 of the dynamics IIFE in index-pretext.html)
  // ------------------------------------------------------------------
  const cta = document.getElementById('ctaChat');
  if (!cta) return;

  // Measure the natural pill size ONCE on load. Animating width:auto doesn't work,
  // so we freeze the closed dimensions as CSS vars. Don't re-measure on resize —
  // a reflow during the close transition can capture a mid-animation width and
  // poison the next open. The pill width is stable enough to ignore resizes.
  requestAnimationFrame(() => {
    const r = cta.getBoundingClientRect();
    cta.style.setProperty('--closed-w', r.width + 'px');
    cta.style.setProperty('--closed-h', r.height + 'px');
  });
  const log = cta.querySelector('#chatLog');
  const form = cta.querySelector('#chatForm');
  const field = cta.querySelector('#chatField');
  const closeBtn = cta.querySelector('.chat-close');
  const sendBtn = cta.querySelector('.chat-send');
  let busy = false;
  let history = [];

  const SYSTEM = "Du bist DKS Causal-AI, die Kausalitäts-Konsole von DKS Analytics GmbH (Stuttgart) — ein KI-First-Beratungshaus für den kompletten KI-Lebenszyklus. Deine Aufgabe: Probleme und Vorgehensweisen als kausale Abfolgen sichtbar machen. Antworte auf Deutsch (außer der Nutzer schreibt Englisch), prägnant (max. 3 kurze Absätze), konkret und beratend. Wenn der Nutzer ein Problem oder Vorgehen beschreibt: zerlege es in 4–6 Schritte mit klarer Ursache-Wirkung-Beziehung. Schließe optional mit einer Rückfrage. Kein Marketing-Sprech.";

  // Smooth-scroll easing helper (used so the page slides down to make room
  // for the expanded chat BEFORE the box morph starts).
  function smoothScrollTo(targetY, duration) {
    const startY = window.scrollY;
    const dist = targetY - startY;
    if (Math.abs(dist) < 2) return Promise.resolve();
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic
    return new Promise((resolve) => {
      function step(now) {
        const t = Math.min(1, (now - start) / duration);
        window.scrollTo(0, startY + dist * ease(t));
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }

  async function open() {
    if (cta.classList.contains('is-open')) return;
    cta.setAttribute('aria-expanded', 'true');

    // Make sure the expanded box (440 wide × 460 tall, anchored at the pill's
    // current top-left) will be fully visible. If not, scroll smoothly first.
    const OPEN_H = 460;
    const MARGIN = 24;
    const r = cta.getBoundingClientRect();
    const bottomNeeded = r.top + OPEN_H + MARGIN; // viewport-y the bottom edge will reach
    const overflow = bottomNeeded - window.innerHeight;
    if (overflow > 0) {
      const target = Math.min(
        window.scrollY + overflow,
        document.documentElement.scrollHeight - window.innerHeight
      );
      await smoothScrollTo(target, 550);
    }

    cta.classList.add('is-open');
    // kill any leftover magnetic transform
    cta.style.transform = '';
    setTimeout(() => field && field.focus(), 1100);
    if (!booted) { booted = true; bootSequence(); }
  }
  function close() {
    cta.classList.remove('is-open');
    cta.setAttribute('aria-expanded', 'false');
  }
  cta.addEventListener('click', (ev) => {
    if (cta.classList.contains('is-open')) return; // clicks inside are handled by their own handlers
    ev.preventDefault();
    open(); // async — fire and forget
  });
  cta.addEventListener('keydown', (ev) => {
    if (cta.classList.contains('is-open')) return;
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
  });
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    close();
  });
  // stop propagation inside the chat pane so clicks don't re-trigger the button
  cta.querySelector('.chat-pane').addEventListener('click', (ev) => ev.stopPropagation());
  // ESC closes
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && cta.classList.contains('is-open')) close();
  });

  function appendMsg(role, text) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg ' + (role === 'user' ? 'from-user' : 'from-bot');
    const bub = document.createElement('div');
    bub.className = 'chat-bubble';
    bub.textContent = text;
    wrap.appendChild(bub);
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    return bub;
  }

  // Char-by-char typewriter with brief lock-in flicker (matches the CTA glitch)
  const TERM_NOISE = '!@#$%&*+=<>?/\\|░▒▓01';
  const tnoise = () => TERM_NOISE[Math.floor(Math.random() * TERM_NOISE.length)];
  const twait = ms => new Promise(r => setTimeout(r, ms));
  async function typewriteInto(bub, text, speed = 14) {
    bub.textContent = '';
    for (let i = 1; i <= text.length; i++) {
      const ch = text[i - 1];
      if (ch !== ' ' && ch !== '\n' && Math.random() < 0.55) {
        bub.textContent = text.slice(0, i - 1) + tnoise();
        await twait(8);
      }
      bub.textContent = text.slice(0, i);
      log.scrollTop = log.scrollHeight;
      await twait(speed + Math.random() * 10);
    }
  }

  // Pretext-driven NOISE-FIRST reveal — terminal "incoming transmission" feel.
  //
  //   Phase 0: Pretext measures the full layout → bubble height locked.
  //            All chars rendered for correct line-wrapping but invisible.
  //   Phase 1: TYPEWRITER but for noise — chars appear left→right as random
  //            TERM_NOISE glyphs (red). A background rotation loop keeps
  //            ALL already-typed noise chars cycling through new noise
  //            glyphs continuously, so the whole bubble looks like a
  //            scrambled transmission while the rest is still being typed.
  //   Phase 2: After a brief hold, the rotation freezes and chars decode
  //            left→right to their real value (normal color).
  //
  // Falls back to typewriter if Pretext didn't load.
  async function revealInto(bub, text, opts = {}) {
    if (!window.__pretext) return typewriteInto(bub, text, opts.speed || 12);
    const {
      typeSpeed        = 16,   // ms between adding new noise char (Phase 1)
      noiseRotateSpeed = 65,   // ms between full rotation passes of active noise
      holdAfterType    = 280,  // ms after typewriter finishes before decode starts
      decodeStagger    = 11,   // ms between chars settling to real value (Phase 2)
    } = opts;

    bub.classList.remove('thinking');
    bub.textContent = '';

    // Phase 0 — Pretext height lock + char span scaffold.
    try {
      const cs = getComputedStyle(bub);
      const fontSize = parseFloat(cs.fontSize) || 16;
      const lh = cs.lineHeight === 'normal' ? fontSize * 1.4 : (parseFloat(cs.lineHeight) || fontSize * 1.4);
      const fontSpec = `${cs.fontStyle} ${cs.fontWeight} ${fontSize}px ${cs.fontFamily}`;
      const maxWidth = bub.clientWidth || bub.parentElement.clientWidth || 600;
      const handle = window.__pretext.prepare(text, fontSpec);
      const { height } = window.__pretext.layout(handle, maxWidth, lh);
      bub.style.minHeight = height + 'px';
    } catch (e) { /* graceful */ }

    const segmenter = (typeof Intl !== 'undefined' && Intl.Segmenter)
      ? new Intl.Segmenter('de', { granularity: 'grapheme' })
      : null;
    const chars = segmenter ? Array.from(segmenter.segment(text), s => s.segment) : Array.from(text);

    const frag = document.createDocumentFragment();
    const spans = [];
    for (const ch of chars) {
      const span = document.createElement('span');
      span.className = 'reveal-char';
      if (ch === '\n') {
        span.textContent = '\n';
        span.style.display = 'block';
        span.style.height = '0';
        span.style.width = '100%';
        span.dataset.kind = 'br';
      } else {
        span.dataset.real = ch;       // remember truth
        span.textContent = ch;          // place real char for layout reservation
        span.style.opacity = '0';       // invisible until typewriter activates it
      }
      frag.appendChild(span);
      spans.push(span);
    }
    bub.appendChild(frag);
    log.scrollTop = log.scrollHeight;
    await new Promise(r => requestAnimationFrame(r));

    // The set of spans currently showing rotating noise (= been typed, not yet decoded).
    const activeNoise = new Set();
    let stopRotation = false;

    // Background rotation loop. Cycles every active span through fresh noise glyphs.
    (async function rotate() {
      while (!stopRotation) {
        for (const span of activeNoise) {
          if (span.dataset.real !== ' ') {
            span.textContent = tnoise();
          }
        }
        await twait(noiseRotateSpeed);
      }
    })();

    // Phase 1 — typewriter the noise. Each new char joins the rotation pool.
    for (const span of spans) {
      if (span.dataset.kind === 'br') continue;
      span.style.opacity = '1';
      const real = span.dataset.real;
      if (real === ' ') {
        // spaces stay as spaces — just visible
      } else {
        span.textContent = tnoise();
        span.style.color = '#ff6e6e';
        activeNoise.add(span);
      }
      log.scrollTop = log.scrollHeight;
      await twait(typeSpeed);
    }

    await twait(holdAfterType);

    // Phase 2 — decode left → right. Each settled span leaves the rotation pool.
    for (const span of spans) {
      if (span.dataset.kind === 'br') continue;
      if (span.dataset.real === ' ') continue;
      activeNoise.delete(span);
      span.textContent = span.dataset.real;
      span.style.color = '';
      await twait(decodeStagger);
    }

    stopRotation = true;
    bub.style.minHeight = '';
    log.scrollTop = log.scrollHeight;
  }


  // ===== Connect-the-Concepts mode (/graph command) =====
  // Directed graphs: each edge is [from, to] and direction matters.
  // Each topic ships its own semantic verb ("folgt aus", "speist", …)
  // shown in the HUD so the user knows what kind of relationship they are
  // drawing. Skill tested: logical sequence + causality, not just association.
  const GRAPH_PROMPTS = {
    ki_projekt: {
      label: 'KI-Projekt-Lebenszyklus',
      edgeVerb: 'folgt aus',
      hint:  'tap erst die Ursache, dann den nächsten Schritt — die Reihenfolge zählt.',
      items: ['Use-Case', 'Datensammlung', 'Modelltraining', 'Deployment', 'Monitoring', 'Retraining'],
      edges: [
        ['Use-Case',      'Datensammlung'],
        ['Datensammlung', 'Modelltraining'],
        ['Modelltraining','Deployment'],
        ['Deployment',    'Monitoring'],
        ['Monitoring',    'Retraining'],
        ['Retraining',    'Deployment'],
      ],
      explanation: 'Jeder Schritt baut auf dem vorherigen auf: aus dem Use-Case folgt die Datensammlung, daraus das Modelltraining, dann Deployment in den Betrieb. Monitoring überwacht laufende Modelle und triggert Retraining — das wiederum führt zu einem neuen Deployment. So entsteht der Kreislauf, der DKS-Lebenszyklus.',
    },
    mlops: {
      label: 'MLOps Stack',
      edgeVerb: 'speist',
      hint:  'tap erst Quelle, dann Empfänger.',
      items: ['Airflow', 'Spark', 'DVC', 'MLflow', 'Kubernetes', 'Sagemaker'],
      edges: [
        ['Airflow',    'Spark'],
        ['Airflow',    'MLflow'],
        ['DVC',        'MLflow'],
        ['MLflow',     'Sagemaker'],
        ['Kubernetes', 'Sagemaker'],
      ],
      explanation: 'Orchestratoren (Airflow, Kubernetes) speisen die ML-Tools: Airflow füttert Spark mit Jobs und MLflow mit Trainings-Runs, DVC liefert versionierte Daten an MLflow, und MLflow schiebt das fertige Modell zu Sagemaker — wo Kubernetes die Compute-Ressourcen bereitstellt.',
    },
    git: {
      label: 'git Workflow',
      edgeVerb: 'wird gefolgt von',
      hint:  'tap erst den früheren, dann den späteren Schritt.',
      items: ['clone', 'commit', 'branch', 'merge', 'rebase', 'push'],
      edges: [
        ['clone',  'commit'],
        ['commit', 'branch'],
        ['branch', 'rebase'],
        ['rebase', 'merge'],
        ['merge',  'push'],
      ],
      explanation: 'Klassischer git-Fluss: clone das Repo, commit deine Änderung, branche ab, rebase auf den Upstream, merge zurück in den Main-Branch und push remote. Die Reihenfolge stellt sicher, dass dein lokaler State sauber bleibt, bevor er publik wird.',
    },
    web: {
      label: 'Web Stack',
      edgeVerb: 'ruft auf',
      hint:  'tap erst den Aufrufer, dann das angesprochene System.',
      items: ['React', 'GraphQL', 'Node', 'MongoDB', 'Redis', 'AWS'],
      edges: [
        ['React',   'GraphQL'],
        ['GraphQL', 'Node'],
        ['Node',    'MongoDB'],
        ['Node',    'Redis'],
        ['Node',    'AWS'],
      ],
      explanation: 'React-Frontend spricht GraphQL als API-Layer, der wiederum Node aufruft. Node ist die Business-Logic-Schicht und kommuniziert mit den persistenten Stores (MongoDB für Dokumente, Redis als Cache) sowie mit AWS für Storage und Auth. Jede Schicht abstrahiert die nächste.',
    },
  };
  GRAPH_PROMPTS.default = GRAPH_PROMPTS.ki_projekt;

  // Directed key — A→B is NOT the same as B→A.
  function edgeKey(a, b) { return a + '||' + b; }

  function ensureGraphRuntimeStyles() {
    if (document.getElementById('dks-graph-runtime-styles')) return;
    const style = document.createElement('style');
    style.id = 'dks-graph-runtime-styles';
    style.textContent = `
      .idea-arena.graph-arena { touch-action: none; }
      .idea-token.graph-node {
        z-index: 3;
        cursor: grab;
        touch-action: none;
        background: rgba(77,255,177,0.13);
      }
      .idea-token.graph-node.graph-dragging {
        z-index: 6;
        cursor: grabbing;
        filter: brightness(1.45);
      }
      .idea-token.graph-connect-target {
        border-color: rgba(255,216,107,0.95) !important;
        box-shadow: 0 0 0 2px rgba(255,216,107,0.35), 0 0 18px rgba(255,216,107,0.45);
      }
      .graph-overlay line.graph-preview {
        stroke: rgba(255,216,107,0.85);
        stroke-width: 1.5;
        stroke-dasharray: 5 4;
      }
      .graph-overlay line.graph-edge {
        transition: opacity .18s ease, stroke-width .18s ease;
      }
    `;
    document.head.appendChild(style);
  }

  async function runGraphBuilder(promptKey) {
    ensureGraphRuntimeStyles();
    const data = GRAPH_PROMPTS[promptKey] || GRAPH_PROMPTS.default;
    const truth = new Set(data.edges.map(([a, b]) => edgeKey(a, b)));

    const arena = document.createElement('div');
    arena.className = 'idea-arena graph-arena';
    arena.style.height = log.clientHeight + 'px';
    log.appendChild(arena);
    log.scrollTo({ top: arena.offsetTop, behavior: 'smooth' });

    // SVG overlay for edges (above tokens, but pointer-events: none)
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.classList.add('graph-overlay');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    // Arrowhead markers — one for correct edges, one for wrong, one for missed.
    const defs = document.createElementNS(svgNS, 'defs');
    defs.innerHTML = `
      <marker id="arr-ok"    viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 Z" fill="rgba(77,255,177,0.85)"/>
      </marker>
      <marker id="arr-bad"   viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 Z" fill="rgba(255,90,100,0.7)"/>
      </marker>
      <marker id="arr-miss"  viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 Z" fill="rgba(255,216,107,0.85)"/>
      </marker>
    `;
    svg.appendChild(defs);
    arena.appendChild(svg);

    // HUD — direkt in die chat-statusbar einbinden (vermeidet z-index-Konflikte
    // mit der statusbar selbst, ist immer sichtbar oberhalb der arena).
    const verb = data.edgeVerb || 'verbindet';
    const statusBar = cta.querySelector('.chat-statusbar');
    const missionEl = statusBar?.querySelector('.term-mission');
    const cyclesEl  = statusBar?.querySelector('.term-cycles');
    const missionOrig = missionEl ? missionEl.innerHTML : '';
    const cyclesOrig  = cyclesEl  ? cyclesEl.textContent : '';
    const renderMissionHtml = () =>
      `▍ <i style="opacity:.7;text-transform:none;font-style:normal">«${verb}»</i>`;
    const renderScoreText = (s) => `SCORE ${s}`;
    if (missionEl) missionEl.innerHTML = renderMissionHtml();
    if (cyclesEl)  cyclesEl.textContent = renderScoreText(0);
    // Sentinel object kept around so existing `scoreEl.innerHTML = …` calls
    // route through to the statusbar elements without further code surgery.
    const scoreEl = {
      get innerHTML() { return cyclesEl?.textContent || ''; },
      set innerHTML(_html) { /* ignored — we render via current score below */ },
    };
    function paintScore(s) {
      if (cyclesEl) {
        cyclesEl.textContent = renderScoreText(s);
        cyclesEl.style.color = s < 0 ? '#ff8a8a' : '#4dffb1';
      }
    }
    paintScore(0);
    const renderScoreHtml = (s) => { paintScore(s); return ''; };

    // No finish button — round auto-completes when ALL truth edges are
    // drawn AND zero wrong edges remain. The user just plays until that
    // condition triggers (or closes the chat to abort).
    let resolveFinish = null;
    const finished = new Promise(r => { resolveFinish = r; });
    function checkAutoFinish() {
      if (!resolveFinish) return;
      const drawn = [...drawnEdges.values()];
      const correctCount = drawn.filter(e => e.correct).length;
      const wrongCount   = drawn.length - correctCount;
      if (wrongCount === 0 && correctCount === data.edges.length) {
        // Celebrate briefly so the user sees the final flash settle.
        const fn = resolveFinish; resolveFinish = null;
        setTimeout(fn, 650);
      }
    }

    await new Promise(r => setTimeout(r, 350));
    const arenaW = arena.clientWidth;
    const arenaH = arena.clientHeight;

    const tokenByEl = new Map();

    // Spawn tokens. They still enter as falling word bubbles, but once a word
    // becomes part of a connection it turns into a graph node and moves under
    // the layout solver instead of the falling-body loop.
    const tokens = data.items.map((text, i) => {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'idea-token';
      const lbl = document.createElement('span');
      lbl.textContent = text;
      t.appendChild(lbl);
      arena.appendChild(t);
      const w = t.offsetWidth, h = t.offsetHeight;
      const px = 10 + Math.random() * Math.max(10, arenaW - w - 20);
      const py = -h - 12 - i * 70;
      const mass = Math.max(0.8, (w * h) / 2800);
      const inertia = mass * (w * w + h * h) / 12;
      const angle = (Math.random() - 0.5) * 0.28;
      t.style.transform = `translate(${px}px, ${py}px) rotate(${angle * 180 / Math.PI}deg)`;
      const body = {
        el: t, lbl, text, w, h, hw: w/2, hh: h/2,
        cx: px + w/2, cy: py + h/2,
        x: px, y: py,
        vx: (Math.random() - 0.5) * 1.2,
        vy: 0, angle,
        av: (Math.random() - 0.5) * 0.05,
        mass, invMass: 1/mass, inertia, invI: 1/inertia,
        rot: angle * 180 / Math.PI,
        sleepFrames: 0, asleep: false, touching: false, dead: false,
        graphNode: false, dragging: false,
      };
      tokenByEl.set(t, body);
      return body;
    });

    const RAD2DEG = 180 / Math.PI;
    // Physics tuned for "small chat box" — pills should fall like real
    // objects (slow enough to read mid-air), not like cartoon bricks.
    // Lowering gravity + terminal velocity + adding air drag makes the
    // motion feel weighty without being sluggish.
    const G = 0.18;            // was 0.36 — halved for realistic descent
    const MAX_VY = 7;          // was 12  — capped slower terminal velocity
    const AIR = 0.993;         // was 0.998 — more air drag on horizontals
    const ANGULAR_AIR = 0.978; // was 0.992 — rotations damp faster
    const RESTITUTION = 0.12;  // was 0.16 — slightly less bouncy on impact
    const FRICTION = 0.62;
    const POSITION_SLOP = 0.08;
    const POSITION_CORRECTION = 0.72;
    const SOLVER_ITERATIONS = 8;
    const SUBSTEPS = 2;
    const SLEEP_FRAMES = 58;
    const SLEEP_LINEAR = 0.045;
    const SLEEP_ANGULAR = 0.0035;
    const MAX_FRAMES = 60 * 75;
    const dot = (a, b) => a.x * b.x + a.y * b.y;
    const cross = (a, b) => a.x * b.y - a.y * b.x;
    const crossSV = (s, v) => ({ x: -s * v.y, y: s * v.x });
    const len = (v) => Math.hypot(v.x, v.y);
    const normalize = (v) => {
      const l = len(v);
      return l > 1e-6 ? { x: v.x / l, y: v.y / l } : { x: 1, y: 0 };
    };

    function wake(b) {
      if (b.dead || b.graphNode) return;
      b.asleep = false;
      b.sleepFrames = 0;
    }

    function axes(b) {
      const c = Math.cos(b.angle || 0), s = Math.sin(b.angle || 0);
      return {
        ux: { x: c, y: s },
        uy: { x: -s, y: c },
      };
    }

    function vertices(b) {
      const a = axes(b);
      const ux = a.ux, uy = a.uy;
      const hx = b.hw, hy = b.hh;
      return [
        { x: b.cx - ux.x * hx - uy.x * hy, y: b.cy - ux.y * hx - uy.y * hy },
        { x: b.cx + ux.x * hx - uy.x * hy, y: b.cy + ux.y * hx - uy.y * hy },
        { x: b.cx + ux.x * hx + uy.x * hy, y: b.cy + ux.y * hx + uy.y * hy },
        { x: b.cx - ux.x * hx + uy.x * hy, y: b.cy - ux.y * hx + uy.y * hy },
      ];
    }

    function project(verts, axis) {
      let min = dot(verts[0], axis), max = min;
      for (let i = 1; i < verts.length; i++) {
        const p = dot(verts[i], axis);
        if (p < min) min = p;
        if (p > max) max = p;
      }
      return { min, max };
    }

    function containsPoint(b, p) {
      const a = axes(b);
      const dx = p.x - b.cx, dy = p.y - b.cy;
      return Math.abs(dx * a.ux.x + dy * a.ux.y) <= b.hw + 0.6 &&
             Math.abs(dx * a.uy.x + dy * a.uy.y) <= b.hh + 0.6;
    }

    function averagedContact(a, b, normal) {
      const av = vertices(a);
      const bv = vertices(b);
      const pts = [];
      for (const p of av) if (containsPoint(b, p)) pts.push(p);
      for (const p of bv) if (containsPoint(a, p)) pts.push(p);
      if (!pts.length) {
        return {
          x: (a.cx + b.cx) / 2 - normal.x * 4,
          y: (a.cy + b.cy) / 2 - normal.y * 4,
        };
      }
      const sum = pts.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
      return { x: sum.x / pts.length, y: sum.y / pts.length };
    }

    function bodyCollision(a, b) {
      const av = vertices(a);
      const bv = vertices(b);
      const aa = axes(a), ba = axes(b);
      const candidates = [aa.ux, aa.uy, ba.ux, ba.uy];
      let minOverlap = Infinity;
      let best = null;

      for (const raw of candidates) {
        const axis = normalize(raw);
        const ap = project(av, axis);
        const bp = project(bv, axis);
        const overlap = Math.min(ap.max, bp.max) - Math.max(ap.min, bp.min);
        if (overlap <= 0) return null;
        if (overlap < minOverlap) {
          minOverlap = overlap;
          best = axis;
        }
      }

      if (dot({ x: a.cx - b.cx, y: a.cy - b.cy }, best) < 0) {
        best = { x: -best.x, y: -best.y };
      }

      return {
        normal: best,
        penetration: minOverlap,
        contact: averagedContact(a, b, best),
      };
    }

    function bodyPointVelocity(b, r) {
      const spin = crossSV(b.av || 0, r);
      return { x: b.vx + spin.x, y: b.vy + spin.y };
    }

    function applyImpulse(b, impulse, r) {
      if (b.graphNode) return;
      b.vx += impulse.x * b.invMass;
      b.vy += impulse.y * b.invMass;
      b.av += cross(r, impulse) * b.invI;
    }

    function solveContact(a, b, normal, penetration, contact, restitution = RESTITUTION) {
      if (a.dead || (b && b.dead)) return;
      if (a.asleep && (!b || b.asleep || b.graphNode) && penetration < 0.8) return;
      if (penetration > 0.5) wake(a);
      if (b && penetration > 0.5) wake(b);

      const invMassA = a.asleep || a.graphNode ? 0 : a.invMass;
      const invMassB = !b || b.asleep || b.graphNode ? 0 : b.invMass;
      const invIA = a.asleep || a.graphNode ? 0 : a.invI;
      const invIB = !b || b.asleep || b.graphNode ? 0 : b.invI;
      const totalInvMass = invMassA + invMassB;
      if (totalInvMass <= 0) return;

      const correction = Math.max(0, penetration - POSITION_SLOP) * POSITION_CORRECTION / totalInvMass;
      if (!a.asleep && !a.graphNode) {
        a.cx += normal.x * correction * invMassA;
        a.cy += normal.y * correction * invMassA;
      }
      if (b && !b.asleep && !b.graphNode) {
        b.cx -= normal.x * correction * invMassB;
        b.cy -= normal.y * correction * invMassB;
      }

      const ra = { x: contact.x - a.cx, y: contact.y - a.cy };
      const rb = b ? { x: contact.x - b.cx, y: contact.y - b.cy } : { x: 0, y: 0 };
      const va = bodyPointVelocity(a, ra);
      const vb = b ? bodyPointVelocity(b, rb) : { x: 0, y: 0 };
      const rv = { x: va.x - vb.x, y: va.y - vb.y };
      const vn = dot(rv, normal);

      let normalImpulseMag = 0;
      if (vn < 0.35) {
        const raN = cross(ra, normal);
        const rbN = b ? cross(rb, normal) : 0;
        const denom = totalInvMass + raN * raN * invIA + rbN * rbN * invIB;
        if (denom > 1e-6) {
          const e = Math.abs(vn) > 2.5 ? restitution : 0.03;
          normalImpulseMag = Math.max(0, -(1 + e) * vn / denom);
          const impulse = { x: normal.x * normalImpulseMag, y: normal.y * normalImpulseMag };
          if (!a.asleep && !a.graphNode) applyImpulse(a, impulse, ra);
          if (b && !b.asleep && !b.graphNode) applyImpulse(b, { x: -impulse.x, y: -impulse.y }, rb);
        }
      }

      const va2 = bodyPointVelocity(a, ra);
      const vb2 = b ? bodyPointVelocity(b, rb) : { x: 0, y: 0 };
      const rv2 = { x: va2.x - vb2.x, y: va2.y - vb2.y };
      let tangent = { x: rv2.x - normal.x * dot(rv2, normal), y: rv2.y - normal.y * dot(rv2, normal) };
      const tangentLen = len(tangent);
      if (tangentLen > 1e-5) {
        tangent = { x: tangent.x / tangentLen, y: tangent.y / tangentLen };
        const raT = cross(ra, tangent);
        const rbT = b ? cross(rb, tangent) : 0;
        const denomT = totalInvMass + raT * raT * invIA + rbT * rbT * invIB;
        if (denomT > 1e-6) {
          const frictionBudget = Math.max(normalImpulseMag, penetration * 0.08) * FRICTION;
          const jt = Math.max(-frictionBudget, Math.min(frictionBudget, -dot(rv2, tangent) / denomT));
          const frictionImpulse = { x: tangent.x * jt, y: tangent.y * jt };
          if (!a.asleep && !a.graphNode) applyImpulse(a, frictionImpulse, ra);
          if (b && !b.asleep && !b.graphNode) applyImpulse(b, { x: -frictionImpulse.x, y: -frictionImpulse.y }, rb);
        }
      }

      a.touching = true;
      if (b) b.touching = true;
    }

    function solveBounds(b) {
      const verts = vertices(b);
      let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
      let leftPoint = null, rightPoint = null, floorPoint = null;
      for (const p of verts) {
        if (p.x < minX) { minX = p.x; leftPoint = p; }
        if (p.x > maxX) { maxX = p.x; rightPoint = p; }
        if (p.y > maxY) { maxY = p.y; floorPoint = p; }
      }
      if (minX < 0) solveContact(b, null, { x: 1, y: 0 }, -minX, leftPoint, 0.08);
      if (maxX > arenaW) solveContact(b, null, { x: -1, y: 0 }, maxX - arenaW, rightPoint, 0.08);
      if (maxY > arenaH) solveContact(b, null, { x: 0, y: -1 }, maxY - arenaH, floorPoint, 0.08);
    }

    function integrate(b) {
      if (b.dead || b.asleep || b.graphNode) return;
      b.vy = Math.min(MAX_VY, b.vy + G / SUBSTEPS);
      b.vx *= AIR;
      b.av *= ANGULAR_AIR;
      b.cx += b.vx / SUBSTEPS;
      b.cy += b.vy / SUBSTEPS;
      b.angle += b.av / SUBSTEPS;
    }

    function sleepTest(b) {
      if (b.dead || b.graphNode || b.asleep) return false;
      const slow = Math.hypot(b.vx, b.vy) < SLEEP_LINEAR && Math.abs(b.av) < SLEEP_ANGULAR && b.touching;
      if (slow) {
        b.sleepFrames++;
        if (b.sleepFrames >= SLEEP_FRAMES) {
          b.asleep = true;
          b.vx = 0; b.vy = 0; b.av = 0;
        }
      } else {
        b.sleepFrames = 0;
        b.asleep = false;
      }
      return !b.asleep;
    }

    function renderFallingToken(b) {
      b.x = b.cx - b.hw;
      b.y = b.cy - b.hh;
      b.rot = b.angle * RAD2DEG;
      b.el.style.transform = `translate(${b.x}px, ${b.y}px) rotate(${b.rot}deg)`;
    }

    let frameCount = 0;
    // Loop-guard: prevents stacked parallel RAF loops from amplifying gravity.
    // Every code path that wants to "kick the physics loop" (initial spawn,
    // re-schedule from inside the loop, deactivateNode after disconnect)
    // must go through scheduleFallStep() so we only have ONE pending frame
    // at a time.
    let fallScheduled = false;
    function fallStep() {
      fallScheduled = false;          // we're now executing the scheduled tick
      frameCount++;
      let anyMoving = false;
      for (const b of tokens) b.touching = false;

      for (let sub = 0; sub < SUBSTEPS; sub++) {
        for (const b of tokens) integrate(b);

        for (let iter = 0; iter < SOLVER_ITERATIONS; iter++) {
          for (const b of tokens) {
            if (!b.dead && !b.graphNode) solveBounds(b);
          }

          for (let i = 0; i < tokens.length; i++) {
            const a = tokens[i];
            if (a.dead) continue;
            for (let j = i + 1; j < tokens.length; j++) {
              const b = tokens[j];
              if (b.dead || (a.graphNode && b.graphNode)) continue;
              const hit = bodyCollision(a, b);
              if (hit) solveContact(a, b, hit.normal, hit.penetration, hit.contact);
            }
          }
        }
      }

      for (const b of tokens) {
        if (b.dead || b.graphNode) continue;
        anyMoving = sleepTest(b) || anyMoving;
        renderFallingToken(b);
      }
      renderEdges();
      if (anyMoving && frameCount < MAX_FRAMES) scheduleFallStep();
    }
    function scheduleFallStep() {
      if (fallScheduled) return;       // already a frame in flight — drop duplicate
      fallScheduled = true;
      requestAnimationFrame(fallStep);
    }
    scheduleFallStep();

    // Connect mode state
    let selected = null;
    const drawnEdges = new Map(); // key -> { line, from, to, correct }
    let score = 0;
    // Free-drag anchor: the FIRST pill the user drag-drops onto empty
    // space gets pinned in mid-air. Any subsequent edge-less drag-drop
    // falls back into the physics pool. Edge-attached pills stay in
    // the force layout regardless.
    let anchorToken = null;
    let layoutRun = 0;
    let previewLine = null;
    let previewTarget = null;

    function flash(el, ok) {
      el.classList.add(ok ? 'graph-correct-flash' : 'graph-wrong-flash');
      setTimeout(() => el.classList.remove(ok ? 'graph-correct-flash' : 'graph-wrong-flash'), 460);
    }

    function clamp(v, min, max) {
      return Math.max(min, Math.min(max, v));
    }

    function renderToken(t) {
      t.x = t.cx - t.hw;
      t.y = t.cy - t.hh;
      t.el.style.transform = `translate(${t.x}px, ${t.y}px) rotate(${t.rot || 0}deg)`;
    }

    // Short-lived "+10" / "-5" / "↺ Richtung umgekehrt" label that floats
    // up from a position and fades out. Lives inside the arena so the
    // arena's overflow:hidden contains it cleanly.
    function showFloater(x, y, text, color = '#4dffb1') {
      const f = document.createElement('div');
      f.textContent = text;
      f.style.cssText = `
        position: absolute; left: ${x}px; top: ${y}px;
        transform: translate(-50%, -50%);
        color: ${color};
        font: 600 13px/1 'JetBrains Mono', monospace;
        text-shadow: 0 0 8px ${color}55;
        pointer-events: none;
        z-index: 6;
        white-space: nowrap;
      `;
      arena.appendChild(f);
      f.animate(
        [
          { transform: 'translate(-50%, -50%) scale(0.6)', opacity: 0 },
          { transform: 'translate(-50%, -120%) scale(1.05)', opacity: 1, offset: 0.25 },
          { transform: 'translate(-50%, -180%) scale(1)',    opacity: 1, offset: 0.7 },
          { transform: 'translate(-50%, -240%) scale(0.92)', opacity: 0 },
        ],
        { duration: 1100, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'forwards' }
      );
      setTimeout(() => f.remove(), 1150);
    }

    // Find the intersection of the line center(from) → center(to) with the
    // AABB of `box`, returning the point ON the box's edge. Pad lets us add
    // a small gap between the pill and the arrowhead tip.
    function clipToBox(fromX, fromY, box, pad = 4) {
      const dx = box.cx - fromX, dy = box.cy - fromY;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.5) return { x: box.cx, y: box.cy };
      const ux = dx / dist, uy = dy / dist;
      const hw = box.hw + pad, hh = box.hh + pad;
      const tX = hw / Math.max(Math.abs(ux), 1e-6);
      const tY = hh / Math.max(Math.abs(uy), 1e-6);
      const t = Math.min(tX, tY);
      return { x: box.cx - ux * t, y: box.cy - uy * t };
    }

    // Minimum on-screen length for an edge stub — anything shorter and
    // the arrowhead marker would overlap the whole line. Falls below
    // → keep the line tip on the `to` pill edge but back-extend the
    // start enough to expose at least this much visible stroke.
    const MIN_EDGE_PX = 22;

    function renderEdges() {
      for (const { line, from, to } of drawnEdges.values()) {
        let start = clipToBox(to.cx, to.cy, from, 4);     // start on `from` edge facing `to`
        let end   = clipToBox(from.cx, from.cy, to, 4);   // end on `to` edge facing `from`
        let dx = end.x - start.x, dy = end.y - start.y;
        let len = Math.hypot(dx, dy);
        if (len < MIN_EDGE_PX) {
          // Extend start back along the from→to axis from `to`'s center so
          // the stroke is at least MIN_EDGE_PX long and the arrowhead has
          // room to render outside the source pill.
          const ux = (to.cx - from.cx) / Math.max(1, Math.hypot(to.cx - from.cx, to.cy - from.cy));
          const uy = (to.cy - from.cy) / Math.max(1, Math.hypot(to.cx - from.cx, to.cy - from.cy));
          start = { x: end.x - ux * MIN_EDGE_PX, y: end.y - uy * MIN_EDGE_PX };
        }
        line.setAttribute('x1', start.x);
        line.setAttribute('y1', start.y);
        line.setAttribute('x2', end.x);
        line.setAttribute('y2', end.y);
      }
      if (previewLine) {
        const from = previewLine._from;
        const to = previewLine._to;
        const start = clipToBox(to.x, to.y, from, 4);
        previewLine.setAttribute('x1', start.x);
        previewLine.setAttribute('y1', start.y);
        previewLine.setAttribute('x2', to.x);
        previewLine.setAttribute('y2', to.y);
      }
    }

    function activeTokens() {
      return tokens.filter(t => t.graphNode && !t.dead);
    }

    function activateNode(t) {
      if (t.graphNode) return;
      t.graphNode = true;
      t.asleep = true;
      t.vx = 0;
      t.vy = 0;
      t.av = 0;
      t.angle = 0;
      t.rot = 0;
      t.el.classList.add('graph-node');
      renderToken(t);
    }

    // Drop a node back into the falling-physics pool. Used when the user
    // disconnects an edge: the dragged pill should fall again rather than
    // hang in mid-air. Reuses the existing fallStep loop — we just unset
    // the graph-mode flag and give it a tiny initial velocity so sleepTest
    // won't immediately re-park it.
    function deactivateNode(t) {
      if (!t.graphNode) return;
      t.graphNode = false;
      t.el.classList.remove('graph-node');
      t.asleep = false;
      t.sleepFrames = 0;
      t.vx = (Math.random() - 0.5) * 0.6;
      t.vy = 1.2;                                   // small downward kick
      t.av = (Math.random() - 0.5) * 0.04;
      t.angle = 0;                                  // forget any layout angle
      // Reset the fall loop's frame budget and kick it back into life if
      // it had stopped after settling earlier in the round. Go through the
      // scheduler so stacked disconnects can't pile up parallel RAFs (which
      // would otherwise double-integrate gravity every frame).
      frameCount = 0;
      scheduleFallStep();
    }

    function hasOtherEdges(token) {
      for (const e of drawnEdges.values()) if (e.from === token || e.to === token) return true;
      return false;
    }

    function computeForceLayout() {
      const nodes = activeTokens();
      const n = nodes.length;
      if (!n) return new Map();

      // Generous padding from the arena walls — keeps half-pills from
      // clipping against the dashed border on tight layouts.
      const bounds = {
        left:   60,
        right:  arenaW - 60,
        top:    40,
        bottom: arenaH - 40,
      };
      const center = {
        x: (bounds.left + bounds.right) / 2,
        y: (bounds.top + bounds.bottom) / 2,
      };
      const layoutW = Math.max(180, bounds.right - bounds.left);
      const layoutH = Math.max(150, bounds.bottom - bounds.top);
      const k = Math.max(72, Math.min(130, Math.sqrt((layoutW * layoutH) / Math.max(1, n)) * 0.7));
      const pos = new Map(nodes.map((node, i) => {
        if (n === 1) return [node, { x: center.x, y: center.y }];
        const a = (Math.PI * 2 * i) / n - Math.PI / 2;
        const rx = Math.min(layoutW * 0.28, 140);
        const ry = Math.min(layoutH * 0.28, 96);
        return [node, {
          x: clamp(node.cx || center.x + Math.cos(a) * rx, bounds.left + node.hw, bounds.right - node.hw),
          y: clamp(node.cy || center.y + Math.sin(a) * ry, bounds.top + node.hh, bounds.bottom - node.hh),
        }];
      }));
      const disp = new Map();
      const edges = [...drawnEdges.values()]
        .filter(e => e.from.graphNode && e.to.graphNode)
        .map(e => [e.from, e.to]);

      for (let iter = 0; iter < 120; iter++) {
        nodes.forEach(v => disp.set(v, { x: 0, y: 0 }));

        for (let i = 0; i < n; i++) {
          const v = nodes[i];
          const pv = pos.get(v);
          for (let j = i + 1; j < n; j++) {
            const u = nodes[j];
            const pu = pos.get(u);
            let dx = pv.x - pu.x;
            let dy = pv.y - pu.y;
            let d = Math.hypot(dx, dy) || 0.01;
            dx /= d;
            dy /= d;
            const force = (k * k) / d;
            disp.get(v).x += dx * force;
            disp.get(v).y += dy * force;
            disp.get(u).x -= dx * force;
            disp.get(u).y -= dy * force;
          }
        }

        for (const [v, u] of edges) {
          const pv = pos.get(v);
          const pu = pos.get(u);
          let dx = pv.x - pu.x;
          let dy = pv.y - pu.y;
          let d = Math.hypot(dx, dy) || 0.01;
          dx /= d;
          dy /= d;
          const ideal = k * 1.05;
          const force = ((d - ideal) * Math.abs(d - ideal)) / k;
          disp.get(v).x -= dx * force;
          disp.get(v).y -= dy * force;
          disp.get(u).x += dx * force;
          disp.get(u).y += dy * force;
        }

        const temperature = Math.max(2, 34 * (1 - iter / 120));
        for (const node of nodes) {
          const p = pos.get(node);
          const d = disp.get(node);
          d.x += (center.x - p.x) * 0.035;
          d.y += (center.y - p.y) * 0.035;
          const mag = Math.hypot(d.x, d.y) || 1;
          p.x = clamp(p.x + (d.x / mag) * Math.min(mag, temperature), bounds.left + node.hw, bounds.right - node.hw);
          p.y = clamp(p.y + (d.y / mag) * Math.min(mag, temperature), bounds.top + node.hh, bounds.bottom - node.hh);
        }
      }

      return pos;
    }

    function animateLayout() {
      const targets = computeForceLayout();
      if (!targets.size) return;
      const run = ++layoutRun;
      const starts = new Map();
      for (const node of targets.keys()) {
        starts.set(node, { cx: node.cx, cy: node.cy, rot: node.rot || 0 });
      }
      const start = performance.now();
      const duration = 650;
      const ease = t => 1 - Math.pow(1 - t, 3);

      function frame(now) {
        if (run !== layoutRun) return;
        const t = ease(Math.min(1, (now - start) / duration));
        for (const [node, target] of targets) {
          if (node.dragging || node.dead) continue;
          const s = starts.get(node);
          node.cx = s.cx + (target.x - s.cx) * t;
          node.cy = s.cy + (target.y - s.cy) * t;
          node.rot = s.rot * (1 - t);
          renderToken(node);
        }
        renderEdges();
        if (t < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }

    function tokenFromPoint(x, y, except = null) {
      const previousPointerEvents = except?.el.style.pointerEvents;
      if (except) except.el.style.pointerEvents = 'none';
      const el = document.elementFromPoint(x, y);
      if (except) except.el.style.pointerEvents = previousPointerEvents;
      const tokenEl = el?.closest?.('.idea-token');
      const token = tokenEl ? tokenByEl.get(tokenEl) : null;
      return token && token !== except && !token.dead ? token : null;
    }

    function setPreview(from, toToken, pointer) {
      if (previewTarget && previewTarget !== toToken) {
        previewTarget.el.classList.remove('graph-connect-target');
      }
      previewTarget = toToken;
      if (toToken) toToken.el.classList.add('graph-connect-target');

      if (!toToken && !previewLine) return;
      if (!previewLine) {
        previewLine = document.createElementNS(svgNS, 'line');
        previewLine.classList.add('graph-preview');
        svg.appendChild(previewLine);
      }
      previewLine._from = from;
      previewLine._to = toToken
        ? { x: toToken.cx, y: toToken.cy }
        : { x: pointer.x, y: pointer.y };
      renderEdges();
      previewLine.style.opacity = toToken ? '1' : '0';
    }

    function clearPreview() {
      if (previewTarget) previewTarget.el.classList.remove('graph-connect-target');
      previewTarget = null;
      if (previewLine) {
        previewLine.remove();
        previewLine = null;
      }
    }

    function tryConnect(a, b) {
      if (a === b) return;
      // Directed edge: a → b. Also bail out if the reverse already exists
      // (one direction at a time keeps the graph readable).
      const k = edgeKey(a.text, b.text);
      const kRev = edgeKey(b.text, a.text);
      const existing = drawnEdges.get(k);
      if (existing) {
        existing.line.style.opacity = '0';
        existing.line.style.strokeWidth = '0.2';
        setTimeout(() => existing.line.remove(), 190);
        drawnEdges.delete(k);
        const delta = existing.correct ? -10 : 5;
        score += delta;
        scoreEl.innerHTML = renderScoreHtml(score);
        showFloater(
          (a.cx + b.cx) / 2, (a.cy + b.cy) / 2,
          (delta > 0 ? '+' : '') + delta,
          delta > 0 ? '#4dffb1' : '#ff8a8a',
        );
        flash(a.el, false);
        flash(b.el, false);
        // Drop pills back into physics if they have no remaining edges. The
        // user-initiated dragged pill (a) is the primary one — but if b is
        // also isolated now, let it fall too, otherwise it floats alone.
        if (!hasOtherEdges(a)) deactivateNode(a);
        if (!hasOtherEdges(b)) deactivateNode(b);
        animateLayout();
        checkAutoFinish();
        return;
      }
      // If the user tries to draw the reverse, that's wrong by design.
      // Flash both pills red AND surface a short "Reverse Direction"
      // hint so the user understands why nothing was drawn.
      if (drawnEdges.has(kRev)) {
        flash(a.el, false);
        flash(b.el, false);
        showFloater(a.cx, (a.cy + b.cy) / 2, '↺ Richtung umgekehrt', '#ff8a8a');
        return;
      }
      activateNode(a);
      activateNode(b);
      const correct = truth.has(k);
      const line = document.createElementNS(svgNS, 'line');
      line.classList.add('graph-edge');
      if (!correct) line.classList.add('bad');
      line.setAttribute('marker-end', correct ? 'url(#arr-ok)' : 'url(#arr-bad)');
      line.setAttribute('x1', a.cx);
      line.setAttribute('y1', a.cy);
      line.setAttribute('x2', b.cx);
      line.setAttribute('y2', b.cy);
      svg.appendChild(line);
      drawnEdges.set(k, { line, from: a, to: b, correct });
      const delta = correct ? 10 : -5;
      score += delta;
      scoreEl.innerHTML = renderScoreHtml(score);
      showFloater(
        (a.cx + b.cx) / 2, (a.cy + b.cy) / 2,
        (delta > 0 ? '+' : '') + delta,
        delta > 0 ? '#4dffb1' : '#ff8a8a',
      );
      flash(a.el, correct);
      flash(b.el, correct);
      animateLayout();
      checkAutoFinish();
    }

    tokens.forEach(t => {
      t.el.addEventListener('pointerdown', (ev) => {
        if (ev.button !== undefined && ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        try { t.el.setPointerCapture?.(ev.pointerId); } catch (e) { /* capture is best-effort */ }
        const rect = arena.getBoundingClientRect();
        const start = {
          px: ev.clientX,
          py: ev.clientY,
          cx: t.cx,
          cy: t.cy,
        };
        let moved = false;
        let candidate = null;

        const onMove = (moveEv) => {
          const dx = moveEv.clientX - start.px;
          const dy = moveEv.clientY - start.py;
          if (!moved && Math.hypot(dx, dy) > 5) {
            moved = true;
            activateNode(t);
            t.dragging = true;
            ++layoutRun;
            t.el.classList.add('graph-dragging');
            if (selected) {
              selected.el.classList.remove('graph-selected');
              selected = null;
            }
          }
          if (!moved) return;
          t.cx = clamp(start.cx + dx, t.hw + 2, arenaW - t.hw - 2);
          t.cy = clamp(start.cy + dy, t.hh + 2, arenaH - t.hh - 2);
          t.angle = 0;
          t.rot = 0;
          renderToken(t);
          candidate = tokenFromPoint(moveEv.clientX, moveEv.clientY, t);
          const pointer = { x: moveEv.clientX - rect.left, y: moveEv.clientY - rect.top };
          setPreview(t, candidate, pointer);
          renderEdges();
        };

        const onUp = (upEv) => {
          try { t.el.releasePointerCapture?.(ev.pointerId); } catch (e) { /* capture is best-effort */ }
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          clearPreview();

          if (moved) {
            t.dragging = false;
            t.el.classList.remove('graph-dragging');
            const dropTarget = candidate || tokenFromPoint(upEv.clientX, upEv.clientY, t);
            if (dropTarget) {
              tryConnect(t, dropTarget);
            } else {
              // Released on empty arena space — no connection to make.
              // Anchor rule: first edge-less drag becomes the pinned anchor,
              // every subsequent edge-less drag falls back into physics.
              const hasEdges = hasOtherEdges(t);
              if (hasEdges) {
                // Edge-attached pills stay in the force layout regardless.
                activateNode(t);
                renderToken(t);
              } else if (!anchorToken || anchorToken === t) {
                // First-time anchor OR moving the existing anchor → pin in mid-air.
                anchorToken = t;
                activateNode(t);
                renderToken(t);
              } else {
                // Another pill already holds the anchor → this one drops.
                deactivateNode(t);
              }
              renderEdges();
            }
            return;
          }

          if (selected === t) {
            t.el.classList.remove('graph-selected');
            selected = null;
            return;
          }
          if (selected) {
            tryConnect(selected, t);
            selected.el.classList.remove('graph-selected');
            selected = null;
          } else {
            selected = t;
            t.el.classList.add('graph-selected');
          }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
      });

      t.el.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        if (selected && selected !== t) {
          tryConnect(selected, t);
          selected.el.classList.remove('graph-selected');
          selected = null;
        } else if (selected === t) {
          t.el.classList.remove('graph-selected');
          selected = null;
        } else {
          selected = t;
          t.el.classList.add('graph-selected');
        }
      });
    });

    // Block until auto-finish triggers (or the user closes the chat).
    await finished;

    // We only reach this point when every truth edge is drawn correctly
    // and zero wrong edges remain. Award the completion bonus and let the
    // celebratory frame breathe before we tear the arena down.
    const correctEdges = [...drawnEdges.values()].filter(e => e.correct).length;
    const wrongEdges   = 0;
    const bonus = 50;
    score += bonus;
    paintScore(score);
    if (missionEl) missionEl.innerHTML = '▍ <span style="color:#4dffb1">GELÖST · +50 BONUS</span>';
    // Big celebratory floater in the centre of the arena.
    showFloater(arenaW / 2, arenaH / 2, '+50 BONUS', '#4dffb1');

    // Celebration window — the solved graph stays on screen.
    await new Promise(r => setTimeout(r, 1800));

    // Restore the statusbar to its idle look.
    if (missionEl) missionEl.innerHTML = missionOrig;
    if (cyclesEl)  { cyclesEl.textContent = cyclesOrig; cyclesEl.style.color = ''; }

    // Mark the arena as "solved snapshot" — the outer /graph handler will
    // smooth-scroll past it and stream the explanation underneath. The
    // arena element itself is NOT removed here; the caller decides when
    // (after the explanation finishes streaming).
    arena.dataset.solved = '1';

    return {
      score,
      correctEdges,
      wrongEdges,
      missingCount: 0,
      bonus,
      label: data.label,
      explanation: data.explanation || null,
      arenaEl: arena,
    };
  }

  function buildGraphSummary(r) {
    // We only ever reach this on a full correct completion (auto-finish
    // is the single exit path). Lead with the score line, then the
    // semantic explanation of why the edges connect the way they do.
    const head = `${r.label} gemeistert. Score ${r.score} (+${r.bonus} Bonus).`;
    return r.explanation ? `${head}\n\n${r.explanation}` : head;
  }

  let booted = false;
  async function bootSequence() {
    const lines = [
      'DKS_CAUSAL-AI · v1.0 ONLINE',
      'KERNEL: CAUSAL-TRACER · MEMORY: 1 PROMPT',
      'AWAITING PROBLEM — welches Vorgehen oder Problem soll ich visualisieren?',
      'BEISPIEL: /graph ki_projekt · /graph mlops · /graph git · /graph web',
    ];
    for (const line of lines) {
      const bub = appendMsg('bot', '');
      await revealInto(bub, line, { stagger: 8, duration: 320 });
      await twait(160);
    }
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = field.value.trim();
    if (!text || busy) return;
    busy = true;
    sendBtn.disabled = true;
    field.value = '';
    appendMsg('user', text);
    history.push({ role: 'user', content: text });

    // === Connect-the-Concepts mode (graph builder) ===
    const graphMatch = text.match(/^\/graph\s*(\w+)?/i);
    if (graphMatch) {
      const key = (graphMatch[1] || 'mlops').toLowerCase();
      const data = GRAPH_PROMPTS[key] || GRAPH_PROMPTS.default;
      const intro = appendMsg('bot', '');
      await revealInto(intro, `GRAPH-MODUS · ${data.label.toUpperCase()} · Kanten-Bedeutung: «${data.edgeVerb || 'verbindet'}». ${data.hint || 'tap erst Quelle, dann Ziel — Reihenfolge zählt.'} Erneut verbinden löst die Kante. Sobald alle Kanten korrekt liegen, werte ich automatisch aus.`, { stagger: 6, duration: 280 });
      const result = await runGraphBuilder(key);
      history.push({ role: 'assistant', content: `[graph result] score=${result.score} ${result.correctEdges}/${result.correctEdges + result.missingCount}` });

      // The solved arena stays on screen. Smooth-scroll the chat log past
      // it so the upcoming explanation has visible space below — the user
      // sees the snapshot scroll up, then the new text appears.
      log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, 620));

      const summary = appendMsg('bot', '');
      await revealInto(summary, buildGraphSummary(result));

      // Solved graph stays in the chat log as a snapshot — user can scroll
      // back to inspect the full sequence of pills + arrows + explanation.
      // Disable further interaction so taps on stale pills don't try to
      // rewire a finished round.
      if (result.arenaEl) {
        result.arenaEl.style.pointerEvents = 'none';
        result.arenaEl.dataset.archived = '1';
      }

      busy = false;
      sendBtn.disabled = false;
      log.scrollTop = log.scrollHeight;
      field.focus();
      return;
    }

    const thinkingBubble = appendMsg('bot', '');
    thinkingBubble.classList.add('thinking');

    try {
      const reply = await window.claude.complete({
        messages: [
          { role: 'user', content: SYSTEM + "\n\n---\n\n" + history.map(m => (m.role === 'user' ? 'Nutzer: ' : 'Assistant: ') + m.content).join('\n\n') }
        ]
      });
      thinkingBubble.classList.remove('thinking');
      await revealInto(thinkingBubble, reply);
      history.push({ role: 'assistant', content: reply });
    } catch (err) {
      thinkingBubble.classList.remove('thinking');
      await revealInto(thinkingBubble, 'Entschuldigung — gerade ist die Verbindung zum Modell unterbrochen. Bitte versuchen Sie es in einem Moment erneut, oder schreiben Sie uns direkt an info@dks-analytics.de.');
    } finally {
      busy = false;
      sendBtn.disabled = false;
      log.scrollTop = log.scrollHeight;
      field.focus();
    }
  });
})();
