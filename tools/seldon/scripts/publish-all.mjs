#!/usr/bin/env node
// Publish every node package in the Seldon stack to the public npm registry.
// Order matters: apiary + foundation before factory (which depends on them).
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ORDER = ["modules/apiary", "modules/foundation", "modules/comb", "modules/factory", "tools/seldon"];
const dry = process.argv.includes("--dry-run");
try { execSync("npm whoami", { stdio: "pipe" }); }
catch { console.error("Not logged in to npm. Run `npm login` (needs the @gorlitzer-labs org)."); process.exit(1); }
for (const dir of ORDER) {
  const abs = path.join(ROOT, dir);
  const pj = JSON.parse(execSync(`cat ${path.join(abs, "package.json")}`));
  console.log(`\n▸ ${pj.name}@${pj.version}`);
  if (pj.scripts?.build) execSync("npm run build", { cwd: abs, stdio: "inherit" });
  execSync(`npm publish --access public${dry ? " --dry-run" : ""}`, { cwd: abs, stdio: "inherit" });
}
console.log("\nAll published.");
