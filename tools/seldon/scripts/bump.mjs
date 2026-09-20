#!/usr/bin/env node
// Bump one module's version (no git tag). Usage:
//   node tools/seldon/scripts/bump.mjs <module> [patch|minor|major]
//   node tools/seldon/scripts/bump.mjs apiary patch
import { execSync } from "node:child_process";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIRS = {
  apiary: "modules/apiary", foundation: "modules/foundation", comb: "modules/comb",
  factory: "modules/factory", seldon: "tools/seldon",
};
const [mod, level = "patch"] = process.argv.slice(2);
if (!DIRS[mod]) {
  console.error(`usage: bump <${Object.keys(DIRS).join("|")}> [patch|minor|major]`);
  process.exit(1);
}
const dir = path.join(ROOT, DIRS[mod]);
execSync(`npm version ${level} --no-git-tag-version`, { cwd: dir, stdio: "pipe" });
const v = JSON.parse(readFileSync(path.join(dir, "package.json"))).version;
console.log(`${mod} → ${v}`);
