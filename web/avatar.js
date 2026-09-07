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

// The figure is assembled from limbed parts, not one lathe. A single
// radius-per-height body of revolution was the first attempt and it reads as a
// robed column: below the hips it tapers to one trunk, and there are no arms.
// Verified by reading the framebuffer back as a coverage map.
//
// Each part is a stack of contour rings around its own axis, so legs and arms
// are separate volumes that happen to share the scan plane.

const FIGURE_HEIGHT = 2.6;
const SEGMENTS = 40;        // points per ring

// [t, radius] up each part, t normalised within the part's own span.
const TORSO = [
  [0.00, 0.140], [0.14, 0.122], [0.30, 0.128],   // hips, waist, ribs
  [0.52, 0.150], [0.66, 0.168],                  // chest, shoulders
  [0.76, 0.072], [0.80, 0.058],                  // neck
  [0.88, 0.086], [0.94, 0.094], [0.99, 0.074], [1.00, 0.040],   // head
];
const LEG = [
  [0.00, 0.052], [0.06, 0.044], [0.10, 0.040],   // foot, ankle
  [0.42, 0.058], [0.62, 0.062], [0.72, 0.066],   // calf, knee
  [1.00, 0.082],                                 // thigh into the hip
];
const ARM = [
  [0.00, 0.030], [0.10, 0.026],                  // hand, wrist
  [0.45, 0.034], [0.60, 0.036],                  // forearm, elbow
  [1.00, 0.052],                                 // upper arm into the shoulder
];

// Where each part sits: vertical span as a fraction of FIGURE_HEIGHT, plus a
// lateral offset so limbs are side by side rather than concentric.
const PARTS = [
  { profile: TORSO, y0: 0.50, y1: 1.00, dx: 0.000, rings: 60, squash: 0.72 },
  { profile: LEG,   y0: 0.00, y1: 0.53, dx: -0.062, rings: 34, squash: 0.95 },
  { profile: LEG,   y0: 0.00, y1: 0.53, dx: 0.062, rings: 34, squash: 0.95 },
  { profile: ARM,   y0: 0.44, y1: 0.80, dx: -0.196, rings: 26, squash: 0.95 },
  { profile: ARM,   y0: 0.44, y1: 0.80, dx: 0.196, rings: 26, squash: 0.95 },
];

function sampleProfile(profile, t) {
  for (let i = 0; i < profile.length - 1; i++) {
    const [a, r0] = profile[i], [b, r1] = profile[i + 1];
    if (t >= a && t <= b) {
      const k = (t - a) / (b - a || 1);
      return r0 + (r1 - r0) * (k * k * (3 - 2 * k));   // smoothstep
    }
  }
  return profile[profile.length - 1][1];
}

const VERT = `
  uniform float uTime, uScan, uBreath, uAgitation, uLevel;
  // Perspective-correct point sizing. uPointK = drawingBufferHeight /
  // (2 * tan(fov/2)), so a world-space radius maps to pixels. An earlier
  // hardcoded 300.0/-z produced 86-268 px points, which merged 7200 points into
  // one blob and hid the limbs entirely.
  uniform float uPointK;
  attribute float aT;        // 0..1 up the body
  attribute float aAngle;
  varying float vGlow;
  varying float vT;

  void main() {
    vT = aT;
    vec3 p = position;

    // Breathing: the chest expands more than the limbs.
    float chest = smoothstep(0.55, 0.80, aT) * (1.0 - smoothstep(0.80, 0.92, aT));
    p.xz *= 1.0 + uBreath * chest * 0.16;

    // Speaking pushes rings outward near the head, driven by real audio level.
    float head = smoothstep(0.84, 0.95, aT);
    p.xz *= 1.0 + uLevel * head * 0.5;

    // Agitation shears the figure while she is thinking.
    float tw = sin(aT * 9.0 + uTime * 2.2) * uAgitation * 0.05;
    p.x += tw; p.z += tw * 0.6;

    // The scan plane: a bright band travelling up the body.
    float d = abs(aT - uScan);
    vGlow = exp(-d * d * 260.0);

    // Rings near the scan plane bulge very slightly -- it reads as a pulse.
    p.xz *= 1.0 + vGlow * 0.05;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    // Size and alpha both used to spike at the scan plane, compounding to a
    // ~36x brightness ratio that made the band the only visible thing. Keep the
    // size boost modest and let colour carry the highlight.
    float worldSize = 0.0085 + vGlow * 0.005;
    gl_PointSize = clamp(worldSize * uPointK / -mv.z, 1.0, 9.0);
  }`;

