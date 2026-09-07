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

// Humanoid radius profile: [height 0..1 from feet, radius]. Hand-tuned rather
// than anatomical -- it needs to read as a person in silhouette, at small size.
const PROFILE = [
  [0.00, 0.070], [0.04, 0.055], [0.08, 0.048],   // feet, ankles
  [0.20, 0.075], [0.34, 0.090], [0.44, 0.098],   // calves, knees, thighs
  [0.50, 0.135], [0.55, 0.140],                  // hips
  [0.62, 0.120], [0.70, 0.128],                  // waist, ribs
  [0.76, 0.150], [0.80, 0.165],                  // chest, shoulders
  [0.84, 0.070], [0.86, 0.058],                  // neck
  [0.90, 0.085], [0.94, 0.092], [0.97, 0.080],   // head
  [1.00, 0.045],
];

const RINGS = 132;          // vertical resolution
const SEGMENTS = 84;        // points per ring
const FIGURE_HEIGHT = 2.6;

function radiusAt(t) {
  for (let i = 0; i < PROFILE.length - 1; i++) {
    const [y0, r0] = PROFILE[i], [y1, r1] = PROFILE[i + 1];
    if (t >= y0 && t <= y1) {
      const k = (t - y0) / (y1 - y0);
      return r0 + (r1 - r0) * (k * k * (3 - 2 * k));   // smoothstep
    }
  }
  return PROFILE[PROFILE.length - 1][1];
}

const VERT = `
  uniform float uTime, uScan, uBreath, uAgitation, uLevel;
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
    gl_PointSize = (1.6 + vGlow * 3.4) * (300.0 / -mv.z);
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
    float a = uOpacity * soft * ends * (0.30 + vGlow * 0.95);
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
  const count = RINGS * SEGMENTS;
  const pos = new Float32Array(count * 3);
  const aT = new Float32Array(count);
  const aAngle = new Float32Array(count);
  let n = 0;
  for (let i = 0; i < RINGS; i++) {
    const t = i / (RINGS - 1);
    const r = radiusAt(t);
    for (let j = 0; j < SEGMENTS; j++) {
      const a = (j / SEGMENTS) * Math.PI * 2;
      // Slight ellipse: people are deeper than they are wide at the chest.
      pos[n * 3] = Math.cos(a) * r;
      pos[n * 3 + 1] = t * FIGURE_HEIGHT;
      pos[n * 3 + 2] = Math.sin(a) * r * 0.72;
      aT[n] = t;
      aAngle[n] = a;
      n++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  geo.setAttribute('aAngle', new THREE.BufferAttribute(aAngle, 1));

  const uniforms = {
    uTime: { value: 0 }, uScan: { value: 0 }, uBreath: { value: 0 },
    uAgitation: { value: 0 }, uLevel: { value: 0 },
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
      const grid = [];
      for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
          // readPixels is bottom-up, so invert the row.
          const y0 = Math.floor((rows - 1 - r) * h / rows);
          const y1 = Math.floor((rows - r) * h / rows);
          const x0 = Math.floor(c * w / cols), x1 = Math.floor((c + 1) * w / cols);
          let sum = 0, n = 0;
          for (let y = y0; y < y1; y += 2) {
            for (let x = x0; x < x1; x += 2) {
              const i = (y * w + x) * 4;
              sum += (px[i] + px[i + 1] + px[i + 2]) / 3 * (px[i + 3] / 255);
              n++;
            }
          }
          const v = n ? sum / n : 0;
          line += v > 40 ? '#' : v > 16 ? '+' : v > 5 ? '.' : ' ';
        }
        grid.push(line);
      }
      return grid;
    },
    dispose() {
      cancelAnimationFrame(raf); ro.disconnect();
      geo.dispose(); mat.dispose(); floorGeo.dispose(); floorMat.dispose();
      renderer.dispose();
    },
  };
}
