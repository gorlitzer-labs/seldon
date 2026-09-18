// The Seldon Plan — a GSAP-driven pitch reel.
//
// Signature scenes: the hex Assembly (each tool zooms in, explains itself, then
// docks into a honeycomb flower around the plan), the Build-up (layered product
// surfaces populating like a real session), and the Combo explorer (subsets of
// the stack and what each is good — or weak — for). Auto-advances; drivable by
// arrows / space / dots. prefers-reduced-motion shows everything at rest.
import gsap from "gsap";

const reduce = matchMedia("(prefers-reduced-motion:reduce)").matches;
if (reduce) document.body.classList.add("reduced");

const slides = Array.from(document.querySelectorAll(".slide"));
const pbar = document.getElementById("pbar");
const counter = document.getElementById("counter");
const dotsEl = document.getElementById("dots");
const ppBtn = document.getElementById("playpause");

/* ---------------- Prime Radiant backdrop ---------------- */
(function radiant() {
  const cv = document.getElementById("radiant"), ctx = cv.getContext("2d");
  let ns = [], raf = 0; const GOLD = "#e8ad3c";
  function build() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ns = [];
    const n = Math.min(90, Math.floor((innerWidth * innerHeight) / 20000));
    for (let i = 0; i < n; i++) ns.push({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, r: Math.random() * 1.5 + 0.4, vx: (Math.random() - 0.5) * 0.12, vy: (Math.random() - 0.5) * 0.12, tw: Math.random() * 6, sp: 0.001 + Math.random() * 0.003 });
  }
  function draw(t) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (let i = 0; i < ns.length; i++) { const a = ns[i];
      for (let j = i + 1; j < ns.length; j++) { const b = ns[j], dx = a.x - b.x, dy = a.y - b.y, d = dx * dx + dy * dy;
        if (d < 13000) { ctx.strokeStyle = GOLD; ctx.globalAlpha = (1 - d / 13000) * 0.06; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); } } }
    for (const p of ns) { if (!reduce) { p.x += p.vx; p.y += p.vy; if (p.x < 0 || p.x > innerWidth) p.vx *= -1; if (p.y < 0 || p.y > innerHeight) p.vy *= -1; }
      ctx.globalAlpha = 0.22 + 0.5 * Math.abs(Math.sin(t * p.sp + p.tw)); ctx.fillStyle = GOLD; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1; if (!reduce) raf = requestAnimationFrame(draw);
  }
  function boot() { cancelAnimationFrame(raf); build(); reduce ? draw(0) : (raf = requestAnimationFrame(draw)); }
  let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { boot(); resetScenes(); layoutTopo(); }, 200); });
  boot();
})();

