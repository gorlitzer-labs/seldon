/**
 * The attention rule and the agent lookup.
 *
 * `needsYou` had three copies (board, state, seldon) and they drifted. These lock the one
 * definition, and in particular the reason that was missing: a hive whose room is UP with work
 * queued and nobody in it. `factory adopt` leaves exactly that state, so it was the normal
 * condition after every restart and nothing reported it.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isIdle, needsYou, attentionReasons } from "../src/lib/hive.mjs";

const root = mkdtempSync(join(tmpdir(), "factory-hive-"));
after(() => rmSync(root, { recursive: true, force: true }));

const hive = (over = {}) => ({ up: true, queueOpen: 0, drift: 0, blockers: 0, agents: [], ...over });

describe("the attention rule", () => {
  test("a staffed hive with work is nominal", () => {
    const s = hive({ queueOpen: 5, agents: ["Coordinator"] });
    assert.equal(isIdle(s), false);
    assert.equal(needsYou(s), false);
    assert.equal(attentionReasons(s), "");
  });

  test("an OPEN room with work and nobody in it needs you", () => {
    const s = hive({ queueOpen: 5, agents: [] });
    assert.equal(isIdle(s), true);
    assert.equal(needsYou(s), true);
    assert.match(attentionReasons(s), /5 queued, nobody working/);
  });

  test("an empty queue with no agent is idle, not a problem", () => {
    const s = hive({ queueOpen: 0, agents: [] });
    assert.equal(isIdle(s), false);
    assert.equal(needsYou(s), false);
  });

  test("a down hive is never also reported as idle", () => {
    const s = hive({ up: false, queueOpen: 5, agents: [] });
    assert.equal(isIdle(s), false);
    assert.equal(attentionReasons(s), "hive is down");
  });

  test("reasons accumulate, most actionable first", () => {
    const s = hive({ up: false, queueOpen: 5, drift: 2, blockers: 1 });
    assert.equal(attentionReasons(s), "hive is down, 2 doc↔reality drift, 1 blocked lane(s)");
  });

  test("agents missing from the shape does not throw (older state blobs)", () => {
    const { agents, ...noAgents } = hive({ queueOpen: 5 });
    assert.equal(isIdle(noAgents), true);
  });
});

describe("agentsInProject", () => {
  // tmux is faked the way staff.test.mjs fakes it: sessions, and a cwd per session.
  const withTmux = async (rows) => {
    const bin = mkdtempSync(join(root, "bin-"));
    writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$1" in
  ls) ${rows.length ? rows.map((r) => `echo apiary_${r.name}`).join("; ") : "exit 1"} ;;
  display) case "$4" in ${rows.map((r) => `apiary_${r.name}) echo '${r.dir}' ;;`).join(" ")} *) exit 1 ;; esac ;;
esac
`);
    chmodSync(join(bin, "tmux"), 0o755);
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    // fresh import per PATH, so execFileSync resolves the fake
    const m = await import(`../src/lib/tmux.mjs?${Math.random()}`);
    return { m, restore: () => (process.env.PATH = prev) };
  };

  test("matches by the pane's cwd, not by the agent's name", async () => {
    const mine = join(root, "mine"), theirs = join(root, "theirs");
    mkdirSync(mine, { recursive: true }); mkdirSync(theirs, { recursive: true });
    const { m, restore } = await withTmux([
      { name: "Coordinator", dir: theirs },      // the name we would have matched on
      { name: "stranded-coordinator", dir: mine },
    ]);
    try {
      assert.deepEqual(m.agentsInProject(mine), ["stranded-coordinator"]);
      assert.deepEqual(m.agentsInProject(theirs), ["Coordinator"]);
    } finally { restore(); }
  });

  test("no tmux server at all is the cold state, not an error", async () => {
    const { m, restore } = await withTmux([]);
    try { assert.deepEqual(m.agentsInProject(root), []); } finally { restore(); }
  });
});
