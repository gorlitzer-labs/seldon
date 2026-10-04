#!/usr/bin/env node
// seldon — the Seldon stack installer. Pick your tools; install each via its
// native method. Zero dependencies: a raw-terminal checklist, no build step.
import { execSync, spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { MODULES, byId, DEPS, RAW, MONOREPO, withRequires, platformOk } from "../modules.mjs";
import { ensureSiblingPath, loadState, resolveProject, adopt as fAdopt, staff as fStaff, attach as fAttach, hiveOf, sameDir } from "../lib/projects.mjs";
import { readLanes, readPlan, addToPlan, run as runCmd, runSteps, projectRoot, harnessBins, recordLane } from "../lib/agents.mjs";
import { openCommand, stopCommand, startCommands, slugify, laneForItem, HARNESSES } from "../lib/lanes.mjs";
import { buildRows, headline, ago, laneDetail, unlistedAgents, GLYPH } from "../lib/home.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The monorepo root when running from a checkout (tools/seldon/bin -> ../../..)
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const IN_CHECKOUT = fs.existsSync(path.join(REPO_ROOT, "modules", "apiary", "package.json"));

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  gold: (s) => `\x1b[33m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function have(dep) {
  const probe = DEPS[dep]?.probe;
  if (!probe) return true;
  try { execSync(probe, { stdio: "ignore" }); return true; } catch { return false; }
}
const depCache = {};
const depOk = (d) => (depCache[d] ??= have(d));

// ---- doctor -----------------------------------------------------------------
function doctorFor(ids) {
  const needed = new Set();
  for (const id of ids) for (const d of byId[id].needs) needed.add(d);
  const rows = [...needed].map((d) => ({ d, ok: depOk(d), hint: DEPS[d]?.hint }));
  return rows;
}
function printDoctor(ids) {
  const rows = doctorFor(ids);
  if (!rows.length) { console.log(C.dim("  no external deps for this selection")); return true; }
  let allOk = true;
  for (const r of rows) {
    if (r.ok) console.log(`  ${C.green("✓")} ${r.d}`);
    else { allOk = false; console.log(`  ${C.red("✗")} ${r.d}  ${C.dim("— " + r.hint)}`); }
  }
  return allOk;
}

// ---- install actions --------------------------------------------------------
function run(cmd, args, opts = {}) {
  console.log(C.dim(`  $ ${cmd} ${args.join(" ")}`));
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  return r.status === 0;
}

// Is a command on PATH? (used to pick the fastest package manager)
const has = (bin) => { try { execSync(`command -v ${bin}`, { stdio: "ignore" }); return true; } catch { return false; } };

// A usable uv, for Python modules. Prefer one on PATH; else a prior isolated
// copy; else bootstrap uv into ~/.seldon/bin with NO shell/profile changes.
// uv can fetch a standalone CPython (e.g. 3.12) itself, so the user's own
// Python is never touched — which is the whole point for demerzel. null = give up.
function ensureUv() {
  if (has("uv")) return "uv";
  const dir = path.join(process.env.HOME, ".seldon", "bin");
  const local = path.join(dir, "uv");
  if (fs.existsSync(local)) return local;
  console.log(C.dim("  installing uv (isolated → ~/.seldon/bin, no shell changes)"));
  fs.mkdirSync(dir, { recursive: true });
  const ok = run("bash", ["-c",
    `curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR='${dir}' UV_NO_MODIFY_PATH=1 sh`]);
  return ok && fs.existsSync(local) ? local : null;
}

// Fallback interpreter when uv is unavailable: an exact minor already on PATH
// (python3.12 → 3.11 → 3.10). Used only to seed an isolated venv, never modified.
function pickPython(ver) {
  const [maj, min] = ver.split(".").map(Number);
  for (let m = min; m >= 10; m--) { const b = `python${maj}.${m}`; if (has(b)) return b; }
  return null;
}

// pnpm can only `add -g` when a global bin dir is configured (else ERR_PNPM_NO_GLOBAL_BIN_DIR).
const pnpmGlobalReady = () => {
  if (process.env.PNPM_HOME) return true;
  try {
    const d = execSync("pnpm config get global-bin-dir", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return !!d && d !== "undefined" && d !== "null";
  } catch { return false; }
};

// ---- where the node CLIs actually live --------------------------------------
// A global package can sit under npm, under pnpm, or under two pnpms at once:
// Homebrew's pnpm and corepack's are different majors, and pnpm 11 refuses to
// run unless $PNPM_HOME/bin is on PATH. So everything here answers from the
// filesystem, never from a package manager's exit code — `npm rm -g` of a
// package npm never had exits 0, and that used to be printed as "removed".

const realpath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const defaultPnpmHome = () => process.env.PNPM_HOME
  || (process.platform === "darwin" ? path.join(process.env.HOME, "Library", "pnpm") : path.join(process.env.HOME, ".local", "share", "pnpm"));

// Env for running one package-manager binary: its own dir first (so the right
// node is found), and pnpm's bin dir on PATH (pnpm 11 checks for it, even to rm).
function pmEnv(bin) {
  const extra = path.isAbsolute(bin) ? [path.dirname(bin)] : [];
  if (path.basename(bin) === "pnpm") extra.push(defaultPnpmHome(), path.join(defaultPnpmHome(), "bin"));
  return { ...process.env, PATH: [...extra, process.env.PATH || ""].join(":") };
}

// Every distinct executable for a package manager on PATH (realpath-deduped).
function pmBins(pm) {
  const seen = new Set(), out = [];
  let found = "";
  try { found = execSync(`which -a ${pm}`, { stdio: ["ignore", "pipe", "ignore"] }).toString(); } catch {}
  for (const p of found.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const r = realpath(p);
    if (!seen.has(r)) { seen.add(r); out.push(p); }
  }
  return out;
}

// The global node_modules one package-manager binary installs into.
function rootOf(bin) {
  if (path.basename(bin) === "bun") return path.join(process.env.HOME, ".bun", "install", "global", "node_modules");
  try { return execSync(`"${bin}" root -g`, { stdio: ["ignore", "pipe", "ignore"], env: pmEnv(bin) }).toString().trim().split("\n").pop() || ""; }
  catch { return ""; }
}

let rootsCache = null;
// Every global node_modules this machine has: one per package-manager binary,
// plus the one next to node itself (`npm i -g` with a node-prefixed npm puts
// packages there, and no other npm can see them to remove them).
function globalRoots() {
  if (rootsCache) return rootsCache;
  const seen = new Set(), out = [];
  const push = (r) => { const k = realpath(r.root); if (r.root && !seen.has(k)) { seen.add(k); out.push(r); } };
  for (const pm of ["pnpm", "npm", "bun"]) {
    for (const bin of pmBins(pm)) {
      const root = rootOf(bin);
      if (root) push({ pm, bin, root });
    }
  }
  const prefix = process.env.SELDON_NODE_PREFIX || path.resolve(path.dirname(process.execPath), "..");
  push({ pm: "node-prefix", bin: "", root: path.join(prefix, "lib", "node_modules") });
  return (rootsCache = out);
}

const pkgDir = (root, pkg) => path.join(root, ...pkg.split("/"));
const installedAt = (pkg) => globalRoots().filter((r) => fs.existsSync(path.join(pkgDir(r.root, pkg), "package.json")));

// The package manager that installed seldon itself — the stack goes there too,
// so one `npm i -g @gorlitzer-labs/seldon` never ends up split across two.
// Compare against the RESOLVED package dir, not the root: pnpm's global
// node_modules/<pkg> is a symlink into a .pnpm store beside it, so the running
// file's real path is never under the root itself.
function homePM() {
  const self = realpath(process.argv[1] || "");
  return globalRoots().find((r) => {
    if (!r.bin) return false;
    const dir = pkgDir(r.root, "@gorlitzer-labs/seldon");
    return fs.existsSync(dir) && self.startsWith(realpath(dir) + path.sep);
  }) || null;
}

// Pick the node package manager: --pm=<x> override (pnpm|bun|npm), else the one
// seldon lives under, else pnpm when it can global-install, else npm.
function nodePM() {
  const ov = (process.argv.find((a) => a.startsWith("--pm=")) || "").split("=")[1];
  if (ov) return { pm: ov, bin: ov };
  const home = homePM();
  if (home) return { pm: home.pm, bin: home.bin };
  if (has("pnpm") && pnpmGlobalReady()) return { pm: "pnpm", bin: "pnpm" };
  return { pm: "npm", bin: "npm" };
}

// Remove one package from one root. A node-prefix root has no package manager
// that can see it, so its dir and the bin links pointing into it go directly.
function removeAt(loc, pkg) {
  const dir = pkgDir(loc.root, pkg);
  if (loc.pm === "node-prefix") {
    const binDir = path.join(loc.root, "..", "..", "bin");
    try {
      for (const f of fs.readdirSync(binDir)) {
        const l = path.join(binDir, f);
        try { if (fs.lstatSync(l).isSymbolicLink() && realpath(l).startsWith(realpath(dir) + path.sep)) fs.rmSync(l); } catch {}
      }
    } catch {}
    console.log(C.dim(`  $ rm -rf ${dir}`));
    fs.rmSync(dir, { recursive: true, force: true });
  } else {
    run(loc.bin, [loc.pm === "bun" ? "remove" : "rm", "-g", pkg], { env: pmEnv(loc.bin) });
  }
  rootsCache = null;
  return !fs.existsSync(path.join(dir, "package.json"));
}

function installNpm(m, dev) {
  const { pm, bin } = nodePM();
  if (dev && IN_CHECKOUT) {
    const dir = path.join(REPO_ROOT, m.dir);
    const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json")));
    if (pj.scripts?.build) run(bin, ["run", "build"], { cwd: dir, env: pmEnv(bin) });
    const link = pm === "pnpm" ? ["link", "--global"] : ["link"]; // bun/npm: `link`
    if (run(bin, link, { cwd: dir, env: pmEnv(bin) })) return true;
    if (pm !== "npm") { console.log(C.dim("  falling back to npm link…")); return run("npm", ["link"], { cwd: dir }); }
    return false;
  }
  // pnpm/bun: `add -g` · npm: `install -g` — a global CLI, no project touched
  const add = pm === "npm" ? ["install", "-g", m.pkg] : ["add", "-g", m.pkg];
  let used = bin;
  let ok = run(bin, add, { env: pmEnv(bin) });
  if (!ok && pm !== "npm") { console.log(C.dim(`  ${pm} failed — falling back to npm…`)); used = "npm"; ok = run("npm", ["install", "-g", m.pkg]); }
  if (!ok) return false;
  // Exactly one copy: an older one under another package manager would shadow
  // or outlive this one (that is how a stale factory kept answering).
  rootsCache = null;
  const here = rootOf(used);
  if (!here) return true; // can't tell which copy is the new one — touch nothing
  for (const loc of installedAt(m.pkg)) {
    if (realpath(loc.root) === realpath(here)) continue;
    console.log(C.dim(`  removing the older copy under ${loc.pm}: ${pkgDir(loc.root, m.pkg)}`));
    removeAt(loc, m.pkg);
  }
  return true;
}

function installShell(m, dev) {
  // bifrost: run its installer. In a checkout, run the local file; otherwise
  // fetch it from the monorepo (the standalone repo is retired).
  if (dev && IN_CHECKOUT) return run("bash", [path.join(REPO_ROOT, m.installer)]);
  return run("bash", ["-c", `curl -fsSL ${RAW}/${m.installer} | bash`]);
}

function installPython(m, dev) {
  if (!platformOk(m)) {
    console.log(C.red(`  ${m.id} needs macOS on Apple silicon — skipping`));
    return false;
  }
  const dest = dev && IN_CHECKOUT
    ? path.join(REPO_ROOT, m.dir)
    : path.join(process.env.HOME, ".seldon", m.id);
  if (!(dev && IN_CHECKOUT)) {
    console.log(C.dim(`  fetching ${m.id} into ${dest}`));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(path.join(dest, ".git"))) {
      run("git", ["-C", dest, "pull", "--ff-only"]);   // already cloned → update in place
    } else {
      const tmp = dest + ".tmp";
      fs.rmSync(tmp, { recursive: true, force: true });                 // clear any stale tmp
      if (!run("git", ["clone", "--depth", "1", `https://github.com/${MONOREPO}.git`, tmp])) return false;
      fs.rmSync(dest, { recursive: true, force: true });                // dest must not exist before rename (fixes ENOTEMPTY)
      fs.renameSync(path.join(tmp, m.dir), dest);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  // Always a DEDICATED venv under the module dir — we never install into the
  // user's system/global/active Python. uv (if present) is faster and can even
  // fetch its own CPython, so it doesn't touch their interpreter at all; plain
  // venv+pip is the isolated fallback. No `--system`, no active-env writes.
  const venv = path.join(dest, ".venv");
  const req = path.join(dest, "requirements.txt");
  fs.rmSync(venv, { recursive: true, force: true }); // never reuse a venv built on the wrong Python
  let ok;
  const uv = ensureUv();
  if (uv) {
    const venvArgs = ["venv", venv, "--seed"]; // --seed puts pip in the venv:
    // kokoro/misaki/spaCy shells out to pip at runtime to load its model, and a
    // bare uv venv has none (crashes the voice on start otherwise).
    // uv fetches a standalone CPython — but only if told to. By default it PREFERS
    // a matching system interpreter, and a python.org framework build ships with
    // no CA bundle, so the venv's urllib failed every HTTPS download (the CAM++
    // voiceprint model silently never arrived). only-managed makes the comment true.
    if (m.pyVersion) venvArgs.push("--python", m.pyVersion, "--python-preference", "only-managed");
    if (!run(uv, venvArgs)) return false;
    ok = run(uv, ["pip", "install", "--python", path.join(venv, "bin", "python"), "-r", req]);
  } else {
    // No uv (and couldn't bootstrap it). Fall back to a matching system python.
    const py = m.pyVersion ? pickPython(m.pyVersion) : "python3";
    if (!py) {
      console.log(C.red(`  ${m.id} needs Python ${m.pyVersion} but uv is unavailable and no python${m.pyVersion} is on PATH.`));
      console.log(C.dim(`  install uv (fetches Python ${m.pyVersion} in isolation): https://astral.sh/uv`));
      return false;
    }
    run(py, ["-m", "venv", venv]);
    ok = run(path.join(venv, "bin", "pip"), ["install", "-r", req]);
  }
  // demerzel needs spaCy's en_core_web_sm (kokoro G2P) in the venv — install it
  // with the venv (a bare fetch-models skip would leave the voice unable to start).
  if (ok && m.id === "demerzel") {
    console.log(C.dim("  installing spaCy model en_core_web_sm (voice text processing)…"));
    run(path.join(venv, "bin", "python"), ["-m", "spacy", "download", "en_core_web_sm"]);
  }
  // demerzel has no standalone binary — it runs as a module from its venv.
  if (ok && m.id === "demerzel") console.log(C.dim(`  run it: seldon up   (voice on http://localhost:8770; add --tailnet for your phone)`));
  else if (ok) console.log(C.dim(`  run it: ${path.join(dest, m.bin)}  (isolated venv at ${venv})`));
  return ok;
}

