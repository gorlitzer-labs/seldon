import { test } from "node:test";
import assert from "node:assert/strict";
import { splitKey, guard, replyArgs, laneCaps } from "../lib/serve.mjs";

test("splitKey: remote keys carry their machine, local keys do not", () => {
  assert.deepEqual(splitKey("mini/claude:ab12"), { machine: "mini", key: "claude:ab12" });
  assert.deepEqual(splitKey("claude:ab12"), { machine: null, key: "claude:ab12" });
  assert.deepEqual(splitKey("tmux:seldon_fix/x"), { machine: null, key: "tmux:seldon_fix/x" });   // a slash after the colon is not a machine
  assert.deepEqual(splitKey(""), { machine: null, key: "" });
});

test("guard: loopback and tailnet hosts only", () => {
  const get = (host) => guard({ method: "GET", host, headers: {} });
  assert.equal(get("localhost:7930"), null);
  assert.equal(get("127.0.0.1:7930"), null);
  assert.equal(get("mini.tail1234.ts.net:8443"), null);
  assert.equal(get("evil.example"), "host not allowed");
  assert.equal(get("ts.net.evil.example"), "host not allowed");
});

test("guard: writes need the x-seldon header (a cross-site form cannot set it)", () => {
  assert.equal(guard({ method: "POST", host: "localhost", headers: {} }), "missing x-seldon header");
  assert.equal(guard({ method: "POST", host: "localhost", headers: { "x-seldon": "1" } }), null);
});

test("guard: --owner pins the tailscale identity", () => {
  const req = (login) => ({ method: "GET", host: "m.t.ts.net", headers: login ? { "tailscale-user-login": login } : {} });
  assert.equal(guard(req("sam@example.com"), { owner: "sam@example.com" }), null);
  assert.equal(guard(req("ana@example.com"), { owner: "sam@example.com" }), "not the owner");
  assert.equal(guard(req(null), { owner: "sam@example.com" }), "not the owner");
});

test("replyArgs: whitelisted keys, or literal text then Enter", () => {
  assert.deepEqual(replyArgs("seldon_x", { key: "esc" }), [["send-keys", "-t", "seldon_x", "Escape"]]);
  assert.deepEqual(replyArgs("seldon_x", { text: "1" }), [["send-keys", "-t", "seldon_x", "-l", "1"], ["send-keys", "-t", "seldon_x", "Enter"]]);
  assert.deepEqual(replyArgs("seldon_x", { text: "1", submit: false }), [["send-keys", "-t", "seldon_x", "-l", "1"]]);   // a menu key: no Enter after it
  assert.equal(replyArgs("seldon_x", { key: "C-b" }), null);          // not on the list
  assert.equal(replyArgs(null, { text: "hi" }), null);                // no pane
  assert.equal(replyArgs("seldon_x", { text: "x".repeat(2001) }), null);
});

test("laneCaps: only offer what the server will do", () => {
  const tmux = laneCaps({ harness: "codex", state: "needs-you", tmuxSession: "seldon_x" });
  assert.equal(tmux.peek && tmux.reply && tmux.stop, true);
  assert.equal(tmux.resume || tmux.rm, false);
  const bg = laneCaps({ harness: "claude", state: "working", id: "ab12" });
  assert.equal(bg.peek, false);
  assert.equal(bg.stop, true);
  assert.equal(laneCaps({ harness: "claude", state: "working", pid: 9 }).stop, false);   // an interactive session: stop it where it runs
  assert.equal(bg.hint, "claude attach ab12");
  const dead = laneCaps({ harness: "codex", state: "stopped", tmuxSession: "seldon_x", cwd: "/w/weather" });
  assert.equal(dead.peek || dead.stop, false);
  assert.equal(dead.resume && dead.rm, true);
});
