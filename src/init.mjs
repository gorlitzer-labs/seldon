// foundation init — install the seam + doc scaffold into a repo (idempotent, bolt-onto-existing).
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { read, writeAtomic } from "./lib/fs.mjs";
import { ok, say, c } from "./lib/log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = join(HERE, "..", "payload", "doc-templates");

export async function init(root) {
  const dst = join(root, "docs");
  mkdirSync(join(dst, "phases"), { recursive: true });
  let created = 0, kept = 0;
  for (const f of readdirSync(PAYLOAD)) {
    if (!f.endsWith(".md")) continue;
    const target = join(dst, f);
    if (existsSync(target)) { kept++; continue; }  // never clobber an existing doc
    writeAtomic(target, read(join(PAYLOAD, f)));
    created++;
  }
  ok(`Foundation installed → ${dst}/  (${created} created, ${kept} kept)`);
  say(c.dim("  seam: QUEUE · WORKSTREAMS · DONE · FACTS    docs: STACK_MAP · DECISIONS · CONTEXT"));
  say(c.dim("  next: foundation status   ·   foundation doctor"));
}
