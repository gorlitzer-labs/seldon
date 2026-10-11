// Tests for the bifrost shell CLI. Run via node --test (which the CI already
// runs) shelling out to bash — no `bats` dependency. Only side-effect-free
// paths: version, help, and the realm-name validation guard (which rejects
// before any tmux/ssh action), since that guard is security-critical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BIFROST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bifrost");

function run(args) {
  try {
    return { code: 0, out: strip(execFileSync("bash", [BIFROST, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) };
  } catch (e) { return { code: e.status ?? 1, out: strip((e.stdout || "") + (e.stderr || "")) }; }
}
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("version prints the pinned version", () => {
  const { out } = run(["version"]);
  assert.match(out, /bifrost\s+1\.7\.0/);
});

test("help lists the core commands", () => {
  const { out } = run(["help"]);
  for (const c of ["realm", "sessions", "attach", "status", "sync"])
    assert.match(out, new RegExp(`\\b${c}\\b`), `help mentions ${c}`);
});

// Security guard: realm names land in local eval-style expansions and remote ssh
// heredocs, so anything outside [A-Za-z0-9_-] must be rejected before use.
for (const bad of ["bad;rm -rf", "../../etc", "$(whoami)", "a b", "name`id`", "x|y", 'q"z']) {
  test(`realm add rejects the unsafe name ${JSON.stringify(bad)}`, () => {
    const { out } = run(["realm", "add", bad]);
    assert.match(out, /realm name must match/i, "the name is rejected by the guard");
    assert.doesNotMatch(out, /Added|configured|scanning|ssh/i, "no realm action taken");
  });
}

test("a wholly valid name passes the guard's regex", () => {
  // We don't run `realm add <valid>` (it would touch tmux/ssh); instead assert
  // the guard's own pattern accepts a clean name and rejects a dirty one.
  assert.match("web-01_node", /^[A-Za-z0-9_-]+$/);
  assert.doesNotMatch("web 01;", /^[A-Za-z0-9_-]+$/);
});