function installOne(m, dev) {
  console.log("\n" + C.bold(`▸ ${m.id}`) + C.dim(` — ${m.title}`));
  const fn = { npm: installNpm, shell: installShell, python: installPython }[m.method];
  const ok = fn(m, dev);
  console.log(ok ? C.green(`  ✓ ${m.id} installed`) : C.red(`  ✗ ${m.id} failed`));
  return ok;
}

async function doInstall(ids, { dev } = {}) {
  ids = withRequires(ids);
  console.log(C.bold(`\nInstalling: `) + ids.join(", ") + (dev ? C.dim("  (dev: link from checkout)") : ""));
  console.log(C.bold("\nPreflight:"));
  const ok = printDoctor(ids);
  if (!ok) console.log(C.gold("\n  ⚠ some deps are missing — install them above, then the tool will work."));
  const results = ids.map((id) => [id, installOne(byId[id], dev)]);
  const good = results.filter(([, r]) => r).map(([i]) => i);
  const bad = results.filter(([, r]) => !r).map(([i]) => i);
  console.log("\n" + C.bold("Done. ") + C.green(good.join(", ") || "—") + (bad.length ? "  " + C.red("failed: " + bad.join(", ")) : ""));
  // demerzel's models are the heavy part — offer to pull them now, at install time.
  if (good.includes("demerzel")) await ensureDemerzelModels({ ask: true });
}

// ---- uninstall --------------------------------------------------------------
// Remove a node CLI from the global store. `rm -g` is the same verb for pnpm,
// npm and bun; try the chosen PM first, then any other present (a tool may have
// been installed under a different one). Removing an absent package is success.
function uninstallNpm(m) {
  const locs = installedAt(m.pkg);
  if (!locs.length) {
    const stray = has(m.bin) ? execSync(`command -v ${m.bin}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() : "";
    if (stray) { console.log(C.red(`  no package manager has ${m.pkg}, but \`${m.bin}\` is still on PATH: ${stray} — remove it by hand`)); return false; }
    console.log(C.dim(`  ${m.id} is not installed (already gone)`));
    return true;
  }
  for (const loc of locs) removeAt(loc, m.pkg);
  const left = installedAt(m.pkg);
  for (const loc of left) console.log(C.red(`  still installed under ${loc.pm}: ${pkgDir(loc.root, m.pkg)}`));
  return left.length === 0;
}

// demerzel & co: the isolated venv lives under ~/.seldon/<id>. Just delete it.
function uninstallPython(m) {
  const dest = path.join(process.env.HOME, ".seldon", m.id);
  if (fs.existsSync(dest)) { fs.rmSync(dest, { recursive: true, force: true }); console.log(C.dim(`  removed ${dest}`)); }
  else console.log(C.dim(`  ${m.id} not present`));
  return true;
}

// bifrost: a single script in ~/bin or ~/.local/bin, plus ~/.config/bifrost.
function uninstallShell(m) {
  let removed = false;
  for (const p of [path.join(process.env.HOME, "bin", m.bin), path.join(process.env.HOME, ".local", "bin", m.bin)]) {
    if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); console.log(C.dim(`  removed ${p}`)); removed = true; }
  }
  const cfg = path.join(process.env.HOME, ".config", m.id);
  if (fs.existsSync(cfg)) { fs.rmSync(cfg, { recursive: true, force: true }); console.log(C.dim(`  removed ${cfg}`)); removed = true; }
  if (!removed) console.log(C.dim(`  ${m.id} not present`));
  return true;
}

function uninstallOne(m) {
  console.log("\n" + C.bold(`▸ ${m.id}`) + C.dim(` — remove`));
  const fn = { npm: uninstallNpm, shell: uninstallShell, python: uninstallPython }[m.method];
  const ok = fn(m);
  console.log(ok ? C.green(`  ✓ ${m.id} removed`) : C.red(`  ✗ ${m.id} failed`));
  return ok;
}

// A single y/N prompt. Built on the same raw-keypress mechanism as the picker
// (proven to release stdin and let the process exit) rather than
// readline.createInterface, whose stdin stayed entangled and hung after abort.
// One keypress: 'y' = yes, anything else (incl. Ctrl-C) = no.
function confirm(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(true); // non-interactive: assume yes (paired with an explicit ids/--all)
    process.stdout.write(question);
    readline.emitKeypressEvents(process.stdin, KEYS);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.ref();  // a prior picker/prompt may have unref'd stdin; without
                          // this the loop empties and we exit before reading a key
    const onKey = (str, key) => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.unref();
      process.stdout.write((str || "") + "\n");
      resolve(/^y$/i.test(str || "") && !(key && key.ctrl));
    };
    process.stdin.on("keypress", onKey);
  });
}

// Read one keypress and return the character (same stdin-safe pattern as confirm).
function readKey(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve("");
    process.stdout.write(question);
    readline.emitKeypressEvents(process.stdin, KEYS);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.ref();
    const onKey = (str, key) => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.unref();
      process.stdout.write((str || "") + "\n");
      resolve((key && key.ctrl && key.name === "c") ? "" : (str || ""));
    };
    process.stdin.on("keypress", onKey);
  });
}

