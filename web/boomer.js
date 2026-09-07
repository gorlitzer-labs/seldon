// Boomer's face: microphone in, speech out, state on screen.
//
// Structure, after Franko pointed out that one long scrolling page is unusable:
//   the console  -- instrument, log, rail. Fixed to the viewport, never scrolls.
//   a modal      -- anything that is an ACTION (managing and enrolling voices).
//   toasts       -- anything that is a STATUS. Transient, never in the layout.
//
// Two audio contexts on purpose. Capture runs at 16 kHz so the browser does the
// resampling the STT needs, properly, rather than us decimating and aliasing.
// Playback runs at the device rate so her voice is not downsampled.

import { WS_PORT, MIC_SR, TTS_SR } from './protocol.js';
import { createAvatar } from './avatar.js';

const el = (id) => document.getElementById(id);

let ws, micCtx, playCtx, nextPlayTime = 0;
let avatar = null;
// Two analysers: hers on the playback graph, yours on the microphone, both read
// every frame so talking over her makes the two spectra meet.
let playAnalyser = null, micAnalyser = null, timeData = null, freqData = null;
// Only stream the mic while she is idle or listening. During thinking/speaking
// the frames would queue in the socket and flood in when the turn ends -- with
// her own voice among them, which reads as a new utterance.
let sending = true;

const UNKNOWN_COLOR = '#FF9E3D';     // nobody enrolled yet: "YOU"
let speakerName = 'YOU', speakerColor = UNKNOWN_COLOR;
let enrolPhrases = [];
let pending = null;                  // her reply block while it still streams

// --- status: toasts, never layout ----------------------------------------
function toast(kind, text, tone = '', ms = 4200) {
  const box = el('toasts');
  const t = document.createElement('div');
  t.className = `toast ${tone}`;
  t.innerHTML = '<span class="k"></span><span class="b"></span>';
  t.querySelector('.k').textContent = kind;
  t.querySelector('.b').textContent = text;
  box.appendChild(t);
  const kill = () => t.remove();
  t.onclick = kill;                  // dismissable: some are worth re-reading
  if (ms) setTimeout(kill, ms);
  while (box.children.length > 4) box.firstChild.remove();
}

// --- the log --------------------------------------------------------------
function hint(text) {
  const log = el('log');
  log.dataset.empty = '1';
  log.innerHTML =
    `<p class="msg them" style="--c:var(--line-lit)">` +
    `<span class="txt" style="color:var(--dim)">${text}</span></p>`;
}

function addMessage(who, text, cls, color) {
  const log = el('log');
  if (log.dataset.empty === '1') { log.innerHTML = ''; delete log.dataset.empty; }
  const p = document.createElement('p');
  p.className = `msg ${cls}`;
  if (color) p.style.setProperty('--c', color);
  p.innerHTML = '<span class="who"></span><span class="txt"></span>';
  p.querySelector('.who').textContent = who;
  p.querySelector('.txt').textContent = text;
  log.appendChild(p);
  while (log.children.length > LOG_MAX) log.firstChild.remove();
  // Next frame: scrollHeight is stale until the new block has been laid out.
  requestAnimationFrame(() => stickBottom());
  return p;
}
const LOG_MAX = 8;

/** Keep the newest message visible, and only fade the top when there IS a top. */
function stickBottom() {
  const log = el('log');
  log.scrollTop = log.scrollHeight;
  if (log.scrollHeight > log.clientHeight + 1) log.dataset.over = '1';
  else delete log.dataset.over;
}

// --- state ----------------------------------------------------------------
const ACCENT = {
  offline: '#4a6377', idle: '#1FA8D8', listening: '#18E08A',
  thinking: '#FFB020', speaking: '#35C8FF', busy: '#FF4D6D',
};

function setState(s) {
  el('state').textContent = s;
  document.body.dataset.state = s;
  document.documentElement.style.setProperty('--accent', ACCENT[s] || ACCENT.idle);
  sending = (s === 'idle' || s === 'listening');
  if (avatar) avatar.setState(s);
}

// --- audio ----------------------------------------------------------------
function playChunk(float32, sampleRate) {
  const buf = playCtx.createBuffer(1, float32.length, sampleRate);
  buf.copyToChannel(float32, 0);
  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playAnalyser);
  const now = playCtx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now + 0.03;
  src.start(nextPlayTime);
  nextPlayTime += buf.duration;
}

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

// --- voices ---------------------------------------------------------------
const sheet = el('voicesheet');