const FRAG = `
  precision mediump float;
  uniform vec3 uColor, uScanColor;
  uniform float uOpacity;
  varying float vGlow;
  varying float vT;

  void main() {
    // Round points; discard the corners so they do not read as squares.
    vec2 c = gl_PointCoord - 0.5;
    float r = dot(c, c);
    if (r > 0.25) discard;
    float soft = 1.0 - smoothstep(0.0, 0.25, r);

    // Fade the extremities so the figure dissolves rather than being cut off.
    float ends = smoothstep(0.0, 0.10, vT) * (1.0 - smoothstep(0.94, 1.05, vT));
    vec3 col = mix(uColor, uScanColor, clamp(vGlow, 0.0, 1.0));
    float a = uOpacity * soft * ends * (0.55 + vGlow * 0.55);
    gl_FragColor = vec4(col, a);
  }`;

const PALETTE = {
  idle:      { color: 0x2f6f8f, scan: 0x8fd9ff, opacity: 0.55, agitation: 0.0, scanSpeed: 0.10 },
  listening: { color: 0x2f8f6a, scan: 0xb6ffcf, opacity: 0.95, agitation: 0.05, scanSpeed: 0.34 },
  thinking:  { color: 0x8f7a2f, scan: 0xffd98f, opacity: 0.90, agitation: 1.0,  scanSpeed: 0.75 },
  speaking:  { color: 0x2f7f9f, scan: 0xa8e8ff, opacity: 1.00, agitation: 0.25, scanSpeed: 0.45 },
  busy:      { color: 0x6a2f3a, scan: 0xff9fb0, opacity: 0.40, agitation: 0.0,  scanSpeed: 0.05 },
  offline:   { color: 0x39424d, scan: 0x5d7893, opacity: 0.28, agitation: 0.0,  scanSpeed: 0.03 },
};

