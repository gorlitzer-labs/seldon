#!/usr/bin/env node
// Publish every Node package in the Seldon stack to public npm.
//
// Idempotent: skips any package whose current version is already on npm, so the
// release flow is just "bump what changed, then run this". Order matters —
// apiary + foundation before factory (which lists them).
//
// Auth: reads the automation token from the env (root .npmrc = ${NPM_TOKEN}).
// Run it through comb so the token never touches disk or history:
//   comb run --with NPM_TOKEN -- node tools/seldon/scripts/publish-all.mjs
import { execSync } from "node:child_process";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ORDER = ["modules/apiary", "modules/foundation", "modules/comb", "modules/factory", "tools/seldon"];
const dry = process.argv.includes("--dry-run");

try { execSync("npm whoami", { stdio: "pipe" }); }
catch {
  console.error("Not authed to npm. Provide the token, e.g.:");
  console.error("  comb run --with NPM_TOKEN -- node tools/seldon/scripts/publish-all.mjs");
  process.exit(1);
}

const isPublished = (name, version) => {
  try { execSync(`npm view ${name}@${version} version`, { stdio: "pipe" }); return true; }
  catch { return false; }
};

const published = [], skipped = [];
for (const dir of ORDER) {
  const abs = path.join(ROOT, dir);
  const pj = JSON.parse(readFileSync(path.join(abs, "package.json")));
  if (isPublished(pj.name, pj.version)) {
    console.log(`= ${pj.name}@${pj.version} already on npm — skip`);
    skipped.push(pj.name);
    continue;
  }
  console.log(`\n▸ ${pj.name}@${pj.version}`);
  if (pj.scripts?.build && !existsSync(path.join(abs, "dist")))
    execSync(`npm run build -w ${dir}`, { cwd: ROOT, stdio: "inherit" });
  execSync(`npm publish -w ${dir} --access public${dry ? " --dry-run" : ""}`, { cwd: ROOT, stdio: "inherit" });
  published.push(`${pj.name}@${pj.version}`);
}
console.log(`\nDone.${dry ? " (dry run)" : ""} Published: ${published.join(", ") || "none"}` +
  (skipped.length ? `  ·  ${skipped.length} already current` : ""));
