// Boomer's presence: a reactive core, not a body.
//
// The first version was a humanoid wireframe, borrowed from the Reddit build
// that inspired this project. That was the wrong idea twice over: he wanted a
// specific character and had a rigged model, and a mannequin at low fidelity
// reads as uncanny rather than alive. A voice assistant has no body -- JARVIS,
// Siri and Alexa are all reactive geometry, because what needs representing is
// attention, thought and speech, not anatomy.
//
// So: an iris that dilates, a spectrum ring driven by real audio, and orbital
// rings whose motion encodes state. Every element is tied to something true --
// nothing here is decoration that moves on a timer for its own sake.
//
// three.js is vendored in web/vendor/, not CDN-loaded: a CDN would break the
// loopback-only property and fail with the network off.

import * as THREE from './vendor/three.module.js';

const BARS = 96;            // spectrum ring resolution
const IRIS_RINGS = 5;
const RING_SEG = 180;       // smoothness of a circle

// `base` is the identity of a state and carries the bright elements. `hot` is
// only reached on an audio peak. An earlier version had this inverted -- near
// white on the iris and spectrum, saturation only on the faint outer rings --
// which is exactly why the whole thing read as grey.
const PALETTE = {
  offline:   { base: 0x35506b, hot: 0x8fb4d6, iris: 0.30, spin: 0.05, glow: 0.35 },
  idle:      { base: 0x1FA8D8, hot: 0xd8f4ff, iris: 0.46, spin: 0.16, glow: 0.80 },
  listening: { base: 0x18E08A, hot: 0xd8fff0, iris: 0.80, spin: 0.34, glow: 1.00 },
  thinking:  { base: 0xFFB020, hot: 0xfff0cf, iris: 0.55, spin: 1.05, glow: 1.00 },
  speaking:  { base: 0x35C8FF, hot: 0xf0fbff, iris: 0.66, spin: 0.42, glow: 1.00 },
  busy:      { base: 0xFF4D6D, hot: 0xffd0da, iris: 0.24, spin: 0.04, glow: 0.55 },
};

/** Resample FFT bins onto the half-ring, log-ish because speech energy bunches
 *  low and a linear sweep leaves most bars flat. */
function resample(bins) {
  if (!bins || !bins.length) return null;
  const half = Math.floor(BARS / 2);
  const out = new Uint8Array(BARS);
  for (let i = 0; i < half; i++) {
    const f = Math.pow(i / half, 1.7);
    out[i] = bins[Math.min(bins.length - 1, Math.floor(f * bins.length * 0.7))];
  }
  return out;
}

// WebGL clamps line width to 1 physical pixel on essentially every platform --
// LineBasicMaterial.linewidth is silently ignored. Hairlines at devicePixelRatio
// 2 antialias down to a grey smear, which is why earlier versions looked washed
// out no matter how the colours were tuned. Everything visible is therefore a
// mesh with a real stroke width.
function ringMesh(radius, width, segments = RING_SEG) {
  return new THREE.RingGeometry(radius - width / 2, radius + width / 2, segments);
}

/** A buffer of `count` quads, written each frame as radial bars. */
function barBuffer(count) {
  const pos = new Float32Array(count * 6 * 3);      // 2 triangles per bar
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return { pos, geo };
}

/** Write one bar as a quad from r0 to r1 at angle a, `w` wide. */
function writeBar(pos, i, a, r0, r1, w) {
  const ca = Math.cos(a), sa = Math.sin(a);
  const nx = -sa * w / 2, ny = ca * w / 2;          // perpendicular
  const ax = ca * r0, ay = sa * r0, bx = ca * r1, by = sa * r1;
  const v = [ax - nx, ay - ny, ax + nx, ay + ny, bx + nx, by + ny,
             ax - nx, ay - ny, bx + nx, by + ny, bx - nx, by - ny];
  for (let k = 0; k < 6; k++) {
    pos[i * 18 + k * 3] = v[k * 2];
    pos[i * 18 + k * 3 + 1] = v[k * 2 + 1];
    pos[i * 18 + k * 3 + 2] = 0;
  }
}

