/** reports.mjs + `seldon report` / `seldon setup` — Codex and opencode telling seldon their state. */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reportFromEvent, applyReports, mergeCodexHooks, removeCodexHooks, opencodePlugin, SELDON_MARK } from "../lib/reports.mjs";

describe("events become states", () => {
  const cx = (name, o = {}) => reportFromEvent("codex", { hook_event_name: name, session_id: "s1", cwd: "/w/a", ...o }, 7);
  test("codex", () => {
    assert.equal(cx("UserPromptSubmit").state, "working");
    assert.deepEqual([cx("PermissionRequest", { tool_name: "Bash" }).state, cx("PermissionRequest", { tool_name: "Bash" }).waitingFor], ["needs-you", "permission: Bash"]);
    assert.equal(cx("PostToolUse").state, "working", "an approved tool clears needs-you");
    assert.equal(cx("Stop").state, "idle");
    assert.equal(cx("Interrupt").state, "idle");
    assert.equal(cx("SessionEnd").ended, true);
    assert.equal(cx("PreCompact"), null);
    assert.equal(reportFromEvent("codex", { hook_event_name: "Stop" }), null, "no session, no report");
  });
  const oc = (type, properties) => reportFromEvent("opencode", { type, properties, cwd: "/w/b" }, 7);
  test("opencode", () => {
    assert.equal(oc("session.status", { sessionID: "o", status: { type: "busy" } }).state, "working");
    assert.equal(oc("session.status", { sessionID: "o", status: { type: "idle" } }).state, "idle");
    assert.equal(oc("permission.asked", { sessionID: "o", permission: "bash" }).waitingFor, "permission: bash");
    assert.equal(oc("permission.replied", { sessionID: "o" }).state, "working");
    assert.equal(oc("session.error", { sessionID: "o" }).state, "failed");
    assert.equal(oc("message.part.updated", { sessionID: "o" }), null);
  });
});

test("a tmux lane takes the newest report from its own worktree, never an older session's", () => {
  const lanes = [{ kind: "tmux", harness: "codex", cwd: "/w/a", state: "running", startedAt: 100_000 }, { kind: "tmux", harness: "codex", cwd: "/w/z", state: "running" }];
  const reports = [
    { harness: "codex", cwd: "/w/a", state: "idle", at: 110_000 },
    { harness: "codex", cwd: "/w/a", state: "needs-you", waitingFor: "permission: Bash", at: 120_000 },
    { harness: "codex", cwd: "/w/a", state: "failed", at: 10 },                 // left by an earlier session
    { harness: "opencode", cwd: "/w/z", state: "idle", at: 120_000 },          // another harness
  ];
  const [a, z] = applyReports(lanes, reports);
  assert.equal(a.state, "needs-you");
  assert.equal(a.waitingFor, "permission: Bash");
  assert.equal(z.state, "running");
});

describe("codex hooks.json", () => {
  test("seldon's hooks merge in, yours stay, and setup twice never duplicates", () => {
    const mine = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }] } };
    const once = mergeCodexHooks(mine, `${SELDON_MARK} "/old/path/seldon" report codex`);
    const twice = mergeCodexHooks(once, `${SELDON_MARK} "/new/path/seldon" report codex`);
    assert.equal(twice.hooks.PreToolUse.length, 2);
    assert.equal(twice.hooks.PreToolUse[0].hooks[0].command, "./guard.sh");
    assert.equal(twice.hooks.Stop.length, 1);
    assert.deepEqual(removeCodexHooks(twice), mine);
  });
});

test("the opencode plugin forwards only state events, with its directory", () => {
  const src = opencodePlugin("/bin/seldon");
  assert.match(src, /"session\.status"/);
  assert.doesNotMatch(src, /message\.part/);
  assert.match(src, /cwd: directory/);
});

describe("the CLI", () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "seldon.js");
  const home = mkdtempSync(join(tmpdir(), "seldon-reports-"));
  after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, SELDON_HOME: join(home, ".seldon"), NO_COLOR: "1" };
  const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: "utf8" });

  test("report records a state file and never fails the agent, even on garbage", () => {
    assert.equal(run(["report", "codex"], JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "abc", cwd: "/w", tool_name: "Bash" })).status, 0);
    const files = readdirSync(join(home, ".seldon", "state"));
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(readFileSync(join(home, ".seldon", "state", files[0]), "utf8")).state, "needs-you");
    const bad = run(["report", "codex"], "not json");
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout + bad.stderr, "", "silent — it runs inside the agent");
    run(["report", "codex"], JSON.stringify({ hook_event_name: "SessionEnd", session_id: "abc" }));
    assert.equal(readdirSync(join(home, ".seldon", "state")).length, 0, "an ended session leaves nothing");
  });

  test("setup codex keeps your hooks; --remove takes only seldon's", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    const mine = { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
    writeFileSync(join(home, ".codex", "hooks.json"), JSON.stringify(mine));
    assert.equal(run(["setup", "codex"]).status, 0);
    const cfg = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
    assert.equal(cfg.hooks.Stop.length, 2);
    assert.match(cfg.hooks.PermissionRequest[0].hooks[0].command, /report codex/);
    assert.match(run(["setup", "codex"]).stdout, /\/hooks/, "says the trust step out loud");
    run(["setup", "codex", "--remove"]);
    assert.deepEqual(JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")), mine);
  });

  test("setup opencode installs and removes the plugin", () => {
    run(["setup", "opencode"]);
    const p = join(home, ".config", "opencode", "plugins", "seldon.js");
    assert.ok(existsSync(p));
    run(["setup", "opencode", "--remove"]);
    assert.ok(!existsSync(p));
  });

  test("a hooks.json that is not JSON is left alone", () => {
    writeFileSync(join(home, ".codex", "hooks.json"), "{ nope");
    assert.match(run(["setup", "codex"]).stdout, /not valid JSON — left alone/);
    assert.equal(readFileSync(join(home, ".codex", "hooks.json"), "utf8"), "{ nope");
  });
});
