// Black-box tests for the foundation CLI against throwaway repos. Zero-dep, so
// this runs anywhere. Exercises the deterministic seam: init, queue, stream,
// fact (+ its verify gate), and the recomputed status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "foundation-"));
  run(["init", dir], dir);                       // seed the seam
  return dir;
}
function run(args, dir) {
  try {
    const out = execFileSync("node", [CLI, ...args, "--dir", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) { return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") }; }
}

test("init lays down the seam docs + skills", () => {
  const dir = mkdtempSync(join(tmpdir(), "foundation-"));
  try {
    const { code, out } = run(["init", dir], dir);
    assert.equal(code, 0);
    assert.match(out, /Foundation installed/i);
    for (const f of ["QUEUE.md", "WORKSTREAMS.md", "DONE.md", "FACTS.md"])
      assert.ok(existsSync(join(dir, "docs", f)), `docs/${f} created`);
    assert.ok(existsSync(join(dir, ".claude", "skills")), ".claude/skills created");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("queue appends an item and status surfaces it as next", () => {
  const dir = fresh();
  try {
    const q = run(["queue", "(P1) add a --units flag"], dir);
    assert.equal(q.code, 0);
    assert.match(readFileSync(join(dir, "docs", "QUEUE.md"), "utf8"), /--units flag/);
    const s = run(["status"], dir);
    assert.match(s.out, /--units flag/, "status shows the next item");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stream upserts a lane that status reports", () => {
  const dir = fresh();
  try {
    const r = run(["stream", "weather-cli", "working", "scaffolding"], dir);
    assert.equal(r.code, 0);
    const s = run(["status"], dir);
    assert.match(s.out, /weather-cli/, "status shows the lane");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fact records only when its --verify check passes", () => {
  const dir = fresh();
  try {
    const ok = run(["fact", "runtime-node", "node is the runtime", "--verify", "true"], dir);
    assert.equal(ok.code, 0, "passing check records the fact");
    assert.match(readFileSync(join(dir, "docs", "FACTS.md"), "utf8"), /runtime-node/);

    const bad = run(["fact", "flaky-thing", "not really true", "--verify", "false"], dir);
    assert.notEqual(bad.code, 0, "failing check does not record");
    assert.doesNotMatch(readFileSync(join(dir, "docs", "FACTS.md"), "utf8"), /flaky-thing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fact ids must be kebab-case", () => {
  const dir = fresh();
  try {
    const r = run(["fact", "NotKebab", "some claim"], dir);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /kebab/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("doctor runs on a fresh repo", () => {
  const dir = fresh();
  try {
    const r = run(["doctor"], dir);
    assert.ok(r.out.length > 0, "doctor produces output");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
