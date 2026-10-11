// Pure helpers for publish-all.mjs, kept separate so they can be tested without npm.

// npm now stages a publish for a while (~20 min seen) before the version is visible:
// `npm view` says it is missing, and publishing it again is refused with
//   409 Conflict - Cannot publish over previously staged version "x.y.z".
// That answer means the version IS taken and on its way — not a failure.
export function classifyPublishError(stderr) {
  const s = String(stderr || "");
  if (/E409/.test(s) && /previously staged version/i.test(s)) return "staged";
  return "error";
}

// A package whose published files are BUILT (apiary: tsup -> dist/) ships whatever dist/ is on
// disk. publish-all used to build only when dist/ was missing, so a checkout with an old dist/
// published old code under a new version: apiary 1.13.5 and 1.13.6 shipped a dist/ from Sep 20,
// and the fixes those versions were cut for never reached npm. Now it always builds, and this
// is the check after the build: no source file may be newer than the oldest built output.
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

function mtimes(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) mtimes(p, out);
    else out.push({ p, t: statSync(p).mtimeMs });
  }
  return out;
}

export function staleBuild(pkgDir, srcDir = "src", outDir = "dist") {
  const src = join(pkgDir, srcDir), out = join(pkgDir, outDir);
  if (!existsSync(out)) return { stale: true, reason: `${outDir}/ does not exist` };
  if (!existsSync(src)) return { stale: false };
  const s = mtimes(src), o = mtimes(out).filter((f) => !f.p.endsWith(".map"));
  if (!o.length) return { stale: true, reason: `${outDir}/ is empty` };
  const newestSrc = s.reduce((a, b) => (b.t > a.t ? b : a), { t: 0 });
  const oldestOut = o.reduce((a, b) => (b.t < a.t ? b : a), { t: Infinity });
  return newestSrc.t > oldestOut.t
    ? { stale: true, reason: `${newestSrc.p} is newer than ${oldestOut.p}` }
    : { stale: false };
}
