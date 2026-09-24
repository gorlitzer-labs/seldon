// Black-box tests for the seldon CLI. Only side-effect-free commands are run
// here (list / doctor / help / arg-guards) — never install/up/down, which touch
// the machine. Interactive flows (the picker) need a TTY and are covered by the
// PTY checks in development, not this suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "seldon.js");

// Run the CLI; return { code, out } with ANSI stripped. Never throws.
// `env` extras are merged in (e.g. SELDON_HOME to sandbox state).
function run(args, env = {}) {
  try {
    const out = execFileSync("node", [BIN, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    return { code: 0, out: strip(out) };
  } catch (e) {
    return { code: e.status ?? 1, out: strip((e.stdout || "") + (e.stderr || "")) };
  }
}
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("`list` shows all six modules, exit 0", () => {
  const { code, out } = run(["list"]);
  assert.equal(code, 0);
  for (const id of ["apiary", "foundation", "comb", "factory", "bifrost", "demerzel"])
    assert.match(out, new RegExp(`\\b${id}\\b`), `lists ${id}`);
});

test("`--help` documents the lifecycle + install/uninstall commands", () => {
  const { code, out } = run(["--help"]);
  assert.equal(code, 0);
  for (const cmd of ["seldon up", "seldon down", "seldon status", "seldon install", "seldon uninstall", "--brain", "--tailnet"])
    assert.ok(out.includes(cmd), `help mentions ${cmd}`);
});

test("`doctor` runs and reports on external deps, exit 0", () => {
  const { code, out } = run(["doctor"]);
  assert.equal(code, 0);
  assert.match(out, /node|tmux|sops|age|tailscale|python/i);
});

test("`uninstall <unknown>` is rejected with a clear error, exit 1", () => {
  const { code, out } = run(["uninstall", "frobnicate"]);
  assert.equal(code, 1);
  assert.match(out, /unknown module/i);
  assert.match(out, /frobnicate/);
});

test("`uninstall` with no targets and no --all refuses, exit 1", () => {
  const { code, out } = run(["uninstall"]);
  assert.equal(code, 1);
  assert.match(out, /nothing to uninstall|--all/i);
});

test("an unknown command prints help and exits 1", () => {
  const { code, out } = run(["frobnicate"]);
  assert.equal(code, 1);
  assert.match(out, /seldon/i);
});

test("no args without a TTY errors instead of hanging on the picker", () => {
  const { code, out } = run([]);          // stdin is ignored (not a TTY)
  assert.equal(code, 1);
  assert.match(out, /no TTY|install/i);
});

test("status reports the remembered brain from a sandboxed SELDON_HOME (read-only)", () => {
  // status is read-only, so a temp SELDON_HOME can't touch the real stack.
  const home = mkdtempSync(path.join(tmpdir(), "seldon-home-"));
  try {
    mkdirSync(path.join(home, "demerzel", ".venv", "bin"), { recursive: true });
    writeFileSync(path.join(home, "demerzel", ".venv", "bin", "python"), "");   // demerzel "installed"
    writeFileSync(path.join(home, "brain"), "bonsai");
    const { code, out } = run(["status"], { SELDON_HOME: home });
    assert.equal(code, 0);
    assert.match(out, /voice brain:\s*bonsai/i, "status reflects the saved brain");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---- adopt / daemon cwd / docker: fake `factory` + `docker` on a restricted PATH ----
// PATH is only the fakes + node + the system dirs, so the real factory (if installed) is
// never reached, and SELDON_HOME is a temp dir so no real pidfile or daemon is touched.
function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "seldon-adopt-"));
  const bin = path.join(root, "bin"), home = path.join(root, "home");
  mkdirSync(bin); mkdirSync(home);
  const PATH = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":");
  const fake = (name, body) => { const f = path.join(bin, name); writeFileSync(f, "#!/bin/sh\n" + body + "\n"); execFileSync("chmod", ["+x", f]); };
  return { root, bin, home, PATH, fake, env: { PATH, SELDON_HOME: home } };
}

test("`adopt` without factory installed says how to get it, exit 1", () => {
  const s = sandbox();
  try {
    const { code, out } = run(["adopt", "."], s.env);
    assert.equal(code, 1);
    assert.match(out, /seldon install factory/);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("`adopt` hands the dir and flags to `factory adopt`, and propagates its exit code", () => {
  const s = sandbox();
  try {
    const log = path.join(s.root, "args");
    s.fake("factory", `printf '%s\\n' "$@" > '${log}'; exit \${FAKE_EXIT:-0}`);
    let r = run(["adopt", "/some/repo", "--name", "stranded"], s.env);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["adopt", "/some/repo", "--name", "stranded"]);
    assert.match(r.out, /supervisor is not running/);   // nudges toward `seldon up`
    r = run(["adopt", "/x"], { ...s.env, FAKE_EXIT: "3" });
    assert.equal(r.code, 3);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("`up` starts daemons from SELDON_HOME, not the folder it was typed in", () => {
  const s = sandbox();
  try {
    const where = path.join(s.root, "cwd");
    s.fake("factory", `pwd -P > '${where}'`);
    const project = path.join(s.root, "some-project"); mkdirSync(project);
    execFileSync("node", [BIN, "up"], { cwd: project, env: { ...process.env, ...s.env }, stdio: "ignore" });
    for (let i = 0; i < 50 && !existsSync(where); i++) execFileSync("sleep", ["0.1"]);
    assert.equal(readFileSync(where, "utf8").trim(), realpathSync(s.home));
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("`status` warns when docker is installed but its daemon is down", () => {
  const s = sandbox();
  try {
    s.fake("docker", "exit 1");
    assert.match(run(["status"], s.env).out, /docker: installed but the daemon is not running/);
    s.fake("docker", "exit 0");
    const up = run(["status"], s.env).out;
    assert.doesNotMatch(up, /daemon is not running/);
    assert.match(up, /docker: up/);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});
