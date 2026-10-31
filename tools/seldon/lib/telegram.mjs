// `seldon tell` — any agent can message you on Telegram: `seldon tell "the build is green"`.
//
// The bot token is a secret and lives in comb (TELEGRAM_BOT_TOKEN): seldon never stores it,
// prints it or puts it on a command line — `comb run` hands it over in the environment. The
// chat id is not a secret (it is useless without the token), so `seldon tell --setup` finds it
// once and keeps it in ~/.seldon/telegram.json.
//
// Sending only. Many sessions can send through one bot at once; reading a bot's messages is
// one-reader-only, which is what Claude Code's own Telegram channel does for one session.
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { SELDON_HOME } from "./agents.mjs";

export const TOKEN_NAME = "TELEGRAM_BOT_TOKEN";
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

export async function sendText(token, chatId, text) {
  for (const part of chunks(text)) await call(token, "sendMessage", { chat_id: chatId, text: part, disable_web_page_preview: true });
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

export async function sendFile(token, chatId, path, caption = "") {
  const size = statSync(path).size;
  if (size > MAX_UPLOAD) throw new Error(`${basename(path)} is ${(size / 1048576).toFixed(0)} MB — Telegram bots can send up to 50 MB`);
  const { method, field } = mediaKind(path);
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) form.set("caption", caption.slice(0, 1024));
  if (method === "sendVideo") form.set("supports_streaming", "true");
  form.set(field, new Blob([readFileSync(path)]), basename(path));
  await call(token, method, form);
}
