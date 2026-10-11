/** machines.mjs — other machines, read from bifrost's realms; seldon on the far end. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRealmFile, sshArgs, lastJsonLine, remoteGroups } from "../lib/machines.mjs";

test("realm files are read, never run — and DEVICE_* still works", () => {
  assert.deepEqual(parseRealmFile('REALM_HOST="mini.tail1234.ts.net"\nREALM_USER=franz\n'), { host: "mini.tail1234.ts.net", user: "franz" });
  assert.deepEqual(parseRealmFile("DEVICE_HOST=box\n"), { host: "box", user: null });
  assert.equal(parseRealmFile("echo hi"), null);
});

test("ssh runs seldon through the remote login shell, every argument quoted", () => {
  const a = sshArgs({ host: "mini", user: "u" }, ["seldon", "lane", "start", "/r/a b", "--task", "it's done"], { tty: true });
  assert.deepEqual(a.slice(0, 6), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=4", "-t", "u@mini"]);
  assert.equal(a[6], `exec "$SHELL" -lic ''\\''seldon'\\'' '\\''lane'\\'' '\\''start'\\'' '\\''/r/a b'\\'' '\\''--task'\\'' '\\''it'\\''\\'\\'''\\''s done'\\'''`);
});

test("rc-file noise before the JSON is skipped", () => {
  assert.deepEqual(lastJsonLine("Last login: today\nnvm: using node 24\n[{\"key\":\"k\"}]\n"), [{ key: "k" }]);
  assert.equal(lastJsonLine("command not found: seldon"), null);
});

test("a machine's lanes become their own projects, keyed so they never collide", () => {
  const gs = remoteGroups({ name: "mini" }, [
    { key: "claude:ab", name: "fix", state: "needs-you", cwd: "/r/s/.claude/worktrees/fix", project: "/r/s", projectName: "stranded" },
    { key: "tmux:seldon_x", name: "x", state: "working", cwd: "/r/s", project: "/r/s", projectName: "stranded" },
  ]);
  assert.equal(gs.length, 1);
  assert.equal(gs[0].name, "stranded @mini");
  assert.equal(gs[0].root, "mini:/r/s");
  assert.equal(gs[0].remoteRoot, "/r/s");
  assert.deepEqual(gs[0].lanes.map((l) => [l.key, l.remoteKey, l.machine]), [["mini/claude:ab", "claude:ab", "mini"], ["mini/tmux:seldon_x", "tmux:seldon_x", "mini"]]);
});
