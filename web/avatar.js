// Boomer's face: a volumetric scan-line figure.
//
// There is no rigged model to drive, so the figure is procedural: a humanoid
// radius profile sampled into stacked contour rings, with a scan plane sweeping
// through it. That reads as a hologram the way a medical scan does, needs no
// asset, and every parameter is something real state can drive.
//
// It is a pure consumer of the protocol in boomer/protocol.py -- it knows the
// four states and an audio level, nothing else. It cannot affect a turn.
//
// three.js is vendored in web/vendor/, not loaded from a CDN: a CDN would break
// the loopback-only property and fail with the network off.

import * as THREE from './vendor/three.module.js';

// The figure is a wireframe mannequin: horizontal contour rings tied together
// by longitudinal lines. Three earlier attempts and one screenshot taught the
// constraints:
//
//   * A single body of revolution has no limbs -- it reads as a robed column.
//   * POINTS are the wrong primitive. Ring points bunch at the silhouette and
//     go sparse across the face, so a torso renders as a dark mass with a bright
//     rim, and thin arms become ladder rungs. Contours want to be LINES.
//   * Proportions have to come from the figure canon, not from taste. Legs at
//     radius 0.06 over 1.38 units are 1:23 and read as a stalk.
//
// So: lines, and the classical 7.5-head canon. All values below are fractions of
// total height, which is what makes them checkable against the canon.

const FIGURE_HEIGHT = 2.55;
const SEG = 30;             // points around each ring
const LONGS = 10;           // longitudinal lines tying the rings together

// Vertical landmarks as fractions of total height (feet 0 -> crown 1).
const Y = {
  foot: 0.00, ankle: 0.045, calf: 0.16, knee: 0.265, thigh: 0.37,
  crotch: 0.47, hip: 0.515, waist: 0.60, chest: 0.70, shoulder: 0.795,
  neck: 0.835, chin: 0.865, eyes: 0.925, crown: 1.00,
  wrist: 0.475, elbow: 0.615,
};

// [y, radius] -- radius also as a fraction of height, so proportions hold at
// any scale. Shoulder radius 0.105 gives a breadth of ~2 head widths.
const TORSO = [
  [Y.crotch, 0.098], [Y.hip, 0.104], [Y.waist, 0.080],
  [Y.chest, 0.098], [Y.shoulder, 0.105],
  [Y.neck, 0.040], [Y.chin, 0.036],
  [Y.eyes, 0.062], [0.965, 0.058], [Y.crown, 0.030],
];
const LEG = [
  [Y.foot, 0.030], [Y.ankle, 0.024], [Y.calf, 0.040],
  [Y.knee, 0.033], [Y.thigh, 0.046], [Y.crotch, 0.052],
];
const ARM = [
  [0.455, 0.017], [Y.wrist, 0.016], [0.545, 0.021],
  [Y.elbow, 0.024], [0.72, 0.031], [Y.shoulder, 0.036],
];

const PARTS = [
  { profile: TORSO, dx: 0.000, rings: 26, squash: 0.62 },
  { profile: LEG,   dx: -0.048, rings: 14, squash: 0.92 },
  { profile: LEG,   dx: 0.048, rings: 14, squash: 0.92 },
  { profile: ARM,   dx: -0.122, rings: 12, squash: 0.92 },
  { profile: ARM,   dx: 0.122, rings: 12, squash: 0.92 },
];

function sampleProfile(profile, y) {
  const lo = profile[0], hi = profile[profile.length - 1];
  if (y <= lo[0]) return lo[1];
  if (y >= hi[0]) return hi[1];
  for (let i = 0; i < profile.length - 1; i++) {
    const [a, r0] = profile[i], [b, r1] = profile[i + 1];
    if (y >= a && y <= b) {
      const k = (y - a) / (b - a || 1);
      return r0 + (r1 - r0) * (k * k * (3 - 2 * k));
    }
  }
  return hi[1];
}

/** Ring vertex at part-local height y and angle a. */
function vertex(part, y, a) {
  const r = sampleProfile(part.profile, y);
  return [part.dx + Math.cos(a) * r, y * FIGURE_HEIGHT, Math.sin(a) * r * part.squash];
}

