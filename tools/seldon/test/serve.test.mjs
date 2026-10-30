import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { splitKey, guard, replyArgs, laneCaps, tokenOk, ownerFromStatus, serveToken } from "../lib/serve.mjs";

test("splitKey: remote keys carry their machine, local keys do not", () => {
  assert.deepEqual(splitKey("mini/claude:ab12"), { machine: "mini", key: "claude:ab12" });
  assert.deepEqual(splitKey("claude:ab12"), { machine: null, key: "claude:ab12" });
  assert.deepEqual(splitKey("tmux:seldon_fix/x"), { machine: null, key: "tmux:seldon_fix/x" });   // a slash after the colon is not a machine
  assert.deepEqual(splitKey(""), { machine: null, key: "" });
});

const T = "t".repeat(32);
const req = (host, { path = "/api/state", token = T, login } = {}) =>
  ({ path, host, headers: { ...(token ? { "x-seldon-token": token } : {}), ...(login ? { "tailscale-user-login": login } : {}) } });

test("guard: loopback, or a tailnet name only when served on the tailnet", () => {
  assert.equal(guard(req("localhost:7930"), { token: T }), null);
  assert.equal(guard(req("127.0.0.1:7930"), { token: T }), null);
  assert.equal(guard(req("evil.example"), { token: T }), "host not allowed");
  assert.equal(guard(req("ts.net.evil.example"), { token: T }), "host not allowed");
  // a tailscale serve mapping left from an earlier --tailnet run reaches nothing
  assert.match(guard(req("mini.tail1234.ts.net", { login: "sam@example.com" }), { token: T }), /not served on the tailnet/);
});

test("guard: on the tailnet, only the owner's login", () => {
  const on = { token: T, tailnet: true, owner: "sam@example.com" };
  assert.equal(guard(req("mini.tail1234.ts.net:8443", { login: "sam@example.com" }), on), null);
  assert.equal(guard(req("mini.tail1234.ts.net", { login: "ana@example.com" }), on), "not the owner");
  assert.equal(guard(req("mini.tail1234.ts.net"), on), "not the owner");
  assert.equal(guard(req("mini.tail1234.ts.net", { login: "sam@example.com" }), { token: T, tailnet: true }), "not the owner");   // no owner = nobody
});

test("guard: every /api call needs the token, reads included; the empty page does not", () => {
  assert.equal(guard(req("localhost", { token: null }), { token: T }), "bad or missing token");
  assert.equal(guard(req("localhost", { token: "x".repeat(32) }), { token: T }), "bad or missing token");
  assert.equal(guard(req("localhost", { path: "/api/lane/stop", token: null }), { token: T }), "bad or missing token");
  assert.equal(guard(req("localhost", { path: "/", token: null }), { token: T }), null);
});

test("tokenOk: exact match only, and no token configured means no", () => {
  assert.equal(tokenOk(T, T), true);
  assert.equal(tokenOk(T.slice(1), T), false);
  assert.equal(tokenOk(undefined, T), false);
  assert.equal(tokenOk("", ""), false);
});

test("ownerFromStatus: this machine's tailscale login", () => {
  assert.equal(ownerFromStatus({ Self: { UserID: 42 }, User: { 42: { LoginName: "sam@example.com" } } }), "sam@example.com");
  assert.equal(ownerFromStatus({ Self: {} }), null);
  assert.equal(ownerFromStatus(null), null);
});

test("serveToken: made once, kept, owner-only", () => {
  const home = mkdtempSync(join(tmpdir(), "seldon-serve-"));
  try {
    const t = serveToken(home);
    assert.ok(t.length >= 32);
    assert.equal(serveToken(home), t);
    assert.equal(statSync(join(home, "serve-token")).mode & 0o777, 0o600);
  } finally { rmSync(home, { recursive: true, force: true }); }
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