async function doUninstall(ids, { yes = false, all = false } = {}) {
  const targets = all ? MODULES.map((m) => m.id) : ids;
  if (!targets.length) { console.log(C.red("nothing to uninstall — name modules or use `seldon uninstall --all`.")); process.exitCode = 1; return; }
  console.log(C.bold("\nUninstall: ") + targets.join(", "));
  console.log(C.dim("  removes their global CLI / isolated venv — never your system Python, tmux, tailscale, etc."));
  if (!yes && !(await confirm(C.gold("\nProceed? [y/N] ")))) { console.log(C.dim("aborted.")); return; }
  const results = targets.map((id) => [id, uninstallOne(byId[id])]);
  // A full uninstall also drops the isolated ~/.seldon (demerzel + the uv/CPython it bootstrapped).
  if (all) {
    const root = path.join(process.env.HOME, ".seldon");
    if (fs.existsSync(root)) { fs.rmSync(root, { recursive: true, force: true }); console.log(C.dim(`\n  removed ${root} (isolated uv/venv store)`)); }
  }
  const good = results.filter(([, r]) => r).map(([i]) => i);
  const bad = results.filter(([, r]) => !r).map(([i]) => i);
  console.log("\n" + C.bold("Done. ") + C.green("removed: " + (good.join(", ") || "—")) + (bad.length ? "  " + C.red("failed: " + bad.join(", ")) : ""));
  if (bad.length) process.exitCode = 1;
  if (all) {
    const self = installedAt("@gorlitzer-labs/seldon")[0];
    if (self && self.bin) console.log(C.dim(`  seldon itself stays — to remove it too:  ${path.basename(self.bin)} rm -g @gorlitzer-labs/seldon`));
  }
}

// ---- up / down / status : the friendly front door ---------------------------
// The stack's only always-on services are the voice (demerzel) and the
// supervisor loop (factory watch). We run them as detached background daemons,
// track them by pidfile under ~/.seldon/run, and print one map of where to go.
// SELDON_HOME can be overridden (tests point it at a temp dir; also a legit
// user override). Everything — run/, bonsai/, demerzel/, brain — derives from it.
const SELDON_HOME = process.env.SELDON_HOME || path.join(process.env.HOME, ".seldon");
const RUN_DIR = path.join(SELDON_HOME, "run");
const pidFile = (name) => path.join(RUN_DIR, name + ".pid");
const readPid = (name) => { try { return parseInt(fs.readFileSync(pidFile(name), "utf8").trim(), 10) || 0; } catch { return 0; } };
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const portListening = (port) => { try { return !!execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return false; } };
const daemonUp = (name) => { const p = readPid(name); return p && isAlive(p) ? p : 0; };

function startDaemon(name, cmd, args, opts = {}) {
  if (daemonUp(name)) return { already: true, pid: readPid(name) };
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const log = fs.openSync(path.join(RUN_DIR, name + ".log"), "a");
  // cwd defaults to SELDON_HOME: a long-lived daemon must not pin whatever folder
  // `seldon up` was typed in (it did — the supervisor held a project dir open).
  const child = spawn(cmd, args, { detached: true, stdio: ["ignore", log, log], cwd: SELDON_HOME, ...opts });
  fs.writeFileSync(pidFile(name), String(child.pid));
  child.unref();
  return { pid: child.pid };
}
function stopDaemon(name) {
  const pid = readPid(name);
  if (!pid || !isAlive(pid)) { try { fs.rmSync(pidFile(name), { force: true }); } catch {} return false; }
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
  try { fs.rmSync(pidFile(name), { force: true }); } catch {}
  return true;
}
// demerzel needs its model set before it can serve. Check each model it loads by
// name — "any models-- dir in the HF cache" was true after a fetch died halfway,
// so the one it died on (the CAM++ voiceprint, the last download) was never
// offered again. The LLM is not listed: which one depends on the brain, and
// bonsai brings its own. Returns the missing labels; [] means ready.
function demerzelModelsMissing() {
  const hub = path.join(process.env.HOME, ".cache", "huggingface", "hub");
  const snapshotOk = (repo) => {
    const snaps = path.join(hub, "models--" + repo.replace("/", "--"), "snapshots");
    try { return fs.readdirSync(snaps).some((d) => fs.readdirSync(path.join(snaps, d)).length > 0); } catch { return false; }
  };
  const missing = [];
  if (!snapshotOk("mlx-community/Qwen3-ASR-1.7B-8bit")) missing.push("ears (Qwen3-ASR)");
  if (!snapshotOk("hexgrad/Kokoro-82M")) missing.push("voice (Kokoro)");
  if (!fs.existsSync(path.join(SELDON_HOME, "demerzel", "models", "campplus_en.onnx"))) missing.push("voiceprint (CAM++)");
  return missing;
}
const demerzelModelsReady = () => demerzelModelsMissing().length === 0;
const demerzelInstalled = () => fs.existsSync(path.join(SELDON_HOME, "demerzel", ".venv", "bin", "python"));

