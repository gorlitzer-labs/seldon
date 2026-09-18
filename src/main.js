// The Seldon Plan — a GSAP-driven pitch reel for the Seldon stack.
//
// Each slide owns a GSAP timeline built lazily on first entry. The reel
// auto-advances (per-slide `data-dur`), and you can drive it by hand with the
// arrows, space, the dots, or the buttons. prefers-reduced-motion drops all
// motion and shows every slide at rest.
import gsap from "gsap";

const reduce = matchMedia("(prefers-reduced-motion:reduce)").matches;
if (reduce) document.body.classList.add("reduced");

const slides = Array.from(document.querySelectorAll(".slide"));
const pbar = document.getElementById("pbar");
const counter = document.getElementById("counter");
const dotsEl = document.getElementById("dots");
const ppBtn = document.getElementById("playpause");

/* ---------- Prime Radiant backdrop (the plan as flowing math) ---------- */
(function radiant() {
  const cv = document.getElementById("radiant");
  const ctx = cv.getContext("2d");
  let ns = [], raf = 0;
  const GOLD = "#e8ad3c";
  function build() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ns = [];
    const n = Math.min(90, Math.floor((innerWidth * innerHeight) / 20000));
    for (let i = 0; i < n; i++) ns.push({
      x: Math.random() * innerWidth, y: Math.random() * innerHeight,
      r: Math.random() * 1.5 + 0.4, vx: (Math.random() - 0.5) * 0.12,
      vy: (Math.random() - 0.5) * 0.12, tw: Math.random() * 6, sp: 0.001 + Math.random() * 0.003,
    });
  }
  function draw(t) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (let i = 0; i < ns.length; i++) {
      const a = ns[i];
      for (let j = i + 1; j < ns.length; j++) {
        const b = ns[j], dx = a.x - b.x, dy = a.y - b.y, d = dx * dx + dy * dy;
        if (d < 13000) {
          ctx.strokeStyle = GOLD; ctx.globalAlpha = (1 - d / 13000) * 0.06; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    for (const p of ns) {
      if (!reduce) { p.x += p.vx; p.y += p.vy; if (p.x < 0 || p.x > innerWidth) p.vx *= -1; if (p.y < 0 || p.y > innerHeight) p.vy *= -1; }
      ctx.globalAlpha = 0.22 + 0.5 * Math.abs(Math.sin(t * p.sp + p.tw));
      ctx.fillStyle = GOLD; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (!reduce) raf = requestAnimationFrame(draw);
  }
  function boot() { cancelAnimationFrame(raf); build(); reduce ? draw(0) : (raf = requestAnimationFrame(draw)); }
  let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { boot(); layoutConstel(); layoutTopo(); }, 180); });
  boot();
})();

/* ---------- lay out the constellation (slide 11) ---------- */
const MODS = [
  { nm: "foundation", rl: "seam" }, { nm: "apiary", rl: "talk" },
  { nm: "factory", rl: "floor" }, { nm: "comb", rl: "vault" },
  { nm: "bifrost", rl: "bridge" }, { nm: "Demerzel", rl: "voice" },
];
const constel = document.getElementById("constel");
const linksSvg = document.getElementById("links");
const hexSVG = `<svg viewBox="0 0 60 60"><polygon points="30,4 54,18 54,42 30,56 6,42 6,18" fill="none" stroke="#e8ad3c" stroke-width="2"/><circle cx="30" cy="30" r="5" fill="#e8ad3c"/></svg>`;
MODS.forEach((m) => {
  const el = document.createElement("div");
  el.className = "node";
  el.innerHTML = `<div class="h">${hexSVG}</div><div class="lbl">${m.nm}</div><div class="rl">${m.rl}</div>`;
  constel.appendChild(el);
});
function layoutConstel() {
  const nodes = Array.from(constel.querySelectorAll(".node"));
  const w = constel.clientWidth, h = constel.clientHeight, cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.4;
  const pos = [];
  nodes.forEach((el, i) => {
    const a = -Math.PI / 2 + i * ((Math.PI * 2) / nodes.length);
    const x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
    el.style.left = x + "px"; el.style.top = y + "px"; pos.push([x, y]);
  });
  let s = "";
  for (let i = 0; i < pos.length; i++) {
    const n = (i + 1) % pos.length;
    s += `<line x1="${pos[i][0]}" y1="${pos[i][1]}" x2="${cx}" y2="${cy}"/>`;
    s += `<line x1="${pos[i][0]}" y1="${pos[i][1]}" x2="${pos[n][0]}" y2="${pos[n][1]}"/>`;
  }
  linksSvg.innerHTML = s;
}
layoutConstel();

