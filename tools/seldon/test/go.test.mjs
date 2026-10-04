/**
 * `seldon go` — the one verb. It owns no state, so what it is tested on is the ORDER and the
 * SHAPE of the calls it delegates: adopt before staff, staff before attach (the empty-room
 * bug), the repo root rather than the cwd, and flags that never leak into the project name.
 *
 * factory / apiary / tmux are faked on PATH and append to one log, so the sequence is the
 * assertion.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "seldon.js");
const root = mkdtempSync(join(tmpdir(), "seldon-go-"));
after(() => rmSync(root, { recursive: true, force: true }));

/**
 * hives: the JSON `factory state --compact` will answer with.
 * Every fake appends "<bin> <args>" to the log, so order is observable.
 */
function setup({ hives = [], hivesAfterAdopt = null, adoptStatus = 0 } = {}) {
  const bin = mkdtempSync(join(root, "bin-"));
  const home = mkdtempSync(join(root, "home-"));
  const log = join(bin, "calls.log");
  const mark = join(bin, "adopted");
  const state = JSON.stringify({ hives, decisions: [], summary: {} });
  // The real `factory adopt` REGISTERS the hive, so a `state` call after it answers
  // differently. A fake that always answers the same thing made `go` look broken when it was
  // correctly refusing to staff into a hive that never registered.
  const after = JSON.stringify({ hives: hivesAfterAdopt || hives, decisions: [], summary: {} });
  writeFileSync(join(bin, "factory"), `#!/bin/sh
echo "factory $*" >> '${log}'
if [ "$1" = "state" ]; then
  if [ -f '${mark}' ]; then printf '%s' '${after}'; else printf '%s' '${state}'; fi
  exit 0
fi
if [ "$1" = "adopt" ]; then [ ${adoptStatus} -eq 0 ] && touch '${mark}'; exit ${adoptStatus}; fi
exit 0
`);
  writeFileSync(join(bin, "apiary"), `#!/bin/sh\necho "apiary $*" >> '${log}'\nexit 0\n`);
  // a tmux that reports no sessions: nothing is running anywhere
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nexit 1\n`);
  // a claude with no sessions: the panel reads lanes from \`claude agents --json\`, and the
  // real one on the machine running the tests must not leak in
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho '[]'\n`);
  for (const f of ["factory", "apiary", "tmux", "claude"]) chmodSync(join(bin, f), 0o755);
  return { bin, home, log, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []) };
}

