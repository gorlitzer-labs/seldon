import { test } from "node:test";
import assert from "node:assert/strict";
import { stewardCommand, STEWARD_ALLOWED, STEWARD_DENIED, STEWARD_BRIEF } from "../lib/steward.mjs";
import { wsRows } from "../lib/workspace.mjs";

test("the steward asks before anything outside seldon, even when your sessions bypass permissions", () => {
  const argv = stewardCommand({ brief: "B" });
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "default");
  assert.ok(STEWARD_ALLOWED.every((t) => /^Bash\(seldon /.test(t)), "only seldon commands run without asking");
  for (const t of ["Edit", "Write"]) assert.ok(STEWARD_DENIED.includes(t), `${t} is denied`);
  assert.ok(!argv.includes("--dangerously-skip-permissions"));
});

test("the brief keeps the rules that make relaying safe", () => {
  assert.match(STEWARD_BRIEF, /Never decide for Franco/);
  assert.match(STEWARD_BRIEF, /Never type into an agent that is working/);
});

test("the steward is pinned at the top of the list, before anyone waiting", () => {
  const lane = (name, state) => ({ key: name, name, state, harness: "claude" });
  const rows = wsRows([{ name: "p", lanes: [lane("joey", "needs-you"), lane("steward", "idle"), lane("tars", "working")] }]);
  assert.deepEqual(rows.map((r) => [r.n, r.name, r.group]), [[1, "steward", "steward"], [2, "joey", "needs you"], [3, "tars", "working"]]);
});