/* ---------- topology wires (slide 15) ---------- */
function layoutTopo() {
  const topo = document.getElementById("topo");
  if (!topo) return;
  const wires = document.getElementById("wires");
  const ns = Array.from(topo.querySelectorAll(".mnode")), w = topo.clientWidth, h = topo.clientHeight;
  const pt = (el) => [parseFloat(el.style.left) / 100 * w, parseFloat(el.style.top) / 100 * h];
  if (ns.length >= 3) {
    const a = pt(ns[0]), b = pt(ns[1]), c = pt(ns[2]);
    wires.innerHTML =
      `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>` +
      `<line x1="${b[0]}" y1="${b[1]}" x2="${c[0]}" y2="${c[1]}"/>` +
      `<line x1="${a[0]}" y1="${a[1]}" x2="${c[0]}" y2="${c[1]}"/>`;
  }
}
layoutTopo();

/* ---------- removal demo grid (slide 12) ---------- */
const demogrid = document.getElementById("demogrid");
["foundation:seam", "apiary:talk", "factory:floor", "comb:vault", "bifrost:bridge", "Demerzel:voice"].forEach((s) => {
  const [nm, rl] = s.split(":");
  const d = document.createElement("div");
  d.className = "dm"; d.dataset.id = nm;
  d.innerHTML = `<div class="dnm">${nm}</div><div class="drl">${rl}</div>`;
  demogrid.appendChild(d);
});
const dverdict = document.getElementById("dverdict");
const dcap = document.getElementById("dcap");
const dtag = document.getElementById("dtag");

/* ---------- helper: draw an SVG stroke on via GSAP ---------- */
function drawOn(tl, selector, at, dur = 1.2) {
  const el = typeof selector === "string" ? document.querySelector(selector) : selector;
  if (!el) return;
  const len = el.getTotalLength ? el.getTotalLength() : 300;
  gsap.set(el, { strokeDasharray: len, strokeDashoffset: len });
  tl.to(el, { strokeDashoffset: 0, duration: dur, ease: "power2.out" }, at);
}

/* ---------- per-slide timeline builders ---------- */
function buildEnter(slide) {
  const tl = gsap.timeline({ paused: true });
  const anims = slide.querySelectorAll(".anim");
  if (anims.length) tl.from(anims, { opacity: 0, y: 20, filter: "blur(5px)", duration: 0.7, stagger: 0.14, ease: "power2.out" }, 0);

  // slide 1 — the mark draws
  if (slide.querySelector(".mark")) {
    slide.querySelectorAll(".mark .stroke").forEach((p, i) => drawOn(tl, p, 0.1 + i * 0.12, 1.0));
    tl.from(".mark .fl", { scale: 0, transformOrigin: "60px 60px", duration: 0.5, ease: "back.out(2)" }, 0.6);
  }
  // module slide — hex outline + inner glyph draw, dots pop
  if (slide.classList.contains("mod-slide")) {
    const hx = slide.querySelector(".emblem .hx");
    const gl = slide.querySelector(".emblem .gl");
    drawOn(tl, hx, 0.15, 1.1);
    if (gl) drawOn(tl, gl, 0.5, 1.2);
    const dots = slide.querySelectorAll(".emblem .dotmark");
    if (dots.length) tl.from(dots, { scale: 0, transformOrigin: "center", duration: 0.4, stagger: 0.08, ease: "back.out(2)" }, 1.1);
  }
  // slide 4 — the plan line grows then dots ignite
  if (slide.querySelector(".planline")) {
    tl.from(".planline", { scaleX: 0, transformOrigin: "left", duration: 1.4, ease: "power2.inOut" }, 0.3);
    tl.from(slide.querySelectorAll(".pstep"), { opacity: 0, y: 14, duration: 0.5, stagger: 0.22, ease: "power2.out" }, 0.4);
    tl.to(slide.querySelectorAll(".pstep .dot"), {
      background: "#e8ad3c", boxShadow: "0 0 22px 2px rgba(232,173,60,.55)", duration: 0.4, stagger: 0.22, ease: "power2.out",
    }, 0.5);
  }
  // slide 11 — constellation: nodes pop in a ring, links draw
  if (slide.querySelector("#constel")) {
    tl.from(slide.querySelectorAll(".node"), { opacity: 0, scale: 0.4, duration: 0.5, stagger: 0.1, ease: "back.out(1.6)" }, 0.3);
    tl.to(slide.querySelectorAll("#links line"), { opacity: 0.28, duration: 0.8, stagger: 0.03, ease: "power1.out" }, 0.7);
  }
  // slide 13 — e2e steps cascade
  if (slide.querySelector(".e2e")) {
    tl.from(slide.querySelectorAll(".estep"), { opacity: 0, x: -24, duration: 0.45, stagger: 0.12, ease: "power2.out" }, 0.4);
  }
  // slide 14 — benchmark bars fill
  if (slide.querySelector(".bench")) {
    slide.querySelectorAll(".bf").forEach((bf, i) => {
      tl.fromTo(bf, { width: 0 }, { width: bf.dataset.w, duration: 1.3, ease: "power2.out" }, 0.6 + i * 0.15);
    });
  }
  // slide 15 — machine discs + wires
  if (slide.querySelector("#topo")) {
    tl.from(slide.querySelectorAll(".mnode"), { opacity: 0, y: 18, duration: 0.5, stagger: 0.2, ease: "power2.out" }, 0.3);
    tl.from(slide.querySelectorAll(".mdisc"), { scale: 0, transformOrigin: "center", duration: 0.5, stagger: 0.2, ease: "back.out(1.8)" }, 0.4);
  }
  return tl;
}