function repo(name = "proj") {
  const dir = join(root, `${name}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  // git resolves symlinked tmp roots, so compare against what git itself reports
  const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  return top;
}

const run = (args, { bin, home }, cwd) =>
  spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, SELDON_HOME: join(home, ".seldon") },
  });

// Attaching is gated on having a terminal, which a spawned test does not. `--attach` is the
// real flag for "attach anyway" (a tmux pane, a wrapper script), so the attach path is driven
// through product surface rather than through a hook that only tests use.
const runTty = (args, env, cwd) => run([...args, "--attach"], env, cwd);

const hive = (dir, over = {}) => ({
  name: "proj", dir, url: "http://127.0.0.1:7920", up: true,
  queueOpen: 3, done: 1, facts: 0, drift: 0, blockers: 0, lanes: [], agents: [], next: [], needsYou: false, why: null,
  ...over,
});

describe("seldon go", () => {
  test("an un-adopted repo is adopted, then staffed, then attached — in that order", () => {
    const dir = repo();
    // state says "not on the line"; after adopt it registers, exactly as the real one does
    const env = setup({ hives: [], hivesAfterAdopt: [hive(dir, { agents: [] })] });
    const r = run(["go"], env, dir);
    const calls = env.calls().join("\n");
    assert.match(calls, /factory adopt /, "did not adopt");
    const order = env.calls().filter((c) => /adopt|staff/.test(c)).map((c) => c.split(" ").slice(0, 2).join(" "));
    assert.deepEqual(order, ["factory adopt", "factory staff"], calls);
  });

  test("attaching happens AFTER staffing — joining an empty room was the whole bug", () => {
    const dir = repo();
    const env = setup({ hives: [hive(dir, { agents: [] })] });
    runTty(["go"], env, dir);
    const c = env.calls();
    const staff = c.findIndex((l) => l.startsWith("factory staff"));
    const attach = c.findIndex((l) => l.startsWith("apiary room resume"));
    assert.ok(staff !== -1 && attach !== -1, c.join("\n"));
    assert.ok(staff < attach, `staffed at ${staff}, attached at ${attach}`);
  });

  test("a hive that already has an agent is not re-staffed", () => {
    const dir = repo();
    const env = setup({ hives: [hive(dir, { agents: ["Coordinator"] })] });
    const r = run(["go"], env, dir);
    assert.ok(!env.calls().some((c) => c.startsWith("factory staff")), env.calls().join("\n"));
    assert.match(r.stdout, /working here: .*Coordinator/);
  });

  test("a down hive is reopened before anything else", () => {
    const dir = repo();
    const env = setup({ hives: [hive(dir, { up: false })] });
    const r = run(["go"], env, dir);
    assert.ok(env.calls().some((c) => c.startsWith("factory adopt")), "a down hive was not reopened");
    assert.match(r.stdout, /hive is down — reopening/);
  });

  test("run from a subdirectory, it means the repo root", () => {
    const dir = repo();
    const deep = join(dir, "src", "world");
    mkdirSync(deep, { recursive: true });
    const env = setup({ hives: [] });
    run(["go"], env, deep);
    const adopt = env.calls().find((c) => c.startsWith("factory adopt"));
    assert.equal(adopt, `factory adopt ${dir}`);
  });

  test("--agent codex is not mistaken for the project name", () => {
    const dir = repo();
    const env = setup({ hives: [hive(dir)] });
    const r = run(["go", "--agent", "codex", "--effort", "high"], env, dir);
    assert.doesNotMatch(r.stdout, /no project or repo called/, r.stdout);
    const staff = env.calls().find((c) => c.startsWith("factory staff"));
    assert.match(staff, /--agent codex/);
    assert.match(staff, /--effort high/);
  });

  test("--no-staff and --no-attach are honoured", () => {
    const dir = repo();
    const env = setup({ hives: [hive(dir)] });
    const r = run(["go", "--no-staff", "--no-attach"], env, dir);
    const c = env.calls().join("\n");
    assert.doesNotMatch(c, /factory staff/);
    assert.doesNotMatch(c, /apiary room resume/);
    assert.match(r.stdout, /apiary room resume proj/);   // still tells you how
  });

  test("an unknown name exits 1 and lists what IS on the line", () => {
    const dir = repo();
    const env = setup({ hives: [hive(dir, { name: "stranded" })] });
    const r = run(["go", "nope"], env, dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /no project or repo called "nope"/);
    assert.match(r.stdout, /stranded/);
  });

  test("with a terminal, attach is the last thing it does", () => {
    const dir = repo();
    const env = setup({ hives: [hive(dir, { agents: ["Coordinator"] })] });
    runTty(["go"], env, dir);
    const c = env.calls();
    assert.equal(c[c.length - 1], "apiary room resume proj", c.join("\n"));
  });

  test("outside a repo with no TTY it names the projects instead of hanging or erroring blind", () => {
    const env = setup({ hives: [hive(join(root, "elsewhere"), { name: "stranded" })] });
    const r = run(["go"], env, root);          // root is not a git repo
    assert.match(r.stdout, /not inside a git repo/);
    assert.match(r.stdout, /seldon go stranded/);
  });

  test("a failed adopt stops the run and exits non-zero — it never staffs into nothing", () => {
    const dir = repo();
    const env = setup({ hives: [], adoptStatus: 3 });
    const r = run(["go"], env, dir);
    assert.equal(r.status, 1);
    assert.ok(!env.calls().some((c) => c.startsWith("factory staff")), env.calls().join("\n"));
  });

  test("an older factory that cannot report agents says so instead of claiming nobody works", () => {
    const dir = repo();
    const h = hive(dir); delete h.agents;      // pre-0.1.10 state blob
    const env = setup({ hives: [h] });
    const r = run(["go", "--no-attach"], env, dir);
    assert.match(r.stdout, /too old to report agents/);
    assert.doesNotMatch(r.stdout, /nobody is working here/);
  });

  test("bare `seldon` without a TTY reports every project rather than erroring", () => {
    const env = setup({ hives: [hive(join(root, "x"), { name: "stranded", agents: ["Coordinator"] })] });
    const r = run([], env, root);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /stranded/);
    assert.match(r.stdout, /Coordinator/);
    assert.match(r.stdout, /seldon go <name>/);
  });
});
