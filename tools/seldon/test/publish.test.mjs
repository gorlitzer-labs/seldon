import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, utimesSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPublishError, staleBuild } from "../scripts/publish-lib.mjs";

test("a staged-version 409 is recognised as already on its way", () => {
  const real = 'npm error code E409\nnpm error 409 Conflict - PUT https://registry.npmjs.org/@gorlitzer-labs%2ffactory - Cannot publish over previously staged version "0.1.3".';
  assert.equal(classifyPublishError(real), "staged");
});
test("every other failure stays a failure", () => {
  assert.equal(classifyPublishError("npm error code E403\nnpm error 403 Forbidden - You cannot publish over the previously published versions: 0.1.2."), "error");
  assert.equal(classifyPublishError("npm error code E409\nnpm error 409 Conflict - some other conflict"), "error");
  assert.equal(classifyPublishError("npm error code ENEEDAUTH"), "error");
  assert.equal(classifyPublishError(""), "error");
});

function pkg({ srcAge, outAge, withOut = true }) {
  const d = mkdtempSync(join(tmpdir(), "stale-"));
  mkdirSync(join(d, "src", "cli"), { recursive: true });
  writeFileSync(join(d, "src", "cli", "a.ts"), "x");
  const now = Date.now() / 1000;
  utimesSync(join(d, "src", "cli", "a.ts"), now - srcAge, now - srcAge);
  if (withOut) {
    mkdirSync(join(d, "dist"));
    writeFileSync(join(d, "dist", "index.js"), "y");
    writeFileSync(join(d, "dist", "index.js.map"), "{}");
    utimesSync(join(d, "dist", "index.js"), now - outAge, now - outAge);
    utimesSync(join(d, "dist", "index.js.map"), now - outAge - 99999, now - outAge - 99999);  // maps don't count
  }
  return d;
}

test("a dist/ older than its source is stale (the Sep 20 dist that shipped as 1.13.5/1.13.6)", () => {
  const d = pkg({ srcAge: 60, outAge: 5 * 86400 });
  const r = staleBuild(d);
  assert.equal(r.stale, true);
  assert.match(r.reason, /a\.ts is newer than .*index\.js/);
  rmSync(d, { recursive: true, force: true });
});

test("a fresh build is not stale; source maps don't count; a missing dist is stale", () => {
  const fresh = pkg({ srcAge: 600, outAge: 5 });
  assert.equal(staleBuild(fresh).stale, false);
  const none = pkg({ srcAge: 600, outAge: 0, withOut: false });
  assert.deepEqual(staleBuild(none), { stale: true, reason: "dist/ does not exist" });
  for (const d of [fresh, none]) rmSync(d, { recursive: true, force: true });
});

// ── the release script must run from anywhere ─────────────────────────────────
// ROOT is derived from the script's own path and every publish call passes `cwd: ROOT`, but the
// auth preflight ran `npm whoami` with no cwd. npm reads .npmrc from its cwd upward and the
// token lives in ROOT/.npmrc, so invoking the script from a home directory reported
// "Not authed to npm" and refused — while the publish it was gating would have succeeded.
test("every npm call runs from the repo root, so the token in ROOT/.npmrc is found", () => {
  const bin = mkdtempSync(path.join(tmpdir(), "seldon-pub-bin-"));
  const elsewhere = mkdtempSync(path.join(tmpdir(), "seldon-pub-cwd-"));
  const log = path.join(bin, "npm-calls.log");
  // `view` succeeds for everything, so each package is "already on npm" and the script skips
  // the build/publish path entirely. Anything else is a call this test did not expect.
  writeFileSync(path.join(bin, "npm"), `#!/bin/sh
echo "$1 $(pwd -P)" >> '${log}'
case "$1" in whoami|view) exit 0 ;; *) exit 1 ;; esac
`);
  chmodSync(path.join(bin, "npm"), 0o755);
  const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "publish-all.mjs");
  const ROOT = realpathSync(path.resolve(path.dirname(SCRIPT), "..", "..", ".."));
  try {
    const out = execFileSync("node", [SCRIPT, "--dry-run"], {
      cwd: elsewhere, encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" "));
    const whoami = calls.find((c) => c[0] === "whoami");
    assert.ok(whoami, "no auth preflight ran");
    assert.equal(whoami[1], ROOT, `whoami ran in ${whoami[1]}, not the repo root`);
    for (const [sub, cwd] of calls) assert.equal(cwd, ROOT, `\`npm ${sub}\` ran in ${cwd}, not the repo root`);
    assert.doesNotMatch(out, /Not authed/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
