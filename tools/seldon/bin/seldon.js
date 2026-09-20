#!/usr/bin/env node
// seldon — the Seldon stack installer. Pick your tools; install each via its
// native method. Zero dependencies: a raw-terminal checklist, no build step.
import { execSync, spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { MODULES, byId, DEPS, RAW, MONOREPO, withRequires, platformOk } from "../modules.mjs";

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

// Pick the node package manager: --pm=<x> override (pnpm|bun|npm), else pnpm
// when it can global-install, else npm (the universal fallback). bun is not
// auto-preferred — opt in with --pm=bun.
function nodePM() {
  const ov = (process.argv.find((a) => a.startsWith("--pm=")) || "").split("=")[1];
  if (ov) return ov;
  if (has("pnpm") && pnpmGlobalReady()) return "pnpm";
  return "npm";
}

function installNpm(m, dev) {
  const pm = nodePM();
  if (dev && IN_CHECKOUT) {
    const dir = path.join(REPO_ROOT, m.dir);
    const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json")));
    if (pj.scripts?.build) run(pm, ["run", "build"], { cwd: dir });
    const link = pm === "pnpm" ? ["link", "--global"] : ["link"]; // bun/npm: `link`
    if (run(pm, link, { cwd: dir })) return true;
    if (pm !== "npm") { console.log(C.dim("  falling back to npm link…")); return run("npm", ["link"], { cwd: dir }); }
    return false;
  }
  // pnpm/bun: `add -g` · npm: `install -g` — a global CLI, no project touched
  const add = pm === "npm" ? ["install", "-g", m.pkg] : ["add", "-g", m.pkg];
  if (run(pm, add)) return true;
  if (pm !== "npm") { console.log(C.dim(`  ${pm} failed — falling back to npm…`)); return run("npm", ["install", "-g", m.pkg]); }
  return false;
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
    const venvArgs = ["venv", venv];
    if (m.pyVersion) venvArgs.push("--python", m.pyVersion); // uv fetches a standalone CPython
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
  // demerzel has no standalone binary — it runs as a module from its venv.
  if (ok && m.id === "demerzel") console.log(C.dim(`  run it: seldon up   (starts the voice on http://localhost:8770; first run fetches models)`));
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

function doInstall(ids, { dev } = {}) {
  ids = withRequires(ids);
  console.log(C.bold(`\nInstalling: `) + ids.join(", ") + (dev ? C.dim("  (dev: link from checkout)") : ""));
  console.log(C.bold("\nPreflight:"));
  const ok = printDoctor(ids);
  if (!ok) console.log(C.gold("\n  ⚠ some deps are missing — install them above, then the tool will work."));
  const results = ids.map((id) => [id, installOne(byId[id], dev)]);
  const good = results.filter(([, r]) => r).map(([i]) => i);
  const bad = results.filter(([, r]) => !r).map(([i]) => i);
  console.log("\n" + C.bold("Done. ") + C.green(good.join(", ") || "—") + (bad.length ? "  " + C.red("failed: " + bad.join(", ")) : ""));
}

// ---- uninstall --------------------------------------------------------------
// Remove a node CLI from the global store. `rm -g` is the same verb for pnpm,
// npm and bun; try the chosen PM first, then any other present (a tool may have
// been installed under a different one). Removing an absent package is success.
function uninstallNpm(m) {
  const pm = nodePM();
  const tried = new Set();
  for (const cand of [pm, "pnpm", "npm", "bun"]) {
    if (tried.has(cand) || !has(cand)) continue;
    tried.add(cand);
    if (run(cand, ["rm", "-g", m.pkg])) return true;
  }
  console.log(C.dim(`  ${m.id} not found in any global store (already gone)`));
  return true;
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
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
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
}

// ---- up / down / status : the friendly front door ---------------------------
// The stack's only always-on services are the voice (demerzel) and the
// supervisor loop (factory watch). We run them as detached background daemons,
// track them by pidfile under ~/.seldon/run, and print one map of where to go.
const RUN_DIR = path.join(process.env.HOME, ".seldon", "run");
const SELDON_HOME = path.join(process.env.HOME, ".seldon");
const pidFile = (name) => path.join(RUN_DIR, name + ".pid");
const readPid = (name) => { try { return parseInt(fs.readFileSync(pidFile(name), "utf8").trim(), 10) || 0; } catch { return 0; } };
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const daemonUp = (name) => { const p = readPid(name); return p && isAlive(p) ? p : 0; };

function startDaemon(name, cmd, args, opts = {}) {
  if (daemonUp(name)) return { already: true, pid: readPid(name) };
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const log = fs.openSync(path.join(RUN_DIR, name + ".log"), "a");
  const child = spawn(cmd, args, { detached: true, stdio: ["ignore", log, log], ...opts });
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
// demerzel needs its model set in the HF cache before it can serve.
function demerzelModelsReady() {
  const hub = path.join(process.env.HOME, ".cache", "huggingface", "hub");
  try { return fs.existsSync(hub) && fs.readdirSync(hub).some((d) => d.startsWith("models--")); } catch { return false; }
}
const demerzelInstalled = () => fs.existsSync(path.join(SELDON_HOME, "demerzel", ".venv", "bin", "python"));

function up() {
  console.log(C.gold("\n  seldon — bringing the stack up\n"));
  const go = [];      // where-to-go lines
  const later = [];   // things that need one action first

  // Voice — demerzel (background daemon)
  const dem = byId.demerzel;
  if (demerzelInstalled()) {
    const home = path.join(SELDON_HOME, "demerzel");
    if (!platformOk(dem)) later.push("Voice (demerzel) needs macOS on Apple silicon — skipped here.");
    else if (!demerzelModelsReady()) later.push(`Voice (demerzel) needs its models once (~25 GB):\n      ${path.join(home, ".venv/bin/python")} ${path.join(home, "scripts/fetch-models.py")}\n      then re-run  seldon up`);
    else {
      const r = startDaemon("demerzel", path.join(home, ".venv/bin/python"), ["-m", "demerzel.server"], { cwd: home });
      go.push(`${C.bold("Voice")}   ${C.cyan("http://localhost:8770")}   ${C.dim(r.already ? "(already up)" : "(starting — models load, ~30s)")}`);
    }
  }

  // Supervisor — factory watch (background daemon, the "let it work" loop)
  if (has("factory")) {
    const r = startDaemon("factory-watch", "factory", ["watch", "--all"]);
    go.push(`${C.bold("Supervisor")}  ${C.dim(r.already ? "already running" : "running")} — heals agents, catches stalls   ${C.dim("· live view: factory board")}`);
  }

  // The rest are on-demand, not daemons — point at the command.
  if (has("factory")) go.push(`${C.bold("Put agents to work")}  ${C.cyan('factory new "<your idea>"')}   ${C.dim("→ repo · foundation · apiary hive")}`);
  if (has("apiary"))  go.push(`${C.bold("Agent rooms")}  ${C.cyan("apiary ps")}   ${C.dim("(active rooms + join links)")}`);
  if (has("bifrost")) go.push(`${C.bold("Across machines / phone")}  ${C.cyan("bifrost sessions")}`);

  if (go.length) { console.log(C.bold("  Where to go:")); for (const l of go) console.log("   • " + l); }
  else console.log(C.dim("  nothing to start — install services first: seldon install factory demerzel"));
  if (later.length) { console.log("\n" + C.gold("  First, one step:")); for (const l of later) console.log("   • " + l); }
  console.log("\n  " + C.dim("stop everything: seldon down   ·   check state: seldon status") + "\n");
}

function down() {
  const names = ["demerzel", "factory-watch"];
  const stopped = names.filter((n) => stopDaemon(n));
  console.log(stopped.length ? C.green("stopped: ") + stopped.join(", ") : C.dim("nothing was running."));
}

function statusCmd() {
  console.log(C.bold("\nseldon services\n"));
  const rows = [["Voice (demerzel)", "demerzel"], ["Supervisor (factory watch)", "factory-watch"]];
  for (const [label, name] of rows) {
    const pid = daemonUp(name);
    console.log(`  ${label.padEnd(28)} ${pid ? C.green("up") + C.dim(` (pid ${pid})`) : C.dim("down")}`);
  }
  console.log(C.dim(`\n  logs: ${RUN_DIR}/<service>.log\n`));
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
  return new Promise((resolve) => {
    const rows = MODULES.map((m) => ({ m, on: platformOk(m) && ["apiary", "foundation", "factory"].includes(m.id) }));
    let cur = 0;
    const methodTag = (m) => ({ npm: "npm", shell: "shell", python: "python" }[m.method]);
    const draw = () => {
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);
      const out = [];
      BANNER.forEach((l) => out.push(C.gold(l)));
      out.push(C.dim("  the AI-agent-factory stack — pick your tools"));
      out.push(C.dim("  ↑↓ move · space toggle · a all · enter install · q quit\n"));
      rows.forEach((r, i) => {
        const sel = r.on ? C.green("[x]") : "[ ]";
        const cursor = i === cur ? C.gold("❯") : " ";
        const okp = !platformOk(r.m);
        const name = i === cur ? C.bold(r.m.id.padEnd(11)) : r.m.id.padEnd(11);
        const deps = r.m.needs.map((d) => (depOk(d) ? d : C.red(d))).join(" ");
        const platNote = okp ? C.red(" (unsupported OS)") : "";
        out.push(`  ${cursor} ${sel} ${name} ${C.dim(methodTag(r.m).padEnd(7))} ${C.dim(r.m.blurb)}${platNote}`);
        if (i === cur) out.push(`        ${C.dim("needs: " + (deps || "nothing"))}${r.m.requires.length ? C.dim("  · pulls in: " + r.m.requires.join(", ")) : ""}`);
      });
      process.stdout.write(out.join("\n") + "\n");
    };
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    draw();
    const onKey = (str, key) => {
      if (key.name === "up") cur = (cur - 1 + rows.length) % rows.length;
      else if (key.name === "down") cur = (cur + 1) % rows.length;
      else if (key.name === "space") { if (platformOk(rows[cur].m)) rows[cur].on = !rows[cur].on; }
      else if (str === "a") { const all = rows.every((r) => r.on || !platformOk(r.m)); rows.forEach((r) => { if (platformOk(r.m)) r.on = !all; }); }
      else if (key.name === "return") return finish(rows.filter((r) => r.on).map((r) => r.m.id));
      else if (key.name === "q" || (key.ctrl && key.name === "c")) return finish(null);
      draw();
    };
    const finish = (ids) => {
      process.stdin.off("keypress", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();   // emitKeypressEvents resumed stdin; without this the
      process.stdin.unref();   // event loop stays alive and the process hangs after install
      readline.cursorTo(process.stdout, 0); readline.clearScreenDown(process.stdout);
      resolve(ids);
    };
    process.stdin.on("keypress", onKey);
  });
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
${C.bold("seldon")} — install the Seldon stack, pick what you use.

  ${C.bold("seldon")}                 open the checklist (space to pick, enter to install)
  ${C.bold("seldon up")}              start the stack (voice + supervisor) and print where to go
  ${C.bold("seldon status")}          what's running   ·   ${C.bold("seldon down")}  stop it
  ${C.bold("seldon install")} [ids…]  install everything picked, or the named modules
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

const argv = process.argv.slice(2);
const dev = argv.includes("--dev");
const args = argv.filter((a) => !a.startsWith("--"));
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
  if (cmd && cmd !== "install") { help(); process.exitCode = 1; return; }
  // interactive
  if (!process.stdin.isTTY) { console.log(C.red("no TTY — use: seldon install <ids…>")); process.exitCode = 1; return; }
  const picked = await tui();
  if (!picked) { console.log(C.dim("nothing installed.")); return; }
  if (!picked.length) { console.log(C.dim("nothing selected.")); return; }
  doInstall(picked, { dev });
})();
