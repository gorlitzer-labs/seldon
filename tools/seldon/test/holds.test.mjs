/**
 * Holds — turn-taking on one-per-machine things (the emulator, Unreal, the GPU) between
 * agents on DIFFERENT projects. Pure rules first, then the real CLI with real processes:
 * each fake agent is a shell running as `codex`, so the hold belongs to it and dies with it.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decide, mayRelease, isLive, ownerPid, parseDuration } from "../lib/holds.mjs";

const live = () => true;
const me = (o) => ({ who: "a/main", pid: 1, forMs: 60_000, ...o });

describe("rules", () => {
  test("free, expired, or abandoned: take it", () => {
    assert.ok(decide(null, me(), 0, live).take);
    assert.ok(decide({ who: "b", pid: 2, since: 0, until: 10 }, me(), 20, live).take, "expired");
    assert.ok(decide({ who: "b", pid: 2, since: 0, until: 99 }, me(), 5, () => false).take, "holder died");
  });

  test("someone else's live hold: wait", () => {
    const held = { who: "b", pid: 2, since: 0, until: 99 };
    assert.deepEqual(decide(held, me(), 5, live), { wait: held });
  });

  test("asking again renews your own hold and keeps when it started", () => {
    const r = decide({ who: "a/main", pid: 1, since: 3, until: 10 }, me(), 5, live);
    assert.equal(r.take.since, 3);
    assert.equal(r.take.until, 5 + 60_000);
  });

  test("only the holder releases, unless forced or the hold is dead", () => {
    const held = { who: "b", pid: 2, since: 0, until: 99 };
    assert.equal(mayRelease(held, me(), 5, live).ok, false);
    assert.ok(mayRelease(held, me(), 5, live, true).ok);
    assert.ok(mayRelease(held, me(), 500, live).ok, "expired");
    assert.ok(mayRelease(null, me(), 5, live).gone);
  });

  test("the owner is the agent CLI up the process tree, not seldon itself", () => {
    const tree = { 10: [9, "node"], 9: [8, "zsh"], 8: [1, "/usr/local/bin/claude"] };
    assert.equal(ownerPid(10, (p) => tree[p]?.[0], (p) => tree[p]?.[1]), 8);
    assert.equal(ownerPid(10, () => 1, () => "zsh"), null);
  });

  test("durations", () => {
    assert.equal(parseDuration("90s"), 90_000);
    assert.equal(parseDuration("30"), 30 * 60_000);
    assert.equal(parseDuration(undefined, 7), 7);
    assert.equal(parseDuration("soon"), null);
    assert.equal(isLive(null, 0, live), false);
  });
});

describe("the CLI between two agents", () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "seldon.js");
  const root = mkdtempSync(join(tmpdir(), "seldon-holds-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, SELDON_HOME: join(root, "home"), NO_COLOR: "1" };
  mkdirSync(join(root, "bin"));
  symlinkSync("/bin/sh", join(root, "bin", "codex"));
  const agent = (script) => spawn(join(root, "bin", "codex"), ["-c", script], { env });
  const seldon = (args) => `${process.execPath} ${CLI} ${args}`;
  const sync = (script) => spawnSync(join(root, "bin", "codex"), ["-c", script], { env, encoding: "utf8" });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  test("A holds; B waits its turn and is told who has it; A's exit frees it", async () => {
    const a = agent(`${seldon("hold emulator --as stranded/fix --wait 0")} && sleep 30`);
    await sleep(1500);
    const b = sync(seldon("hold emulator --as anatomy/lint --wait 0"));
    assert.equal(b.status, 2, b.stdout + b.stderr);
    assert.match(b.stdout, /emulator is held by stranded\/fix/);
    assert.match(sync(seldon("holds")).stdout, /emulator\s+stranded\/fix/);
    a.kill("SIGKILL");
    await sleep(300);
    const b2 = sync(seldon("hold emulator --as anatomy/lint --wait 0"));
    assert.equal(b2.status, 0, b2.stdout + b2.stderr);
    assert.match(b2.stdout, /emulator is yours/);
  });

  test("hold -- <command> runs it and lets go after", () => {
    const r = sync(seldon("hold gpu --as x/y --wait 0 -- sh -c 'echo ran; exit 3'"));
    assert.equal(r.status, 3, "the command's exit code comes back");
    assert.match(r.stdout, /ran/);
    assert.match(sync(seldon("holds")).stdout, /nothing is held|emulator/);
    assert.doesNotMatch(sync(seldon("holds")).stdout, /gpu/);
  });

  test("you cannot release someone else's hold", async () => {
    const a = agent(`${seldon("hold unreal --as one/main --wait 0")} && sleep 30`);
    await sleep(1500);
    const r = sync(seldon("release unreal --as two/main"));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /not yours to release/);
    a.kill("SIGKILL");
  });

  test("a bad resource name is refused", () => {
    assert.equal(sync(seldon("hold 'Bad Name'")).status, 1);
  });
});
