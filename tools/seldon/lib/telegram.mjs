// `seldon tell` — any agent can message you on Telegram: `seldon tell "the build is green"`.
//
// The bot token is a secret and lives in comb (TELEGRAM_BOT_TOKEN): seldon never stores it,
// prints it or puts it on a command line — `comb run` hands it over in the environment. The
// chat id is not a secret (it is useless without the token), so `seldon tell --setup` finds it
// once and keeps it in ~/.seldon/telegram.json.
//
// Sending is open to any number of sessions at once. Reading a bot's messages is one reader
// only: `seldon inbox` (what you send the bot lands in a folder on this machine — no agent in
// between), or Claude Code's own Telegram channel, never both. --setup reads once.
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { SELDON_HOME } from "./agents.mjs";
import { ago } from "./home.mjs";

export const TOKEN_NAME = "TELEGRAM_BOT_TOKEN";
// The comb name the token is stored under: TELEGRAM_BOT_TOKEN unless setup was told another.
export const tokenName = (chat = readChat()) => chat?.tokenName || TOKEN_NAME;
export const MAX = 4096;                  // Telegram's limit per message
export const MAX_UPLOAD = 50 * 1024 * 1024;   // a bot may upload up to 50 MB
const CONFIG = () => join(SELDON_HOME, "telegram.json");

// ---- pure -------------------------------------------------------------------------
// Long text goes out in pieces, split at a line break when there is one near the limit.
export function chunks(text, max = MAX) {
  const out = [];
  let s = String(text);
  while (s.length > max) {
    const cut = s.lastIndexOf("\n", max);
    const at = cut > max * 0.5 ? cut : max;
    out.push(s.slice(0, at));
    s = s.slice(at).replace(/^\n/, "");
  }
  if (s.length) out.push(s);
  return out;
}

// The private chat that last wrote to the bot: whoever just sent it /start during --setup.
export function chatFromUpdates(updates) {
  const msgs = (updates?.result || []).map((u) => u.message || u.edited_message).filter((m) => m?.chat?.type === "private");
  const m = msgs.at(-1);
  return m ? { id: m.chat.id, name: m.chat.username || m.chat.first_name || null } : null;
}

// ---- I/O --------------------------------------------------------------------------
export function readChat() {
  try { return JSON.parse(readFileSync(CONFIG(), "utf8")); } catch { return null; }
}
export function writeChat(chat) {
  mkdirSync(SELDON_HOME, { recursive: true });
  writeFileSync(CONFIG(), JSON.stringify(chat) + "\n", { mode: 0o600 });
}

// Errors name the method and Telegram's description, never the URL (it carries the token).
async function call(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, body instanceof FormData
    ? { method: "POST", body } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
  return j;
}

export const getUpdates = (token) => call(token, "getUpdates", { allowed_updates: ["message"] });
// Long polling: Telegram holds the request until something arrives (or `timeout` seconds pass).
// Asking with `offset` = last update_id + 1 also tells Telegram the earlier ones are handled.
export const pollUpdates = (token, offset, timeout = 50) =>
  call(token, "getUpdates", { offset, timeout, allowed_updates: ["message"] });

