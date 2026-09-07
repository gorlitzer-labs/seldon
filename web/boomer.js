// Boomer's face: microphone in, speech out, state on screen.
//
// Two audio contexts on purpose. Capture runs at 16 kHz so the browser does the
// resampling the STT needs (and does it properly, rather than us decimating and
// aliasing). Playback runs at the device rate so her voice is not downsampled.

import { WS_PORT, MIC_SR, TTS_SR } from './protocol.js';
import { createAvatar } from './avatar.js';

const el = (id) => document.getElementById(id);
const setState = (s) => {
  el('state').textContent = s;
  document.body.dataset.state = s;
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
      el('metrics').textContent =
        `stt ${m.stt_ms|0}ms   ttft ${m.ttft_ms|0}ms   first audio ${m.tts_first_ms|0}ms`;
      break;
    case 'ready':
      el('metrics').textContent = `endpoint hangover ${m.hangoverMs|0}ms`
        + (m.readonly ? '  -  READ-ONLY (no writes)' : '');
      break;
    case 'busy':
      // Only one browser can hold her: the models are shared singletons.
      setState('busy');
      el('hint').textContent = m.detail;
      el('go').disabled = false;
      break;
    case 'announce':
      // She spoke first. Mark it so it doesn't read as a reply to you.
      el('you').textContent = '';
      el('boomer').textContent = m.text;
      el('metrics').textContent = `unprompted - ${m.kind} on ${m.hive || 'the factory'}`;
      document.body.dataset.unprompted = '1';
      break;
    case 'batched':
      el('hint').textContent = `${m.count} item(s) waiting - ask "anything need me?"`;
      break;
    case 'error':
      el('metrics').textContent = `error in ${m.where}: ${m.detail}`;
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

  el('hint').textContent = `mic ${micCtx.sampleRate} Hz / speaker ${playCtx.sampleRate} Hz - just talk`;
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
