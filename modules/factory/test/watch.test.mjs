/**
 * `factory watch` escalation cadence — against a fake hive that records every post.
 *
 * The bug: a stalled hive escalated on EVERY tick (30s), and each escalation is a room
 * post, a briefing line and a macOS notification with a sound. An idle project with an
 * empty queue also counted as "stalled", so it did this for hours with nothing wrong.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "node:fs";
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
async function supervise(dir, hiveUrl, ms = 4500, doctorOut = "no drift") {
  const home = mkdtempSync(join(root, "home-"));
  // a bin dir PER RUN: tests that need a different `foundation doctor` output must not
  // overwrite each other's fake while another supervisor is still ticking
  const bin = mkdtempSync(join(root, "bin-"));
  writeFileSync(join(bin, "foundation"), `#!/bin/sh\ncat <<'DOCTOR'\n${doctorOut}\nDOCTOR\n`); chmodSync(join(bin, "foundation"), 0o755);
  mkdirSync(join(home, ".factory"), { recursive: true });
  writeFileSync(join(home, ".factory", "hives.json"), JSON.stringify([{ name: "p", dir, hive: { serverUrl: hiveUrl, adminToken: "A" } }]));
  const w = spawn("node", [CLI, "watch", "--all", "--interval", "1", "--stall", "0"], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: "1", FACTORY_NO_NOTIFY: "1" },
  });
  let out = ""; w.stdout.on("data", (d) => (out += d)); w.stderr.on("data", (d) => (out += d));
  await new Promise((r) => setTimeout(r, ms));
  w.kill("SIGKILL");
  return { text: out, home };          // home holds .factory/decisions.json
}

describe("factory watch escalation", () => {
  test("a stall with work waiting is escalated once, not every tick", async () => {
    const h = await fakeHive();
    try {
      const { text: out } = await supervise(project("busy", ["fix the title screen"]), h.url);
      const ticks = (out.match(/p: queue 1/g) || []).length;
      assert.ok(ticks >= 3, `expected several ticks, got ${ticks}:\n${out}`);
      const stalls = h.posts.filter((p) => /STALL/.test(p));
      assert.equal(stalls.length, 1, `STALL posted ${stalls.length}x over ${ticks} ticks`);
    } finally { h.srv.close(); }
  });

  test("an empty queue with no lanes is idle, never stalled", async () => {
    const h = await fakeHive();
    try {
      const { text: out } = await supervise(project("idle", []), h.url);
      assert.doesNotMatch(out, /STALLED/);
      assert.equal(h.posts.filter((p) => /STALL/.test(p)).length, 0);
      assert.ok(h.posts.some((p) => /All nominal/.test(p)), "first digest still posted");
    } finally { h.srv.close(); }
  });
});

describe("an unaccounted queue item reaches the human", () => {
  // The other half of foundation's provenance check. The coupling is one string, and these two
  // tests pin both ends of it: foundation.test.mjs asserts its doctor says
  // `QUEUE.md:<n> no provenance on "<text>"`, and this asserts the supervisor acts on exactly
  // that. If either side rewords it, one of the two fails.
  const DOCTOR_OUT = 'foundation doctor\n\u2717 QUEUE.md:4 no provenance on "who wrote me" - appended outside `foundation queue`. Who added it?\n\n1 drift issue(s)';

  test("it is FILED as a decision, not just counted as drift in a room nobody reads", async () => {
    const h = await fakeHive();
    try {
      const r = await supervise(project("mystery", ["who wrote me"]), h.url, 4500, DOCTOR_OUT);
      const store = join(r.home, ".factory", "decisions.json");
      assert.ok(existsSync(store), `no decisions filed:\n${r.text}`);
      const filed = JSON.parse(readFileSync(store, "utf8"));
      assert.equal(filed.length, 1, `expected exactly one decision, got ${filed.length}`);
      assert.match(filed[0].text, /no provenance on "who wrote me"/);
      assert.equal(filed[0].status, "pending");
      assert.equal(filed[0].from, "foundation doctor");
      assert.match(r.text, /UNACCOUNTED queue item/);
    } finally { h.srv.close(); }
  });

  test("it is filed ONCE, however many ticks it survives", async () => {
    const h = await fakeHive();
    try {
      const r = await supervise(project("mystery2", ["who wrote me"]), h.url, 4500, DOCTOR_OUT);
      const ticks = (r.text.match(/queue 1/g) || []).length;
      assert.ok(ticks >= 3, `expected several ticks, got ${ticks}`);
      assert.equal((r.text.match(/UNACCOUNTED queue item/g) || []).length, 1, "re-escalated every tick");
    } finally { h.srv.close(); }
  });

  test("a clean doctor files nothing", async () => {
    const h = await fakeHive();
    try {
      const r = await supervise(project("clean", ["ordinary work"]), h.url);
      assert.ok(!existsSync(join(r.home, ".factory", "decisions.json")), "filed a decision with no drift");
      assert.doesNotMatch(r.text, /UNACCOUNTED/);
    } finally { h.srv.close(); }
  });
});
