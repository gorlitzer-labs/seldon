#!/usr/bin/env node
// seldon — the Seldon stack installer. Pick your tools; install each via its
// native method. Zero dependencies: a raw-terminal checklist, no build step.
import { execSync, spawnSync } from "node:child_process";
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
  let ok;
  if (has("uv")) {
    if (!run("uv", ["venv", venv])) return false;
    ok = run("uv", ["pip", "install", "--python", path.join(venv, "bin", "python"), "-r", req]);
  } else {
    run("python3", ["-m", "venv", venv]);
    ok = run(path.join(venv, "bin", "pip"), ["install", "-r", req]);
  }
  if (ok) console.log(C.dim(`  run it: ${path.join(dest, m.bin)}  (isolated venv at ${venv})`));
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
  ${C.bold("seldon install")} [ids…]  install everything picked, or the named modules
  ${C.bold("seldon doctor")} [ids…]   check external deps (tmux, sops, age, tailscale, python…)
  ${C.bold("seldon list")}            list the modules
  ${C.bold("seldon --dev")}           link node modules from this checkout instead of npm
  ${C.bold("seldon install --pm=pnpm")}  force the node package manager (pnpm|bun|npm; auto-detected)

  ${C.dim("node tools install via pnpm/bun if present (faster), else npm.")}
  ${C.dim("python (demerzel) installs into its own isolated venv — never your system Python;")}
  ${C.dim("uses uv if present, else python3 -m venv + pip.")}

  modules: ${MODULES.map((m) => m.id).join(", ")}
`);
}

const argv = process.argv.slice(2);
const dev = argv.includes("--dev");
const args = argv.filter((a) => !a.startsWith("--"));
const cmd = args[0];
const ids = args.slice(1).filter((id) => byId[id]);

(async () => {
  if (argv.includes("--help") || cmd === "help") return help();
  if (cmd === "list") return list();
  if (cmd === "doctor") { printDoctor(ids.length ? withRequires(ids) : MODULES.map((m) => m.id)); return; }
  if (cmd === "install") {
    if (ids.length) return doInstall(ids, { dev });
    // install with no ids -> fall through to the picker
  }
  if (cmd && cmd !== "install") { help(); process.exitCode = 1; return; }
  // interactive
  if (!process.stdin.isTTY) { console.log(C.red("no TTY — use: seldon install <ids…>")); process.exitCode = 1; return; }
  const picked = await tui();
  if (!picked) { console.log(C.dim("nothing installed.")); return; }
  if (!picked.length) { console.log(C.dim("nothing selected.")); return; }
  doInstall(picked, { dev });
})();
