// Black-box tests for the foundation CLI against throwaway repos. Zero-dep, so
// this runs anywhere. Exercises the deterministic seam: init, queue, stream,
// fact (+ its verify gate), and the recomputed status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

test("queue --list --json gives tools the open items, with provenance, and nothing done", () => {
  const dir = fresh();
  try {
    run(["queue", "(P2) second thing"], dir);
    run(["queue", "(P1) first thing"], dir);
    const p = join(dir, "docs", "QUEUE.md");
    writeFileSync(p, readFileSync(p, "utf8").replace("- [ ] (P2) second thing", "- [x] (P2) second thing"));
    const { code, out } = run(["queue", "--list", "--json"], dir);
    assert.equal(code, 0);
    const items = JSON.parse(out);
    assert.deepEqual(items.map((i) => [i.priority, i.text]), [["P1", "first thing"]]);
    assert.match(items[0].id, /^q-[0-9a-f]{8}$/);
    assert.ok(items[0].by, "provenance carried through");
    assert.match(run(["queue", "--list"], dir).out, /\(P1\) first thing/);
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

// ── queue provenance ─────────────────────────────────────────────────────────
// QUEUE.md is an instruction channel: /plan-phase dispatches from it and a coordinator puts a
// worker on what it finds. On 2026-09-28 a line appeared in the seldon repo's queue that no
// transcript, shell history or editor store could account for, and nothing reported it for
// four days. These pin the check that makes that visible.

test("queue records who appended an item and when", () => {
  const dir = fresh();
  try {
    const { code, out } = run(["queue", "(P1) do the thing"], dir);
    assert.equal(code, 0, out);
    const q = readFileSync(join(dir, "docs", "QUEUE.md"), "utf8");
    assert.match(q, /^- \[ \] \(P1\) do the thing$/m);
    assert.match(q, /^ {4}added: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z {2}by: \S+$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FOUNDATION_AGENT names the author, so an agent is not recorded as the human", () => {
  const dir = fresh();
  try {
    execFileSync("node", [CLI, "queue", "(P2) agent work", "--dir", dir], {
      encoding: "utf8", env: { ...process.env, FOUNDATION_AGENT: "seldon-coordinator" },
    });
    assert.match(readFileSync(join(dir, "docs", "QUEUE.md"), "utf8"), /by: seldon-coordinator$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an item appended by hand has no provenance, and doctor calls it DRIFT with exit 1", () => {
  const dir = fresh();
  try {
    const p = join(dir, "docs", "QUEUE.md");
    writeFileSync(p, readFileSync(p, "utf8").replace(/## Queue\n/, "## Queue\n- [ ] (P3) who wrote me\n"));
    const { code, out } = run(["doctor"], dir);
    // the exact wording factory's supervisor matches on — see UNACCOUNTED_RE in watch.mjs
    assert.match(out, /QUEUE\.md:\d+ no provenance on "who wrote me"/);
    assert.match(out, /drift issue/);
    assert.equal(code, 1, "an unaccounted instruction must fail CI");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("queue --stamp backfills pre-existing items as unverified, never inventing an author", () => {
  const dir = fresh();
  try {
    const p = join(dir, "docs", "QUEUE.md");
    writeFileSync(p, readFileSync(p, "utf8").replace(/## Queue\n/, "## Queue\n- [ ] (P3) legacy item\n"));
    const { code, out } = run(["queue", "--stamp"], dir);
    assert.equal(code, 0, out);
    assert.match(readFileSync(p, "utf8"), /by: unverified$/m);
    assert.doesNotMatch(readFileSync(p, "utf8"), new RegExp(`by: ${process.env.USER}`), "must not claim the human added it");
    assert.equal(run(["doctor"], dir).code, 0, "a stamped item is accounted for");
    // idempotent, and it never overwrites a real author
    assert.match(run(["queue", "--stamp"], dir).out, /already carries provenance/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a stamped item still parses: status reports it, and the text excludes the stamp", () => {
  const dir = fresh();
  try {
    run(["queue", "(P1) sail to reefstack"], dir);
    const { out } = run(["status"], dir);
    assert.match(out, /\(P1\) sail to reefstack/);
    assert.doesNotMatch(out, /added:/, "the stamp must not leak into the item text");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
