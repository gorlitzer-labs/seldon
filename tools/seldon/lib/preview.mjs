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
  if (row.state === "gone") return [["x", "remove it from the list"]];
  // Reply is offered to an agent at rest (waiting or idle) that seldon can type into. Never to
  // one at work: typing would land in the middle of what it is doing.
  const atRest = row.state === "needs-you" || row.state === "idle";
  if (!atRest) return [open, ["x", "stop"]];
  if (!row.lane?.tmuxSession) return [["⏎", row.state === "needs-you" ? "open it to answer" : "open it"], ["x", "stop"]];
  const opts = row.state === "needs-you" ? options.map((o) => [String(o.n), short(o.label, 22)]) : [];
  return [...opts, ["a", "reply"], open, ["x", "stop"]];
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
  if (row.state === "gone") return "gone: it stopped before its first answer, nothing to reopen";
  if (row.state === "needs-you") return row.waitingFor && row.waitingFor !== "you" ? `waiting: ${row.waitingFor}` : "waiting for an answer";
  return { working: "working", running: "working", idle: "idle", stopped: "stopped", failed: "stopped with an error" }[row.state] || row.state;
}

// ---- the question --------------------------------------------------------------------
// What the agent asks you: the last sentence of its message that ends with "?", if the message
// ends on it (a "?" early on, followed by more explanation, is not a question to you).
export function askOf(text) {
  const t = String(text || "").replace(/```[\s\S]*?```/g, "").trim();
  const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const isOptions = (p) => p.split("\n").every((l) => /^\s*\d+[.)]\s/.test(l));
  // numbered options at the very end belong to the question just before them
  let cand = paras.at(-1) || "";
  if (isOptions(cand) && paras.length > 1) cand = paras.at(-2);
  const flat = cand.split("\n").map((l) => l.replace(/^\s*([-*•]|\d+[.)])\s+/, "")).join(" ").replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
  if (!/\?$/.test(flat)) return null;
  const sentences = flat.match(/[^.!?:]*\?/g);
  return sentences ? sentences.at(-1).trim() : null;
}

// ---- formatting -----------------------------------------------------------------------
// Wrap a message for the pane and style it: lists become "•" with the wrapped lines hanging
// under the text, **bold** and `code` styled, PR numbers, commit hashes and versions picked out.
// `paint` supplies the colours: { bold, code, ref, version, dim }.
export function formatBody(text, width, paint = {}) {
  const P = { bold: (x) => x, code: (x) => x, ref: (x) => x, version: (x) => x, dim: (x) => x, ...paint };
  const clean = String(text || "").replace(/```[\s\S]*?```/g, "‹code›");
  const out = [];
  for (const raw of clean.split("\n")) {
    if (!raw.trim()) { if (out.length && out.at(-1) !== "") out.push(""); continue; }
    const m = raw.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)$/);
    const lead = m ? `${m[1]}${/\d/.test(m[2]) ? m[2] : "•"} ` : "";
    const hang = " ".repeat(lead.length);
    const words = (m ? m[3] : raw.trim()).split(/\s+/);
    let line = "";
    const flush = (first) => { out.push((first ? lead : hang) + line); line = ""; };
    let first = true;
    for (const w of words) {
      const plainLen = (s) => s.replace(/\*\*|`/g, "").length;
      if (line && plainLen(line) + 1 + plainLen(w) + lead.length > width) { flush(first); first = false; }
      line = line ? `${line} ${w}` : w;
    }
    if (line) flush(first);
  }
  while (out.length && out.at(-1) === "") out.pop();
  return out.map((l) => styleLine(l, P));
}
function styleLine(l, P) {
  return l
    .replace(/\*\*([^*]+)\*\*/g, (_, x) => P.bold(x))
    .replace(/`([^`]+)`/g, (_, x) => P.code(x))
    .replace(/\*\*|`/g, "")
    .replace(/(^|[\s(])(#\d+)(?=[\s,.)/:;]|$)/g, (_, a, x) => a + P.ref(x))
    .replace(/(^|[\s(])([0-9a-f]{7,40})(?=[\s,.);:]|$)/g, (_, a, x) => (/[a-f]/.test(x) && /\d/.test(x) ? a + P.ref(x) : a + x))
    .replace(/(^|[\s(@v])(\d+\.\d+\.\d+)(?=[\s,.);:]|$)/g, (_, a, x) => a + P.version(x))
    .replace(/^(\s*)(•|\d+[.)])(?= )/, (_, s, b) => s + P.dim(b));
}

// Only the end of a long message, unless asked for all of it: the last paragraph (and a list
// that belongs to it). Returns { lines, cut } where cut says something was left out.
export function summaryOf(text) {
  const paras = String(text || "").trim().split(/\n\s*\n/);
  if (paras.length <= 2) return { text: String(text || "").trim(), cut: false };
  let keep = paras.slice(-1);
  if (/^\s*(\d[.)]|[-*•])\s/.test(keep[0]) && paras.length > 2) keep = paras.slice(-2);
  return { text: keep.join("\n\n"), cut: true };
}

// "3 min ago" for when the message was written.
export function agoWords(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
