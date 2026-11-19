// A desktop notification, best-effort: macOS, Linux (notify-send), else nothing.
// SELDON_NO_NOTIFY silences it (tests, CI).
//
// On macOS, `osascript … display notification` is posted by Script Editor, so clicking the
// banner opened Script Editor, not your terminal. terminal-notifier can say which app a click
// brings to the front, so it is used whenever it is installed (brew install terminal-notifier):
// the terminal seldon runs in (macOS sets __CFBundleIdentifier for it, through tmux too).
import { execFile, execFileSync } from "node:child_process";

let notifier;
const hasNotifier = () => {
  if (notifier === undefined) {
    try { execFileSync("which", ["terminal-notifier"], { stdio: "ignore" }); notifier = true; } catch { notifier = false; }
  }
  return notifier;
};

// The arguments for terminal-notifier. Pure, so the click target can be tested.
export function notifierArgs(title, message, env = process.env) {
  const app = env.SELDON_NOTIFY_APP || env.__CFBundleIdentifier || "com.apple.Terminal";
  return ["-title", String(title).slice(0, 240), "-message", String(message).slice(0, 240), "-activate", app, "-group", "seldon"];
}

export function notify(title, message) {
  if (process.env.SELDON_NO_NOTIFY) return;
  if (process.platform === "darwin") {
    if (hasNotifier()) { execFile("terminal-notifier", notifierArgs(title, message), () => {}); return; }
    // No terminal-notifier: arguments go through argv so quotes in a message can't break the script.
    execFile("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run",
      String(title).slice(0, 240), String(message).slice(0, 240)], () => {});
  } else if (process.platform === "linux") execFile("notify-send", [String(title), String(message)], () => {});
}
