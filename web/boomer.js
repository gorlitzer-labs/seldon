// Boomer's face: microphone in, speech out, state on screen.
//
// Two audio contexts on purpose. Capture runs at 16 kHz so the browser does the
// resampling the STT needs (and does it properly, rather than us decimating and
// aliasing). Playback runs at the device rate so her voice is not downsampled.

import { WS_PORT, MIC_SR, TTS_SR } from './protocol.js';
import { createAvatar } from './avatar.js';

const el = (id) => document.getElementById(id);
// One accent, driven by her actual state. Matches the avatar palette so the
// dot, the focus ring and her transcript lines all shift together.
const ACCENT = {
  offline: '#4a6377', idle: '#1FA8D8', listening: '#18E08A',
  thinking: '#FFB020', speaking: '#35C8FF', busy: '#FF4D6D',
};

const setState = (s) => {
  el('state').textContent = s;
  document.body.dataset.state = s;
  document.documentElement.style.setProperty('--accent', ACCENT[s] || ACCENT.idle);
  sending = (s === 'idle' || s === 'listening');
  if (avatar) avatar.setState(s);
};

// BOTH sides, every frame. Her voice grows the ring outward, yours inward, so
// when you talk over her the bars meet and the overlap itself is the barge-in
// indicator. Nothing here is a timer animation -- silence settles the core.
function readAnalyser(a) {
  if (!a || !timeData) return null;
  a.getByteTimeDomainData(timeData);
  let peak = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = Math.abs(timeData[i] - 128) / 128;
    if (v > peak) peak = v;
  }
  a.getByteFrequencyData(freqData);
  return { peak, freq: freqData };
}

function pumpAudio() {
  if (avatar) {
    const h = readAnalyser(playAnalyser);
    if (h) { avatar.setLevel(h.peak * 1.8); avatar.setSpectrum(h.freq); }
    const m = readAnalyser(micAnalyser);
    if (m) { avatar.setLevelMine(m.peak * 1.8); avatar.setSpectrumMine(m.freq); }
  }
  requestAnimationFrame(pumpAudio);
}

let ws, micCtx, playCtx, nextPlayTime = 0, pendingAudio = null;
let avatar = null;
// Two analysers: hers on the playback graph, yours on the microphone. The core
// reacts to whoever is actually talking, which is the point of it.
let playAnalyser = null, micAnalyser = null;
let timeData = null, freqData = null;
// Only stream the mic while she is idle or listening. During thinking/speaking
// the frames would queue in the socket and flood in when the turn ends -- with
// her own voice among them, which reads as a new utterance.
let sending = true;

function playChunk(float32, sampleRate) {
  const buf = playCtx.createBuffer(1, float32.length, sampleRate);
  buf.copyToChannel(float32, 0);
  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playAnalyser);
  // Schedule back-to-back so consecutive chunks play without a seam.
  const now = playCtx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now + 0.03;
  src.start(nextPlayTime);
  nextPlayTime += buf.duration;
}

function onMessage(ev) {
  if (ev.data instanceof ArrayBuffer) {
    if (!pendingAudio) return;
    playChunk(new Float32Array(ev.data), pendingAudio.sampleRate);
    pendingAudio = null;
    return;
  }
  const m = JSON.parse(ev.data);
  if (handleVoiceMessage(m)) {
    // 'ready' also carries pipeline info the main switch renders.
    if (m.type !== 'ready') return;
  }
  switch (m.type) {
    case 'state':      setState(m.value); break;
    case 'audio':      pendingAudio = m; break;
    case 'transcript':
      el('you').textContent = m.text || '...';
      delete document.body.dataset.unprompted;
      break;
    case 'reply':
      if (m.done) break;
      el('boomer').textContent += (el('boomer').textContent ? ' ' : '') + m.text;
      break;
    case 'metrics':
      el('readout').textContent = `${m.tts_first_ms | 0} ms`;
      break;
    case 'ready':
      el('readout').textContent = m.readonly ? 'read-only' : '';
      break;
    case 'busy':
      // Only one browser can hold her: the models are shared singletons.
      setState('busy');
      el('estatus').textContent = m.detail;
      el('voicepanel').hidden = false;
      el('go').disabled = false;
      break;
    case 'announce':
      // She spoke first. Mark it so it doesn't read as a reply to you.
      el('you').textContent = '';
      el('boomer').textContent = m.text;
      el('readout').textContent = `${m.kind} - ${m.hive || 'factory'}`;
      document.body.dataset.unprompted = '1';
      break;
    case 'batched':
      el('readout').textContent = `${m.count} waiting`;
      break;
    case 'error':
      el('readout').textContent = `error: ${m.where}`;
      el('estatus').textContent = `${m.where}: ${m.detail}`;
      break;
  }
  if (m.type === 'transcript' && m.final === false) el('boomer').textContent = '';
}

