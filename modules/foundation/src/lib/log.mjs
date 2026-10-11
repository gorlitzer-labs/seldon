// Tiny colored logger — no deps. Honors NO_COLOR.
const on = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  cyan: wrap("36"),
};

export const say = (...a) => console.log(...a);
export const ok = (m) => console.log(`${c.green("✓")} ${m}`);
export const warn = (m) => console.log(`${c.yellow("!")} ${m}`);
export const err = (m) => console.error(`${c.red("✗")} ${m}`);
export const info = (m) => console.log(`${c.cyan("·")} ${m}`);

// A drift/finding for `doctor` — collected, then rendered; exit code driven by count.
export class Findings {
  constructor() { this.items = []; }
  add(level, msg) { this.items.push({ level, msg }); return this; }
  drift(msg) { return this.add("drift", msg); }
  note(msg) { return this.add("note", msg); }
  get driftCount() { return this.items.filter((i) => i.level === "drift").length; }
  render() {
    if (this.items.length === 0) { ok("no drift — docs match reality"); return 0; }
    for (const i of this.items) (i.level === "drift" ? err : warn)(i.msg);
    const d = this.driftCount;
    console.log(d ? c.red(`\n${d} drift issue(s)`) : c.yellow("\nnotes only, no drift"));
    return d ? 1 : 0;
  }
}
