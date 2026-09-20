// Throttled npm-registry update check — shared shape across the Seldon tools.
// Reads this package's own version, checks the registry at most once a day
// (cached under ~/.seldon), and prints a one-line notice to stderr if a newer
// version is out. Never blocks meaningfully, never throws.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
export const VERSION = PKG.version;
const NAME = PKG.name;
const SHORT = NAME.includes("/") ? NAME.split("/").pop() : NAME;
const CACHE = join(homedir(), ".seldon", `update-${SHORT}.json`);
const DAY = 24 * 60 * 60 * 1000;

const newer = (a, b) => {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0; }
  return false;
};
const read = () => { try { return JSON.parse(readFileSync(CACHE, "utf8")); } catch { return null; } };
const write = (o) => { try { mkdirSync(dirname(CACHE), { recursive: true }); writeFileSync(CACHE, JSON.stringify(o)); } catch { /* ignore */ } };

/** Check (throttled to once/day) and print an update notice to stderr.
 *  Safe to call on every run — silent when current, offline, or npm is absent. */
export function checkAndNotify() {
  try {
    const c = read();
    let latest = c?.latest;
    if (!c || Date.now() - c.at > DAY) {
      try {
        latest = execFileSync("npm", ["view", NAME, "version"], { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
        if (/^\d+\.\d+\.\d+/.test(latest)) write({ at: Date.now(), latest });
      } catch { /* offline / npm unavailable — skip */ }
    }
    if (latest && newer(latest, VERSION))
      process.stderr.write(`\x1b[33m  ${SHORT} ${latest} is available\x1b[0m \x1b[2m— you have ${VERSION}. Update: \x1b[36mseldon install ${SHORT}\x1b[0m\x1b[2m (or npm i -g ${NAME})\x1b[0m\n`);
  } catch { /* never break the CLI */ }
}