const VERT = `
  uniform float uTime, uScan, uBreath, uAgitation, uLevel;
  attribute float aT;
  varying float vGlow;
  varying float vT;

  void main() {
    vT = aT;
    vec3 p = position;

    // Breathing: the chest expands, the limbs barely move.
    float chest = smoothstep(0.58, 0.78, aT) * (1.0 - smoothstep(0.78, 0.86, aT));
    p.xz *= 1.0 + uBreath * chest * 0.13;

    // Speaking pushes the head and jaw, driven by real playback audio.
    float head = smoothstep(0.85, 0.98, aT);
    p.xz *= 1.0 + uLevel * head * 0.34;

    // Thinking shears the figure very slightly, like a settling hologram.
    float tw = sin(aT * 7.0 + uTime * 2.0) * uAgitation * 0.035;
    p.x += tw; p.z += tw * 0.5;

    // The scan plane travelling up the body.
    float d = abs(aT - uScan);
    vGlow = exp(-d * d * 420.0);
    p.xz *= 1.0 + vGlow * 0.03;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;

const FRAG = `
  precision mediump float;
  uniform vec3 uColor, uScanColor;
  uniform float uOpacity;
  varying float vGlow;
  varying float vT;

  void main() {
    // Dissolve the extremities so she fades rather than being cut off.
    float ends = smoothstep(0.0, 0.05, vT) * (1.0 - smoothstep(0.97, 1.02, vT));
    vec3 col = mix(uColor, uScanColor, clamp(vGlow * 1.2, 0.0, 1.0));
    float a = uOpacity * ends * (0.34 + vGlow * 0.66);
    gl_FragColor = vec4(col, a);
  }`;

const PALETTE = {
  idle:      { color: 0x1f5f7a, scan: 0x9fe8ff, opacity: 0.62, agitation: 0.0, scanSpeed: 0.10 },
  listening: { color: 0x2f9f74, scan: 0xd6ffe8, opacity: 1.00, agitation: 0.05, scanSpeed: 0.32 },
  thinking:  { color: 0xb08a2a, scan: 0xffe9b8, opacity: 0.95, agitation: 1.0,  scanSpeed: 0.70 },
  speaking:  { color: 0x2b8fc4, scan: 0xdff4ff, opacity: 1.00, agitation: 0.22, scanSpeed: 0.42 },
  busy:      { color: 0x8a3346, scan: 0xffc2ce, opacity: 0.45, agitation: 0.0,  scanSpeed: 0.05 },
  offline:   { color: 0x2b3540, scan: 0x53687d, opacity: 0.30, agitation: 0.0,  scanSpeed: 0.03 },
};

export function createAvatar(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas, alpha: true, antialias: true,
    // Only so a headless check can read the framebuffer back.
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  // Framed so she fills the canvas: an earlier build left her small and lost in
  // empty space, which flattened everything.
  const mid = FIGURE_HEIGHT * 0.52;
  camera.position.set(0, mid + 0.10, 4.45);
  camera.lookAt(0, mid, 0);

  // --- the figure: contour rings + longitudinal lines ---------------------
  const verts = [], ts = [];
  const seg = (a, b) => {
    verts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    ts.push(a[1] / FIGURE_HEIGHT, b[1] / FIGURE_HEIGHT);
  };
  for (const part of PARTS) {
    const y0 = part.profile[0][0], y1 = part.profile[part.profile.length - 1][0];
    const ys = [];
    for (let i = 0; i < part.rings; i++) {
      ys.push(y0 + (y1 - y0) * (i / (part.rings - 1)));
    }
    // rings
    for (const y of ys) {
      for (let j = 0; j < SEG; j++) {
        const a0 = (j / SEG) * Math.PI * 2, a1 = ((j + 1) / SEG) * Math.PI * 2;
        seg(vertex(part, y, a0), vertex(part, y, a1));
      }
    }
    // longitudinals: without these the rings float as separate hoops
    for (let k = 0; k < LONGS; k++) {
      const a = (k / LONGS) * Math.PI * 2;
      for (let i = 0; i < ys.length - 1; i++) {
        seg(vertex(part, ys[i], a), vertex(part, ys[i + 1], a));
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('aT', new THREE.Float32BufferAttribute(ts, 1));

  const uniforms = {
    uTime: { value: 0 }, uScan: { value: 0 }, uBreath: { value: 0 },
    uAgitation: { value: 0 }, uLevel: { value: 0 },
    uColor: { value: new THREE.Color(PALETTE.offline.color) },
    uScanColor: { value: new THREE.Color(PALETTE.offline.scan) },
    uOpacity: { value: PALETTE.offline.opacity },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const figure = new THREE.LineSegments(geo, mat);
  scene.add(figure);

  // --- floor: a grid that ripples, so she is standing on something --------
  const floorGeo = new THREE.BufferGeometry();
  const gridN = 20, half = 1.5, lines = [];
  for (let i = 0; i <= gridN; i++) {
    const q = -half + (i / gridN) * half * 2;
    lines.push(q, 0, -half, q, 0, half, -half, 0, q, half, 0, q);
  }
  floorGeo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  const floorMat = new THREE.ShaderMaterial({
    uniforms: { uTime: uniforms.uTime, uColor: uniforms.uScanColor, uOpacity: uniforms.uOpacity },
    vertexShader: `
      uniform float uTime;
      varying float vFade;
      void main() {
        vec3 p = position;
        float d = length(p.xz);
        p.y += sin(d * 4.0 - uTime * 1.5) * 0.030 * exp(-d * 0.7);
        vFade = 1.0 - smoothstep(0.25, 1.45, d);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      precision mediump float;
      uniform vec3 uColor; uniform float uOpacity;
      varying float vFade;
      void main() { gl_FragColor = vec4(uColor, vFade * uOpacity * 0.22); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  scene.add(new THREE.LineSegments(floorGeo, floorMat));

  // --- state ---------------------------------------------------------------
  let target = PALETTE.offline;
  let scanSpeed = target.scanSpeed;
  let levelDecay = 0;
  const col = new THREE.Color(), scanCol = new THREE.Color();
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    const w = canvas.clientWidth || 320, h = canvas.clientHeight || 420;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  let raf = 0;
  const t0 = performance.now();
  function frame(now) {
    const t = (now - t0) / 1000;
    uniforms.uTime.value = t;

    const k = calm ? 1 : 0.055;
    col.setHex(target.color); scanCol.setHex(target.scan);
    uniforms.uColor.value.lerp(col, k);
    uniforms.uScanColor.value.lerp(scanCol, k);
    uniforms.uOpacity.value += (target.opacity - uniforms.uOpacity.value) * k;
    uniforms.uAgitation.value += (target.agitation - uniforms.uAgitation.value) * k;
    scanSpeed += (target.scanSpeed - scanSpeed) * k;

    // 0..1.15 so there is a beat between sweeps rather than a strobe.
    uniforms.uScan.value = (uniforms.uScan.value + scanSpeed * 0.016) % 1.15;
    uniforms.uBreath.value = calm ? 0 : Math.sin(t * 0.85) * 0.5 + 0.5;

    levelDecay *= 0.90;
    uniforms.uLevel.value += (levelDecay - uniforms.uLevel.value) * 0.30;

    figure.rotation.y = calm ? 0 : Math.sin(t * 0.14) * 0.20;

    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    setState(name) { target = PALETTE[name] || PALETTE.idle; },
    /** amplitude 0..1 from the audio actually being played */
    setLevel(v) { levelDecay = Math.max(levelDecay, Math.min(1, v)); },
    stats() {
      return { calls: renderer.info.render.calls, lines: renderer.info.render.lines,
               state: Object.keys(PALETTE).find((s) => PALETTE[s] === target),
               scan: +uniforms.uScan.value.toFixed(3),
               opacity: +uniforms.uOpacity.value.toFixed(3) };
    },
    /** Coverage map for headless verification. */
    capture(cols = 40, rows = 32) {
      renderer.render(scene, camera);
      const gl = renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const cell = [];
      let max = 0, total = 0;
      for (let r = 0; r < rows; r++) {
        cell.push([]);
        for (let c = 0; c < cols; c++) {
          const y0 = Math.floor((rows - 1 - r) * h / rows), y1 = Math.floor((rows - r) * h / rows);
          const x0 = Math.floor(c * w / cols), x1 = Math.floor((c + 1) * w / cols);
          let sum = 0, n = 0;
          for (let y = y0; y < y1; y += 2) {
            for (let x = x0; x < x1; x += 2) {
              const i = (y * w + x) * 4;
              // RGB only: multiplying by alpha double-attenuates an additively
              // blended transparent canvas.
              sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
              n++;
            }
          }
          const v = n ? sum / n : 0;
          cell[r].push(v);
          if (v > max) max = v;
          total += v;
        }
      }
      const art = cell.map((row) => row.map((v) => {
        const q = max > 0 ? v / max : 0;
        return q > 0.55 ? '#' : q > 0.28 ? '+' : q > 0.08 ? '.' : ' ';
      }).join('')).join('\n');
      return { art, maxBrightness: +max.toFixed(1),
               meanBrightness: +(total / (rows * cols)).toFixed(2) };
    },
    dispose() {
      cancelAnimationFrame(raf); ro.disconnect();
      geo.dispose(); mat.dispose(); floorGeo.dispose(); floorMat.dispose();
      renderer.dispose();
    },
  };
}
