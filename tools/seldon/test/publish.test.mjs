import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPublishError } from "../scripts/publish-lib.mjs";

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

import { staleBuild } from "../scripts/publish-lib.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
