const on = process.stdout.isTTY && !process.env.NO_COLOR;
const w = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = { bold: w("1"), dim: w("2"), red: w("31"), green: w("32"), yellow: w("33"), cyan: w("36"), honey: w("38;5;214") };
export const say = (...a) => console.log(...a);
export const step = (n, m) => console.log(`${c.honey(`[${n}]`)} ${m}`);
export const ok = (m) => console.log(`${c.green("✓")} ${m}`);
export const warn = (m) => console.log(`${c.yellow("!")} ${m}`);
export const err = (m) => console.error(`${c.red("✗")} ${m}`);