/* ---------------- module data + emblems ---------------- */
const HEX = 'polygon points="100,18 168,58 168,142 100,182 32,142 32,58"';
const MODULES = [
  { id: "foundation", nm: "foundation", role: "the seam", desc: "The deterministic workflow beneath it all — a plan, and a verified record.",
    inner: '<path class="gl" d="M64 78 h72 M64 100 h72 M64 122 h72 M84 66 v68 M114 66 v68"/>' },
  { id: "apiary", nm: "apiary", role: "the conversation", desc: "Shared rooms where a hive of agents talks, claims lanes, and builds.",
    inner: '<path class="gl" d="M62 78 h56 a8 8 0 0 1 8 8 v22 a8 8 0 0 1 -8 8 h-30 l-14 12 v-12 h-12 a8 8 0 0 1 -8 -8 v-22 a8 8 0 0 1 8 -8 z"/><circle class="fl" cx="80" cy="97" r="3.5"/><circle class="fl" cx="100" cy="97" r="3.5"/><circle class="fl" cx="120" cy="97" r="3.5"/>' },
  { id: "factory", nm: "factory", role: "the floor", desc: "The 24/7 supervisor: heals dead agents, gates work, escalates the hard calls.",
    inner: '<circle class="gl" cx="100" cy="100" r="27"/><g class="fl"><rect x="96" y="60" width="8" height="16" rx="2"/><rect x="96" y="124" width="8" height="16" rx="2"/><rect x="60" y="96" width="16" height="8" rx="2"/><rect x="124" y="96" width="16" height="8" rx="2"/></g><circle class="fl" cx="100" cy="100" r="7"/>' },
  { id: "comb", nm: "comb", role: "the vault", desc: "Keys by name, never by value — and credentials that follow an agent anywhere.",
    inner: '<circle class="gl" cx="100" cy="86" r="22"/><path class="gl" d="M100 108 v36 M100 122 h16 M100 134 h12"/><circle class="fl" cx="100" cy="86" r="6"/>' },
  { id: "bifrost", nm: "bifrost", role: "the bridge", desc: "Many machines as one workspace — sessions survive, reachable from a phone.",
    inner: '<path class="gl" d="M50 128 Q100 62 150 128"/><circle class="fl" cx="50" cy="128" r="6"/><circle class="fl" cx="150" cy="128" r="6"/><circle class="gl" cx="100" cy="95" r="7" style="fill:var(--bg)"/>' },
  { id: "demerzel", nm: "Demerzel", role: "the voice", desc: "A fully-local voice you talk to — the way a human steers the whole factory.",
    inner: '<path class="gl" d="M56 100 h10 l8 -26 8 46 8 -60 8 74 8 -46 8 22 h14"/>' },
];
const petalSVG = (m) => `<div class="hexbox"><svg viewBox="0 0 200 200"><${HEX} class="hx"/>${m.inner}</svg></div>`;

/* ---------------- generic entrance for simple scenes ---------------- */
function drawOn(tl, el, at, dur = 1.1) {
  if (!el) return; const len = el.getTotalLength ? el.getTotalLength() : 300;
  gsap.set(el, { strokeDasharray: len, strokeDashoffset: len });
  tl.to(el, { strokeDashoffset: 0, duration: dur, ease: "power2.out" }, at);
}
function genericEnter(slide) {
  const tl = gsap.timeline({ paused: true });
  const anims = slide.querySelectorAll(".anim");
  if (anims.length) tl.from(anims, { opacity: 0, y: 20, filter: "blur(5px)", duration: 0.7, stagger: 0.14, ease: "power2.out" }, 0);
  if (slide.querySelector(".mark")) {
    slide.querySelectorAll(".mark .stroke").forEach((p, i) => drawOn(tl, p, 0.1 + i * 0.12, 1.0));
    tl.from(".mark .fl", { scale: 0, transformOrigin: "60px 60px", duration: 0.5, ease: "back.out(2)" }, 0.6);
  }
  if (slide.querySelector(".planline")) {
    tl.from(".planline", { scaleX: 0, transformOrigin: "left", duration: 1.4, ease: "power2.inOut" }, 0.3);
    tl.from(slide.querySelectorAll(".pstep"), { opacity: 0, y: 14, duration: 0.5, stagger: 0.22, ease: "power2.out" }, 0.4);
    tl.to(slide.querySelectorAll(".pstep .dot"), { background: "#e8ad3c", boxShadow: "0 0 22px 2px rgba(232,173,60,.55)", duration: 0.4, stagger: 0.22 }, 0.5);
  }
  if (slide.querySelector(".e2e")) tl.from(slide.querySelectorAll(".estep"), { opacity: 0, x: -24, duration: 0.45, stagger: 0.12, ease: "power2.out" }, 0.4);
  if (slide.querySelector("#topo")) {
    tl.from(slide.querySelectorAll(".mnode"), { opacity: 0, duration: 0.5, stagger: 0.2 }, 0.3);
    tl.from(slide.querySelectorAll(".mdisc"), { scale: 0, transformOrigin: "center", duration: 0.5, stagger: 0.2, ease: "back.out(1.8)" }, 0.4);
  }
  return tl;
}