async function start() {
  el('go').disabled = true;
  ws = new WebSocket(`ws://${location.hostname}:${WS_PORT}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = onMessage;
  ws.onclose = () => { setState('offline'); el('go').disabled = false; };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  // Echo cancellation on: measured 26.8 dB ERLE, which is what stops her
  // hearing herself. AGC off: it moved the mic gain between phases and made
  // the barge-in numbers meaningless.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
  });

  micCtx = new AudioContext({ sampleRate: MIC_SR });
  playCtx = new AudioContext();
  await micCtx.resume(); await playCtx.resume();

  // Everything she says passes through this on its way to the speakers.
  playAnalyser = playCtx.createAnalyser();
  playAnalyser.fftSize = 512;
  playAnalyser.smoothingTimeConstant = 0.7;
  playAnalyser.connect(playCtx.destination);
  timeData = new Uint8Array(playAnalyser.fftSize);
  freqData = new Uint8Array(playAnalyser.frequencyBinCount);

  const src = micCtx.createMediaStreamSource(stream);
  // Your voice drives the core while she is listening. Tapped off the AEC'd
  // stream, so it is the same audio the endpointer sees.
  micAnalyser = micCtx.createAnalyser();
  micAnalyser.fftSize = 512;
  micAnalyser.smoothingTimeConstant = 0.6;
  src.connect(micAnalyser);
  const node = micCtx.createScriptProcessor(1024, 1, 1);
  node.onaudioprocess = (e) => {
    if (ws.readyState !== 1 || !sending) return;
    const f = e.inputBuffer.getChannelData(0);
    const i16 = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      i16[i] = s * 32767;
    }
    ws.send(i16.buffer);
  };
  // A ScriptProcessorNode only runs if its output reaches the destination.
  const sink = micCtx.createGain();
  sink.gain.value = 0;
  src.connect(node); node.connect(sink); sink.connect(micCtx.destination);

  el('go').textContent = 'listening';
  el('go').disabled = true;
  setState('idle');
}

// WebGL can be unavailable (software rendering off, remote session). The CSS
// orb stays in the markup as the fallback, so losing the avatar loses nothing
// functional.
try {
  avatar = createAvatar(el('avatar'));
  document.body.dataset.avatar = 'on';
  // Debug hook: lets a headless check confirm the scene renders and step the
  // states without a microphone. Read-only apart from the visual state.
  window.__boomer = { avatar, setState };
  requestAnimationFrame(pumpAudio);
} catch (e) {
  console.warn('avatar unavailable, falling back to the orb:', e);
}

el('go').onclick = start;
el('stop').onclick = () => ws && ws.send(JSON.stringify({ type: 'stop' }));
el('reset').onclick = () => {
  if (!ws) return;
  ws.send(JSON.stringify({ type: 'reset' }));
  el('you').textContent = el('boomer').textContent = '';
};

// --- voices: who she knows, and enrolling new ones -------------------------
// Enrolment reuses the endpointer that already segments speech: read three
// phrases, each captured utterance becomes a sample. No separate recorder.

const panel = el('voicepanel');

function renderRoster(voices) {
  const ul = el('roster');
  ul.innerHTML = '';
  if (!voices || !voices.length) {
    ul.innerHTML = '<li class="none">No voices enrolled. She answers anyone.</li>';
    return;
  }
  for (const v of voices) {
    const li = document.createElement('li');
    const owner = v.role === 'owner';
    li.innerHTML = `<span>${v.name}</span>`
      + `<span class="${owner ? 'owner-mark' : 'guest-mark'}">`
      + `${owner ? 'answers the factory' : 'conversation only'}</span>`
      + `<span class="q">${v.quality == null ? '' : v.quality}</span>`;
    const btn = document.createElement('button');
    btn.textContent = 'forget';
    btn.onclick = () => ws.send(JSON.stringify({ type: 'forget_voice', name: v.name }));
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function showPhrases(list, got) {
  const ol = el('phrases');
  ol.hidden = false;
  ol.innerHTML = '';
  list.forEach((t, i) => {
    const li = document.createElement('li');
    li.textContent = t;
    li.className = i < got ? 'done' : i === got ? 'now' : '';
    ol.appendChild(li);
  });
}

let enrolPhrases = [];

export function handleVoiceMessage(m) {
  switch (m.type) {
    case 'ready':
      renderRoster(m.voices);
      el('enrol').disabled = !m.canEnrol;
      if (!m.canEnrol) el('estatus').textContent =
        'Voice model missing. Run scripts/fetch-models.py to enable voices.';
      return true;
    case 'roster':
      renderRoster(m.voices);
      if (m.removed) el('estatus').textContent = 'Voice forgotten.';
      return true;
    case 'speaker':
      el('readout').textContent = `${m.name} ${m.similarity.toFixed(2)}`;
      return true;
    case 'rejected':
      el('estatus').textContent =
        `ignored: voice not recognised (best match ${(m.similarity ?? 0).toFixed(2)})`;
      return true;
    case 'enrol':
      if (m.stage === 'start') {
        enrolPhrases = m.phrases;
        showPhrases(enrolPhrases, 0);
        el('estatus').textContent = `Enrolling ${m.name}. Read the first line aloud.`;
        el('ecancel').hidden = false;
        el('enrol').disabled = true;
      } else if (m.stage === 'progress') {
        showPhrases(enrolPhrases, m.got);
        el('estatus').textContent = m.got < m.need
          ? `${m.got} of ${m.need} captured. Read the next line.`
          : 'Building the voiceprint.';
      } else if (m.stage === 'done') {
        el('phrases').hidden = true;
        el('ecancel').hidden = true;
        el('enrol').disabled = false;
        el('ename').value = '';
        renderRoster(m.roster);
        const q = m.report.self_similarity_min;
        el('estatus').textContent = q < 0.6
          ? `${m.name} enrolled, but the samples only agree ${q}. `
            + `Re-enrol somewhere quieter or she will confuse people.`
          : `${m.name} enrolled. Samples agree ${q}.`;
      } else if (m.stage === 'failed' || m.stage === 'cancelled') {
        el('phrases').hidden = true;
        el('ecancel').hidden = true;
        el('enrol').disabled = false;
        el('estatus').textContent = m.detail || 'cancelled';
      }
      return true;
  }
  return false;
}

el('voices').onclick = () => {
  panel.hidden = !panel.hidden;
  if (panel.hidden) return;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'voices' }));
  else el('estatus').textContent = 'press listen first, then enrol';
};

// Render the empty state at load: opening the panel before connecting used to
// show a blank box with no explanation.
renderRoster([]);
el('enrol').onclick = () => {
  if (!ws) { el('estatus').textContent = 'press listen first'; return; }
  const name = el('ename').value.trim();
  if (!name) { el('estatus').textContent = 'Type a name first.'; return; }
  ws.send(JSON.stringify({ type: 'enrol', name,
                           role: el('eowner').checked ? 'owner' : 'guest' }));
};
el('ecancel').onclick = () => ws && ws.send(JSON.stringify({ type: 'enrol_cancel' }));
