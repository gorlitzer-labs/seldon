/**
 * Find the secrets you have already leaked.
 *
 * This is the half no vault does, and it is the half that makes manual rotation
 * survivable. Rotating credentials is slow and irreversible-ish, so "rotate
 * everything, just in case" is advice nobody follows twice. Knowing that three
 * specific keys appeared in a transcript turns a day of work into ten minutes.
 *
 * Agent sessions are the leak nobody watches. A token pasted into a chat is
 * written to a transcript file and stays there, in plaintext, indefinitely —
 * long after the conversation is forgotten. Shell history is the same story with
 * a longer tradition.
 *
 * Two kinds of finding, and the difference matters:
 *
 *   - EXACT   a value from your own store appears verbatim in a file. Certain.
 *   - SHAPED  something that looks like a credential by its prefix. Probable,
 *             and biased: a GitHub token announces itself with `ghp_`, while a
 *             Cloudflare token is forty characters of nothing in particular and
 *             cannot be recognised at all. Finding none proves nothing.
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Credentials that announce themselves. Deliberately not exhaustive. */
export const SHAPES = [
  { name: "GitHub token", rx: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "GitHub fine-grained PAT", rx: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: "AWS access key id", rx: /AKIA[0-9A-Z]{16}/g },
  { name: "Slack token", rx: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "Google API key", rx: /AIza[0-9A-Za-z_\-]{30,}/g },
  { name: "OpenAI key", rx: /sk-[A-Za-z0-9_\-]{20,}/g },
  { name: "Anthropic key", rx: /sk-ant-[A-Za-z0-9_\-]{20,}/g },
  { name: "private key block", rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/** Where credentials go to be forgotten about. */
export function defaultTargets(home = homedir()) {
  return [
    { label: "Claude transcripts", path: join(home, ".claude", "projects") },
    { label: "Codex sessions", path: join(home, ".codex", "sessions") },
    { label: "Codex history", path: join(home, ".codex", "history.jsonl") },
    { label: "zsh history", path: join(home, ".zsh_history") },
    { label: "bash history", path: join(home, ".bash_history") },
  ].filter((t) => existsSync(t.path));
}

/** Every readable file under a path, capped so a huge tree cannot hang the scan. */
function* walk(path, budget = { files: 20000 }) {
  let st;
  try { st = statSync(path); } catch { return; }
  if (st.isFile()) { yield path; return; }
  if (!st.isDirectory()) return;
  let entries;
  try { entries = readdirSync(path); } catch { return; }
  for (const e of entries) {
    if (budget.files-- <= 0) return;
    yield* walk(join(path, e), budget);
  }
}

/**
 * Scan for leaks.
 *
 * `known` maps name → current value. Those are matched verbatim, which is the
 * only certain signal available; everything else is a shape and says so.
 * Values are compared, never returned — a leak report that quotes the secret
 * has simply moved the leak.
 */
export function scan({ targets = defaultTargets(), known = {}, minLength = 16 } = {}) {
  const exact = new Map();   // name -> { files:Set, hits:number }
  const shaped = new Map();  // shapeName -> { distinct:Set, hits:number, files:Set }

  const watch = Object.entries(known).filter(([, v]) => typeof v === "string" && v.length >= minLength);

  for (const target of targets) {
    for (const file of walk(target.path)) {
      let text;
      try { text = readFileSync(file, "utf-8"); } catch { continue; }

      for (const [name, value] of watch) {
        if (!text.includes(value)) continue;
        const rec = exact.get(name) ?? { files: new Set(), hits: 0, labels: new Set() };
        rec.hits += text.split(value).length - 1;
        rec.files.add(file);
        rec.labels.add(target.label);
        exact.set(name, rec);
      }

      for (const shape of SHAPES) {
        const found = text.match(shape.rx);
        if (!found) continue;
        const rec = shaped.get(shape.name) ?? { distinct: new Set(), hits: 0, files: new Set(), labels: new Set() };
        rec.hits += found.length;
        for (const f of found) rec.distinct.add(f);
        rec.files.add(file);
        rec.labels.add(target.label);
        shaped.set(shape.name, rec);
      }
    }
  }
  return { exact, shaped, targets };
}