/* ---------------- Scene: THE ASSEMBLY (hex flower) ---------------- */
const flower = document.getElementById("flower");
const asmTitle = document.getElementById("asmTitle");
let asmBuilt = false;
function buildAssembly() {
  flower.innerHTML = "";
  // central plan mark
  const center = document.createElement("div");
  center.className = "flower-center";
  center.innerHTML = `<svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" fill="none" stroke="#e8ad3c" stroke-width="1.3"/><circle cx="60" cy="60" r="9" fill="#e8ad3c"/><g stroke="#e8ad3c" stroke-width="1" opacity=".6"><line x1="60" y1="60" x2="100" y2="40"/><line x1="60" y1="60" x2="22" y2="34"/><line x1="60" y1="60" x2="34" y2="100"/><line x1="60" y1="60" x2="96" y2="94"/></g></svg><div class="pname" style="margin-top:6px;font-size:16px">the plan</div>`;
  flower.appendChild(center);
  // 6 petals
  const petals = MODULES.map((m) => {
    const el = document.createElement("div");
    el.className = "petal";
    el.innerHTML = `${petalSVG(m)}<div class="pname"><small>${m.role}</small>${m.nm}</div><div class="pdesc">${m.desc}</div>`;
    flower.appendChild(el);
    return el;
  });
  return { center, petals };
}
function assemblyTimeline() {
  const { center, petals } = buildAssembly();
  const w = flower.clientWidth, h = flower.clientHeight;
  // Reserve the top for the caption and the bottom for the controls; centre the
  // flower in what's left, so nothing docks under the title.
  const capReserve = 150, ctrlReserve = 120;
  const midY = (capReserve + (h - ctrlReserve)) / 2;
  const OFFY = midY - h / 2;
  const R = Math.max(120, Math.min(w * 0.30, (h - ctrlReserve - capReserve) / 2 - 30));
  const centerW = 116, spotW = Math.min(260, w * 0.62), dockW = Math.min(138, w * 0.2);
  // Ring rotated 30° so no petal sits straight up (that space is the caption's).
  const slot = (i) => { const a = (-60 + i * 60) * Math.PI / 180; return { x: R * Math.cos(a), y: OFFY + R * Math.sin(a) }; };

  const tl = gsap.timeline({ paused: true });
  petals.forEach((p) => gsap.set(p, { xPercent: -50, yPercent: -50, width: spotW, x: 0, y: OFFY, opacity: 0, scale: 1 }));
  gsap.set(center, { xPercent: -50, yPercent: -50, x: 0, y: OFFY, opacity: 0, scale: 0.6, width: centerW });

  tl.call(() => { asmTitle.textContent = "The pieces"; }, null, 0);

  const START = 0.6, STEP = 3.9;
  petals.forEach((p, i) => {
    const t = START + i * STEP;
    tl.call(() => { asmTitle.textContent = MODULES[i].nm; }, null, t);
    tl.fromTo(p, { opacity: 0, y: OFFY + 44, scale: 0.9 }, { opacity: 1, y: OFFY, scale: 1, duration: 0.7, ease: "power3.out" }, t);
    const s = slot(i);
    tl.to(p.querySelector(".pdesc"), { opacity: 0, duration: 0.4 }, t + 2.3);
    tl.to(p, { width: dockW, x: s.x, y: s.y, duration: 1.0, ease: "power2.inOut" }, t + 2.3);
    tl.to(p.querySelector(".pname"), { scale: 0.72, duration: 1.0, ease: "power2.inOut" }, t + 2.3);
  });
  // the plan lights at the centre only after the last petal has docked
  const END = START + 6 * STEP;
  tl.to(center, { opacity: 1, scale: 1, duration: 0.9, ease: "back.out(1.6)" }, END - 0.4);
  tl.call(() => { asmTitle.textContent = "One plan, six tools."; }, null, END - 0.2);
  return tl;
}