// This machine's Tailscale IPv4 (100.64.0.0/10), or null. Tries PATH then the
// macOS app location. Used to expose the voice to your phone over the tailnet.
function tailnetIp() {
  for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/tailscale"]) {
    try {
      const ip = execSync(`${bin} ip -4`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split(/\s+/)[0];
      if (/^100\./.test(ip)) return ip;
    } catch {}
  }
  // CLI missing/moved? The tailnet address is still on a utun interface —
  // read it straight from the OS (Tailscale's CGNAT range is 100.64.0.0/10).
  try {
    const out = execSync("ifconfig", { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const m = out.match(/inet (100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)/);
    if (m) return m[1];
  } catch {}
  try { // linux `ip addr`
    const out = execSync("ip -4 addr", { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const m = out.match(/inet (100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)/);
    if (m) return m[1];
  } catch {}
  return null;
}

// Find the Tailscale CLI (PATH, homebrew, or the macOS app bundle).
function tailscaleBin() {
  for (const b of ["tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/tailscale", "/usr/bin/tailscale"]) {
    try { execSync(`${b} version`, { stdio: "ignore" }); return b; } catch {}
  }
  return null;
}
function tailnetDnsName(ts) {
  try {
    const d = JSON.parse(execSync(`${ts} status --json`, { stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).toString());
    return ((d.Self && d.Self.DNSName) || "").replace(/\.$/, "");
  } catch { return null; }
}
function tailscaleServeUrl() {
  const ts = tailscaleBin(); if (!ts) return null;
  try {
    const out = execSync(`${ts} serve status`, { stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).toString();
    const m = out.match(/https:\/\/\S+/);
    return m ? m[0] : null;
  } catch { return null; }
}

// Expose the loopback voice on the tailnet over HTTPS via `tailscale serve`, so a
// phone can use the mic (browsers require a secure context). Provisions the cert,
// then maps / -> :8770 and /ws -> :8765. Returns { url } or { err } with guidance.
function tailscaleServeSetup() {
  const ts = tailscaleBin();
  if (!ts) return { err: "Tailscale CLI not found — install Tailscale to reach the voice from your phone." };
  const dns = tailnetDnsName(ts);
  if (!dns) return { err: "couldn't read the tailnet name (is Tailscale connected?)." };
  console.log(C.dim("  setting up HTTPS via tailscale serve (first cert can take ~30s)…"));
  try { execSync(`${ts} cert ${dns}`, { stdio: ["ignore", "ignore", "pipe"], timeout: 120000 }); }
  catch (e) {
    const err = ((e.stderr && e.stderr.toString()) || "") + (e.message || "");
    if (/does not support|HTTPS is not enabled|not enabled/i.test(err))
      return { err: "HTTPS certs aren't enabled for your tailnet. Enable them at https://login.tailscale.com/admin/dns (HTTPS Certificates), then re-run `seldon up --tailnet`." };
    if (/timed out|ETIMEDOUT/i.test(err))
      return { err: "Tailscale is still provisioning the cert — re-run `seldon up --tailnet` in a moment." };
    // otherwise the cert probably already exists — carry on
  }
  try {
    execSync(`${ts} serve --bg http://127.0.0.1:8770`, { stdio: "ignore", timeout: 30000 });
    execSync(`${ts} serve --bg --set-path=/ws http://127.0.0.1:8765`, { stdio: "ignore", timeout: 30000 });
  } catch (e) {
    return { err: "tailscale serve failed: " + ((e.stderr || e.message || "").toString().split("\n")[0]) };
  }
  return { url: `https://${dns}` };
}

// Fetch demerzel's model set (~25 GB) — offered, never silent. Respects the
// chosen LLM (DEMERZEL_LLM) so `seldon install demerzel` / `seldon up` pull the
// model you'll actually run. --models forces yes, --no-models forces skip.
async function ensureDemerzelModels({ ask = true } = {}) {
  if (!demerzelInstalled() || !platformOk(byId.demerzel)) return false;
  if (demerzelModelsReady()) return true;
  const home = path.join(SELDON_HOME, "demerzel");
  const force = process.argv.includes("--models");
  const skip = process.argv.includes("--no-models");
  let doit = force;
  if (!doit && !skip) doit = process.stdin.isTTY
    ? await confirm(C.gold("\n  Download Demerzel's voice models now (~25 GB, one time)? [y/N] "))
    : false; // never pull 25 GB non-interactively without --models
  if (!doit) { console.log(C.dim("  models not fetched — the voice stays off until they are (seldon up will offer again).")); return false; }
  const llm = process.env.DEMERZEL_LLM;
  console.log(C.dim(`  fetching Demerzel models${llm ? ` (LLM ${llm})` : ""} — ~25 GB, resumable…`));
  return run(path.join(home, ".venv/bin/python"), [path.join(home, "scripts/fetch-models.py")], { cwd: home, env: { ...process.env } });
}

// ---- the voice brain: Qwen (in-process) or Bonsai (local llama-server) ------
// Bonsai runs as a separate OpenAI-compatible server (PrismML's llama.cpp),
// which frees the ~20 GB the in-process Qwen holds. seldon manages that server
// as a daemon so the choice is durable, and remembers it in ~/.seldon/brain.
const BONSAI_HOME = path.join(SELDON_HOME, "bonsai");
const BONSAI_BIN = path.join(BONSAI_HOME, "bin", "llama-server");
const BONSAI_PORT = 8081;
const BRAIN_FILE = path.join(SELDON_HOME, "brain");
const BONSAI_RELEASE = "prism-b10709-9a9394a";           // pinned PrismML llama.cpp build
const BONSAI_GGUF_REPO = "prism-ml/Ternary-Bonsai-2-27B-gguf";
const BONSAI_GGUF_FILE = "Ternary-Bonsai-2-27B-PQ2_0.gguf";

const savedBrain = () => { try { return fs.readFileSync(BRAIN_FILE, "utf8").trim(); } catch { return ""; } };
const saveBrain = (b) => { try { fs.mkdirSync(SELDON_HOME, { recursive: true }); fs.writeFileSync(BRAIN_FILE, b); } catch {} };

function bonsaiGgufPath() {
  const local = path.join(BONSAI_HOME, BONSAI_GGUF_FILE);
  if (fs.existsSync(local)) return local;
  try {
    const base = path.join(process.env.HOME, ".cache/huggingface/hub/models--prism-ml--Ternary-Bonsai-2-27B-gguf/snapshots");
    for (const s of fs.readdirSync(base)) {
      const f = path.join(base, s, BONSAI_GGUF_FILE);
      if (fs.existsSync(f)) return fs.realpathSync(f);
    }
  } catch {}
  return null;
}
const bonsaiInstalled = () => fs.existsSync(BONSAI_BIN) && !!bonsaiGgufPath();
const bonsaiHealthy = () => { try { execSync(`curl -sf -o /dev/null --max-time 3 http://127.0.0.1:${BONSAI_PORT}/health`, { stdio: "ignore" }); return true; } catch { return false; } };

function startBonsaiServer() {
  if (bonsaiHealthy()) return { already: true };
  const gguf = bonsaiGgufPath();
  // tuned: flash-attn + single slot (warm prefix sticks) + cache reuse
  return startDaemon("bonsai", BONSAI_BIN,
    ["--jinja", "-m", gguf, "--host", "127.0.0.1", "--port", String(BONSAI_PORT),
     "-c", "8192", "-ngl", "999", "-fa", "on", "--parallel", "1", "--cache-reuse", "256"]);
}

// Download the Bonsai runtime (PrismML prebuilt macOS binary) + the GGUF. Big,
// so always offered, never silent. macOS/Apple-silicon only (like the voice).
async function ensureBonsaiAssets() {
  if (bonsaiInstalled()) return true;
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    console.log(C.red("  Bonsai brain is macOS / Apple-silicon only.")); return false;
  }
  const force = process.argv.includes("--yes");
  const ok = force || (process.stdin.isTTY
    ? await confirm(C.gold("  Bonsai needs a one-time download (~7 GB model + runtime). Get it now? [y/N] "))
    : false);
  if (!ok) { console.log(C.dim("  skipped — Bonsai not fetched.")); return false; }
  fs.mkdirSync(path.join(BONSAI_HOME, "bin"), { recursive: true });
  if (!fs.existsSync(BONSAI_BIN)) {
    console.log(C.dim("  fetching Bonsai runtime (PrismML llama.cpp, macOS-arm64)…"));
    const url = `https://github.com/PrismML-Eng/llama.cpp/releases/download/${BONSAI_RELEASE}/llama-${BONSAI_RELEASE}-bin-macos-arm64.tar.gz`;
    const tmp = path.join(BONSAI_HOME, ".dl");
    // extract anywhere, then find llama-server + its sibling dylibs (layout-proof)
    run("bash", ["-c",
      `set -e; rm -rf '${tmp}'; mkdir -p '${tmp}'; curl -fSL '${url}' -o '${tmp}/b.tgz'; ` +
      `tar -xzf '${tmp}/b.tgz' -C '${tmp}'; ` +
      `d=$(dirname "$(find '${tmp}' -name llama-server -type f | head -1)"); ` +
      `cp "$d/llama-server" "$d"/*.dylib '${path.join(BONSAI_HOME, "bin")}/' 2>/dev/null || cp "$d/llama-server" '${path.join(BONSAI_HOME, "bin")}/'; ` +
      `chmod +x '${BONSAI_BIN}'; rm -rf '${tmp}'`]);
  }
  if (!bonsaiGgufPath()) {
    console.log(C.dim("  fetching Bonsai 2 model (~7 GB, resumable)…"));
    const url = `https://huggingface.co/${BONSAI_GGUF_REPO}/resolve/main/${BONSAI_GGUF_FILE}`;
    run("bash", ["-c", `curl -fL -C - '${url}' -o '${path.join(BONSAI_HOME, BONSAI_GGUF_FILE)}'`]);
  }
  return bonsaiInstalled();
}

// Decide the voice brain: --brain=X flag > saved choice > a one-key prompt when
// the voice is installed and we're interactive > qwen. The prompt is the "right
// moment": only surfaced once, then remembered.
async function chooseBrain() {
  const flag = (process.argv.find((a) => a.startsWith("--brain=")) || "").split("=")[1];
  if (flag) { saveBrain(flag); return flag; }
  const saved = savedBrain();
  if (saved) return saved;
  if (demerzelInstalled() && process.stdin.isTTY) {
    console.log(C.bold("\n  Voice brain — pick once (remembered):"));
    console.log("   " + C.cyan("q") + C.dim(" Qwen 3.6-35B — in-process, sharpest, ~20 GB RAM"));
    console.log("   " + C.cyan("b") + C.dim(" Bonsai 2-27B — local server, lighter (~7 GB), tool-capable"));
    const k = await readKey(C.gold("  [q/b] "));
    const brain = /^b/i.test(k) ? "bonsai" : "qwen";
    console.log(C.dim(`  → ${brain}`));
    saveBrain(brain);
    return brain;
  }
  return "qwen";
}

async function up() {
  console.log(C.gold("\n  seldon — bringing the stack up\n"));
  const go = [];      // where-to-go lines
  const later = [];   // things that need one action first

  // Voice — demerzel (background daemon)
  const dem = byId.demerzel;
  if (demerzelInstalled()) {
    const home = path.join(SELDON_HOME, "demerzel");
    if (!platformOk(dem)) later.push("Voice (demerzel) needs macOS on Apple silicon — skipped here.");
    else {
      if (!demerzelModelsReady()) await ensureDemerzelModels({ ask: true });  // offer the fetch inline
      if (demerzelModelsReady()) {
        const env = { ...process.env };
        // --- choose the brain (remembered) ---
        let brain = await chooseBrain();
        if (brain === "bonsai") {
          if (!bonsaiInstalled()) await ensureBonsaiAssets();
          if (bonsaiInstalled()) {
            const bs = startBonsaiServer();
            env.DEMERZEL_BRAIN = "bonsai";
            env.DEMERZEL_LLM_SERVER = `http://127.0.0.1:${BONSAI_PORT}`;
            go.push(`${C.bold("Brain")}  Bonsai 2 ${C.dim("(local server :8081, ~7 GB) " + (bs.already ? "already up" : "starting"))}`);
          } else {
            later.push("Bonsai unavailable — using Qwen. (macOS/arm64 + the ~7 GB download are needed.)");
            brain = "qwen"; saveBrain("qwen");
          }
        }
        if (brain === "qwen") go.push(`${C.bold("Brain")}  Qwen 3.6-35B ${C.dim("(in-process)")}`);
        // The voice always binds loopback; --tailnet fronts it with HTTPS via
        // `tailscale serve` so a phone can use the mic (needs a secure context).
        env.DEMERZEL_HOST = "127.0.0.1";
        let phoneUrl = null;
        const wantTailnet = process.argv.includes("--tailnet") || process.argv.includes("--phone");
        if (wantTailnet) {
          const s = tailscaleServeSetup();
          if (s.url) { phoneUrl = s.url; later.push(C.dim("Phone: anyone on your tailnet can talk to Demerzel (it can act on this Mac). Use DEMERZEL_READONLY=1 to share safely.")); }
          else later.push("Phone (--tailnet): " + s.err);
        }
        // (Re)start the voice only when it isn't running, or when --brain changed.
        const explicit = process.argv.some((a) => a.startsWith("--brain="));
        if (explicit && daemonUp("demerzel")) stopDaemon("demerzel");
        const r = startDaemon("demerzel", path.join(home, ".venv/bin/python"), ["-m", "demerzel.server"], { cwd: home, env });
        go.push(`${C.bold("Voice")}   ${C.cyan("http://localhost:8770")}   ${C.dim(r.already ? "(already up)" : "(starting — models load, ~30s)")}`);
        if (phoneUrl) go.push(`${C.bold("Phone")}   ${C.cyan(phoneUrl)}   ${C.dim("(HTTPS — mic works from your phone, on your tailnet)")}`);
      } else {
        later.push("Voice (demerzel): models not fetched yet — run `seldon up` again when you're ready to pull them.");
      }
    }
  }

  // Supervisor — factory watch (background daemon, the "let it work" loop)
  if (has("factory")) {
    const r = startDaemon("factory-watch", "factory", ["watch", "--all"]);
    go.push(`${C.bold("Supervisor")}  ${C.dim(r.already ? "already running" : "running")} — heals agents, catches stalls   ${C.dim("· live view: factory board")}`);
  }

  // The rest are on-demand, not daemons — point at the command.
  if (has("factory")) go.push(`${C.bold("Put agents to work")}  ${C.cyan('factory new "<your idea>"')}   ${C.dim("→ repo · foundation · apiary hive")}`);
  if (has("factory")) go.push(`${C.bold("An existing repo")}  ${C.cyan("seldon adopt [dir]")}   ${C.dim("→ foundation (keeps your docs) · hive · supervised")}`);
  if (has("apiary"))  go.push(`${C.bold("Agent rooms")}  ${C.cyan("apiary ps")}   ${C.dim("(active rooms + join links)")}`);
  if (has("bifrost")) go.push(`${C.bold("Across machines / phone")}  ${C.cyan("bifrost sessions")}`);

  if (go.length) { console.log(C.bold("  Where to go:")); for (const l of go) console.log("   • " + l); }
  else console.log(C.dim("  nothing to start — install services first: seldon install factory demerzel"));
  if (later.length) { console.log("\n" + C.gold("  First, one step:")); for (const l of later) console.log("   • " + l); }
  console.log("\n  " + C.dim("stop everything: seldon down   ·   check state: seldon status") + "\n");
}

function down() {
  const tracked = ["demerzel", "bonsai", "factory-watch"].filter((n) => stopDaemon(n));
  // Belt-and-suspenders so nothing leaks: also reap by seldon's OWN ports and
  // process signatures. This catches a server started outside seldon (manual
  // launch) or a pidfile that drifted. Scoped tightly — only our ports and
  // command shapes — so unrelated processes are never touched.
  const probes = [
    "lsof -nP -iTCP:8081 -sTCP:LISTEN -t",                    // bonsai llama-server
    "lsof -nP -iTCP:8770 -sTCP:LISTEN -t",                    // voice UI
    "lsof -nP -iTCP:8765 -sTCP:LISTEN -t",                    // voice websocket
    `pgrep -f '${SELDON_HOME}/bonsai/bin/llama-server'`,
    "pgrep -f 'demerzel[.]server'",
    "pgrep -f 'factory.*watch --all'",
  ];
  const collect = () => {
    const s = new Set();
    for (const c of probes) {
      try { execSync(c, { stdio: ["ignore", "pipe", "ignore"] }).toString().split(/\s+/).filter(Boolean).forEach((p) => s.add(p)); } catch {}
    }
    s.delete(String(process.pid));
    return [...s];
  };
  const first = collect();
  for (const p of first) { try { process.kill(Number(p), "SIGTERM"); } catch {} }
  let reaped = 0;
  if (first.length) {
    try { execSync("sleep 1.5"); } catch {}
    for (const p of collect()) { try { process.kill(Number(p), "SIGKILL"); reaped++; } catch {} }
    reaped = first.length;   // count what we signalled
  }
  const parts = [];
  if (tracked.length) parts.push("stopped " + tracked.join(", "));
  if (first.length) parts.push(`reaped ${first.length} straggler${first.length > 1 ? "s" : ""}`);
  console.log(parts.length ? C.green(parts.join(" · ")) : C.dim("nothing was running."));
}

// Version of a globally-installed node package, across every global root.
function npmGlobalVersion(pkg) {
  for (const r of installedAt(pkg)) {
    try { return JSON.parse(fs.readFileSync(path.join(pkgDir(r.root, pkg), "package.json"), "utf8")).version; } catch {}
  }
  return "";
}
function bifrostVersion() {
  for (const p of [path.join(process.env.HOME, "bin", "bifrost"), path.join(process.env.HOME, ".local/bin/bifrost")]) {
    try { if (fs.existsSync(p)) { const mm = fs.readFileSync(p, "utf8").match(/BIFROST_VERSION=["']?([\d.]+)/); return mm ? mm[1] : "installed"; } } catch {}
  }
  return "";
}
function moduleInstalled(m) {
  if (m.method === "python") return demerzelInstalled();
  if (m.method === "shell") return has(m.bin) || fs.existsSync(path.join(process.env.HOME, "bin", m.bin)) || fs.existsSync(path.join(process.env.HOME, ".local/bin", m.bin));
  return has(m.bin);
}

function statusCmd() {
  console.log(C.bold("\n  seldon — stack status\n"));
  // The dot answers "is it working?". For a CLI tool that is "installed"; for a
  // SERVICE it is "running" — a green dot next to "voice down" read as up, and
  // `seldon down` saying "nothing was running" then looked like a lie.
  const up = [], starting = [], stopped = [];
  const svcState = (label, pid, upText) => {
    (pid ? up : stopped).push(label);
    return pid ? "   " + C.green(upText) : "   " + C.gold(label + " down");
  };
  const brain = demerzelInstalled() ? (savedBrain() || "qwen") : null;
  for (const m of MODULES) {
    const inst = moduleInstalled(m);
    let detail;
    if (!inst) detail = platformOk(m) ? C.dim(`not installed   ${C.dim("· seldon install " + m.id)}`) : C.dim("not supported on this machine");
    else if (m.method === "npm") detail = C.dim("v" + (npmGlobalVersion(m.pkg) || "?"));
    else if (m.id === "bifrost") detail = C.dim("v" + (bifrostVersion() || "?"));
    else if (m.id === "demerzel") detail = demerzelModelsReady() ? C.dim("venv + models ✓") : C.gold(`venv ok · missing ${demerzelModelsMissing().join(", ")} (seldon up)`);
    else detail = C.dim("installed");

    // service state for the two daemons
    let svc = "", running = true;
    if (m.id === "factory" && inst) {
      const p = daemonUp("factory-watch"); running = !!p;
      svc = svcState("supervisor", p, "supervisor up") + (p ? C.dim(` (pid ${p})`) : "");
    }
    if (m.id === "demerzel" && inst) {
      const p = daemonUp("demerzel"), b = brain !== "bonsai" || daemonUp("bonsai") || bonsaiHealthy();
      // A live pid is not a working voice: models load for ~30-90s before :8770
      // listens, and "voice up" there sent you to a page that would not open.
      const serving = p && portListening(8770);
      running = !!serving && !!b;   // the voice without its brain server cannot answer
      if (p && !serving) { starting.push("voice"); svc = "   " + C.gold("voice starting") + C.dim(" — models loading, give it a minute"); }
      else svc = svcState("voice", p, "voice up") + (p ? " " + C.cyan("http://localhost:8770") : "");
    }
    const dot = !inst ? C.dim("○") : running ? C.green("●") : C.gold("●");
    console.log(`  ${dot} ${C.bold(m.id.padEnd(11))} ${detail}${svc}`);
  }
  if (brain) {
    const bstate = brain === "bonsai"
      ? ((daemonUp("bonsai") || bonsaiHealthy()) ? (up.push("brain"), C.green("server up")) : (stopped.push("brain"), C.gold("server down")))
      : C.dim("in-process");
    console.log(C.dim(`\n  voice brain: `) + C.bold(brain) + "  " + bstate + C.dim("   · switch: seldon up --brain=qwen|bonsai"));
    const phone = tailscaleServeUrl();
    if (phone) console.log(C.dim("  phone (HTTPS): ") + C.cyan(phone));
  }
  if (up.length || starting.length || stopped.length) {
    const parts = [];
    if (up.length) parts.push(C.green("● running: " + up.join(", ")));
    if (starting.length) parts.push(C.gold("● starting: " + starting.join(", ")));
    if (stopped.length) parts.push(C.gold("● stopped: " + stopped.join(", ")) + C.dim(" — start: ") + C.cyan("seldon up"));
    if (!up.length && !starting.length) parts[0] = C.gold("● nothing is running") + C.dim(" — start: ") + C.cyan("seldon up");
    console.log("\n  " + parts.join("   "));
  }
  const dk = dockerState();
  if (dk === "down") console.log(C.gold("\n  ⚠ docker: installed but the daemon is not running") + C.dim(" — factory box and containerised gates need it (open Docker Desktop)"));
  else if (dk === "up") console.log(C.dim("\n  docker: ") + C.green("up"));
  console.log(C.dim(`\n  start: seldon up   ·   stop: seldon down   ·   logs: ${RUN_DIR}/\n`));
}

// "none" (no docker CLI) | "down" (CLI but no daemon) | "up". Only shown when docker exists.
function dockerState() {
  if (!has("docker")) return "none";
  try { execSync("docker info", { stdio: "ignore", timeout: 8000 }); return "up"; } catch { return "down"; }
}



// readline waits 500ms after Esc to tell a bare Esc from an Alt-sequence, so Esc then a quick
// key read as Alt+key and the screen ignored both. 50ms still catches real escape sequences,
// which a terminal sends in one write. Whichever emitKeypressEvents call runs first wins, so
// every caller passes this.
const KEYS = { escapeCodeTimeout: 50 };

// ---- raw-terminal plumbing, once ---------------------------------------------
// Both interactive screens (the install picker and the panel) need the same four-step dance,
// and the pause/unref at the end is load-bearing: emitKeypressEvents resumes stdin, and
// without releasing it the event loop stays alive and the process hangs after the screen
// closes. That bug was fixed once in the picker; sharing it means the panel cannot
// reintroduce it. `suspend` lets a screen hand the terminal to a child process and take it
// back — the panel does that every time it staffs an agent.
function rawSession({ draw, onKey }) {
  let done = null;
  const listen = () => {
    readline.emitKeypressEvents(process.stdin, KEYS);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", handler);
  };
  const release = () => {
    process.stdin.off("keypress", handler);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.unref();
  };
  // Keys are handled one at a time, in order. A handler can take a while (it may spawn a CLI),
  // and keys typed meanwhile used to run concurrently with it — Esc and the next prompt raced
  // the first, leaving a stale screen and dropped characters.
  let chain = Promise.resolve();
  const handler = (str, key) => { chain = chain.then(() => onKey(str, key, api)).catch(() => {}); };
  const api = {
    draw: () => draw(api),
    finish: (v) => { release(); readline.cursorTo(process.stdout, 0); readline.clearScreenDown(process.stdout); done(v); },
    // run something that owns the terminal (a child process), then come back
    suspend: async (fn) => { release(); try { return await fn(); } finally { listen(); api.draw(); } },
  };
  return new Promise((resolve) => { done = resolve; listen(); api.draw(); });
}

const clearScreen = () => { readline.cursorTo(process.stdout, 0, 0); readline.clearScreenDown(process.stdout); };

// Pad to a COLUMN width, then colour. Padding a string that already carries ANSI escapes
// counts those invisible bytes as width, which silently knocked every column after a coloured
// cell out of line.
const pad = (text, width, color = (x) => x) => color(String(text)) + " ".repeat(Math.max(0, width - String(text).length));

// ---- the panel: every agent, every project ------------------------------------
// Bare `seldon` is this screen: every coding agent on this machine (Claude, Codex, opencode),
// grouped by the project it works on, the ones waiting on you first. Lanes are read from the
// harnesses themselves (lib/agents.mjs), not from rooms, so the panel works with or without
// factory and apiary; when factory is there its projects and plans are shown too.
async function panel() {
  ensureSiblingPath();
  let groups = [], state = null, rows = [], cur = 0, note = "";
  let lastState = 0;
  // What the screen is doing: the home list, a project's plan, a line of text being typed, or
  // picking which agent starts a lane. One at a time; esc always goes back to home.
  let mode = { name: "home" };
  let armedStop = null;                       // { key, at } — stop needs a second x within 3s
  const here = projectRoot(process.cwd());     // the repo seldon was opened in is always listed
  const load = (force = false) => {
    groups = readLanes();
    if (force || Date.now() - lastState > 10_000) { state = has("factory") ? loadState() : null; lastState = Date.now(); }
    const prev = rows[cur];
    rows = buildRows(groups, state?.hives || [], sameDir, here);
    // Keep the cursor on the same thing across a refresh, not the same row number.
    const keep = prev && rows.findIndex((r) => r.type === prev.type && (r.type === "lane" ? r.lane.key === prev.lane.key : r.project.root === prev.project.root));
    cur = keep >= 0 ? keep : Math.min(cur, Math.max(0, rows.length - 1));
  };
  const allLanes = () => groups.flatMap((g) => g.lanes);

  const svc = (label, on) => (on ? C.green("●") : C.dim("○")) + " " + label;
  const tint = { "needs-you": C.gold, working: C.green, running: C.green, idle: C.dim, failed: C.red, stopped: C.dim };
  const laneCells = (l, sel) => {
    const color = tint[l.state] || ((x) => x);
    return `${color(GLYPH[l.state] || "?")} ${pad((l.name || l.id || "?").slice(0, 26), 26, sel ? C.bold : (x) => x)} ${pad(l.harness, 9, C.dim)} ${pad(laneDetail(l).slice(0, 40), 40, color)} ${C.dim(ago(l.startedAt))}`;
  };

  const drawHome = (out) => {
    if (!rows.length) {
      out.push(C.dim("  no agents running and no projects yet."));
      out.push("  " + C.cyan("cd <repo> && seldon") + C.dim(", then ") + C.cyan("n") + C.dim(" starts an agent on a task"));
    }
    rows.forEach((r, i) => {
      const sel = i === cur;
      const cursor = sel ? C.gold("❯") : " ";
      if (r.type === "project") {
        const p = r.project;
        const plan = p.hive ? C.dim(`plan ${p.hive.queueOpen} · ${p.hive.done} done`) : "";
        const why = p.hive?.needsYou && p.hive.why ? C.gold("  ⚑ " + p.hive.why) : "";
        const others = unlistedAgents(p);
        out.push(`  ${cursor} ${pad(p.name, 22, C.bold)} ${plan}${others.length ? C.green("  agents: " + others.join(", ")) : ""}${why}`);
        if (sel) out.push(`      ${C.dim(p.root)}`);
      } else {
        out.push(`  ${cursor}   ${laneCells(r.lane, sel)}`);
        if (sel && r.lane.cwd !== r.project.root) out.push(`        ${C.dim(r.lane.cwd)}`);
      }
    });
    const sel = rows[cur];
    out.push("");
    out.push("  " + C.dim(sel?.type === "lane"
      ? "↑↓ move · ⏎ open · x stop · n new lane · p plan · r refresh · q quit"
      : "↑↓ move · n new lane · p plan · ⏎ go (staff + room) · s staff · a room · b board · q quit"));
    out.push("  " + C.dim("U start stack · D stop stack · i install"));
  };

  const drawPlan = (out) => {
    const { project, items } = mode;
    out.push(`  ${C.bold("PLAN")} ${C.dim("·")} ${C.bold(project.name)}   ${C.dim(items ? `${items.length} open` : "")}`);
    out.push("");
    if (items === null) out.push(C.dim("  no plan here — needs foundation ≥ 0.3 and docs/QUEUE.md (") + C.cyan("foundation init") + C.dim(")"));
    else if (!items.length) out.push(C.dim("  the plan is empty — ") + C.cyan("a") + C.dim(" adds an item"));
    (items || []).forEach((it, i) => {
      const sel = i === mode.cur;
      const lane = laneForItem(it, allLanes());
      const tag = lane ? (tint[lane.state] || ((x) => x))(`${GLYPH[lane.state]} ${lane.harness} ${laneDetail(lane)}`) : C.dim("— no lane");
      out.push(`  ${sel ? C.gold("❯") : " "} ${C.dim(`(${it.priority})`)} ${pad(it.text.slice(0, 60), 60, sel ? C.bold : (x) => x)} ${tag}`);
    });
    out.push("");
    out.push("  " + C.dim("↑↓ move · ⏎ start a lane on it · a add an item · esc back"));
  };

  const drawInput = (out) => {
    out.push(`  ${C.bold(mode.title)}`);
    out.push("");
    out.push(`  ${mode.prompt} ${mode.buf}${C.gold("▏")}`);
    out.push("");
    out.push("  " + C.dim("⏎ ok · esc cancel"));
  };

  const drawHarness = (out) => {
    out.push(`  ${C.bold("NEW LANE")} ${C.dim("·")} ${C.bold(mode.project.name)}`);
    out.push("");
    out.push(`  task   ${mode.task}`);
    out.push(`  agent  ${HARNESSES.map((h, i) => `${C.cyan(String(i + 1))} ${h}`).join("   ")}`);
    out.push("");
    out.push("  " + C.dim("⏎ claude · 1/2/3 pick · esc cancel   (each lane gets its own branch + worktree)"));
  };

  const draw = () => {
    const out = [""];
    out.push("  " + C.gold(C.bold("SELDON")) + "   " + headline(groups) + "   " + C.dim([
      svc("supervisor", !!daemonUp("factory-watch")), svc("voice", !!daemonUp("demerzel")),
    ].join("  ")));
    out.push("");
    ({ home: drawHome, plan: drawPlan, input: drawInput, harness: drawHarness })[mode.name](out);
    if (note) out.push("\n  " + note);
    clearScreen();
    process.stdout.write(out.join("\n") + "\n");
  };

  load(true);
  // Live: lanes change on their own, so redraw without a keypress. Cheap — one
  // `claude agents --json` and one `tmux list-panes` per tick.
  let timer = null;
  const tick = () => { try { load(); } catch { /* keep the last frame */ } draw(); };
  const startTimer = () => { timer = setInterval(tick, 2000); };
  const stopTimer = () => { clearInterval(timer); timer = null; };
  startTimer();

  // Hand the terminal to something that needs it, then come back to a fresh frame.
  const runOwned = async (api, fn) => { stopTimer(); try { return await api.suspend(fn); } finally { load(true); startTimer(); } };

  const openPlan = (project) => { mode = { name: "plan", project, items: readPlan(project.root), cur: 0 }; };
  const ask = (title, prompt, then) => { mode = { name: "input", title, prompt, buf: "", then }; };
  const pickHarness = (project, task) => { mode = { name: "harness", project, task }; };

  const startLane = async (api, project, task, harness) => {
    const slug = slugify(task);
    const bins = harnessBins();
    if (!bins[harness]) { note = C.red(`${harness} is not installed`) + C.dim(" (not on PATH)"); mode = { name: "home" }; return; }
    const cmds = startCommands({ harness, task, root: project.root, slug, worktreesDir: path.join(SELDON_HOME, "worktrees", project.name), bins, env: { PATH: process.env.PATH } });
    const r = await runOwned(api, () => runSteps(cmds));
    const session = cmds.find((c) => c.session)?.session;
    if (r.ok && session) recordLane({ session, harness, task, slug, root: project.root, worktree: cmds.find((c) => c.session).cwd, startedAt: Date.now() });
    note = r.ok ? C.green(`started ${slug} (${harness})`) + C.dim(" — it shows up here in a moment") : C.red(`could not start ${slug}: `) + r.error;
    mode = { name: "home" };
  };

  const keys = {
    input: async (str, key) => {
      if (key.name === "escape") mode = { name: "home" };
      else if (key.name === "return") { const t = mode.buf.trim(); const then = mode.then; mode = { name: "home" }; if (t) await then(t); }
      else if (key.name === "backspace") mode.buf = mode.buf.slice(0, -1);
      else if (str && !key.ctrl && !key.meta && str >= " ") mode.buf += str;
    },
    harness: async (str, key, api) => {
      if (key.name === "escape") { mode = { name: "home" }; return; }
      const i = key.name === "return" ? 0 : "123".indexOf(str);
      if (i >= 0) await startLane(api, mode.project, mode.task, HARNESSES[i]);
    },
    plan: async (str, key) => {
      const items = mode.items || [];
      if (key.name === "escape" || str === "q") mode = { name: "home" };
      else if (key.name === "up" || str === "k") mode.cur = Math.max(0, mode.cur - 1);
      else if (key.name === "down" || str === "j") mode.cur = Math.min(Math.max(0, items.length - 1), mode.cur + 1);
      else if (str === "a") {
        const project = mode.project;
        ask(`ADD TO PLAN · ${project.name}`, "(P2) ›", (text) => {
          const r = addToPlan(project.root, text);
          openPlan(project);
          note = r.ok ? C.green("added") : C.red("could not add: ") + r.error;
        });
      } else if (key.name === "return" && items[mode.cur]) {
        const it = items[mode.cur];
        const lane = laneForItem(it, allLanes());
        if (lane) note = C.dim(`already has a lane: ${lane.name} (${lane.harness}, ${laneDetail(lane)})`);
        else pickHarness(mode.project, it.text);
      }
    },
    home: async (str, key, api) => {
      const r = rows[cur];
      if (key.name === "up" || str === "k") cur = (cur - 1 + (rows.length || 1)) % (rows.length || 1);
      else if (key.name === "down" || str === "j") cur = (cur + 1) % (rows.length || 1);
      else if (str === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) { stopTimer(); return api.finish(); }
      else if (str === "r") load(true);
      else if (str === "i") { stopTimer(); api.finish(); return install_picker(); }
      else if (str === "U") await runOwned(api, () => up());
      else if (str === "D") await runOwned(api, () => down());
      else if (!r) { /* nothing selected */ }
      else if (str === "n") { const p = r.project; ask(`NEW LANE · ${p.name}`, "task ›", (task) => pickHarness(p, task)); }
      else if (str === "p") openPlan(r.project);
      else if (r.type === "lane") {
        if (key.name === "return") {
          const how = openCommand(r.lane);
          if (how.why) note = C.gold(`can't open ${r.lane.name || "this agent"}: `) + how.why;
          else await runOwned(api, () => spawnSync(how.bin, how.args, { stdio: "inherit", cwd: how.cwd }));
        } else if (str === "x") {
          const how = stopCommand(r.lane);
          if (how.why) note = C.gold(`can't stop ${r.lane.name || "this agent"}: `) + how.why;
          else if (armedStop?.key === r.lane.key && Date.now() - armedStop.at < 3000) {
            armedStop = null;
            const res = await runOwned(api, () => runCmd(how));
            note = res.ok ? C.dim(`stopped ${r.lane.name}`) : C.red(`could not stop: ${res.error}`);
          } else { armedStop = { key: r.lane.key, at: Date.now() }; note = C.gold(`press x again to stop ${r.lane.name}`); }
        }
      } else {
        const p = r.project;
        if (key.name === "return") { stopTimer(); api.finish(); return go(p.hive ? p.hive.name : p.root); }
        if (!p.hive && "sab".includes(str)) note = C.dim("not adopted yet — ⏎ (seldon go) puts it on the line");
        else if (str === "a") { stopTimer(); api.finish(); return fAttach(p.hive.name); }
        else if (str === "b") await runOwned(api, () => spawnSync("factory", ["board"], { stdio: "inherit" }));
        else if (str === "s") await runOwned(api, () => { fStaff(p.root); });
      }
    },
  };

  await rawSession({
    draw,
    onKey: async (str, key, api) => {
      if (mode.name === "home" && note && !note.includes("press x again")) note = "";
      if (key.ctrl && key.name === "c") { stopTimer(); return api.finish(); }
      const done = await keys[mode.name](str, key, api);
      if (done !== undefined) return done;
      api.draw();
    },
  });
}

// ---- go: the one verb that gets you back to work ----------------------------
// Every other command answered half of "I am in my repo, continue": `seldon up` started
// daemons, `factory adopt` opened a room, `factory staff` put an agent in it, `apiary room
// resume` got you a seat. Four commands across three tools, and none of them said which one
// you needed — so an adopted repo with a stopped room looked identical to a broken install.
//
// `go` owns no decisions. It asks `factory state` what is missing and fills the gaps in order,
// printing ✓ for a step it SKIPPED and → for one it DID, so the output doubles as the
// explanation of how the pieces fit. Every step is idempotent: safe from a cold boot, safe
// twice in a row, safe mid-session.
const sDid  = (t) => console.log("  " + C.gold("→") + " " + t);
const sSkip = (t) => console.log("  " + C.green("✓") + " " + t);
const sWarn = (t) => console.log("  " + C.gold("!") + " " + t);

function needFactory() {
  if (has("factory")) return true;
  console.log(C.red("\n  this needs factory — install it: ") + C.cyan("seldon install factory") + "\n");
  process.exitCode = 1;
  return false;
}

// `seldon go [name|dir] [--agent claude|codex] [--model X] [--effort E] [--no-staff] [--no-attach]`
async function go(arg, flags = {}) {
  ensureSiblingPath();
  if (!needFactory()) return;

  let state = loadState();
  if (!state) {
    console.log(C.red("\n  could not read the hive registry (`factory state` failed).") +
                C.dim("\n  try: factory state --compact\n"));
    process.exitCode = 1; return;
  }
  let t = resolveProject(arg, state);

  if (t.kind === "unknown") {
    console.log(C.red(`\n  no project or repo called "${t.arg}" `) + C.dim(`(${t.reason})`));
    if (state.hives.length) {
      console.log(C.dim("  on the line: ") + state.hives.map((h) => C.bold(h.name)).join(C.dim(" · ")));
    }
    console.log("");
    process.exitCode = 1; return;
  }
  // Not in a repo and no name given: the panel is the right answer to "where was I".
  if (t.kind === "nowhere") {
    if (!state.hives.length) {
      console.log(C.gold("\n  nothing on the line yet.") +
                  C.dim("\n  a new idea:      ") + C.cyan('factory new "<your idea>"') +
                  C.dim("\n  a repo you have: ") + C.cyan("cd <repo> && seldon go") + "\n");
      return;
    }
    if (process.stdin.isTTY) return panel();
    console.log(C.gold("\n  not inside a git repo — name a project:"));
    for (const h of state.hives) console.log(`   ${C.cyan("seldon go " + h.name)}  ${C.dim(h.dir)}`);
    console.log("");
    process.exitCode = 1; return;
  }

  const dir = t.dir;
  console.log("\n  " + C.gold(C.bold(path.basename(dir))) + "  " + C.dim(dir));

  // 1. on the line? `factory adopt` is idempotent — it never overwrites docs and reuses a
  //    reachable hive, so it is both "adopt me" and "reopen my room".
  let hive = t.kind === "hive" ? t.hive : null;
  if (!hive) {
    sDid("not on the line yet — adopting");
    if (!fAdopt(dir)) { process.exitCode = 1; return; }
    state = loadState(); hive = hiveOf(state, dir);
    if (!hive) { sWarn("adopted, but the hive did not register — run: factory adopt " + dir); process.exitCode = 1; return; }
  } else {
    sSkip("adopted" + C.dim("  (foundation docs in place)"));
  }

  // 2. room up? A stopped room is the single most common state after a reboot, and the one
  //    that used to look like a broken install.
  if (hive.up) {
    sSkip("hive up" + C.dim(hive.url ? "  " + hive.url : ""));
  } else {
    sDid("hive is down — reopening" + C.dim("  (room history resumes)"));
    if (!fAdopt(dir)) { process.exitCode = 1; return; }
    state = loadState(); hive = hiveOf(state, dir) || hive;
    if (!hive.up) sWarn("the room still is not answering — check: apiary ps");
  }

  // 3. the supervisor heals dead agents and catches stalls. `go` starts it rather than
  //    telling you to go and run `seldon up` first.
  if (daemonUp("factory-watch")) sSkip("supervisor running");
  else { startDaemon("factory-watch", "factory", ["watch", "--all"]); sDid("supervisor started" + C.dim("  (heals agents, catches stalls)")); }

  // 4. is anyone actually working here? This is the step that was missing: `factory adopt`
  //    opens an EMPTY room, and nothing said so — you joined and sat there alone.
  // `agents` is absent from an older factory that cannot report it. Absent is NOT empty:
  // claiming "nobody is working here" when we simply do not know got printed over a running
  // Coordinator. Unknown falls through to `factory staff`, which is idempotent and says the
  // truth either way.
  const agents = hive.agents;
  const known = Array.isArray(agents);
  if (!known) sWarn("this factory is too old to report agents — " + C.cyan("seldon install factory"));
  if (known && agents.length) {
    sSkip("working here: " + C.bold(agents.join(", ")));
  } else if (flags["no-staff"]) {
    sSkip(C.dim("no agent (--no-staff)"));
  } else if (!has("apiary")) {
    sWarn("apiary is not installed — no agent can be staffed: " + C.cyan("seldon install apiary"));
  } else if (!has("tmux")) {
    sWarn("tmux is missing — apiary runs each agent in a tmux session: " + C.cyan("brew install tmux"));
  } else {
    sDid(known ? "nobody is working here — staffing" : "staffing (if nobody already is)");
    if (!fStaff(dir, flags)) sWarn("staffing failed — watch it try: factory board");
    state = loadState(); hive = hiveOf(state, dir) || hive;
  }

  // 5. where the work stands, from the seam — the answer to "what was I doing".
  const bits = [`queue ${C.cyan(hive.queueOpen)}`, `${C.green(hive.done)} done`, `${hive.lanes.length} lanes`];
  if (hive.blockers) bits.push(C.red(`${hive.blockers} blocker`));
  if (hive.drift) bits.push(C.gold(`drift ${hive.drift}`));
  console.log("    " + C.dim(bits.join(" · ")));
  for (const n of (hive.next || []).slice(0, 2)) console.log("    " + C.dim("next: ") + n.slice(0, 96) + (n.length > 96 ? "…" : ""));
  const mine = (state.decisions || []).filter((d) => d.hive === hive.name);
  for (const d of mine) console.log("    " + C.gold("⚑ your call: ") + d.text.replace(/^\w+:\s*/, "").slice(0, 80) + C.dim(`  (factory decide ${d.id} "…")`));

  // 6. a seat in the room. `apiary room resume` restarts a stopped room, refreshes the share
  //    tokens and shows the agent strip — the command nothing ever pointed at.
  if (flags["no-attach"]) { console.log("\n  " + C.dim("attach when you want it: ") + C.cyan(`apiary room resume ${hive.name}`) + "\n"); return; }
  if (!has("apiary")) { console.log(""); return; }
  // Attaching takes over the terminal, so it is gated on having one. `--attach` forces it for
  // the cases where there IS a terminal we cannot see — a tmux pane, a wrapper script.
  if (!process.stdin.isTTY && !flags.attach) {
    console.log("\n  " + C.dim("no TTY — attach from your terminal: ") + C.cyan(`apiary room resume ${hive.name}`) +
                C.dim("  (or: seldon go --attach)") + "\n");
    return;
  }
  sDid(`attaching to the ${C.bold(hive.name)} room` + C.dim("  (ctrl-c leaves the room; agents keep working)"));
  fAttach(hive.name);
}

// ---- adopt: bring an existing repo onto the line ----------------------------
// factory owns the registry + hive, so this is a front door onto `factory adopt`.
function adopt(target) {
  if (!has("factory")) {
    console.log(C.red("  adopt needs factory — install it: ") + C.cyan("seldon install factory"));
    process.exitCode = 1; return;
  }
  const passthru = process.argv.slice(3).filter((a) => a !== "--dev");
  const r = spawnSync("factory", ["adopt", ...passthru], { stdio: "inherit" });
  if (r.status !== 0) { process.exitCode = r.status || 1; return; }
  if (!daemonUp("factory-watch")) console.log(C.gold("  the supervisor is not running — ") + C.cyan("seldon up") + C.dim(" starts it, so agents here get healed and nudged.") + "\n");
}

// ---- the checklist TUI ------------------------------------------------------
const BANNER = [
  " ███████╗███████╗██╗     ██████╗  ██████╗ ███╗   ██╗",
  " ██╔════╝██╔════╝██║     ██╔══██╗██╔═══██╗████╗  ██║",
  " ███████╗█████╗  ██║     ██║  ██║██║   ██║██╔██╗ ██║",
  " ╚════██║██╔══╝  ██║     ██║  ██║██║   ██║██║╚██╗██║",
  " ███████║███████╗███████╗██████╔╝╚██████╔╝██║ ╚████║",
  " ╚══════╝╚══════╝╚══════╝╚═════╝  ╚═════╝ ╚═╝  ╚═══╝",
];
function tui() {
  // Pre-check what's already installed so the picker mirrors reality. On a
  // fresh machine (nothing installed) fall back to the recommended starter set.
  const anyInstalled = MODULES.some((m) => moduleInstalled(m));
  const rows = MODULES.map((m) => ({
    m,
    installed: moduleInstalled(m),
    on: platformOk(m) && (anyInstalled ? moduleInstalled(m) : ["apiary", "foundation", "factory"].includes(m.id)),
  }));
  let cur = 0;
  const methodTag = (m) => ({ npm: "npm", shell: "shell", python: "python" }[m.method]);
  return rawSession({
    draw: () => {
      const out = [];
      BANNER.forEach((l) => out.push(C.gold(l)));
      out.push(C.dim("  the AI-agent-factory stack — pick your tools  ") + C.green("✓ = installed"));
      out.push(C.dim("  ↑↓ move · space toggle · a all · enter install · q quit\n"));
      rows.forEach((r, i) => {
        const sel = r.on ? C.green("[x]") : "[ ]";
        const cursor = i === cur ? C.gold("❯") : " ";
        const okp = !platformOk(r.m);
        const name = i === cur ? C.bold(r.m.id.padEnd(11)) : r.m.id.padEnd(11);
        const deps = r.m.needs.map((d) => (depOk(d) ? d : C.red(d))).join(" ");
        const platNote = okp ? C.red(" (unsupported OS)") : "";
        const mark = r.installed ? C.green("✓") : " ";
        out.push(`  ${cursor} ${sel} ${mark} ${name} ${C.dim(methodTag(r.m).padEnd(7))} ${C.dim(r.m.blurb)}${platNote}`);
        if (i === cur) out.push(`        ${C.dim("needs: " + (deps || "nothing"))}${r.m.requires.length ? C.dim("  · pulls in: " + r.m.requires.join(", ")) : ""}`);
      });
      clearScreen();
      process.stdout.write(out.join("\n") + "\n");
    },
    onKey: (str, key, api) => {
      if (key.name === "up") cur = (cur - 1 + rows.length) % rows.length;
      else if (key.name === "down") cur = (cur + 1) % rows.length;
      else if (key.name === "space") { if (platformOk(rows[cur].m)) rows[cur].on = !rows[cur].on; }
      else if (str === "a") { const all = rows.every((r) => r.on || !platformOk(r.m)); rows.forEach((r) => { if (platformOk(r.m)) r.on = !all; }); }
      else if (key.name === "return") return api.finish(rows.filter((r) => r.on).map((r) => r.m.id));
      else if (key.name === "q" || (key.ctrl && key.name === "c")) return api.finish(null);
      api.draw();
    },
  });
}

// The picker plus the install it leads to — `seldon install` with no ids, and `i` in the panel.
async function install_picker({ dev = false } = {}) {
  if (!process.stdin.isTTY) { console.log(C.red("no TTY — use: seldon install <ids…>")); process.exitCode = 1; return; }
  const picked = await tui();
  if (!picked) { console.log(C.dim("nothing installed.")); return; }
  if (!picked.length) { console.log(C.dim("nothing selected.")); return; }
  await doInstall(picked, { dev });
}

// ---- cli --------------------------------------------------------------------
function list() {
  console.log(C.bold("\nThe Seldon stack\n"));
  for (const m of MODULES) {
    const plat = platformOk(m) ? "" : C.red("  (unsupported here)");
    console.log(`  ${C.bold(m.id.padEnd(11))} ${C.dim(m.method.padEnd(7))} ${m.blurb}${plat}`);
  }
  console.log("");
}
function help() {
  console.log(`
${C.bold("seldon")} — the agent factory: your projects, and the stack that runs them.

  ${C.bold("seldon")}                 ${C.gold("the panel")} — every project, what state it is in, and the key that fixes it
  ${C.bold("seldon go")} [name|dir]   ${C.gold("get back to work")} — adopt if needed, reopen the room, staff an agent, attach.
                         Idempotent, and it prints every step it skipped. Run it from inside a repo.
  ${C.bold("seldon up")}              start the stack (voice + supervisor) and print where to go
  ${C.bold("seldon up --tailnet")}    expose the voice over HTTPS (tailscale serve) so the mic works on your phone
  ${C.bold("seldon up --brain=X")}    pick the voice brain: qwen (in-process) | bonsai (local server); remembered
  ${C.bold("seldon status")}          what's running   ·   ${C.bold("seldon down")}  stop it
  ${C.bold("seldon adopt")} [dir]     put an existing repo on the line: foundation docs (never overwritten),
                         an apiary hive, supervised by factory — and print what's next. Safe to re-run.
  ${C.dim("go takes --agent claude|codex, --model <id>, --effort <lvl>, --name <n>,")}
  ${C.dim("        --no-staff (do not start an agent), --no-attach (do not open the room) and")}
  ${C.dim("        --attach (open it even with no terminal detected — inside tmux, or from a script).")}
  ${C.bold("seldon install")} [ids…]  install everything picked, or the named modules (no ids: the picker)
  ${C.bold("seldon uninstall")} ids…  remove the named modules (global CLI / isolated venv)
  ${C.bold("seldon uninstall --all")} remove the whole stack (also drops ~/.seldon)
  ${C.bold("seldon doctor")} [ids…]   check external deps (tmux, sops, age, tailscale, python…)
  ${C.bold("seldon list")}            list the modules
  ${C.bold("seldon --dev")}           link node modules from this checkout instead of npm
  ${C.bold("seldon install --pm=pnpm")}  force the node package manager (pnpm|bun|npm; auto-detected)
  ${C.dim("uninstall takes --yes to skip the confirm prompt.")}

  ${C.dim("node tools install via pnpm/bun if present (faster), else npm.")}
  ${C.dim("python (demerzel) installs into its own isolated venv — never your system Python;")}
  ${C.dim("uses uv (auto-installed to ~/.seldon/bin if missing) to fetch a standalone CPython 3.12.")}

  modules: ${MODULES.map((m) => m.id).join(", ")}
`);
}

// ---- argv -------------------------------------------------------------------
// A flag either carries a value (`--agent claude`, `--agent=claude`) or stands alone
// (`--no-attach`). The value form has to be CONSUMED: filtering out everything starting with
// `--` and keeping the rest as positionals read `seldon go --agent claude` as the project
// named "claude".
const VALUE_FLAGS = new Set(["agent", "model", "effort", "name", "port", "pm", "stall", "dir"]);
function parseArgv(raw) {
  const flags = {}, positional = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    if (VALUE_FLAGS.has(body) && raw[i + 1] && !raw[i + 1].startsWith("-")) { flags[body] = raw[++i]; continue; }
    flags[body] = true;
  }
  return { flags, positional };
}

const argv = process.argv.slice(2);
const { flags, positional: args } = parseArgv(argv);
const dev = !!flags.dev;
const cmd = args[0];
const tokens = args.slice(1);                          // raw names after the command
const ids = tokens.filter((id) => byId[id]);           // only the valid module ids

(async () => {
  if (argv.includes("--help") || cmd === "help") return help();
  if (cmd === "list") return list();
  if (cmd === "doctor") { printDoctor(ids.length ? withRequires(ids) : MODULES.map((m) => m.id)); return; }
  if (cmd === "install") {
    if (ids.length) return doInstall(ids, { dev });
    // install with no ids -> fall through to the picker
  }
  if (cmd === "uninstall") {
    const all = argv.includes("--all");
    const bad = tokens.filter((t) => !byId[t]);
    if (bad.length) { console.log(C.red(`unknown module(s): ${bad.join(", ")}`)); console.log(C.dim(`modules: ${MODULES.map((m) => m.id).join(", ")}`)); process.exitCode = 1; return; }
    return doUninstall(ids, { all, yes: argv.includes("--yes") });
  }
  if (cmd === "up") return up();
  if (cmd === "down") return down();
  if (cmd === "status") return statusCmd();
  if (cmd === "adopt") return adopt(tokens[0]);
  if (cmd === "go") return go(tokens[0], flags);
  if (cmd === "panel" || cmd === "board") return panel();
  if (cmd && cmd !== "install") { help(); process.exitCode = 1; return; }
  if (cmd === "install") return install_picker({ dev });   // `install` with no ids

  // ---- bare `seldon` ----------------------------------------------------------
  // The checklist is a screen you need once per machine; the panel is the one you need every
  // day. So the default is state-aware, like everything else here: nothing installed yet means
  // you came to install, anything else means you came to work.
  const cold = !MODULES.some((m) => moduleInstalled(m));
  if (cold) return install_picker({ dev });
  if (!process.stdin.isTTY) {
    // No terminal to draw on (a script, a hook, an agent's shell) — answer the same question
    // in text: every agent and every project, the same rows the panel draws.
    ensureSiblingPath();
    const groups = readLanes();
    const st = has("factory") ? loadState() : null;
    const rows = buildRows(groups, st?.hives || [], sameDir);
    console.log(headline(groups));
    for (const r of rows) {
      if (r.type === "project") {
        const others = unlistedAgents(r.project);
        console.log(`${r.project.name}${r.project.hive ? `  (plan ${r.project.hive.queueOpen})` : ""}${others.length ? `  agents: ${others.join(", ")}` : ""}${r.project.hive?.why ? `  needs you: ${r.project.hive.why}` : ""}`);
      }
      else console.log(`  ${GLYPH[r.lane.state] || "?"} ${(r.lane.name || r.lane.id || "?").padEnd(26)} ${r.lane.harness.padEnd(9)} ${laneDetail(r.lane)}`);
    }
    console.log(C.dim("\n  in a terminal, `seldon` is the live panel · continue one: ") + C.cyan("seldon go <name>"));
    return;
  }
  return panel();
})();
