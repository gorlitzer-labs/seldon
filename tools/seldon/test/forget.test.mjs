import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { forgetProject, ensureSiblingPath } from "../lib/projects.mjs";

test("forgetProject: drops only that entry from the registry and never touches the folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forget-"));
  const project = path.join(dir, "stranded"); fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  const reg = path.join(dir, "hives.json");
  fs.writeFileSync(reg, JSON.stringify([{ name: "seldon", dir: "/x" }, { name: "stranded", dir: project }]));
  assert.deepEqual(forgetProject("stranded", reg), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(reg, "utf8")).map((h) => h.name), ["seldon"]);
  assert.ok(fs.existsSync(path.join(project, ".git")), "the folder and its git are untouched");
  assert.equal(forgetProject("stranded", reg).ok, false);           // already gone: says so
  assert.equal(forgetProject("x", path.join(dir, "missing.json")).ok, false);
});

test("ensureSiblingPath: Claude's install folder is on PATH even from a shell that skipped .zshrc", () => {
  const home = os.homedir(), local = path.join(home, ".local", "bin");
  if (!fs.existsSync(local)) return;                                 // nothing to find on this machine
  const was = process.env.PATH;
  try {
    process.env.PATH = "/usr/bin:/bin";
    ensureSiblingPath(process.argv[1]);
    assert.ok(process.env.PATH.split(path.delimiter).includes(local));
  } finally { process.env.PATH = was; }
});
