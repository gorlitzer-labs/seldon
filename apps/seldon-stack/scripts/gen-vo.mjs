#!/usr/bin/env node
// gen-vo — generate the narration clips for the lecture from the say lines in
// chapters.ts, via ElevenLabs. Key comes by reference, never on the command line:
//
//   comb run --with ELEVENLABS_API_KEY -- node scripts/gen-vo.mjs            # missing clips, both voices
//   comb run --with ELEVENLABS_API_KEY -- node scripts/gen-vo.mjs --only combos
//   comb run --with ELEVENLABS_API_KEY -- node scripts/gen-vo.mjs --voice george --force
//   node scripts/gen-vo.mjs --dry-run                                        # list what it WOULD do, no API calls
//
// chapters.ts is loaded directly (Node 22.18+ strips TS types natively — no build step).
// Filenames match the Narrator: public/vo/<voice>/<chapterId>-<beatId>-<lineIndex>.mp3
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");                       // apps/seldon-stack
const VO = join(APP, "public", "vo");

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = has("--dry-run");
const FORCE = has("--force");
const ONLY = val("--only");                          // limit to one chapter id (e.g. combos)
const VOICES_ARG = (val("--voice") || "george,lily").split(",").map((s) => s.trim());

// ── voices + model (ElevenLabs premade ids; override via env) ─────────────────
const VOICE_ID = {
  george: process.env.VOICE_GEORGE || "JBFqnCBsd6RMkjVDRZzb",
  lily: process.env.VOICE_LILY || "pFZP5JQG7iQjIQuC4Bku",
};
const MODEL = process.env.ELEVEN_MODEL || "eleven_multilingual_v2";
const FORMAT = process.env.ELEVEN_FORMAT || "mp3_44100_128";
const SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true };

const API = process.env.ELEVENLABS_API_KEY;
if (!API && !DRY) {
  console.error("ELEVENLABS_API_KEY not set. Run via:\n  comb run --with ELEVENLABS_API_KEY -- node scripts/gen-vo.mjs");
  process.exit(1);
}

// ── load chapters.ts directly (native TS type stripping on Node 22.18+) ───────
async function loadChapters() {
  const mod = await import(pathToFileURL(join(APP, "src", "content", "chapters.ts")).href);
  return mod.chapters;
}

// ── flatten to the exact clips the Narrator will ask for ──────────────────────
function clips(chapters) {
  const out = [];
  for (const c of chapters) {
    if (ONLY && c.id !== ONLY) continue;
    for (const b of c.beats) {
      (b.say ?? []).forEach((line, i) => {
        if (line?.text) out.push({ chap: c.id, beat: b.id, i, text: line.text });
      });
    }
  }
  return out;
}

// ── one ElevenLabs TTS call → mp3 bytes ───────────────────────────────────────
async function tts(text, voiceId) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${FORMAT}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": API, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: MODEL, voice_settings: SETTINGS }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── run ───────────────────────────────────────────────────────────────────────
const chapters = await loadChapters();
const all = clips(chapters);
let made = 0, skipped = 0, failed = 0;

for (const voice of VOICES_ARG) {
  const voiceId = VOICE_ID[voice];
  if (!voiceId) { console.error(`unknown voice "${voice}" (no id)`); failed++; continue; }
  const dir = join(VO, voice);
  if (!DRY) mkdirSync(dir, { recursive: true });
  for (const c of all) {
    const file = join(dir, `${c.chap}-${c.beat}-${c.i}.mp3`);
    if (!FORCE && existsSync(file)) { skipped++; continue; }
    if (DRY) { console.log(`would gen ${voice}/${c.chap}-${c.beat}-${c.i}.mp3  "${c.text.slice(0, 48)}..."`); made++; continue; }
    try {
      const buf = await tts(c.text, voiceId);
      writeFileSync(file, buf);
      console.log(`✓ ${voice}/${c.chap}-${c.beat}-${c.i}.mp3  (${buf.length} bytes)`);
      made++;
    } catch (e) {
      console.error(`✗ ${voice}/${c.chap}-${c.beat}-${c.i}.mp3  ${e.message}`);
      failed++;
    }
  }
}

console.log(`\n${DRY ? "[dry-run] " : ""}made ${made}, skipped ${skipped} (existing), failed ${failed}`);
process.exit(failed ? 1 : 0);
