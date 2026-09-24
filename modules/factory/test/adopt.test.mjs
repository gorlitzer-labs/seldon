/**
 * `factory adopt` — bringing an existing repo onto the line.
 *
 * The promises that matter: it never overwrites the repo's own docs, it is safe to run twice
 * (the second run reuses the live hive instead of opening another), it keeps the hive token
 * out of git, and it stops the registry from supervising folders that no longer exist.
 *
 * The CLI runs for real in a child process with HOME sandboxed (the registry lives under
 * ~/.factory) and fake `foundation` / `apiary` shims first on PATH. The fake apiary serves
 * real HTTP, so "is the hive still up?" is answered by an actual fetch.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openQueueItems, slugName, excludeLocally, freePort } from "../src/adopt.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");
const root = mkdtempSync(join(tmpdir(), "factory-adopt-"));
const HOME = join(root, "home");
const BIN = join(root, "bin");
mkdirSync(HOME, { recursive: true });
mkdirSync(BIN, { recursive: true });
const pids = [];
after(() => {
  // Every fake hive logs its pid, so none outlive the suite — even when a test fails early.
  try { for (const l of readFileSync(APIARY_LOG, "utf8").trim().split("\n")) pids.push(+l.split(" ")[2]); } catch {}
  for (const p of pids) { try { process.kill(p, "SIGKILL"); } catch {} }
  rmSync(root, { recursive: true, force: true });
});

// foundation shim: like the real init, only creates docs that are missing.
writeFileSync(join(BIN, "foundation"), `#!/bin/sh
[ "$1" = init ] || exit 0
mkdir -p "$2/docs"
[ -f "$2/docs/QUEUE.md" ] || printf '# Queue\\n\\n## Queue\\n\\n' > "$2/docs/QUEUE.md"
exit 0
`);
// apiary shim: `apiary serve --room N --headless --port P` → a real HTTP server on P that
// prints the one JSON info line factory reads, then stays up (detached, like the daemon).
writeFileSync(join(BIN, "apiary"), `#!/usr/bin/env node
const a = process.argv.slice(2);
const room = a[a.indexOf("--room") + 1], port = +a[a.indexOf("--port") + 1];
require("fs").appendFileSync(process.env.APIARY_LOG, room + " " + port + " " + process.pid + "\\n");
require("http").createServer((q, r) => r.end("ok")).listen(port, "127.0.0.1", () => {
  const u = "http://127.0.0.1:" + port;
  console.log(JSON.stringify({ serverUrl: u, publicUrl: u, roomName: room, adminToken: "ADMIN", memberToken: "MEMBER", pid: process.pid }));
});
`);
chmodSync(join(BIN, "foundation"), 0o755);
chmodSync(join(BIN, "apiary"), 0o755);
const APIARY_LOG = join(root, "apiary.log");

function adopt(dir, ...extra) {
  const r = spawnSync("node", [CLI, "adopt", dir, ...extra], {
    encoding: "utf8",
    env: { ...process.env, HOME, PATH: `${BIN}:${process.env.PATH}`, APIARY_LOG, NO_COLOR: "1", FACTORY_NO_UPDATE_CHECK: "1" },
    timeout: 30000,
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const registry = () => { try { return JSON.parse(readFileSync(join(HOME, ".factory", "hives.json"), "utf8")); } catch { return []; } };
function gitRepo(name) {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: d });
  return d;
}

describe("factory adopt — end to end", () => {
  test("refuses a folder that is not a git repo, and points at `factory new`", () => {
    const d = join(root, "plain"); mkdirSync(d);
    const r = adopt(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /not a git repo/);
    assert.match(r.out, /factory new/);
  });

  const game = gitRepo("stranded");
  mkdirSync(join(game, "docs"));
  const PRD = "# my real PRD — do not touch\n";
  writeFileSync(join(game, "docs", "PRD.md"), PRD);
  writeFileSync(join(game, "docs", "QUEUE.md"), "# Queue\n\n## Queue\n\n- [ ] (P1) fix double title screen\n- [ ] (P2) crosshair\n");

  test("first run: keeps the repo's docs, opens a hive, registers it, lists what's next", () => {
    const r = adopt(game);
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(join(game, "docs", "PRD.md"), "utf8"), PRD);
    assert.match(r.out, /next up \(2 open/);
    assert.match(r.out, /fix double title screen/);
    const reg = registry();
    assert.equal(reg.length, 1);
    assert.equal(reg[0].name, "stranded");
    assert.equal(reg[0].dir, game);
    const info = JSON.parse(readFileSync(join(game, ".factory.json"), "utf8"));
    pids.push(info.hive.pid);
    assert.equal(info.hive.roomName, "stranded");
  });

  test("the hive token stays out of git", () => {
    const ex = readFileSync(join(game, ".git", "info", "exclude"), "utf8");
    assert.match(ex, /^\/\.factory\.json$/m);
    const st = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: game, encoding: "utf8" });
    assert.doesNotMatch(st, /\.factory\.json/);
    mkdirSync(join(game, ".factory"), { recursive: true });
    writeFileSync(join(game, ".factory", "digest.log"), "x\n");
    const st2 = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: game, encoding: "utf8" });
    assert.doesNotMatch(st2, /\.factory\//, "the supervisor's digest dir shows up as untracked");
  });

  test("second run reuses the live hive — no second server, no duplicate entry", () => {
    const before = readFileSync(APIARY_LOG, "utf8").trim().split("\n").length;
    const r = adopt(game);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /already up/);
    assert.equal(readFileSync(APIARY_LOG, "utf8").trim().split("\n").length, before);
    assert.equal(registry().length, 1);
    // exclude line not duplicated either
    const ex = readFileSync(join(game, ".git", "info", "exclude"), "utf8");
    assert.equal(ex.match(/\.factory\.json/g).length, 1);
  });

  test("a hive that died is replaced, not trusted", () => {
    const info = JSON.parse(readFileSync(join(game, ".factory.json"), "utf8"));
    process.kill(info.hive.pid, "SIGKILL");
    spawnSync("sleep", ["0.3"]);
    const before = readFileSync(APIARY_LOG, "utf8").trim().split("\n").length;
    const r = adopt(game);
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(APIARY_LOG, "utf8").trim().split("\n").length, before + 1);
    pids.push(JSON.parse(readFileSync(join(game, ".factory.json"), "utf8")).hive.pid);
    assert.equal(registry().length, 1);
  });

  test("registry entries whose folder is gone are dropped", () => {
    const reg = registry();
    reg.push({ name: "ghost", dir: join(root, "no-such-dir"), hive: null, added: null });
    writeFileSync(join(HOME, ".factory", "hives.json"), JSON.stringify(reg));
    const r = adopt(game);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /dropped 1 hive.*ghost/);
    assert.deepEqual(registry().map((e) => e.name), ["stranded"]);
  });

  test("a folder the supervisor kept alive (only .factory/, no .git) counts as dead", () => {
    const zombie = join(root, "zombie"); mkdirSync(join(zombie, ".factory"), { recursive: true });
    writeFileSync(join(zombie, ".factory", "digest.log"), "[old] digest\n");
    const reg = registry();
    reg.push({ name: "zombie", dir: zombie, hive: { serverUrl: "http://127.0.0.1:7999" }, added: null });
    writeFileSync(join(HOME, ".factory", "hives.json"), JSON.stringify(reg));
    const r = adopt(game);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /dropped 1 hive.*zombie/);
    assert.deepEqual(registry().map((e) => e.name), ["stranded"]);
  });

  test("an empty queue says how to fill it instead of going quiet", () => {
    const d = gitRepo("blank");
    const r = adopt(d);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /queue is empty/);
    assert.match(r.out, /foundation queue/);
    pids.push(JSON.parse(readFileSync(join(d, ".factory.json"), "utf8")).hive.pid);
  });
});

describe("factory watch --all", () => {
  test("does not supervise — or re-create the folder of — a project that is gone", () => {
    const H = mkdtempSync(join(root, "watchhome-"));
    const gone = join(root, "deleted-project");
    mkdirSync(join(H, ".factory"), { recursive: true });
    writeFileSync(join(H, ".factory", "hives.json"), JSON.stringify([{ name: "gone", dir: gone, hive: null, added: null }]));
    const r = spawnSync("node", [CLI, "watch", "--all", "--once"], {
      encoding: "utf8", timeout: 30000,
      env: { ...process.env, HOME: H, PATH: `${BIN}:${process.env.PATH}`, NO_COLOR: "1" },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(gone), false, "watch re-created the deleted project's folder");
  });
});

describe("factory watch --all picks up hives adopted after it started", () => {
  test("empty registry → waits; a repo registered later is watched on the next tick", async () => {
    const H = mkdtempSync(join(root, "watchhome2-"));
    mkdirSync(join(H, ".factory"), { recursive: true });
    writeFileSync(join(H, ".factory", "hives.json"), "[]");
    const { spawn } = await import("node:child_process");
    const w = spawn("node", [CLI, "watch", "--all", "--interval", "1"], {
      env: { ...process.env, HOME: H, PATH: `${BIN}:${process.env.PATH}`, NO_COLOR: "1" },
    });
    let out = "";
    w.stdout.on("data", (d) => (out += d)); w.stderr.on("data", (d) => (out += d));
    try {
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(w.exitCode, null, "supervisor exited on an empty registry:\n" + out);
      const late = gitRepo("adopted-late");
      writeFileSync(join(H, ".factory", "hives.json"), JSON.stringify([{ name: "adopted-late", dir: late, hive: null, added: null }]));
      for (let i = 0; i < 40 && !/now watching adopted-late/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
      assert.match(out, /now watching adopted-late/);
    } finally { w.kill("SIGKILL"); }
  });
});

describe("factory new --here on a repo that already has a PRD", () => {
  test("keeps the existing PRD instead of overwriting it with a seed", async () => {
    const d = gitRepo("has-prd");
    mkdirSync(join(d, "docs"));
    writeFileSync(join(d, "docs", "PRD.md"), "# the real one\n");
    const r = spawnSync("node", [CLI, "new", "some idea", "--here", "--name", "has-prd", "--port", String(await freePort(7960))], {
      cwd: d, encoding: "utf8", timeout: 30000,
      env: { ...process.env, HOME, PATH: `${BIN}:${process.env.PATH}`, APIARY_LOG, NO_COLOR: "1" },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(d, "docs", "PRD.md"), "utf8"), "# the real one\n");
  });
});

describe("adopt helpers", () => {
  test("freePort skips ports another registered hive claims, even when the OS says free", async () => {
    const start = 20000 + Math.floor(Math.random() * 20000);
    const p = await freePort(start, 20, new Set([start, start + 1]));
    assert.ok(p >= start + 2, `got ${p}, expected to skip ${start} and ${start + 1}`);
  });
  test("slugName", () => {
    assert.equal(slugName("Stranded Game!"), "stranded-game");
    assert.equal(slugName("---"), "project");
  });
  test("openQueueItems reads only open items, in order", () => {
    const d = mkdtempSync(join(root, "q-"));
    mkdirSync(join(d, "docs"));
    writeFileSync(join(d, "docs", "QUEUE.md"), "- [x] done\n- [ ] (P1) a\n- [ ] (P2) b\n- [ ] (P3) c\n- [ ] (P3) d\n");
    assert.deepEqual(openQueueItems(d), { total: 4, top: ["(P1) a", "(P2) b", "(P3) c"] });
    assert.deepEqual(openQueueItems(join(d, "nope")), { total: 0, top: [] });
  });
  test("excludeLocally is a no-op outside git and when already excluded", () => {
    const d = mkdtempSync(join(root, "x-"));
    assert.equal(excludeLocally(d, ".factory.json"), false);
    execFileSync("git", ["init", "-q"], { cwd: d });
    assert.equal(excludeLocally(d, ".factory.json"), true);
    assert.equal(excludeLocally(d, ".factory.json"), false);
    assert.ok(existsSync(join(d, ".git", "info", "exclude")));
  });
});
