// Feedback on screen: a toast after every action and a confirm box before anything that stops
// or removes. Pure string work — the screens hand over the lines they drew and get them back
// with the box laid on top — so it is tested without a terminal.

export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
// Columns a string takes. Emoji and other wide glyphs take two.
export function width(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  return w;
}
const padTo = (s, w) => s + " ".repeat(Math.max(0, w - width(s)));

// A rounded box around some lines. `paint` colours the border.
export function box(lines, { title = "", paint = (x) => x, min = 0 } = {}) {
  const inner = Math.max(min, width(title) + 2, ...lines.map(width));
  const top = title ? `╭─ ${title} ${"─".repeat(Math.max(0, inner - width(title) - 1))}╮` : `╭${"─".repeat(inner + 2)}╮`;
  return [paint(top), ...lines.map((l) => `${paint("│")} ${padTo(l, inner)} ${paint("│")}`), paint(`╰${"─".repeat(inner + 2)}╯`)];
}

// The kinds a toast can be, and how each one is drawn.
export const TOAST = { ok: "✓", warn: "!", err: "✗", info: "·" };
export function toastLines(text, kind = "info", paint = {}) {
  const p = paint[kind] || ((x) => x);
  return box([`${p(TOAST[kind] || "·")} ${text}`], { paint: p });
}

// Lay `boxLines` over `screen`, right-aligned, its last line `above` rows from the bottom.
// The rows it lands on are the blank filler between the list and the hints, so nothing is hidden.
export function placeToast(screen, boxLines, cols, above = 0) {
  const out = [...screen];
  const end = Math.max(boxLines.length - 1, out.length - 1 - above);
  boxLines.forEach((l, i) => {
    const at = end - (boxLines.length - 1) + i;
    if (at < 0) return;
    const left = Math.max(0, cols - width(l) - 2);
    const under = stripAnsi(out[at] || "");
    out[at] = (width(under) <= left ? padTo(out[at] || "", left) : padTo(under.slice(0, left), left)) + l;
  });
  return out;
}

// A modal: the screen behind is dimmed and the box sits in the middle.
export function placeModal(screen, boxLines, cols, rows, dim = (x) => x) {
  const out = Array.from({ length: Math.max(rows, screen.length) }, (_, i) => dim(stripAnsi(screen[i] || "")));
  const top = Math.max(0, Math.floor((out.length - boxLines.length) / 2));
  const left = Math.max(0, Math.floor((cols - width(boxLines[0] || "")) / 2));
  boxLines.forEach((l, i) => {
    const plain = stripAnsi(screen[top + i] || "");
    out[top + i] = dim(padTo(plain.slice(0, left), left)) + l;
  });
  return out;
}

// Is the last toast still worth showing?
export const TOAST_MS = 4000;
export const fresh = (t, now = Date.now()) => !!t && now - t.at < TOAST_MS;
