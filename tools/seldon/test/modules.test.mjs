// Unit tests for the module registry — the pure logic the installer relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODULES, byId, DEPS, withRequires, platformOk } from "../modules.mjs";

test("all six modules are present with the fields the installer reads", () => {
  const ids = MODULES.map((m) => m.id).sort();
  assert.deepEqual(ids, ["apiary", "bifrost", "comb", "demerzel", "factory", "foundation"]);
  for (const m of MODULES) {
    assert.ok(m.id && m.title && m.blurb, `${m.id} has id/title/blurb`);
    assert.ok(["npm", "shell", "python"].includes(m.method), `${m.id} method valid`);
    assert.ok(m.bin, `${m.id} has a bin`);
    if (m.method === "npm") assert.ok(m.pkg?.startsWith("@gorlitzer-labs/"), `${m.id} scoped pkg`);
  }
});

test("byId maps every module", () => {
  for (const m of MODULES) assert.equal(byId[m.id], m);
});

test("withRequires expands factory to include apiary + foundation", () => {
  const out = withRequires(["factory"]);
  assert.ok(out.includes("factory"));
  assert.ok(out.includes("apiary"), "factory pulls in apiary");
  assert.ok(out.includes("foundation"), "factory pulls in foundation");
});

test("withRequires is a no-op for modules with no requires", () => {
  assert.deepEqual(withRequires(["comb"]).sort(), ["comb"]);
});

test("withRequires dedupes and preserves registry order", () => {
  const out = withRequires(["factory", "apiary", "comb"]);
  assert.equal(new Set(out).size, out.length, "no duplicates");
  // order follows MODULES, not the argument order
  const order = MODULES.map((m) => m.id);
  const idx = out.map((id) => order.indexOf(id));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), "sorted by registry order");
});

test("platformOk gates demerzel to darwin/arm64 only", () => {
  const dem = byId.demerzel;
  assert.ok(dem.platforms, "demerzel declares a platform constraint");
  // simulate platforms via the actual check against the current process only
  // (unit-check the shape rather than mutate process.platform)
  assert.equal(dem.platforms.platform, "darwin");
  assert.equal(dem.platforms.arch, "arm64");
});

test("platform-agnostic modules pass platformOk everywhere", () => {
  for (const id of ["apiary", "foundation", "comb", "factory", "bifrost"]) {
    assert.equal(byId[id].platforms, null, `${id} has no platform gate`);
    assert.equal(platformOk(byId[id]), true, `${id} platformOk`);
  }
});

test("every needs entry has a DEPS probe + hint", () => {
  const needed = new Set(MODULES.flatMap((m) => m.needs));
  for (const dep of needed) {
    assert.ok(DEPS[dep], `DEPS has ${dep}`);
    assert.ok(DEPS[dep].probe && DEPS[dep].hint, `${dep} has probe + hint`);
  }
});

test("dep hints stay cross-platform (never assume brew-only)", () => {
  for (const [name, d] of Object.entries(DEPS)) {
    if (/brew/i.test(d.hint)) {
      assert.match(d.hint, /apt|dnf|pacman|pkg|package manager|releases|nodejs\.org|python\.org|tailscale\.com/i,
        `${name} hint offers a non-brew path too`);
    }
  }
});
