/** home.mjs — the panel's rows. Projects come from lanes AND from factory; matched by dir. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRows, headline, ago, unlistedAgents, laneDetail } from "../lib/home.mjs";

const lane = (key, state, o = {}) => ({ key, state, harness: "claude", cwd: "/r/a", ...o });

test("a registered project with no agents still shows (it has a plan); active projects come first", () => {
  const groups = [{ root: "/r/a", name: "a", lanes: [lane(1, "working")] }];
  const hives = [{ name: "zed", dir: "/r/z", queueOpen: 2, agents: [] }, { name: "a", dir: "/r/a", queueOpen: 1, agents: [] }];
  const rows = buildRows(groups, hives);
  assert.deepEqual(rows.map((r) => r.type === "project" ? `P:${r.project.name}` : `L:${r.lane.key}`), ["P:a", "L:1", "P:zed"]);
  assert.equal(rows[0].project.hive.queueOpen, 1, "lane project picked up its factory plan");
});

test("a project whose lanes are all idle sorts with the quiet ones, by name", () => {
  const groups = [{ root: "/r/b", name: "b", lanes: [lane(1, "idle")] }, { root: "/r/c", name: "c", lanes: [lane(2, "needs-you")] }];
  assert.deepEqual(buildRows(groups).filter((r) => r.type === "project").map((r) => r.project.name), ["c", "b"]);
});

test("headline counts what matters", () => {
  assert.equal(headline([{ lanes: [lane(1, "needs-you"), lane(2, "working"), lane(3, "running"), lane(4, "idle")] }]), "1 need you · 2 working · 1 idle");
  assert.equal(headline([]), "no agents running");
});

test("factory's agents that no lane accounts for are still shown (another machine, say)", () => {
  const p = { hive: { agents: ["Coordinator", "Remote"] }, lanes: [lane(1, "working", { tmuxSession: "apiary_Coordinator" })] };
  assert.deepEqual(unlistedAgents(p), ["Remote"]);
  assert.deepEqual(unlistedAgents({ hive: null, lanes: [] }), []);
});

test("ago and laneDetail", () => {
  assert.equal(ago(1000, 61_000), "1m");
  assert.equal(ago(0), "");
  assert.equal(laneDetail({ state: "needs-you", waitingFor: "permission prompt" }), "needs you: permission prompt");
});