function renderRoster(voices) {
  const ul = el('roster');
  ul.innerHTML = '';
  if (!voices || !voices.length) {
    ul.innerHTML = '<li class="none">Nobody enrolled. She answers anyone who talks.</li>';
    return;
  }
  for (const v of voices) {
    const li = document.createElement('li');
    li.style.setProperty('--c', v.color || UNKNOWN_COLOR);
    const owner = v.role === 'owner';
    li.innerHTML =
      `<span class="pname"></span>` +
      `<span class="mark ${owner ? 'owner' : ''}"></span>` +
      `<span class="q"></span>`;
    li.querySelector('.pname').textContent = v.name;
    li.querySelector('.mark').textContent =
      owner ? 'answers the factory' : 'conversation only';
    li.querySelector('.q').textContent = v.quality == null ? '' : v.quality;
    const btn = document.createElement('button');
    btn.className = 'btn btn--danger';
    btn.textContent = 'forget';
    btn.onclick = () => ws && ws.send(JSON.stringify({ type: 'forget_voice', name: v.name }));
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

function endEnrolment() {
  el('phrases').hidden = true;
  el('ecancel').hidden = true;
  el('enrol').disabled = false;
}

/** Messages the voices layer owns. Returns true when fully handled. */
function handleVoiceMessage(m) {
  switch (m.type) {
    case 'roster':
      renderRoster(m.voices);
      if (m.removed) toast('voices', 'Voice forgotten.');
      return true;
    case 'speaker':
      speakerName = m.name.toUpperCase();
      speakerColor = m.color || UNKNOWN_COLOR;
      el('readout').textContent = `${m.name} ${m.similarity.toFixed(2)}`;
      return true;
    case 'rejected':
      toast('ignored', `Voice not recognised (best match ${(m.similarity ?? 0).toFixed(2)}).`, 'bad');
      return true;
    case 'enrol':
      if (m.stage === 'start') {
        enrolPhrases = m.phrases;
        showPhrases(enrolPhrases, 0);
        el('ecancel').hidden = false;
        el('enrol').disabled = true;
        if (!sheet.open) sheet.showModal();
        toast('enrolling', `${m.name}: read the highlighted line aloud.`);
      } else if (m.stage === 'progress') {
        showPhrases(enrolPhrases, m.got);
        if (m.got >= m.need) toast('enrolling', 'Building the voiceprint.');
      } else if (m.stage === 'done') {
        endEnrolment();
        el('ename').value = '';
        el('eowner').checked = false;
        renderRoster(m.roster);
        const q = m.report.self_similarity_min;
        if (q < 0.6) {
          toast('enrolled', `${m.name} saved, but the samples only agree ${q}. `
            + 'Re-enrol somewhere quieter or she will confuse people.', 'bad', 9000);
        } else {
          toast('enrolled', `${m.name} saved. Samples agree ${q}.`, 'good');
        }
      } else {
        endEnrolment();
        toast('enrolling', m.detail || 'Cancelled.', m.stage === 'failed' ? 'bad' : '');
      }
      return true;
  }
  return false;
}

// --- websocket ------------------------------------------------------------
function onMessage(ev) {
  if (ev.data instanceof ArrayBuffer) {
    // Self-describing frame: <uint32 sampleRate><uint32 count><float32 ...>.
    // Nothing to pair, so nothing can be dropped.
    if (ev.data.byteLength < 8) return;
    const head = new DataView(ev.data, 0, 8);
    const rate = head.getUint32(0, true);
    const count = head.getUint32(4, true);
    playChunk(new Float32Array(ev.data, 8, count), rate);
    return;
  }
  const m = JSON.parse(ev.data);
  if (handleVoiceMessage(m)) return;

  switch (m.type) {
    case 'state': setState(m.value); break;

    case 'transcript':
      // Only the final transcript is logged; the interim one changes under you.
      if (m.final && m.text) addMessage(speakerName, m.text, 'me', speakerColor);
      break;

    case 'reply':
      if (m.done) {
        if (pending) pending.classList.remove('pending');
        pending = null;
      } else if (!pending) {
        pending = addMessage('BOOMER', m.text, 'them pending');
      } else {
        const t = pending.querySelector('.txt');
        t.textContent += (t.textContent ? ' ' : '') + m.text;
        requestAnimationFrame(() => stickBottom());
      }
      break;

    case 'announce':
      pending = null;
      addMessage(`BOOMER / ${(m.hive || 'factory').toUpperCase()}`, m.text,
                 `them unprompted${m.kind === 'blocker' ? ' alert' : ''}`);
      break;

    case 'metrics':
      el('readout').textContent = `${m.tts_first_ms | 0} ms`;
      break;

    case 'batched':
      toast('waiting', `${m.count} item${m.count === 1 ? '' : 's'} held back. `
        + 'Ask "anything need me?" when you want them.');
      break;

    case 'ready':
      renderRoster(m.voices);
      el('enrol').disabled = !m.canEnrol;
      if (!m.canEnrol) {
        toast('voices', 'Voice model missing. Run scripts/fetch-models.py to enable voices.', 'bad', 9000);
      }
      if (m.readonly) toast('read-only', 'Writes are disabled for this session.');
      hint('Talk to her. Try "what is on the board?"');
      break;

    case 'busy':
      setState('busy');
      toast('busy', m.detail, 'bad', 0);
      el('go').disabled = false;
      el('go').textContent = 'listen';
      break;

    case 'error':
      el('readout').textContent = 'error';
      toast(m.where, m.detail, 'bad', 9000);
      break;
  }
}

// --- start ----------------------------------------------------------------
async function start() {
  el('go').disabled = true;
  el('go').textContent = 'connecting';
  try {
    ws = new WebSocket(`ws://${location.hostname}:${WS_PORT}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = onMessage;
    ws.onclose = () => {
      setState('offline');
      el('go').disabled = false;
      el('go').textContent = 'listen';
      hint('Disconnected. Press listen to reconnect.');
    };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    // Echo cancellation on: measured 26.8 dB ERLE, which is what stops her
    // hearing herself. AGC off: it moved the mic gain between measurements and
    // made the barge-in numbers meaningless.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });

    micCtx = new AudioContext({ sampleRate: MIC_SR });
    playCtx = new AudioContext();
    await micCtx.resume(); await playCtx.resume();

    playAnalyser = playCtx.createAnalyser();
    playAnalyser.fftSize = 512;
    playAnalyser.smoothingTimeConstant = 0.7;
    playAnalyser.connect(playCtx.destination);
    timeData = new Uint8Array(playAnalyser.fftSize);
    freqData = new Uint8Array(playAnalyser.frequencyBinCount);

    const src = micCtx.createMediaStreamSource(stream);
    // Your voice drives the core while she listens. Tapped off the AEC'd stream,
    // so it is the same audio the endpointer sees.
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
        i16[i] = Math.max(-1, Math.min(1, f[i])) * 32767;
      }
      ws.send(i16.buffer);
    };
    // A ScriptProcessorNode only runs if its output reaches the destination.
    const sink = micCtx.createGain();
    sink.gain.value = 0;
    src.connect(node); node.connect(sink); sink.connect(micCtx.destination);

    el('go').textContent = 'listening';
    setState('idle');
  } catch (e) {
    el('go').disabled = false;
    el('go').textContent = 'listen';
    toast('microphone', e.name === 'NotAllowedError'
      ? 'Microphone access was refused. Allow it in the address bar, then press listen.'
      : `Could not start: ${e.message}`, 'bad', 9000);
  }
}

// --- controls -------------------------------------------------------------
el('go').onclick = start;
el('stop').onclick = () => ws && ws.send(JSON.stringify({ type: 'stop' }));
el('clear').onclick = () => {
  if (ws) ws.send(JSON.stringify({ type: 'reset' }));
  pending = null;
  hint('Cleared. She has forgotten this conversation, not her memory.');
};
el('voices').onclick = () => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'voices' }));
  sheet.showModal();
  // A dialog focuses its first focusable child, which was "close" -- the least
  // useful control in the sheet. Point it at the thing you came here to type in.
  el('ename').focus();
};
el('sheetclose').onclick = () => sheet.close();
// Clicking the backdrop closes it, which is what people expect of a sheet.
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

el('enrol').onclick = () => {
  if (!ws || ws.readyState !== 1) {
    toast('voices', 'Press listen first so she can hear you.', 'bad');
    return;
  }
  const name = el('ename').value.trim();
  if (!name) { toast('voices', 'Type a name first.', 'bad'); return; }
  ws.send(JSON.stringify({ type: 'enrol', name,
                           role: el('eowner').checked ? 'owner' : 'guest' }));
};
el('ecancel').onclick = () => ws && ws.send(JSON.stringify({ type: 'enrol_cancel' }));

// --- boot -----------------------------------------------------------------
// WebGL can be unavailable (software rendering off, remote session). The CSS orb
// stays in the markup as the fallback, so losing the avatar loses nothing
// functional.
try {
  avatar = createAvatar(el('avatar'));
  document.body.dataset.avatar = 'on';
  window.__boomer = { avatar, setState, toast };   // headless checks
  requestAnimationFrame(pumpAudio);
} catch (e) {
  console.warn('avatar unavailable, using the orb:', e);
}

renderRoster([]);
hint('Press listen, allow the microphone, then just talk.');
setState('offline');