// Plain text is split to fit; a card (HTML) is built to fit already, so it goes as one.
export async function sendText(token, chatId, text, { html = false } = {}) {
  if (html) return void await call(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
  for (const part of chunks(text)) await call(token, "sendMessage", { chat_id: chatId, text: part, disable_web_page_preview: true });
}

// ---- cards: what happened, where, and what to do — readable at a glance ---------------
// Telegram has no colours in text; a coloured dot carries it. One kind per message.
export const KINDS = {
  done: { dot: "🟢", label: "DONE" },
  need: { dot: "🟠", label: "NEEDS YOU" },
  fail: { dot: "🔴", label: "FAILED" },
  wip:  { dot: "🟡", label: "WORKING" },
  info: { dot: "🔵", label: "INFO" },
};
export const escHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ---- Markdown → Telegram HTML -----------------------------------------------------
// Agents write Markdown; Telegram renders a small HTML set. This turns the common subset into
// it: **bold** *italic* _italic_ ~~strike~~ ||spoiler|| `code`, ```lang fenced blocks```,
// [text](https://…), # headings, - lists, 1. lists, > quotes, ---. Everything is escaped
// first, so text can never inject a tag; what isn't Markdown is shown as written.
// Telegram rejects badly nested tags — sendCard falls back to plain text when it does.
const SAFE_URL = /^(https?:\/\/|tg:\/\/|mailto:)/i;

function inline(line) {
  const keep = [];
  const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  let s = escHtml(line)
    .replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${c}</code>`))
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => SAFE_URL.test(url) ? hold(`<a href="${url}">${label}</a>`) : m)
    .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, "<b>$1</b>")
    .replace(/__(?=\S)([^_\n]+?)__/g, "<b>$1</b>")
    .replace(/~~(?=\S)([^~\n]+?)~~/g, "<s>$1</s>")
    .replace(/\|\|(?=\S)([^|\n]+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>")
    .replace(/(^|[\s(])\*(?=\S)([^*\n]+?)\*(?=$|[\s).,:;!?])/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])_(?=\S)([^_\n]+?)_(?=$|[\s).,:;!?])/g, "$1<i>$2</i>");   // not snake_case
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[i]);
}

export function mdToHtml(text) {
  const out = [];
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let quote = [];
  const flush = () => { if (quote.length) { out.push(`<blockquote>${quote.join("\n")}</blockquote>`); quote = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (fence) {                                   // a fenced block, to its closing fence (or the end)
      flush();
      const body = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i]);
      const lang = fence[1] ? ` class="language-${escHtml(fence[1])}"` : "";
      out.push(`<pre><code${lang}>${escHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { quote.push(inline(q[1])); continue; }
    flush();
    let m;
    if ((m = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/))) out.push(`<b>${inline(m[1])}</b>`);
    else if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) out.push(`${m[1].replace(/\t/g, "  ")}• ${inline(m[2])}`);
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) out.push("──────────");
    else out.push(inline(line));
  }
  flush();
  return out.join("\n");
}

// The same card without tags: what is sent when Telegram rejects the HTML.
export const htmlToPlain = (html) => String(html)
  .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, (_, url, label) => (label === url ? label : `${label} (${url})`))
  .replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

// Every part is optional but the kind. `log` is shown as code (its tail: the end of a log is
// what matters). `max` keeps the whole card under Telegram's limit — 1024 for a caption.
export function card({ kind = "info", text, log, project, branch, lane, harness, detail, age, machine, link, max = MAX } = {}) {
  const k = KINDS[kind] || KINDS.info;
  const e = escHtml;
  const meta = [age && `⏱ ${e(age)}`, machine && `💻 ${e(machine)}`].filter(Boolean).join("  ·  ");
  const top = [
    `${k.dot} <b>${k.label}</b>` + (project ? ` · <b>${e(project)}</b>` : "") + (branch ? ` <i>(${e(branch)})</i>` : ""),
    lane && `▸ <b>${e(lane)}</b>${harness ? `  ·  ${e(harness)}` : ""}`,
    detail && `⏳ ${e(detail)}`,
  ].filter(Boolean);
  const bottom = [meta && `<i>${meta}</i>`, link && `👉 <a href="${e(link)}">open the app</a>`].filter(Boolean);
  // The free text gets whatever room the frame leaves (escaping can grow it, hence the margin).
  const room = Math.max(0, max - [...top, ...bottom].join("\n").length - 60);
  const words = text && mdToHtml(clip(String(text).trim(), Math.floor(room * (log ? 0.4 : 1) / 1.2)));
  const tail = log && String(log).trimEnd();
  const logRoom = Math.floor(room * 0.55 / 1.2);
  const shown = tail && (tail.length > logRoom ? "…" + tail.slice(-logRoom) : tail);
  // A short log shows as is; a long one folds away (tap to open), so the card stays readable.
  const folds = shown && (shown.split("\n").length > 8 || shown.length > 500);
  const code = shown && (folds ? `<blockquote expandable><pre>${e(shown)}</pre></blockquote>` : `<pre>${e(shown)}</pre>`);
  return [...top, words, code, ...bottom].filter(Boolean).join("\n");
}

// How a file shows up in the chat: images inline, videos playable, GIFs animated, audio as a
// track, anything else as a document.
export function mediaKind(path) {
  const ext = String(path).toLowerCase().split(".").pop();
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return { method: "sendPhoto", field: "photo" };
  if (["mp4", "mov", "m4v", "webm"].includes(ext)) return { method: "sendVideo", field: "video" };
  if (ext === "gif") return { method: "sendAnimation", field: "animation" };
  if (["mp3", "m4a", "ogg", "wav", "flac"].includes(ext)) return { method: "sendAudio", field: "audio" };
  return { method: "sendDocument", field: "document" };
}

