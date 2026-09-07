// Boomer's face: microphone in, speech out, state on screen.
//
// Two audio contexts on purpose. Capture runs at 16 kHz so the browser does the
// resampling the STT needs (and does it properly, rather than us decimating and
// aliasing). Playback runs at the device rate so her voice is not downsampled.

import { WS_PORT, MIC_SR, TTS_SR } from './protocol.js';

const el = (id) => document.getElementById(id);
const setState = (s) => {
  el('state').textContent = s;
  document.body.dataset.state = s;
  sending = (s === 'idle' || s === 'listening');
};

let ws, micCtx, playCtx, nextPlayTime = 0, pendingAudio = null;
// Only stream the mic while she is idle or listening. During thinking/speaking
// the frames would queue in the socket and flood in when the turn ends -- with
// her own voice among them, which reads as a new utterance.
let sending = true;

function playChunk(float32, sampleRate) {
  const buf = playCtx.createBuffer(1, float32.length, sampleRate);
  buf.copyToChannel(float32, 0);
  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playCtx.destination);
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
      el('metrics').textContent = `endpoint hangover ${m.hangoverMs|0}ms`;
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

  const src = micCtx.createMediaStreamSource(stream);
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

el('go').onclick = start;
el('stop').onclick = () => ws && ws.send(JSON.stringify({ type: 'stop' }));
el('reset').onclick = () => {
  if (!ws) return;
  ws.send(JSON.stringify({ type: 'reset' }));
  el('you').textContent = el('boomer').textContent = '';
};
