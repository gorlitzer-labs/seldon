// Black-box tests for the seldon CLI. Only side-effect-free commands are run
// here (list / doctor / help / arg-guards) — never install/up/down, which touch
// the machine. Interactive flows (the picker) need a TTY and are covered by the
// PTY checks in development, not this suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
