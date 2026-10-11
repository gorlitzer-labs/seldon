/**
 * factory reaching a hive on another machine — by reading bifrost's realms.
 *
 * The value and the danger both live in the ssh argv: get it wrong and a
 * supervisor tick either hangs on a dead realm or, worse, runs a command
 * somewhere it shouldn't. So the argv is read off runnerArgv directly, and the
 * realm-file parsing is pinned against bifrost's actual format including its
 * legacy DEVICE_* keys.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRealmFile, resolveRealm, listRealms, runnerArgv } from "../src/lib/realm.mjs";

describe("parsing bifrost realm files", () => {
  test("reads REALM_HOST and REALM_USER", () => {
    assert.deepEqual(parseRealmFile('REALM_HOST="zanpakuto"\nREALM_USER="gorlitzer"\n'),
      { host: "zanpakuto", user: "gorlitzer" });
  });
  test("falls back to legacy DEVICE_* keys", () => {
    assert.deepEqual(parseRealmFile('DEVICE_HOST="old"\nDEVICE_USER="thor"\n'),
      { host: "old", user: "thor" });
  });
  test("host without user is allowed (ssh uses the current user)", () => {
    assert.deepEqual(parseRealmFile('REALM_HOST="h"\n'), { host: "h", user: null });
  });
  test("no host → not a realm", () => {
    assert.equal(parseRealmFile('REALM_USER="x"\n'), null);
  });
  test("does not execute the file — a command substitution is inert text", () => {
    // If this were sourced, $(touch pwned) would run. Parsed, it is just not a
    // valid host match, so we get null rather than a side effect.
    const r = parseRealmFile('REALM_HOST=$(touch /tmp/pwned)\n');
    // either null or the literal string, but nothing executed
    assert.ok(r === null || r.host.includes("touch"));
  });
});

describe("resolveRealm", () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "realms-")); });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("resolves a known realm", () => {
    writeFileSync(join(dir, "asgard"), 'REALM_HOST="asgard.ts"\nREALM_USER="odin"\n');
    assert.deepEqual(resolveRealm("asgard", dir), { host: "asgard.ts", user: "odin" });
  });
  test("unknown realm → null", () => {
    assert.equal(resolveRealm("nope", dir), null);
  });
  test("rejects a realm name that could smuggle an ssh option or path", () => {
    assert.throws(() => resolveRealm("-oProxyCommand=x", dir), /invalid realm name/);
    assert.throws(() => resolveRealm("../etc/passwd", dir), /invalid realm name/);
  });
});

describe("listRealms skips junk", () => {
  test("ignores .DS_Store and malformed names, keeps real realms", () => {
    const dir = mkdtempSync(join(tmpdir(), "realms-"));
    writeFileSync(join(dir, "asgard"), 'REALM_HOST="a"\n');
    writeFileSync(join(dir, ".DS_Store"), "junk");
    writeFileSync(join(dir, "bad name"), 'REALM_HOST="b"\n');
    const names = listRealms(dir).map((r) => r.name).sort();
    assert.deepEqual(names, ["asgard"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runnerArgv — local vs realm", () => {
  test("null realm runs the command verbatim, no ssh", () => {
    const { bin, args } = runnerArgv(null, ["tmux", "has-session", "-t", "apiary_bee"]);
    assert.equal(bin, "tmux");
    assert.deepEqual(args, ["has-session", "-t", "apiary_bee"]);
  });
  test("a realm wraps the command in ssh with batch + timeout, and cannot hang", () => {
    const { bin, args } = runnerArgv({ host: "zan", user: "g" }, ["tmux", "has-session", "-t", "apiary_bee"]);
    assert.equal(bin, "ssh");
    assert.ok(args.includes("BatchMode=yes"), "must never prompt in a supervisor tick");
    assert.ok(args.includes("ConnectTimeout=8"), "must time out on a dead realm");
    assert.ok(args.includes("g@zan"), "target is user@host");
    assert.equal(args[args.length - 1], "tmux has-session -t apiary_bee");
  });
  test("a realm without a user uses a bare host", () => {
    const { args } = runnerArgv({ host: "zan", user: null }, ["true"]);
    assert.ok(args.includes("zan") && !args.some((a) => a.includes("@")));
  });
});
