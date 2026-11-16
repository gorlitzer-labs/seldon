// The preview on the right of the workspace: what the selected agent last said, and the keys
// that answer it. Pure, so the decisions that type into an agent are tested.

// Numbered choices at the end of a message — "1. straight to the queue" / "2) review first".
// Only a run that starts at 1 and counts up, at least two long, and only near the end: a
// numbered list in the middle of an explanation is not a question.
export function parseOptions(text) {
  const lines = String(text || "").trimEnd().split("\n").slice(-12);
  const opts = [];
  for (const l of lines) {
    const m = l.match(/^\s*(?:[-*]\s*)?(?:\*\*)?(\d)[.)](?:\*\*)?\s+(.+?)\s*$/);
    if (m && Number(m[1]) === opts.length + 1) opts.push({ n: opts.length + 1, label: m[2].replace(/\*\*/g, "") });
    else if (m && Number(m[1]) === 1) { opts.length = 0; opts.push({ n: 1, label: m[2].replace(/\*\*/g, "") }); }
  }
  return opts.length >= 2 && opts.length <= 9 ? opts : [];
}

// The keys the preview offers. Typing into an agent only when it is waiting and seldon can
// reach it (a tmux agent); otherwise the only way to answer is to open it.
export function previewKeys(row, options = []) {
  if (!row) return [];
  const open = ["⏎", "open it"];
  if (row.off) return [];
  if (row.state !== "needs-you") return [open, ["x", "stop"]];
  if (!row.lane?.tmuxSession) return [["⏎", "open it to answer"], ["x", "stop"]];
  return [...options.map((o) => [String(o.n), short(o.label, 22)]), ["a", "type an answer"], open, ["x", "stop"]];
}
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// The words shown, wrapped to the pane: the last paragraphs that fit, code blocks out.
export function previewBody(text, width, maxLines) {
  const clean = String(text || "").replace(/```[\s\S]*?```/g, "[code]").replace(/\*\*|__|`/g, "");
  const out = [];
  for (const para of clean.split(/\n/)) {
    if (!para.trim()) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/\s+/)) {
      if ((line + " " + word).trim().length > width) { out.push(line); line = word; }
      else line = (line + " " + word).trim();
    }
    out.push((para.match(/^\s*/)[0] || "") + line);
  }
  while (out.length && !out.at(-1).trim()) out.pop();
  return out.slice(-maxLines);
}

// A state in words, the same words everywhere.
export function stateWords(row) {
  if (!row) return "";
  if (row.off) return `paused · ${row.machine} is asleep`;
  if (row.state === "needs-you") return row.waitingFor && row.waitingFor !== "you" ? `waiting: ${row.waitingFor}` : "waiting for an answer";
  return { working: "working", running: "working", idle: "idle", stopped: "stopped", failed: "stopped with an error" }[row.state] || row.state;
}
