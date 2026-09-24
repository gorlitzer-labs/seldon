/**
 * `factory watch` escalation cadence — against a fake hive that records every post.
 *
 * The bug: a stalled hive escalated on EVERY tick (30s), and each escalation is a room
 * post, a briefing line and a macOS notification with a sound. An idle project with an
 * empty queue also counted as "stalled", so it did this for hours with nothing wrong.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");
const root = mkdtempSync(join(tmpdir(), "factory-watch-"));
after(() => rmSync(root, { recursive: true, force: true }));

// A hive that accepts the supervisor and records what it posts.
function fakeHive() {
  const posts = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/join") return res.end(JSON.stringify({ sessionToken: "S" }));
      if (req.url === "/participants") return res.end(JSON.stringify({ participants: [] }));
      if (req.url === "/messages") return res.end(JSON.stringify({ items: [] }));
      if (req.url === "/message") { posts.push(JSON.parse(body || "{}").content || ""); return res.end("{}"); }
      res.end("{}");
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, posts, url: `http://127.0.0.1:${srv.address().port}` })));
}

function project(name, queueItems) {
  const dir = join(root, name);
  mkdirSync(join(dir, "docs"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "docs", "QUEUE.md"), "# Queue\n\n## Queue\n\n" + queueItems.map((q) => `- [ ] (P1) ${q}\n`).join(""));
  return dir;
}

// Run the supervisor for ~`ms` at a 1s interval with stall threshold 0 (stalled at once).
async function supervise(dir, hiveUrl, ms = 4500) {
  const home = mkdtempSync(join(root, "home-"));
  const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "foundation"), "#!/bin/sh\necho 'no drift'\n"); chmodSync(join(bin, "foundation"), 0o755);
  mkdirSync(join(home, ".factory"), { recursive: true });
  writeFileSync(join(home, ".factory", "hives.json"), JSON.stringify([{ name: "p", dir, hive: { serverUrl: hiveUrl, adminToken: "A" } }]));
  const w = spawn("node", [CLI, "watch", "--all", "--interval", "1", "--stall", "0"], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: "1", FACTORY_NO_NOTIFY: "1" },
  });
  let out = ""; w.stdout.on("data", (d) => (out += d)); w.stderr.on("data", (d) => (out += d));
  await new Promise((r) => setTimeout(r, ms));
  w.kill("SIGKILL");
  return out;
}

describe("factory watch escalation", () => {
  test("a stall with work waiting is escalated once, not every tick", async () => {
    const h = await fakeHive();
    try {
      const out = await supervise(project("busy", ["fix the title screen"]), h.url);
      const ticks = (out.match(/p: queue 1/g) || []).length;
      assert.ok(ticks >= 3, `expected several ticks, got ${ticks}:\n${out}`);
      const stalls = h.posts.filter((p) => /STALL/.test(p));
      assert.equal(stalls.length, 1, `STALL posted ${stalls.length}x over ${ticks} ticks`);
    } finally { h.srv.close(); }
  });

  test("an empty queue with no lanes is idle, never stalled", async () => {
    const h = await fakeHive();
    try {
      const out = await supervise(project("idle", []), h.url);
      assert.doesNotMatch(out, /STALLED/);
      assert.equal(h.posts.filter((p) => /STALL/.test(p)).length, 0);
      assert.ok(h.posts.some((p) => /All nominal/.test(p)), "first digest still posted");
    } finally { h.srv.close(); }
  });
});