/* ---------------- Scene: BUILD-UP (product surfaces) ---------------- */
const surfaces = document.getElementById("surfaces");
function buildSurfaces() {
  surfaces.innerHTML = "";
  const wide = innerWidth < 780;
  // terminal
  const term = document.createElement("div");
  term.className = "win term";
  term.style.cssText = wide ? "left:5%;top:16%;width:90%;" : "right:6%;top:14%;width:44%;";
  term.innerHTML = `<div class="tb"><i></i><i></i><i></i><span class="ttl">Claude Code — factory</span></div>
    <div class="body">
      <div class="ln"><span class="pr">›</span> factory new "landing page"</div>
      <div class="ln"><span class="ok">✓</span> repo · foundation plan seeded</div>
      <div class="ln"><span class="ok">✓</span> hive up · 2 agents joined</div>
      <div class="ln"><span class="dim">⋯ building lanes: hero, copy</span></div>
      <div class="ln"><span class="ok">✓</span> gate: 12/12 · mutant killed</div>
      <div class="ln"><span class="ok">✓</span> shipped v0.1.0 · <span class="ok">live</span></div>
    </div>`;
  // room
  const room = document.createElement("div");
  room.className = "win room";
  room.style.cssText = wide ? "left:3%;top:40%;width:80%;" : "left:6%;top:30%;width:42%;";
  room.innerHTML = `<div class="tb"><i></i><i></i><i></i><span class="ttl">#stranded · apiary</span></div>
    <div class="body">
      <div class="msg"><div class="av">A</div><div><div class="who">aria</div><div class="txt">claimed lane <b>hero</b> — building the header + CTA.</div></div></div>
      <div class="msg"><div class="av">B</div><div><div class="who">bruno</div><div class="txt">on <b>copy</b>. will hand you the strings.</div></div></div>
      <div class="msg"><div class="av">A</div><div><div class="who">aria</div><div class="txt">DONE hero — gorlitzer-labs/site#3 ✓</div></div></div>
    </div>`;
  // board
  const board = document.createElement("div");
  board.className = "win board";
  board.style.cssText = wide ? "left:12%;top:66%;width:76%;" : "right:12%;bottom:12%;width:34%;";
  board.innerHTML = `<div class="tb"><i></i><i></i><i></i><span class="ttl">factory board</span></div>
    <div class="body">
      <div class="row"><span class="g gi">●</span><span class="nm">aria</span><span class="st">idle · ready</span></div>
      <div class="row"><span class="g gw">◐</span><span class="nm">bruno</span><span class="st">working</span></div>
      <div class="row"><span class="g gb">■</span><span class="nm">carel</span><span class="st">needs you</span></div>
    </div>`;
  surfaces.append(term, room, board);
  return { term, room, board };
}
function buildupTimeline() {
  const { term, room, board } = buildSurfaces();
  const tl = gsap.timeline({ paused: true });
  tl.from(term, { opacity: 0, y: 40, scale: 0.96, duration: 0.7, ease: "power3.out" }, 0.2);
  tl.to(term.querySelectorAll(".ln"), { opacity: 1, duration: 0.35, stagger: 0.55, ease: "none" }, 0.8);
  tl.from(room, { opacity: 0, y: 40, scale: 0.96, duration: 0.7, ease: "power3.out" }, 1.4);
  tl.to(room.querySelectorAll(".msg"), { opacity: 1, y: 0, duration: 0.4, stagger: 0.7, ease: "power2.out" }, 2.0);
  tl.from(board, { opacity: 0, y: 40, scale: 0.96, duration: 0.7, ease: "power3.out" }, 3.0);
  tl.to(board.querySelectorAll(".row"), { opacity: 1, duration: 0.4, stagger: 0.4 }, 3.6);
  tl.set(term, {}, "+=1"); // hold
  return tl;
}

