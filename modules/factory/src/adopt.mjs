// `factory adopt [dir]` — bring an EXISTING repo onto the line. `factory new` is for a blank idea;
// this is for the project you already have. Idempotent: run it again and it only fills in what
// is missing — it never overwrites docs, never re-inits git, and reuses a hive that is still up.
//   repo check -> foundation init (never clobbers) -> hive (reuse or open) -> register -> next steps
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { createServer } from "node:net";
import { c, say, step, ok, warn } from "./lib/log.mjs";
import { readRegistry, addToRegistry, pruneRegistry } from "./lib/hive.mjs";
import { openHive } from "./new.mjs";

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const has = (cmd) => { try { sh("sh", ["-c", `command -v ${cmd}`]); return true; } catch { return false; } };

export const slugName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";

// The open items at the top of docs/QUEUE.md — what "what's next" means for this repo.
export function openQueueItems(dir, limit = 3) {
  let q = "";
  try { q = readFileSync(join(dir, "docs", "QUEUE.md"), "utf8"); } catch { return { total: 0, top: [] }; }
  const items = q.split("\n").filter((l) => /^- \[ \] /.test(l)).map((l) => l.replace(/^- \[ \] /, "").trim());
  return { total: items.length, top: items.slice(0, limit) };
}

// .factory.json carries the hive's admin token. Keep it out of git without touching the
// repo's own .gitignore: .git/info/exclude is local to this clone.
export function excludeLocally(dir, file) {
  const ex = join(dir, ".git", "info", "exclude");
  if (!existsSync(join(dir, ".git"))) return false;
  let cur = "";
  try { cur = readFileSync(ex, "utf8"); } catch {}
  if (cur.split("\n").some((l) => l.trim() === file || l.trim() === "/" + file)) return false;
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  appendFileSync(ex, (cur && !cur.endsWith("\n") ? "\n" : "") + "/" + file + "\n");
  return true;
}

const portFree = (port) => new Promise((res) => {
  const s = createServer();
  s.once("error", () => res(false));
  s.once("listening", () => s.close(() => res(true)));
  s.listen(port, "127.0.0.1");
});
// `taken`: ports other registered hives claim. A hive that is down leaves its port free on the
// OS, but reusing it would make the registry send that hive's traffic to this one.
export async function freePort(start = 7920, span = 50, taken = new Set()) {
  for (let p = start; p < start + span; p++) if (!taken.has(p) && await portFree(p)) return p;
  throw new Error(`no free port in ${start}-${start + span - 1} for the hive`);
}

async function reachable(url) {
  try { await fetch(url + "/", { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
}

export async function factoryAdopt(target, flags = {}) {
  const dir = resolve(target || process.cwd());
  if (!existsSync(dir)) throw new Error(`${dir} does not exist`);
  if (!existsSync(join(dir, ".git"))) throw new Error(`${dir} is not a git repo — for a brand-new project use: factory new "<idea>"`);
  const name = slugName(flags.name || basename(dir));

  say(`\n${c.honey("🏭 The Agentic Factory")} — adopting ${c.bold(name)} ${c.dim(dir)}\n`);

  // 0. Registry hygiene: drop hives whose folder is gone (renamed, deleted, old scratch dirs),
  // or `factory watch --all` keeps supervising projects that no longer exist.
  const pruned = pruneRegistry();
  if (pruned.length) ok(`registry: dropped ${pruned.length} hive(s) whose folder is gone ${c.dim("(" + pruned.join(", ") + ")")}`);

  // 1. Foundation — idempotent; creates only the docs that are missing.
  step(1, "foundation");
  const fcmd = has("foundation") ? ["foundation", ["init", dir]] : ["npx", ["--yes", "@gorlitzer-labs/foundation", "init", dir]];
  sh(fcmd[0], fcmd[1], { stdio: "ignore" });
  ok(`Foundation in place ${c.dim("(existing docs kept)")}`);

  // 2. Hive — reuse this repo's hive if it is still answering, else open one.
  step(2, "hive");
  let hive = null;
  const prev = readRegistry().find((e) => e.dir === dir);
  if (prev?.hive?.serverUrl && await reachable(prev.hive.serverUrl)) {
    hive = prev.hive;
    ok(`hive ${c.bold(prev.name)} already up on ${c.dim(hive.serverUrl)}`);
  } else if (!has("apiary")) {
    warn("apiary not on PATH — skipping the hive. Install it (seldon install apiary), then re-run adopt.");
  } else {
    const taken = new Set(readRegistry().filter((e) => e.dir !== dir)
      .map((e) => { try { return parseInt(new URL(e.hive.serverUrl).port, 10); } catch { return 0; } }));
    const port = flags.port ? parseInt(flags.port, 10) : await freePort(7920, 50, taken);
    hive = await openHive(name, port);
    ok(`hive ${c.bold(name)} up on ${c.dim(hive.serverUrl)} ${c.dim("(room history resumes if it existed)")}`);
  }

  // 3. Register — so `factory board` and `factory watch --all` see it.
  step(3, "register");
  if (hive) {
    writeFileSync(join(dir, ".factory.json"), JSON.stringify({ name, hive }, null, 2));
    if (excludeLocally(dir, ".factory.json")) ok(`.factory.json kept out of git ${c.dim("(.git/info/exclude — it holds the hive token)")}`);
    excludeLocally(dir, ".factory/");   // the supervisor's digest log lives here
    addToRegistry({ name, dir, hive, added: prev?.added || new Date().toISOString() });
    ok("registered with the supervisor");
  } else warn("not registered (no hive)");

  // 4. What next — the whole point: never open a repo and wonder what to do.
  const q = openQueueItems(dir);
  say(`\n${c.honey("adopted.")} ${c.bold(name)} is on the line.\n`);
  if (q.total) {
    say(`  ${c.bold("next up")} ${c.dim(`(${q.total} open in docs/QUEUE.md)`)}`);
    for (const t of q.top) say(`   • ${t}`);
  } else {
    say(`  ${c.bold("queue is empty")} — add what you want next:`);
    say(`   ${c.cyan(`foundation queue "(P1) <thing>" --dir ${dir}`)}`);
  }
  say("");
  if (hive) {
    say(`  ${c.bold("put an agent on it")}  ${c.cyan(`factory staff ${name}`)}   ${c.dim("(a coordinator that joins this hive)")}`);
    say(`  ${c.bold("join the room")}       ${c.dim(hive.joinUrl)}`);
  }
  say(`  ${c.bold("watch it")}            ${c.cyan("factory board")}   ${c.dim("· the supervisor (seldon up) heals and nudges agents")}\n`);
  return { name, dir, hive, queue: q, pruned };
}
