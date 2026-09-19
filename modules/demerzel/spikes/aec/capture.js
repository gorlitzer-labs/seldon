// Shared mic-capture plumbing for Aria's audio spikes.
// One implementation of the audio graph; the pages only script the phases.

export const log = (s) => { document.getElementById('log').textContent += s + "\n"; };

let ws;
export async function connect() {
  ws = new WebSocket(`ws://${location.hostname}:8765`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.send(JSON.stringify({ phase: 'reset' }));
  return ws;
}
export const send = (o) => ws.send(JSON.stringify(o));

// A 440+880 Hz tone stands in for Aria's own TTS leaving the speakers.
export function playTone(ctx, seconds) {
  const g = ctx.createGain();
  g.gain.value = 0.25;
  g.connect(ctx.destination);
  for (const f of [440, 880]) {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    o.connect(g);
    o.start();
    o.stop(ctx.currentTime + seconds);
  }
  return new Promise(r => setTimeout(r, seconds * 1000));
}

/**
 * Capture `seconds` of mic audio under `constraints`, tagged as `phase`.
 * If `duringTone` is set, the tone plays for the same window.
 */
export async function capture(ctx, constraints, phase, seconds, duringTone = false) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  const track = stream.getAudioTracks()[0];
  const s = track.getSettings();
  log(`  [${phase}] aec=${s.echoCancellation} agc=${s.autoGainControl} ns=${s.noiseSuppression}`);

  let sent = 0;
  const src = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(1024, 1, 1);
  send({ phase, sampleRate: ctx.sampleRate });
  node.onaudioprocess = (e) => {
    if (ws.readyState === 1) { ws.send(e.inputBuffer.getChannelData(0).slice().buffer); sent++; }
  };

  // A ScriptProcessorNode is only pulled if its output reaches the destination.
  // Route through a zero-gain node: the graph runs, nothing extra is audible.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(node); node.connect(sink); sink.connect(ctx.destination);

  if (duringTone) await playTone(ctx, seconds);
  else await new Promise(r => setTimeout(r, seconds * 1000));

  node.onaudioprocess = null;
  src.disconnect(); node.disconnect(); sink.disconnect();
  track.stop();
  log(`  [${phase}] captured ${sent} frames`);
  if (!sent) log(`  [${phase}] WARNING: no audio captured`);
}
