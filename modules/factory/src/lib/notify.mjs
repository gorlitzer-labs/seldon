// Off-screen alerting — reach the human when they're not watching the terminal.
// macOS native notifications (best-effort) + a persistent morning briefing file.
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BRIEF = join(homedir(), ".factory", "briefing.md");

// Fire a macOS notification. No-op (silent) on other platforms or if osascript is unavailable.
export function notify(title, message) {
  if (process.platform !== "darwin" || process.env.FACTORY_NO_NOTIFY) return;
  const esc = (s) => String(s).replace(/["\\]/g, "\\$&").slice(0, 240);
  execFile("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}" sound name "Submarine"`], () => {});
}

// Append a timestamped line to the accumulating briefing (the thing you read at 8am).
export function brief(line) {
  mkdirSync(join(homedir(), ".factory"), { recursive: true });
  const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
  appendFileSync(BRIEF, `- ${ts}  ${line}\n`);
}
export const BRIEFING_PATH = BRIEF;