/* ---------- the removal-demo sub-sequence (slide 12) ---------- */
function demoTimeline() {
  const tl = gsap.timeline({ paused: true });
  const off = (id) => `.dm[data-id="${id}"]`;
  const dim = { opacity: 0.18, filter: "grayscale(1)", scale: 0.94, duration: 0.5, ease: "power2.out" };
  const lit = { opacity: 1, filter: "grayscale(0)", scale: 1, duration: 0.5, ease: "power2.out" };
  const setText = (warn, v, cap, tag) => () => {
    dverdict.classList.toggle("warn", warn);
    dverdict.textContent = v; dcap.textContent = cap; dtag.textContent = tag || "";
  };
  // beat 0 — whole
  tl.call(setText(false, "The whole factory.", "Runs itself across machines, and you talk to it.", "all six · online"), null, 0);
  // beat 1 — remove comb
  tl.add(setText(true, "Remove the vault.", "Agents on other machines have no safe credentials — keys leak into transcripts.", "− comb"), 5);
  tl.to(off("comb"), dim, 5).fromTo(off("comb"), { borderColor: "#2a2f42" }, { borderColor: "#f0664c", duration: 0.5 }, 5);
  // beat 2 — remove factory
  tl.add(setText(true, "Remove the floor.", "Now it isn't a factory at all: dead agents stay dead, nothing heals, nothing escalates.", "− comb − factory"), 11);
  tl.to(off("factory"), dim, 11).fromTo(off("factory"), { borderColor: "#2a2f42" }, { borderColor: "#f0664c", duration: 0.5 }, 11);
  // beat 3 — restore
  tl.add(setText(false, "Back to whole.", "Foundation, apiary and factory close the loop; comb, bifrost and Demerzel extend it.", "restored"), 18);
  tl.to([off("comb"), off("factory")], { ...lit, borderColor: "#2a2f42" }, 18);
  return tl;
}

/* ---------- reel controller ---------- */
const timelines = new Array(slides.length).fill(null);
let demoTL = null;
let idx = 0, playing = !reduce, timer = 0, pbarTween = null;

slides.forEach((s, i) => {
  const d = document.createElement("button");
  d.className = "dot2"; d.setAttribute("aria-label", "Slide " + (i + 1));
  d.addEventListener("click", () => go(i));
  dotsEl.appendChild(d);
});
const dots = Array.from(dotsEl.children);
const dur = (i) => (parseInt(slides[i].dataset.dur, 10) || 14) * 1000;

function playEnter(i) {
  if (reduce) return;
  if (!timelines[i]) timelines[i] = buildEnter(slides[i]);
  timelines[i].restart();
  if (slides[i].id === "slide-demo") {
    if (!demoTL) demoTL = demoTimeline();
    demoTL.restart();
  }
}
function stopDemo() { if (demoTL) demoTL.pause(); }

function runBar(i) {
  if (pbarTween) pbarTween.kill();
  gsap.set(pbar, { width: "0%" });
  if (playing && !reduce) pbarTween = gsap.to(pbar, { width: "100%", duration: dur(i) / 1000, ease: "none" });
}

function go(i) {
  if (i < 0) i = slides.length - 1;
  if (i >= slides.length) i = 0;
  clearTimeout(timer);
  if (slides[idx].id === "slide-demo") stopDemo();
  slides[idx].classList.remove("active");
  idx = i;
  slides[idx].classList.add("active");
  dots.forEach((d, k) => d.classList.toggle("on", k === idx));
  counter.textContent = (idx + 1) + " / " + slides.length;
  playEnter(idx);
  runBar(idx);
  schedule();
}
function schedule() { clearTimeout(timer); if (playing && !reduce) timer = setTimeout(() => go(idx + 1), dur(idx)); }
function setPlay(p) {
  playing = p;
  ppBtn.textContent = p ? "❚❚" : "▶";
  ppBtn.setAttribute("aria-label", p ? "Pause" : "Play");
  if (p) { runBar(idx); schedule(); }
  else { clearTimeout(timer); if (pbarTween) pbarTween.pause(); }
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
slides[0].classList.add("active");
dots[0].classList.add("on");
if (reduce) { ppBtn.textContent = "▶"; ppBtn.setAttribute("aria-label", "Play"); }
else { playEnter(0); runBar(0); schedule(); }

const total = slides.reduce((a, s) => a + (parseInt(s.dataset.dur, 10) || 14), 0);
ppBtn.title = `~${Math.round(total / 60)} min reel — press ▶, then screen-record for a video`;