/* ---------------- Scene: COMBOS ---------------- */
const combogrid = document.getElementById("combogrid");
const cvTitle = document.getElementById("cvTitle");
const cvGood = document.getElementById("cvGood");
const cvWeak = document.getElementById("cvWeak");
const state = {}; MODULES.forEach((m) => (state[m.id] = true));
MODULES.forEach((m) => {
  const b = document.createElement("button");
  b.className = "cm"; b.type = "button"; b.dataset.id = m.id; b.setAttribute("aria-pressed", "true");
  b.innerHTML = `<div class="cnm">${m.nm}</div><div class="crl">${m.role}</div>`;
  b.addEventListener("click", () => { state[m.id] = !state[m.id]; b.setAttribute("aria-pressed", String(state[m.id])); renderVerdict(); });
  combogrid.appendChild(b);
});
function fitness(S) {
  const f = S.foundation, a = S.apiary, fac = S.factory, c = S.comb, b = S.bifrost, d = S.demerzel;
  const core = f && a && fac;
  if (core && c && b && d) return { t: "The whole factory", g: ["Runs 24/7, unattended", "Agents across machines", "Credentials that travel, safely", "Steer it by voice"], w: ["Nothing held back"] };
  if (core && c && b) return { t: "Headless factory, across machines", g: ["Unattended multi-machine runs", "Safe remote credentials", "Scriptable / CI-friendly"], w: ["No voice — you drive by terminal"] };
  if (core && c) return { t: "Single-machine autonomy", g: ["Solo-repo, hands-off builds", "Secrets never leak"], w: ["No remote agents", "No phone, no voice"] };
  if (core) return { t: "Supervised build, one box", g: ["Coordinated multi-agent builds", "Heals & escalates"], w: ["Remote agents blind — no keys", "One machine only"] };
  if (a && f) return { t: "A hive with a plan", g: ["Agents coordinate to a shared plan", "Good for human-driven pairing"], w: ["No supervisor — nothing heals or escalates", "Not yet a factory"] };
  if (a) return { t: "A chat room for agents", g: ["Quick multi-agent coordination", "A demo"], w: ["No plan", "No supervision, no record of done"] };
  if (f) return { t: "A project skeleton", g: ["Structure, a queue, a record"], w: ["No agents at all"] };
  return { t: "Loose parts", g: ["Each piece still works alone"], w: ["No loop — turn on foundation + apiary + factory"] };
}
function renderVerdict() {
  const v = fitness(state);
  cvTitle.textContent = v.t;
  cvGood.innerHTML = v.g.map((x) => `<li>${x}</li>`).join("");
  cvWeak.innerHTML = v.w.map((x) => `<li>${x}</li>`).join("");
}
function setCombo(ids) {
  MODULES.forEach((m) => {
    state[m.id] = ids.includes(m.id);
    const b = combogrid.querySelector(`[data-id="${m.id}"]`);
    if (b) b.setAttribute("aria-pressed", String(state[m.id]));
  });
  renderVerdict();
}
const ALL = MODULES.map((m) => m.id);
renderVerdict();
function combosTimeline() {
  const tl = gsap.timeline({ paused: true });
  const walk = [
    { at: 0.2, ids: ALL },
    { at: 5, ids: ["foundation", "apiary", "factory", "comb", "bifrost"] },
    { at: 10, ids: ["foundation", "apiary", "factory"] },
    { at: 15, ids: ["foundation", "apiary"] },
    { at: 20, ids: ["apiary"] },
    { at: 25, ids: ALL },
  ];
  walk.forEach((step) => tl.call(() => setCombo(step.ids), null, step.at));
  return tl;
}

/* ---------------- topology wires ---------------- */
function layoutTopo() {
  const topo = document.getElementById("topo"); if (!topo) return;
  const wires = document.getElementById("wires");
  const ns = Array.from(topo.querySelectorAll(".mnode")), w = topo.clientWidth, h = topo.clientHeight;
  const pt = (el) => [parseFloat(el.style.left) / 100 * w, parseFloat(el.style.top) / 100 * h];
  if (ns.length >= 3) { const a = pt(ns[0]), b = pt(ns[1]), c = pt(ns[2]);
    wires.innerHTML = `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/><line x1="${b[0]}" y1="${b[1]}" x2="${c[0]}" y2="${c[1]}"/><line x1="${a[0]}" y1="${a[1]}" x2="${c[0]}" y2="${c[1]}"/>`; }
}
layoutTopo();

