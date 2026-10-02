/**
 * A stored value must never be a command-line argument.
 *
 * Arguments are public: any process on the machine can read them with `ps` for
 * as long as the command runs. comb once passed every value to `sops set` that
 * way. This puts a recording `sops` first on PATH — it logs its own arguments,
 * then hands over to the real one — and checks that the value never appears.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import * as store from "../src/backends/sops.mjs";

const SECRET = "argv-must-never-see-this-9f8e7d6c5b4a";
let home, shim, log, realPath;

before(() => {
  home = mkdtempSync(join(tmpdir(), "comb-argv-"));
  store.init(home);
  const real = execSync("command -v sops").toString().trim();
  shim = mkdtempSync(join(tmpdir(), "comb-shim-"));
  log = join(shim, "argv.log");
  writeFileSync(join(shim, "sops"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${real}" "$@"\n`);
  chmodSync(join(shim, "sops"), 0o755);
  realPath = process.env.PATH;
  process.env.PATH = `${shim}:${realPath}`;
});
after(() => {
  process.env.PATH = realPath;
  rmSync(home, { recursive: true, force: true });
  rmSync(shim, { recursive: true, force: true });
});

test("writing a secret never puts its value in sops's arguments", () => {
  store.writeSecret("ARGV_CHECK", SECRET, {}, home);
  assert.ok(existsSync(log), "the recording sops must have been the one called");
  assert.ok(!readFileSync(log, "utf-8").includes(SECRET), "the value was visible to ps");
  assert.equal(store.readAll(home).ARGV_CHECK.value, SECRET, "and it must still be stored");
});

test("a sops too old for --value-stdin is refused, not worked around", () => {
  assert.equal(store.sopsSupportsValueStdin("sops 3.9.4 (latest)"), false);
  assert.equal(store.sopsSupportsValueStdin("sops 3.11.0"), true);
  assert.equal(store.sopsSupportsValueStdin("sops 3.13.3 (latest)"), true);
  assert.equal(store.sopsSupportsValueStdin("sops 4.0.0"), true);
  assert.equal(store.sopsSupportsValueStdin(""), false);
});