export async function sendFile(token, chatId, path, caption = "", { html = false } = {}) {
  const size = statSync(path).size;
  if (size > MAX_UPLOAD) throw new Error(`${basename(path)} is ${(size / 1048576).toFixed(0)} MB — Telegram bots can send up to 50 MB`);
  const { method, field } = mediaKind(path);
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) form.set("caption", html ? caption : caption.slice(0, 1024));
  if (caption && html) form.set("parse_mode", "HTML");
  if (method === "sendVideo") form.set("supports_streaming", "true");
  form.set(field, new Blob([readFileSync(path)]), basename(path));
  await call(token, method, form);
}

// ---- the inbox: what you send the bot, saved on this machine ------------------------
export const MAX_DOWNLOAD = 20 * 1024 * 1024;   // a bot may download up to 20 MB

// The one file in a message, if it carries one. A photo comes in several sizes: the largest.
export function fileFromMessage(m) {
  if (!m) return null;
  const pick = (f, fallback) => f && { fileId: f.file_id, size: f.file_size ?? null, name: f.file_name || fallback };
  if (m.photo?.length) return pick(m.photo.at(-1), "photo.jpg");
  return pick(m.document, "file") || pick(m.video, "video.mp4") || pick(m.animation, "animation.mp4")
    || pick(m.audio, "audio.mp3") || pick(m.voice, "voice.ogg") || pick(m.video_note, "video-note.mp4") || null;
}

// A name that is safe on disk and sorts by time: 20261031-091502-screenshot.png
export function inboxName(name, date) {
  const base = String(name).split(/[\\/]/).pop().replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(-120) || "file";
  const d = new Date(date), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${base}`;
}

// One line in notes.md per thing received, so the folder reads as a log.
export function noteLine(date, { file, text }) {
  const d = new Date(date), p = (n) => String(n).padStart(2, "0");
  const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  const body = String(text || "").replace(/\s*\n\s*/g, " ⏎ ").trim();
  return `- ${when} · ${file ? `[${file}](${encodeURI(file)})${body ? ` — ${body}` : ""}` : body}\n`;
}

export async function downloadFile(token, fileId, dest) {
  const { result } = await call(token, "getFile", { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${result.file_path}`);
  if (!r.ok) throw new Error(`telegram download: ${r.status}`);
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()), { mode: 0o600 });
}

// A reaction on your message says it is saved, without a reply cluttering the chat.
export const react = (token, chatId, messageId, emoji) =>
  call(token, "setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji }] }).catch(() => {});

// The watcher's news as a card: which agent, on what, what it is waiting for, for how long,
// and — when the phone app is on the tailnet — a link straight to it.
const WATCH_KIND = { "needs-you": "need", failed: "fail", idle: "done" };
const WATCH_DETAIL = { failed: "ended with an error", idle: "finished its turn — ready for the next task" };
export function watchCard(e, { machine = null, link = null, now = Date.now() } = {}) {
  return {
    kind: WATCH_KIND[e.to] || "info",
    project: basename(e.lane.project || e.lane.cwd || "") || null,
    lane: e.lane.name || e.lane.id, harness: e.lane.harness,
    detail: e.to === "needs-you" ? (e.lane.waitingFor || "waiting for you") : WATCH_DETAIL[e.to] || e.to,
    age: e.lane.startedAt ? `running ${ago(e.lane.startedAt, now)}` : null,
    machine, link,
  };
}

// Send a card — as a message, or as a file's caption. If Telegram rejects the formatting (badly
// nested Markdown), the same card goes out as plain text: a message is never lost to styling.
export async function sendCard(token, chatId, fields, file = null) {
  const html = card({ ...fields, max: file ? 1024 : MAX });
  try {
    return file ? await sendFile(token, chatId, file, html, { html: true }) : await sendText(token, chatId, html, { html: true });
  } catch (e) {
    if (!/can't parse entities/i.test(e.message)) throw e;
    const plain = htmlToPlain(html);
    return file ? await sendFile(token, chatId, file, plain) : await sendText(token, chatId, plain);
  }
}