/* ---------------- scene registry ---------------- */
const sceneTL = new Array(slides.length).fill(null);
function sceneFor(i) {
  const s = slides[i], kind = s.dataset.scene;
  if (kind === "assembly") return assemblyTimeline();
  if (kind === "buildup") return buildupTimeline();
  if (kind === "combos") return combosTimeline();
  return genericEnter(s);
}
function resetScenes() { // on resize: drop geometry-dependent caches
  [4, 5].forEach((i) => { if (sceneTL[i]) { sceneTL[i].kill(); sceneTL[i] = null; } });
  asmBuilt = false;
}

/* ---------------- controller ---------------- */
slides.forEach((s, i) => { const d = document.createElement("button"); d.className = "dot2"; d.setAttribute("aria-label", "Slide " + (i + 1)); d.addEventListener("click", () => go(i)); dotsEl.appendChild(d); });
const dots = Array.from(dotsEl.children);
const dur = (i) => (parseInt(slides[i].dataset.dur, 10) || 14) * 1000;
let idx = 0, playing = !reduce, timer = 0, pbarTween = null;

function playEnter(i) {
  if (reduce) { if (slides[i].dataset.scene === "combos") setCombo(ALL); return; }
  if (sceneTL[i]) sceneTL[i].kill();
  sceneTL[i] = sceneFor(i);
  sceneTL[i].restart();
}
function runBar(i) {
  if (pbarTween) pbarTween.kill(); gsap.set(pbar, { width: "0%" });
  if (playing && !reduce) pbarTween = gsap.to(pbar, { width: "100%", duration: dur(i) / 1000, ease: "none" });
}
function go(i) {
  if (i < 0) i = slides.length - 1; if (i >= slides.length) i = 0;
  clearTimeout(timer);
  if (sceneTL[idx]) sceneTL[idx].pause();
  slides[idx].classList.remove("active");
  idx = i; slides[idx].classList.add("active");
  dots.forEach((d, k) => d.classList.toggle("on", k === idx));
  counter.textContent = (idx + 1) + " / " + slides.length;
  playEnter(idx); runBar(idx); schedule();
}
function schedule() { clearTimeout(timer); if (playing && !reduce) timer = setTimeout(() => go(idx + 1), dur(idx)); }
function setPlay(p) {
  playing = p; ppBtn.textContent = p ? "❚❚" : "▶"; ppBtn.setAttribute("aria-label", p ? "Pause" : "Play");
  if (p) { if (sceneTL[idx]) sceneTL[idx].resume(); runBar(idx); schedule(); }
  else { clearTimeout(timer); if (pbarTween) pbarTween.pause(); if (sceneTL[idx]) sceneTL[idx].pause(); }
}
document.getElementById("next").addEventListener("click", () => go(idx + 1));
document.getElementById("prev").addEventListener("click", () => go(idx - 1));
ppBtn.addEventListener("click", () => setPlay(!playing));
addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") { go(idx + 1); e.preventDefault(); }
  else if (e.key === "ArrowLeft") { go(idx - 1); e.preventDefault(); }
  else if (e.key === " ") { setPlay(!playing); e.preventDefault(); }
});

// boot
slides[0].classList.add("active"); dots[0].classList.add("on");
if (reduce) { ppBtn.textContent = "▶"; ppBtn.setAttribute("aria-label", "Play"); playEnter(0); }
else { playEnter(0); runBar(0); schedule(); }
const total = slides.reduce((a, s) => a + (parseInt(s.dataset.dur, 10) || 14), 0);
ppBtn.title = `~${Math.round(total / 60)} min reel — press ▶, then screen-record for a video`;
