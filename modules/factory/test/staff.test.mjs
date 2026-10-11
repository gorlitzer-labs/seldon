/**
 * `factory staff` — the agent must be handed the room invite BEFORE it launches, or it
 * starts outside every room. Fake `apiary` records its argv/cwd and, like the real
 * runtime, deletes the invite once "joined"; fake `tmux` reports which agents exist.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pickAgentName, modelArgs } from "../src/staff.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");
const root = mkdtempSync(join(tmpdir(), "factory-staff-"));
after(() => rmSync(root, { recursive: true, force: true }));

function setup({ running = [] } = {}) {
  const home = mkdtempSync(join(root, "home-")), bin = mkdtempSync(join(root, "bin-"));
  const log = join(root, `apiary-${Math.random().toString(36).slice(2)}.log`);
  // apiary <harness> <name> --admin --background: record, then "join" (consume the invite)
  writeFileSync(join(bin, "apiary"), `#!/bin/sh
inv="$HOME/.apiary/invites/$2"
printf '%s|%s|%s|%s\\n' "$*" "$(pwd -P)" "$(cat "$inv" 2>/dev/null)" > '${log}'
sleep 0.5; rm -f "$inv"
`);
  // running: [{ name, dir }] — has-session / ls / display answer like tmux would.
  const rows = running.map((r) => (typeof r === "string" ? { name: r, dir: "/elsewhere" } : r));
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$1" in
  has-session) for r in ${rows.map((r) => r.name).join(" ")}; do [ "$3" = "apiary_$r" ] && exit 0; done; exit 1 ;;
  ls) ${rows.length ? rows.map((r) => `echo apiary_${r.name}`).join("; ") : "exit 1"} ;;
  display) case "$4" in ${rows.map((r) => `apiary_${r.name}) echo '${r.dir}' ;;`).join(" ")} *) exit 1 ;; esac ;;
esac
`);
  chmodSync(join(bin, "apiary"), 0o755); chmodSync(join(bin, "tmux"), 0o755);
  const dir = join(root, `proj-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir); execFileSync("git", ["init", "-q"], { cwd: dir });
  const hive = { serverUrl: "http://127.0.0.1:7920", adminToken: "ADMINTOK" };
  writeFileSync(join(dir, ".factory.json"), JSON.stringify({ name: "stranded", hive }));
  mkdirSync(join(home, ".factory"), { recursive: true });
  writeFileSync(join(home, ".factory", "hives.json"), JSON.stringify([{ name: "stranded", dir, hive }]));
  const run = (...args) => spawnSync("node", [CLI, "staff", ...args], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: "1" },
  });
  const launched = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("|") : null);
  return { home, dir, run, launched };
}

describe("factory staff", () => {
  test("writes the invite first, launches in the project dir, and waits for the join", () => {
    const s = setup();
    const r = s.run("stranded", "--wait", "10");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const [argv, cwd, invite] = s.launched();
    assert.equal(argv, "claude Coordinator --admin --background");
    assert.equal(cwd, execFileSync("realpath", [s.dir], { encoding: "utf8" }).trim());
    assert.equal(invite, "http://127.0.0.1:7920/?token=ADMINTOK", "agent launched without its room invite");
    assert.match(r.stdout, /Coordinator joined the stranded hive/);
  });

  test("a dir works as well as a registry name; --agent codex is passed through", () => {
    const s = setup();
    const r = s.run(s.dir, "--agent", "codex", "--no-wait");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (let i = 0; i < 50 && !s.launched(); i++) execFileSync("sleep", ["0.1"]);   // --no-wait returns before the launch lands
    assert.match(s.launched()?.[0] ?? "", /^codex Coordinator --admin --background$/);
  });

  test("does not start a second copy of an agent that is already running", () => {
    const s = setup({ running: ["Coordinator", "stranded-coordinator"] });
    const r = s.run("stranded", "--name", "Coordinator");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /already running/);
    assert.equal(s.launched(), null);
  });

  test("unknown project and bad harness fail clearly", () => {
    const s = setup();
    assert.match(s.run("nope").stderr, /no hive for nope/);
    assert.match(s.run("stranded", "--agent", "gpt").stderr, /--agent must be claude or codex/);
  });

  test("a project that already has an agent working in it is not staffed again, whatever its name", () => {
    const s = setup();
    const s2 = setup({ running: [{ name: "Coordinator", dir: s.dir }] });
    // point s2's registry/hive at s.dir so the running Coordinator is in THIS project
    writeFileSync(join(s2.home, ".factory", "hives.json"), JSON.stringify([{ name: "stranded", dir: s.dir, hive: { serverUrl: "http://127.0.0.1:7920", adminToken: "A" } }]));
    const r = s2.run("stranded");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /already has Coordinator working/);
    assert.equal(s2.launched(), null, "started a second coordinator on the same project");
  });

  test("Coordinator busy on ANOTHER project: this one gets <project>-coordinator", () => {
    const s = setup({ running: [{ name: "Coordinator", dir: "/some/other/project" }] });
    const r = s.run("stranded", "--wait", "10");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(s.launched()[0], /^claude stranded-coordinator --admin --background$/);
  });

  test("--model/--effort reach apiary in each harness's own spelling", () => {
    const s = setup();
    let r = s.run("stranded", "--model", "claude-fable-5-1", "--effort", "high", "--name", "fable-alt", "--wait", "10");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(s.launched()[0], "claude fable-alt --admin --background --model claude-fable-5-1 --effort high");
    assert.match(r.stdout, /claude · claude-fable-5-1 · high effort/);
    const s2 = setup();
    r = s2.run("stranded", "--agent", "codex", "--model", "gpt-6-astra", "--effort", "high", "--name", "astra-alt", "--wait", "10");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(s2.launched()[0], "codex astra-alt --admin --background --model gpt-6-astra -- -c model_reasoning_effort=high");
  });

  test("model and effort are checked before they can reach a shell", () => {
    for (const bad of ["x; rm -rf ~", "$(id)", "a b", "`x`", "m|n", ""]) {
      if (bad === "") continue;
      assert.throws(() => modelArgs("claude", { model: bad }), /not a model id/, bad);
    }
    assert.throws(() => modelArgs("codex", { effort: "high;id" }), /--effort must be/);
    assert.throws(() => modelArgs("claude", { effort: "turbo" }), /--effort must be/);
    assert.deepEqual(modelArgs("claude", { model: "opus[1m]" }), ["--model", "opus[1m]"]);
    assert.deepEqual(modelArgs("claude", {}), []);
    const s = setup();
    const r = s.run("stranded", "--model", "x;id", "--no-wait");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a model id/);
    assert.equal(s.launched(), null, "a rejected model still launched an agent");
  });

  test("the default name steps aside when Coordinator is taken by another project", () => {
    assert.equal(pickAgentName("seldon", undefined, () => false), "Coordinator");
    assert.equal(pickAgentName("seldon", undefined, (n) => n === "Coordinator"), "seldon-coordinator");
    assert.equal(pickAgentName("seldon", "Lead", () => true), "Lead");
  });
});