export function createAvatar(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas, alpha: true, antialias: true,
    // Needed only so a headless check can read the framebuffer back and verify
    // the figure actually reads as a figure. Negligible cost at this scene size.
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(0, 1.45, 5.6);
  camera.lookAt(0, 1.25, 0);

  // --- the figure ---------------------------------------------------------
  const count = PARTS.reduce((n, p) => n + p.rings * SEGMENTS, 0);
  const pos = new Float32Array(count * 3);
  const aT = new Float32Array(count);
  const aAngle = new Float32Array(count);
  let n = 0;
  for (const part of PARTS) {
    for (let i = 0; i < part.rings; i++) {
      const local = i / (part.rings - 1);
      const r = sampleProfile(part.profile, local);
      // aT is height over the WHOLE figure, so one scan plane crosses every part.
      const t = part.y0 + (part.y1 - part.y0) * local;
      for (let j = 0; j < SEGMENTS; j++) {
        const a = (j / SEGMENTS) * Math.PI * 2;
        pos[n * 3] = part.dx + Math.cos(a) * r;
        pos[n * 3 + 1] = t * FIGURE_HEIGHT;
        pos[n * 3 + 2] = Math.sin(a) * r * part.squash;
        aT[n] = t;
        aAngle[n] = a;
        n++;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  geo.setAttribute('aAngle', new THREE.BufferAttribute(aAngle, 1));

  const uniforms = {
    uTime: { value: 0 }, uScan: { value: 0 }, uBreath: { value: 0 },
    uAgitation: { value: 0 }, uLevel: { value: 0 },
    uPointK: { value: 600 },
    uColor: { value: new THREE.Color(PALETTE.offline.color) },
    uScanColor: { value: new THREE.Color(PALETTE.offline.scan) },
    uOpacity: { value: PALETTE.offline.opacity },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const figure = new THREE.Points(geo, mat);
  scene.add(figure);

  // --- floor: a grid that ripples, so she is standing on something --------
  const floorGeo = new THREE.BufferGeometry();
  const gridN = 22, half = 2.2, lines = [];
  for (let i = 0; i <= gridN; i++) {
    const p = -half + (i / gridN) * half * 2;
    lines.push(p, 0, -half, p, 0, half, -half, 0, p, half, 0, p);
  }
  floorGeo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  const floorMat = new THREE.ShaderMaterial({
    uniforms: { uTime: uniforms.uTime, uColor: uniforms.uColor, uOpacity: uniforms.uOpacity },
    vertexShader: `
      uniform float uTime;
      varying float vFade;
      void main() {
        vec3 p = position;
        float d = length(p.xz);
        p.y += sin(d * 3.4 - uTime * 1.6) * 0.035 * exp(-d * 0.5);
        vFade = 1.0 - smoothstep(0.4, 2.2, d);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      precision mediump float;
      uniform vec3 uColor; uniform float uOpacity;
      varying float vFade;
      void main() { gl_FragColor = vec4(uColor, vFade * uOpacity * 0.30); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  scene.add(new THREE.LineSegments(floorGeo, floorMat));

  // --- state ---------------------------------------------------------------
  let target = PALETTE.offline;
  let scanSpeed = target.scanSpeed;
  let level = 0, levelDecay = 0;
  const col = new THREE.Color(), scanCol = new THREE.Color();

  // Respect a viewer who has asked for less motion.
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    const w = canvas.clientWidth || 320, h = canvas.clientHeight || 420;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Recomputed on resize so point size is stable across window sizes and DPR.
    const bufH = renderer.getContext().drawingBufferHeight || h;
    uniforms.uPointK.value = bufH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  let raf = 0, t0 = performance.now();
  function frame(now) {
    const t = (now - t0) / 1000;
    uniforms.uTime.value = t;

    // Ease toward the target look so state changes read as transitions.
    const k = calm ? 1 : 0.055;
    col.setHex(target.color); scanCol.setHex(target.scan);
    uniforms.uColor.value.lerp(col, k);
    uniforms.uScanColor.value.lerp(scanCol, k);
    uniforms.uOpacity.value += (target.opacity - uniforms.uOpacity.value) * k;
    uniforms.uAgitation.value += (target.agitation - uniforms.uAgitation.value) * k;
    scanSpeed += (target.scanSpeed - scanSpeed) * k;

    uniforms.uScan.value = (uniforms.uScan.value + scanSpeed * 0.016) % 1.2;
    uniforms.uBreath.value = calm ? 0 : Math.sin(t * 0.9) * 0.5 + 0.5;

    // Audio level decays on its own, so she settles when the speech stops.
    levelDecay *= 0.90;
    uniforms.uLevel.value += (levelDecay - uniforms.uLevel.value) * 0.30;

    // Gaze drift: a slow turn so she is never perfectly static.
    figure.rotation.y = calm ? 0 : Math.sin(t * 0.16) * 0.22;

    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    setState(name) { target = PALETTE[name] || PALETTE.idle; },
    /** For diagnostics only: is the scene actually being drawn? */
    stats() {
      return { calls: renderer.info.render.calls,
               points: renderer.info.render.points,
               lines: renderer.info.render.lines,
               state: Object.keys(PALETTE).find((k) => PALETTE[k] === target),
               scan: +uniforms.uScan.value.toFixed(3),
               opacity: +uniforms.uOpacity.value.toFixed(3) };
    },
    /** amplitude 0..1 from the audio actually being played */
    setLevel(v) { levelDecay = Math.max(levelDecay, Math.min(1, v)); },
    /** Coverage map of what is on screen, for headless verification. */
    capture(cols = 34, rows = 30) {
      renderer.render(scene, camera);
      const gl = renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      // Two passes: measure, then threshold relative to what is actually there.
      // A fixed threshold cannot tell "the figure is dim" from "my cutoff is
      // wrong", which cost a debugging round.
      const cell = [];
      let max = 0, sum2 = 0, lit = 0;
      for (let r = 0; r < rows; r++) {
        cell.push([]);
        for (let c = 0; c < cols; c++) {
          // readPixels is bottom-up, so invert the row.
          const y0 = Math.floor((rows - 1 - r) * h / rows);
          const y1 = Math.floor((rows - r) * h / rows);
          const x0 = Math.floor(c * w / cols), x1 = Math.floor((c + 1) * w / cols);
          let sum = 0, n = 0;
          for (let y = y0; y < y1; y += 2) {
            for (let x = x0; x < x1; x += 2) {
              const i = (y * w + x) * 4;
              // RGB only. Multiplying by alpha double-attenuates on a
              // transparent additively-blended canvas and made the figure look
              // 100x dimmer than it renders.
              sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
              n++;
            }
          }
          const v = n ? sum / n : 0;
          cell[r].push(v);
          if (v > max) max = v;
          sum2 += v; if (v > 0.5) lit++;
        }
      }
      const grid = cell.map((row) => row.map((v) => {
        const k = max > 0 ? v / max : 0;
        return k > 0.55 ? '#' : k > 0.28 ? '+' : k > 0.08 ? '.' : ' ';
      }).join(''));
      return { art: grid.join('\n'), maxBrightness: +max.toFixed(2),
               meanBrightness: +(sum2 / (rows * cols)).toFixed(3),
               litCells: lit, totalCells: rows * cols };
    },
    dispose() {
      cancelAnimationFrame(raf); ro.disconnect();
      geo.dispose(); mat.dispose(); floorGeo.dispose(); floorMat.dispose();
      renderer.dispose();
    },
  };
}