export function createAvatar(canvas) {
  // Opaque, not alpha:true. Additive blending never accumulates into the alpha
  // channel, so a transparent canvas composites the glow against the page and
  // mutes it to grey. Clearing to the page colour instead lets additive light
  // build against a real black.
  const renderer = new THREE.WebGLRenderer({
    canvas, alpha: false, antialias: true, preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x070a0e, 1);

  const scene = new THREE.Scene();
  // Orthographic: this is an instrument read head-on, not an object in a room.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 3;

  const root = new THREE.Group();
  scene.add(root);

  const col = { base: new THREE.Color(PALETTE.offline.base),
                hot: new THREE.Color(PALETTE.offline.hot) };

  // --- iris: concentric rings that dilate with attention -------------------
  const iris = [];
  for (let i = 0; i < IRIS_RINGS; i++) {
    const r = 0.16 + i * 0.052;
    const mat = new THREE.MeshBasicMaterial({
      color: col.hot.clone(), transparent: true, opacity: 0.9 - i * 0.13,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const line = new THREE.Mesh(ringMesh(r, 0.007 + (IRIS_RINGS - i) * 0.0022), mat);
    root.add(line);
    iris.push({ line, mat, r0: r, phase: i * 0.7 });
  }

  // --- core: a filled disc that carries the audio level --------------------
  const coreMat = new THREE.MeshBasicMaterial({
    color: col.hot.clone(), transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const core = new THREE.Mesh(new THREE.CircleGeometry(0.115, 64), coreMat);
  root.add(core);

  // --- spectrum ring: BOTH voices, on one shared baseline -----------------
  // Hers grows outward, yours grows inward from the same circle. When both move
  // at once the bars meet, so the overlap itself shows a barge-in -- there is no
  // separate indicator to read.
  const SPEC_R = 0.46;
  function makeSpectrum(color) {
    const { pos, geo } = barBuffer(BARS);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color), transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    root.add(new THREE.Mesh(geo, mat));
    return { pos, geo, mat };
  }
  const hers = makeSpectrum(0x35C8FF);
  // Yours keeps a fixed identity regardless of her state, so you always know
  // which side of the conversation you are looking at.
  const MINE = 0xFF9E3D;
  const mine = makeSpectrum(MINE);

  // --- orbital rings: state as motion --------------------------------------
  const orbits = [];
  for (const [r, tilt, speed, op] of [[0.60, 0.9, 1.0, 0.40],
                                      [0.72, -0.5, -0.62, 0.28],
                                      [0.86, 0.28, 0.34, 0.18]]) {
    const mat = new THREE.MeshBasicMaterial({
      color: col.base.clone(), transparent: true, opacity: op,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const line = new THREE.Mesh(ringMesh(r, 0.005), mat);
    line.rotation.x = tilt;
    root.add(line);
    orbits.push({ line, mat, speed, op });
  }

  // --- tick marks: an outer scale, so it reads as an instrument ------------
  const TICKS = 60;
  const tickBuf = barBuffer(TICKS);
  for (let i = 0; i < TICKS; i++) {
    const a = (i / TICKS) * Math.PI * 2;
    const long = i % 5 === 0;
    writeBar(tickBuf.pos, i, a, 0.94, 0.94 + (long ? 0.06 : 0.028), long ? 0.012 : 0.007);
  }
  const tickMat = new THREE.MeshBasicMaterial({
    color: col.base.clone(), transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const ticks = new THREE.Mesh(tickBuf.geo, tickMat);
  root.add(ticks);

  // --- state ---------------------------------------------------------------
  let target = PALETTE.offline;
  let level = 0, levelTarget = 0;              // her voice
  let levelMine = 0, levelMineTarget = 0;      // yours
  let spectrum = new Uint8Array(BARS);
  let spectrumMine = new Uint8Array(BARS);
  let spin = target.spin, irisOpen = target.iris, glow = target.glow;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    const w = canvas.clientWidth || 320, h = canvas.clientHeight || 400;
    renderer.setSize(w, h, false);
    // Keep the core circular whatever the canvas aspect.
    const a = w / h;
    camera.left = a > 1 ? -a : -1;
    camera.right = a > 1 ? a : 1;
    camera.top = a > 1 ? 1 : 1 / a;
    camera.bottom = a > 1 ? -1 : -1 / a;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  let raf = 0;
  const t0 = performance.now();

  function frame(now) {
    const t = (now - t0) / 1000;
    const k = calm ? 1 : 0.08;

    col.base.lerp(new THREE.Color(target.base), k);
    col.hot.lerp(new THREE.Color(target.hot), k);
    spin += (target.spin - spin) * k;
    irisOpen += (target.iris - irisOpen) * k;
    glow += (target.glow - glow) * k;
    level += (levelTarget - level) * 0.25;
    levelTarget *= 0.90;
    levelMine += (levelMineTarget - levelMine) * 0.3;
    levelMineTarget *= 0.88;

    // Iris: dilates with attention, breathes, and pulses with the voice.
    iris.forEach((r, i) => {
      const breathe = calm ? 0 : Math.sin(t * 1.1 + r.phase) * 0.012;
      const s = 0.62 + irisOpen * 0.62 + level * 0.16 + breathe;
      r.line.scale.setScalar(s);
      r.line.rotation.z = calm ? 0 : t * spin * (i % 2 ? -0.6 : 0.4);
      r.mat.color.copy(col.base).lerp(col.hot, level * 0.75);
      r.mat.opacity = (1.0 - i * 0.12) * glow;
    });

    coreMat.color.copy(col.base).lerp(col.hot, 0.25 + level * 0.7);
    coreMat.opacity = (0.30 + level * 0.60) * glow;
    core.scale.setScalar(0.9 + level * 0.35);

    // Both spectra, mirrored left/right so each reads as symmetric.
    const half = Math.floor(BARS / 2);
    const writeBars = (ring, bins, dir, scale) => {
      for (let i = 0; i < BARS; i++) {
        const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
        const idx = i < half ? i : BARS - 1 - i;
        const v = (bins[idx] || 0) / 255;
        const len = (0.014 + v * 0.26 * scale) * dir;
        writeBar(ring.pos, i, a, SPEC_R, SPEC_R + len, 0.016);
      }
      ring.geo.attributes.position.needsUpdate = true;
    };
    writeBars(hers, spectrum, +1, 0.4 + glow * 0.6);
    writeBars(mine, spectrumMine, -1, 0.9);
    hers.mat.color.copy(col.base).lerp(col.hot, level * 0.6);
    hers.mat.opacity = 0.45 + glow * 0.55;
    mine.mat.opacity = 0.35 + levelMine * 0.65;

    orbits.forEach((o, i) => {
      o.line.rotation.z = t * spin * o.speed;
      o.line.rotation.y = calm ? 0 : Math.sin(t * 0.3 + i) * 0.5;
      o.mat.color.copy(col.base).multiplyScalar(0.55);
      o.mat.opacity = o.op * (0.4 + glow * 0.8);
    });

    ticks.rotation.z = -t * spin * 0.18;
    tickMat.color.copy(col.base).multiplyScalar(0.7);
    tickMat.opacity = 0.25 + glow * 0.4;

    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    setState(name) { target = PALETTE[name] || PALETTE.idle; },
    /** her voice: amplitude 0..1 */
    setLevel(v) { levelTarget = Math.max(levelTarget, Math.min(1, v)); },
    /** your voice: amplitude 0..1 */
    setLevelMine(v) { levelMineTarget = Math.max(levelMineTarget, Math.min(1, v)); },
    /** her voice: frequency bins 0..255 */
    setSpectrum(bins) { spectrum = resample(bins) || spectrum; },
    /** your voice: frequency bins 0..255 */
    setSpectrumMine(bins) { spectrumMine = resample(bins) || spectrumMine; },
    stats() {
      return { calls: renderer.info.render.calls, lines: renderer.info.render.lines,
               state: Object.keys(PALETTE).find((s) => PALETTE[s] === target),
               level: +level.toFixed(3), levelMine: +levelMine.toFixed(3),
               iris: +irisOpen.toFixed(3) };
    },
    dispose() {
      cancelAnimationFrame(raf); ro.disconnect();
      iris.forEach((r) => { r.line.geometry.dispose(); r.mat.dispose(); });
      hers.geo.dispose(); hers.mat.dispose();
      mine.geo.dispose(); mine.mat.dispose();
      tickBuf.geo.dispose(); tickMat.dispose();
      orbits.forEach((o) => { o.line.geometry.dispose(); o.mat.dispose(); });
      core.geometry.dispose(); coreMat.dispose();
      renderer.dispose();
    },
  };
}
