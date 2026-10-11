// A desktop notification, best-effort: macOS (osascript), Linux (notify-send), else nothing.
// SELDON_NO_NOTIFY silences it (tests, CI).
import { execFile } from "node:child_process";

export function notify(title, message) {
  if (process.env.SELDON_NO_NOTIFY) return;
  const esc = (s) => String(s).replace(/["\\]/g, "\\$&").slice(0, 240);
  if (process.platform === "darwin") execFile("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`], () => {});
  else if (process.platform === "linux") execFile("notify-send", [String(title), String(message)], () => {});
}
